import * as Live from "./attioHarness.js";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type AttioSnapshot, type AttioValue } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { Directory } from "@patchy/companies";
import { Binding, Runtime } from "@patchy/runtime/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ConnectionStore from "../src/ConnectionStore.js";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as PidgeonSource from "../src/pidgeon/Source.js";
import * as PostgresSource from "../src/postgres/Source.js";
import * as PostHogSource from "../src/posthog/Source.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";
import * as Operations from "../src/attio/Operations.js";
import { NodeCryptography } from "@patchy/core";

/**
 * Attio's reads against Attio itself: Patchy's probe workspace, read with its read-only key. Each
 * row of the filter table is sent as Patchy builds it, paged to the end, and the ids it answers are
 * compared with the same filter evaluated here over every record read unfiltered, emptiness
 * included. It proves the encodings exact on a real workspace and catches Attio drifting; the
 * offline tests (`src/attio`) are what carry correctness, and this tier is never required.
 *
 * It reads `deals`, `companies`, `people` and the `probe_pipeline` list, which Attio's Free plan
 * keeps. A case about a custom object skips when the workspace doesn't have one. Nothing here
 * prints a key, a record, an email or the workspace's id.
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const services = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 9).toString("base64")}`)),
  RuntimeLog.layer,
  // Never called: these connections reach no database, PostHog project or Pidgeon address.
  Layer.succeed(
    PostgresSource.Source,
    PostgresSource.Source.of({
      test: () => Effect.die("no Postgres here"),
      inspect: () => Effect.die("no Postgres here")
    })
  ),
  PostHogSource.layer,
  PidgeonSource.layer,
  Live.layer
).pipe(Layer.provideMerge(Testing.layer()), Layer.provideMerge(NodeCryptography.layer));

afterAll(Live.summary);

type Value = typeof AttioValue.Type;
interface Row {
  readonly id: string;
  readonly values: Readonly<Record<string, Value>>;
}
interface Entry extends Row {
  readonly parent: { readonly object: string; readonly id: string };
}
type Page<R> = { readonly rows: ReadonlyArray<R>; readonly cursor: string | null };
type Viewer = NonNullable<Binding.Binding["Service"]["identity"]>;

/** The probe workspace, connected as `crm`, and its reads as a tier 2 action's callbacks make them. */
const connect = Effect.gen(function* () {
  const store = yield* SqlConnectionStore.make;
  const connection = yield* store.connect({
    integration: "attio",
    ...who,
    handle: `crm-reads-${Date.now().toString(36)}`,
    description: "The probe workspace",
    credentials: Live.readKey()
  });
  const metadata = yield* store.snapshot(who.companyId, connection.id, connection.metadataRevision);
  if (metadata.integration !== "attio") return assert.fail("not an Attio snapshot");
  const handlers = yield* Operations.makeHandlers.pipe(
    Effect.provide(Directory.layer),
    Effect.provideService(ConnectionStore.ConnectionStore, store)
  );
  const viewer: Viewer = {
    user: { id: who.userId, name: "Dev", email: "dev@patchy.local" },
    company: { id: who.companyId, name: "Patchy Dev", handle: "patchy-dev" },
    admin: false
  };
  const binding = Binding.Binding.of({
    companyId: who.companyId,
    patchId: "dealdesk00001",
    versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
    wireVersion: WIRE_VERSION,
    scope: "company",
    correlationId: "attio-live",
    principal: { userId: viewer.user.id },
    identity: viewer,
    manifest: {
      manifestVersion: 1,
      release: CURRENT_RELEASE,
      tier: 2,
      tables: {},
      files: {},
      handlers: {},
      uses: {
        crm: {
          kind: "attio",
          handle: connection.handle,
          id: connection.id,
          revision: connection.metadataRevision
        }
      }
    }
  });
  const call = (op: keyof typeof handlers, args: Record<string, unknown>) =>
    handlers[op]
      .run({ connection: "crm", ...args })
      .pipe(Effect.provideService(Binding.Binding, binding));
  const refused = (op: keyof typeof handlers, args: Record<string, unknown>) =>
    call(op, args).pipe(Effect.flip, Effect.map(Runtime.toFailure));
  /** Every row a list call answers, page by page. */
  const all = <R>(op: "attio.listRecords" | "attio.listEntries", args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const rows: R[] = [];
      let cursor: string | null = null;
      do {
        const page = (yield* call(op, {
          ...args,
          limit: 500,
          ...(cursor === null ? {} : { cursor })
        })) as Page<R>;
        rows.push(...page.rows);
        cursor = page.cursor;
      } while (cursor !== null);
      return rows;
    });
  return { snapshot: metadata.snapshot as AttioSnapshot, call, refused, all };
});

const isEmpty = (value: Value | undefined) =>
  value === null || value === undefined || (Array.isArray(value) && value.length === 0);
const ones = (value: Value | undefined): ReadonlyArray<unknown> =>
  value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
const field = (value: unknown, key: string) =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : value);
const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id).sort();
/** The first value a row holds on `slug`, among `rows`, for building a filter that matches. */
const some = (rows: ReadonlyArray<Row>, slug: string) =>
  rows.map((row) => ones(row.values[slug])[0]).find((value) => value !== undefined) ??
  assert.fail(`No row holds ${slug}.`);

describe.skipIf(Live.READ_KEY === undefined)(
  "Attio reads, live on Patchy's probe workspace",
  () => {
    it.layer(services, { timeout: "300 seconds", excludeTestServices: true })(
      "every row of the filter table, exactly",
      (it) => {
        it.effect(
          "matches deals as evaluated here, for every type, empty included",
          () =>
            Effect.gen(function* () {
              const { all, snapshot } = yield* connect;
              const deals = yield* all<Row>("attio.listRecords", { object: "deals" });
              assert.isAbove(deals.length, 1000);
              const options = (slug: string) =>
                snapshot.objects
                  .find((object) => object.slug === "deals")!
                  .attributes.find((attribute) => attribute.slug === slug)!.options ?? [];
              /** Attio's answer to `args` on deals is exactly the deals `keep` keeps. */
              const exactly = (
                label: string,
                args: Record<string, unknown>,
                keep: (row: Row) => boolean
              ) =>
                Effect.gen(function* () {
                  const answered = yield* all<Row>("attio.listRecords", {
                    object: "deals",
                    ...args
                  });
                  const expected = deals.filter(keep);
                  assert.deepStrictEqual(ids(answered), ids(expected), label);
                  return expected.length;
                });
              const v = (row: Row, slug: string) => row.values[slug];
              const name = some(deals, "name") as string;
              const notes = some(deals, "notes") as string;
              const amount = some(deals, "amount") as number;
              const score = some(deals, "score") as number;
              const value = field(some(deals, "value"), "amount") as number;
              const close = some(deals, "close_date") as string;
              const touched = some(deals, "last_touch_at") as string;
              const phone = some(deals, "phone") as string;
              const locality = field(some(deals, "hq_location"), "locality") as string;
              const company = field(some(deals, "associated_company"), "id") as string;
              const person = field(some(deals, "associated_people"), "id") as string;
              const counterparty = some(deals, "counterparty") as { object: string; id: string };
              const owner = field(some(deals, "owner"), "id") as string;
              const [segmentA, segmentB] = options("segment");
              const [tagA, tagB] = options("tags");
              const stage =
                options("stage").find((title) => /\p{Extended_Pictographic}/u.test(title)) ??
                options("stage")[0]!;

              // text: case-insensitive eq, $in, contains, empty
              yield* exactly(
                "text eq",
                { eq: { name: name.toUpperCase() } },
                (row) => lower(v(row, "name")) === name.toLowerCase()
              );
              yield* exactly(
                "text any-of, case-insensitive too",
                { eq: { notes: [notes.toUpperCase(), "no such note"] } },
                (row) => lower(v(row, "notes")) === notes.toLowerCase()
              );
              yield* exactly(
                "text contains",
                { contains: { name: name.slice(0, 8).toUpperCase() } },
                (row) =>
                  String(v(row, "name") ?? "")
                    .toLowerCase()
                    .includes(name.slice(0, 8).toLowerCase())
              );
              yield* exactly("text empty", { eq: { notes: null } }, (row) =>
                isEmpty(v(row, "notes"))
              );
              // number and rating: eq, any-of, range, empty
              yield* exactly("number eq", { eq: { amount } }, (row) => v(row, "amount") === amount);
              yield* exactly(
                "number range",
                { range: { attribute: "amount", gte: amount, lt: amount + 2000 } },
                (row) =>
                  typeof v(row, "amount") === "number" &&
                  (v(row, "amount") as number) >= amount &&
                  (v(row, "amount") as number) < amount + 2000
              );
              yield* exactly("number empty", { eq: { amount: null } }, (row) =>
                isEmpty(v(row, "amount"))
              );
              yield* exactly(
                "rating any-of",
                { eq: { score: [score, score + 1] } },
                (row) => v(row, "score") === score || v(row, "score") === score + 1
              );
              yield* exactly("rating empty", { eq: { score: null } }, (row) =>
                isEmpty(v(row, "score"))
              );
              // checkbox: false matches unset
              yield* exactly(
                "checkbox true",
                { eq: { is_hot: true } },
                (row) => v(row, "is_hot") === true
              );
              yield* exactly(
                "checkbox false",
                { eq: { is_hot: false } },
                (row) => v(row, "is_hot") === false
              );
              // currency on its amount
              yield* exactly(
                "currency eq",
                { eq: { value } },
                (row) => field(v(row, "value"), "amount") === value
              );
              yield* exactly(
                "currency range",
                { range: { attribute: "value", gt: value } },
                (row) =>
                  typeof field(v(row, "value"), "amount") === "number" &&
                  (field(v(row, "value"), "amount") as number) > value
              );
              yield* exactly("currency empty", { eq: { value: null } }, (row) =>
                isEmpty(v(row, "value"))
              );
              // date and timestamp
              yield* exactly(
                "date eq",
                { eq: { close_date: close } },
                (row) => v(row, "close_date") === close
              );
              yield* exactly(
                "date range",
                { range: { attribute: "close_date", gte: close, lt: "2026-12-31" } },
                (row) =>
                  typeof v(row, "close_date") === "string" &&
                  (v(row, "close_date") as string) >= close &&
                  (v(row, "close_date") as string) < "2026-12-31"
              );
              yield* exactly("date empty", { eq: { close_date: null } }, (row) =>
                isEmpty(v(row, "close_date"))
              );
              yield* exactly(
                "timestamp eq",
                { eq: { last_touch_at: touched } },
                (row) => v(row, "last_touch_at") === touched
              );
              const since = `${touched.slice(0, 10)}T00:00:00Z`;
              yield* exactly(
                "timestamp range",
                { range: { attribute: "last_touch_at", gte: since } },
                (row) =>
                  typeof v(row, "last_touch_at") === "string" &&
                  Date.parse(v(row, "last_touch_at") as string) >= Date.parse(since)
              );
              yield* exactly("timestamp empty", { eq: { last_touch_at: null } }, (row) =>
                isEmpty(v(row, "last_touch_at"))
              );
              // select, multiselect, status: titles exact; empty over the options now
              yield* exactly(
                "select eq",
                { eq: { segment: segmentA } },
                (row) => v(row, "segment") === segmentA
              );
              yield* exactly(
                "select any-of",
                { eq: { segment: [segmentA, segmentB] } },
                (row) => v(row, "segment") === segmentA || v(row, "segment") === segmentB
              );
              yield* exactly("select empty", { eq: { segment: null } }, (row) =>
                isEmpty(v(row, "segment"))
              );
              yield* exactly("multiselect has", { eq: { tags: tagA } }, (row) =>
                ones(v(row, "tags")).includes(tagA)
              );
              yield* exactly("multiselect has any", { eq: { tags: [tagA, tagB] } }, (row) =>
                ones(v(row, "tags")).some((tag) => tag === tagA || tag === tagB)
              );
              yield* exactly("multiselect empty", { eq: { tags: null } }, (row) =>
                isEmpty(v(row, "tags"))
              );
              yield* exactly(
                "status eq, emoji included",
                { eq: { stage } },
                (row) => v(row, "stage") === stage
              );
              yield* exactly("status empty", { eq: { health: null } }, (row) =>
                isEmpty(v(row, "health"))
              );
              // phone
              yield* exactly("phone eq", { eq: { phone } }, (row) => v(row, "phone") === phone);
              yield* exactly("phone contains", { contains: { phone: phone.slice(-4) } }, (row) =>
                String(v(row, "phone") ?? "").includes(phone.slice(-4))
              );
              yield* exactly("phone empty", { eq: { phone: null } }, (row) =>
                isEmpty(v(row, "phone"))
              );
              // location
              yield* exactly(
                "location eq",
                { eq: { hq_location: { locality } } },
                (row) => field(v(row, "hq_location"), "locality") === locality
              );
              yield* exactly(
                "location contains",
                { contains: { hq_location: locality.slice(0, 3) } },
                (row) =>
                  String(field(v(row, "hq_location"), "locality") ?? "")
                    .toLowerCase()
                    .includes(locality.slice(0, 3).toLowerCase())
              );
              // record references: one target, many, several targets; empty over the targets now
              yield* exactly(
                "reference eq, bare id",
                { eq: { associated_company: company } },
                (row) => field(v(row, "associated_company"), "id") === company
              );
              yield* exactly(
                "reference any-of",
                { eq: { associated_people: [{ object: "people", id: person }] } },
                (row) =>
                  ones(v(row, "associated_people")).some((ref) => field(ref, "id") === person)
              );
              yield* exactly(
                "reference with several targets",
                { eq: { counterparty: [counterparty] } },
                (row) =>
                  ones(v(row, "counterparty")).some(
                    (ref) =>
                      field(ref, "id") === counterparty.id &&
                      field(ref, "object") === counterparty.object
                  )
              );
              yield* exactly("reference empty", { eq: { associated_company: null } }, (row) =>
                isEmpty(v(row, "associated_company"))
              );
              yield* exactly(
                "reference with several targets empty",
                { eq: { counterparty: null } },
                (row) => isEmpty(v(row, "counterparty"))
              );
              // actor references
              yield* exactly(
                "actor eq",
                { eq: { owner } },
                (row) => field(v(row, "owner"), "id") === owner
              );
              yield* exactly("actor multiselect has", { eq: { watchers: owner } }, (row) =>
                ones(v(row, "watchers")).some((actor) => field(actor, "id") === owner)
              );
              yield* exactly("actor empty", { eq: { watchers: null } }, (row) =>
                isEmpty(v(row, "watchers"))
              );
            }),
          // About fifty filters, each paged to its end, at the harness's shared pace.
          600_000
        );

        it.effect("matches people and companies on names, emails, domains and interactions", () =>
          Effect.gen(function* () {
            const { all } = yield* connect;
            const people = yield* all<Row>("attio.listRecords", { object: "people" });
            const companies = yield* all<Row>("attio.listRecords", { object: "companies" });
            const exactly = (
              object: string,
              rows: ReadonlyArray<Row>,
              label: string,
              args: Record<string, unknown>,
              keep: (row: Row) => boolean
            ) =>
              Effect.gen(function* () {
                const answered = yield* all<Row>("attio.listRecords", { object, ...args });
                assert.deepStrictEqual(ids(answered), ids(rows.filter(keep)), label);
              });
            const full = field(some(people, "name"), "full") as string;
            const email = some(people, "email_addresses") as string;
            const domain = some(companies, "domains") as string;
            yield* exactly(
              "people",
              people,
              "personal name eq",
              { eq: { name: full } },
              (row) => lower(field(row.values.name, "full")) === full.toLowerCase()
            );
            yield* exactly(
              "people",
              people,
              "personal name contains",
              { contains: { name: full.slice(0, 7) } },
              (row) =>
                String(field(row.values.name, "full") ?? "")
                  .toLowerCase()
                  .includes(full.slice(0, 7).toLowerCase())
            );
            yield* exactly("people", people, "personal name empty", { eq: { name: null } }, (row) =>
              isEmpty(row.values.name)
            );
            yield* exactly(
              "people",
              people,
              "email eq",
              { eq: { email_addresses: email } },
              (row) => ones(row.values.email_addresses).includes(email)
            );
            yield* exactly(
              "people",
              people,
              "email contains",
              { contains: { email_addresses: email.slice(0, 7) } },
              (row) =>
                ones(row.values.email_addresses).some((item) =>
                  String(item).includes(email.slice(0, 7))
                )
            );
            yield* exactly(
              "people",
              people,
              "email empty",
              { eq: { email_addresses: null } },
              (row) => isEmpty(row.values.email_addresses)
            );
            yield* exactly(
              "companies",
              companies,
              "domain eq",
              { eq: { domains: domain } },
              (row) => ones(row.values.domains).includes(domain)
            );
            yield* exactly(
              "companies",
              companies,
              "domain contains",
              { contains: { domains: domain.slice(0, 9) } },
              (row) =>
                ones(row.values.domains).some((item) => String(item).includes(domain.slice(0, 9)))
            );
            yield* exactly(
              "companies",
              companies,
              "domain empty",
              { eq: { domains: null } },
              (row) => isEmpty(row.values.domains)
            );
            yield* exactly(
              "companies",
              companies,
              "interaction empty",
              { eq: { last_interaction: null } },
              (row) => isEmpty(row.values.last_interaction)
            );
            yield* exactly(
              "companies",
              companies,
              "interaction range",
              { range: { attribute: "last_interaction", gte: "2000-01-01T00:00:00Z" } },
              (row) => !isEmpty(row.values.last_interaction)
            );
          })
        );
      }
    );

    it.layer(services, { timeout: "300 seconds", excludeTestServices: true })(
      "order, paging, gets and the journey",
      (it) => {
        it.effect(
          "orders by option, amount and name with empties lowest, repeating and skipping nothing",
          () =>
            Effect.gen(function* () {
              const { all, snapshot } = yield* connect;
              const deals = snapshot.objects.find((object) => object.slug === "deals")!;
              const segments =
                deals.attributes.find((attribute) => attribute.slug === "segment")!.options ?? [];
              const bySegment = yield* all<Row>("attio.listRecords", {
                object: "deals",
                orderBy: { attribute: "segment" }
              });
              const everything = yield* all<Row>("attio.listRecords", { object: "deals" });
              // Heavy ties: every deal once, in option order, empties first.
              assert.strictEqual(new Set(bySegment.map((row) => row.id)).size, bySegment.length);
              assert.deepStrictEqual(ids(bySegment), ids(everything));
              const rank = (row: Row) =>
                isEmpty(row.values.segment) ? -1 : segments.indexOf(row.values.segment as string);
              for (let index = 1; index < bySegment.length; index++)
                assert.isAtMost(
                  rank(bySegment[index - 1]!),
                  rank(bySegment[index]!),
                  "option order"
                );
              // Descending: empties last.
              const byValue = yield* all<Row>("attio.listRecords", {
                object: "deals",
                eq: { is_hot: true },
                orderBy: { attribute: "value", direction: "desc" }
              });
              const amounts = byValue.map(
                (row) => field(row.values.value, "amount") as number | undefined
              );
              const firstEmpty = amounts.findIndex((amount) => amount === undefined);
              if (firstEmpty !== -1)
                assert.isTrue(amounts.slice(firstEmpty).every((amount) => amount === undefined));
              const present = amounts.filter((amount): amount is number => amount !== undefined);
              assert.deepStrictEqual(
                present,
                [...present].sort((a, b) => b - a)
              );
            })
        );

        it.effect(
          "walks the parent's journey: deals by stage and owner, a deal, its companies, its pipeline",
          () =>
            Effect.gen(function* () {
              const { call, all, refused, snapshot } = yield* connect;
              const members = (yield* call("attio.listMembers", {})) as {
                rows: ReadonlyArray<{ id: string; active: boolean; email: string }>;
              };
              assert.isTrue(members.rows.some((member) => member.active));
              const owned = (
                (yield* call("attio.listRecords", { object: "deals", limit: 50 })) as Page<Row>
              ).rows;
              const owner = owned
                .map((row) => field(row.values.owner, "id"))
                .find((id): id is string => typeof id === "string")!;
              const stage = owned
                .map((row) => row.values.stage)
                .find((title): title is string => typeof title === "string")!;
              // Deals by stage and owner, sorted by value, page by page.
              const first = (yield* call("attio.listRecords", {
                object: "deals",
                eq: { stage, owner },
                orderBy: { attribute: "value", direction: "desc" },
                limit: 100
              })) as Page<Row>;
              assert.isAbove(first.rows.length, 0);
              const pages = yield* all<Row>("attio.listRecords", {
                object: "deals",
                eq: { stage, owner },
                orderBy: { attribute: "value", direction: "desc" }
              });
              assert.isAtLeast(pages.length, first.rows.length);
              // Open one, then its company and people with getMany.
              const deal = first.rows[0]!;
              const opened = (yield* call("attio.getRecord", { object: "deals", id: deal.id })) as {
                rows: ReadonlyArray<Row>;
              };
              assert.strictEqual(opened.rows[0]?.id, deal.id);
              assert.deepStrictEqual(
                yield* call("attio.getRecord", {
                  object: "deals",
                  id: "00000000-0000-4000-8000-000000000000"
                }),
                { ok: true, rows: [] }
              );
              const companyIds = pages
                .flatMap((row) =>
                  ones(row.values.associated_company).map((ref) => field(ref, "id") as string)
                )
                .slice(0, 150);
              const missing = "00000000-0000-4000-8000-000000000001";
              const asked = [...companyIds, companyIds[0]!, missing];
              const many = (yield* call("attio.getManyRecords", {
                object: "companies",
                ids: asked
              })) as { rows: ReadonlyArray<Row | null> };
              assert.deepStrictEqual(
                many.rows.map((row) => row?.id ?? null),
                [...companyIds, companyIds[0]!, null]
              );
              // A pipeline's entries for a deal on it, sorted by when they entered.
              const pipeline = snapshot.lists.find((list) => list.slug === "probe_pipeline");
              if (pipeline !== undefined) {
                const entries = yield* all<Entry>("attio.listEntries", {
                  list: "probe_pipeline",
                  orderBy: { attribute: "entered_on", direction: "desc" }
                });
                assert.isAbove(entries.length, 0);
                const parent = entries[0]!.parent;
                const its = yield* all<Entry>("attio.listEntries", {
                  list: "probe_pipeline",
                  parent: parent.id
                });
                assert.deepStrictEqual(
                  ids(its),
                  ids(entries.filter((entry) => entry.parent.id === parent.id))
                );
                const one = (yield* call("attio.getEntry", {
                  list: "probe_pipeline",
                  id: entries[0]!.id
                })) as { rows: ReadonlyArray<Entry> };
                assert.strictEqual(one.rows[0]?.id, entries[0]!.id);
                const stages =
                  pipeline.attributes.find((attribute) => attribute.slug === "stage")?.options ??
                  [];
                if (stages[0] !== undefined) {
                  const staged = yield* all<Entry>("attio.listEntries", {
                    list: "probe_pipeline",
                    eq: { stage: stages[0] }
                  });
                  assert.deepStrictEqual(
                    ids(staged),
                    ids(entries.filter((entry) => entry.values.stage === stages[0]))
                  );
                }
              }
              // Attio refuses a title it doesn't have, named as the patch's own mistake.
              const failure = yield* refused("attio.listRecords", {
                object: "deals",
                eq: { segment: "No such segment, ever" }
              });
              assert.strictEqual(failure.code, "invalid_request");
              assert.deepStrictEqual(failure.details, {
                object: "deals",
                attribute: "segment",
                operator: "eq",
                reason: "option"
              });
            })
        );

        it.effect("reads a custom object while the workspace's plan keeps them", (ctx) =>
          Effect.gen(function* () {
            const { all, snapshot } = yield* connect;
            if (!snapshot.objects.some((object) => object.slug === "probe_deals"))
              return ctx.skip("No probe_deals: the workspace's plan has no custom objects.");
            const rows = yield* all<Row>("attio.listRecords", { object: "probe_deals" });
            const empty = yield* all<Row>("attio.listRecords", {
              object: "probe_deals",
              eq: { related_deals: null }
            });
            assert.deepStrictEqual(
              ids(empty),
              ids(rows.filter((row) => isEmpty(row.values.related_deals)))
            );
          })
        );
      }
    );
  }
);
