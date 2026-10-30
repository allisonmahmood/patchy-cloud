import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type AttioSnapshot } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { Directory } from "@patchy/companies";
import { Binding, Runtime } from "@patchy/runtime/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as Reads from "../test/attioReads.js";
import * as Operations from "./Operations.js";
import { NodeCryptography } from "@patchy/core";

/**
 * Patchy's side of Attio's reads, offline: the requests each operation sends, what it refuses
 * before Attio sees anything, how it reads each answer and refusal in the probe's shapes, and the
 * call's own bounds. Whether Attio answers each encoding exactly is the live tier's.
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const fixture = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 7).toString("base64")}`)),
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
  PidgeonSource.layer
).pipe(Layer.provideMerge(Testing.layer()), Layer.provideMerge(NodeCryptography.layer));

type Viewer = NonNullable<Binding.Binding["Service"]["identity"]>;
const viewer: Viewer = {
  user: { id: who.userId, name: "Dev", email: "dev@patchy.local" },
  company: { id: who.companyId, name: "Patchy Dev", handle: "patchy-dev" },
  admin: false,
  guest: false
};
/** A tier 2 version's binding, declaring `crm` at `revision`, as `viewer`. */
const binding = (
  crm: { readonly id: string; readonly handle: string; readonly revision?: number },
  overrides: Partial<Binding.Binding["Service"]> = {}
) =>
  Binding.Binding.of({
    companyId: who.companyId,
    patchId: "dealpatch0001",
    versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
    wireVersion: WIRE_VERSION,
    scope: "company",
    correlationId: "attio-test",
    principal: { userId: viewer.user.id },
    identity: viewer,
    manifest: {
      manifestVersion: 1,
      release: CURRENT_RELEASE,
      tier: 2,
      tables: {},
      files: {},
      uses: {
        crm: { kind: "attio", handle: crm.handle, id: crm.id, revision: crm.revision ?? 1 },
        warehouse: { kind: "postgres", handle: "warehouse", id: "conn_pg", revision: 1 }
      }
    },
    ...overrides
  });

/** Waits, on the real clock, for work a test can't join, such as a call loading its key. */
const eventually = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400; tries++) {
      if (done()) return;
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
    return assert.fail("It never happened.");
  });

const { uuid, items, record } = Reads;
const deal = (n: number, values: Parameters<typeof record>[2] = {}) =>
  record("deals", uuid(1000 + n), values);
const page = (rows: ReadonlyArray<unknown>) => ({ body: { data: rows } });

let made = 0;
/** An Attio connection seeded with `revisions`, and the handlers over `routes`. */
const setup = (
  routes: ReadonlyArray<Reads.Route> = [],
  options: {
    readonly revisions?: ReadonlyArray<AttioSnapshot>;
    readonly limits?: Parameters<typeof Reads.scripted>[2];
  } = {}
) =>
  Effect.gen(function* () {
    made++;
    const crm = { id: `conn_attio_${made}`, handle: `crm${made}` };
    const attio = Reads.scripted(
      routes,
      options.revisions?.[options.revisions.length - 1],
      options.limits
    );
    const store = yield* SqlConnectionStore.make.pipe(Effect.provide(attio.layer));
    yield* Reads.seed({
      ...who,
      ...crm,
      ...(options.revisions === undefined ? {} : { revisions: options.revisions })
    });
    const handlers = yield* Operations.makeHandlers.pipe(
      Effect.provide(Layer.merge(attio.layer, Directory.layer)),
      Effect.provideService(ConnectionStore.ConnectionStore, store)
    );
    /** One call as the page makes it, through `crm`. */
    const call = (
      op: keyof typeof handlers,
      args: Record<string, unknown>,
      bound: Binding.Binding["Service"] = binding(crm)
    ) =>
      handlers[op]
        .run({ connection: "crm", ...args })
        .pipe(Effect.provideService(Binding.Binding, bound));
    /** The refusal a call answers on the wire. */
    const refused = (
      op: keyof typeof handlers,
      args: Record<string, unknown>,
      bound?: Binding.Binding["Service"]
    ) => call(op, args, bound).pipe(Effect.flip, Effect.map(Runtime.toFailure));
    return { attio, store, crm, call, refused };
  });
it.layer(fixture)("Attio operations, offline", (it) => {
  it.effect("lists deals by stage and owner, sorted by value, page by page", () =>
    Effect.gen(function* () {
      const owner = uuid(5);
      const rows = [1, 2, 3].map((n) =>
        deal(n, {
          name: [items.text(`Deal ${n}`)],
          stage: [items.status("Lead")],
          owner: [items.actor(owner)],
          value: [items.currency(10_000 - n)]
        })
      );
      const { attio, call } = yield* setup([
        Reads.route("POST", "/objects/deals/records/query", (sent) =>
          page(
            rows
              .slice((sent.body as { offset: number }).offset)
              .slice(0, (sent.body as { limit: number }).limit)
          )
        )
      ]);
      const args = {
        object: "deals",
        eq: { stage: "Lead", owner },
        orderBy: { attribute: "value", direction: "desc" },
        limit: 2
      };
      const first = (yield* call("attio.listRecords", args)) as {
        rows: Array<{ id: string; values: Record<string, unknown> }>;
        cursor: string | null;
      };
      assert.deepStrictEqual(
        first.rows.map((row) => row.id),
        [uuid(1001), uuid(1002)]
      );
      assert.deepStrictEqual(first.rows[0]!.values.value, { amount: 9_999, currency: "USD" });
      assert.deepStrictEqual(first.rows[0]!.values.owner, { type: "workspace-member", id: owner });
      assert.isString(first.cursor);
      // The query exactly, and the check beside it with archived attributes.
      assert.deepStrictEqual(attio.queries()[0], {
        method: "POST",
        path: "/v2/objects/deals/records/query",
        query: {},
        body: {
          filter: {
            $and: [
              { stage: "Lead" },
              { owner: { referenced_actor_type: "workspace-member", referenced_actor_id: owner } }
            ]
          },
          sorts: [
            { attribute: "value", field: "currency_value", direction: "desc" },
            { attribute: "record_id", direction: "asc" }
          ],
          limit: 3,
          offset: 0
        },
        authorization: `Bearer ${Reads.key}`
      });
      assert.deepStrictEqual(
        attio.requests
          .filter((sent) => sent.path.endsWith("/attributes"))
          .map((sent) => sent.query),
        [{ show_archived: "true", limit: "500", offset: "0" }]
      );
      const second = (yield* call("attio.listRecords", { ...args, cursor: first.cursor })) as {
        rows: Array<{ id: string }>;
        cursor: string | null;
      };
      assert.deepStrictEqual(
        second.rows.map((row) => row.id),
        [uuid(1003)]
      );
      assert.isNull(second.cursor);
      assert.strictEqual((attio.queries()[1]!.body as { offset: number }).offset, 2);
    })
  );

  it.effect("opens one record, null when it's missing or another object's", () =>
    Effect.gen(function* () {
      const { attio, call } = yield* setup([
        Reads.route("GET", `/objects/deals/records/${uuid(1001)}`, {
          body: { data: deal(1, { name: [items.text("Deal 1")] }) }
        }),
        Reads.route("GET", `/objects/deals/records/${uuid(1009)}`, Reads.refusal(404, "not_found"))
      ]);
      const found = (yield* call("attio.getRecord", {
        object: "deals",
        id: uuid(1001).toUpperCase()
      })) as { rows: Array<{ values: Record<string, unknown> }> };
      assert.lengthOf(found.rows, 1);
      assert.strictEqual(found.rows[0]!.values.name, "Deal 1");
      assert.deepStrictEqual(yield* call("attio.getRecord", { object: "deals", id: uuid(1009) }), {
        ok: true,
        rows: []
      });
      assert.deepStrictEqual(
        attio.queries().map((sent) => `${sent.method} ${sent.path}`),
        [
          `GET /v2/objects/deals/records/${uuid(1001)}`,
          `GET /v2/objects/deals/records/${uuid(1009)}`
        ]
      );
    })
  );

  it.effect("resolves many records in the order asked, duplicates kept, null for missing", () =>
    Effect.gen(function* () {
      const { attio, call, store, crm } = yield* setup([
        Reads.route("POST", "/objects/companies/records/query", () =>
          // Attio answers in id order, without the ids it doesn't have.
          page([record("companies", uuid(701)), record("companies", uuid(703))])
        )
      ]);
      const answer = (yield* call("attio.getManyRecords", {
        object: "companies",
        ids: [uuid(703), uuid(702), uuid(701), uuid(703)]
      })) as { rows: Array<{ id: string } | null> };
      assert.deepStrictEqual(
        answer.rows.map((row) => row?.id ?? null),
        [uuid(703), null, uuid(701), uuid(703)]
      );
      assert.deepStrictEqual(attio.queries()[0]!.body, {
        filter: { record_id: { $in: [uuid(703), uuid(702), uuid(701)] } },
        limit: 3
      });
      // No ids: no call to Attio at all.
      const before = attio.requests.length;
      assert.deepStrictEqual(
        yield* call("attio.getManyRecords", { object: "companies", ids: [] }),
        {
          ok: true,
          rows: []
        }
      );
      assert.strictEqual(attio.requests.length, before);
      // It still answers only for a connection the caller may read.
      yield* store.disconnect({ ...who, id: crm.id });
      assert.include(
        Runtime.toFailure(
          yield* call("attio.getManyRecords", { object: "companies", ids: [] }).pipe(Effect.flip)
        ),
        { code: "access_denied" }
      );
      assert.strictEqual(attio.requests.length, before);
    })
  );

  it.effect("lists a pipeline's entries for one deal, opens one, and lists members", () =>
    Effect.gen(function* () {
      const { attio, call } = yield* setup([
        Reads.route("POST", "/lists/pipeline/entries/query", () =>
          page([Reads.entry(uuid(800), uuid(1001), { stage: [items.status("Demo")] })])
        ),
        Reads.route("GET", `/lists/pipeline/entries/${uuid(800)}`, {
          body: { data: Reads.entry(uuid(800), uuid(1001)) }
        }),
        Reads.route("GET", `/lists/pipeline/entries/${uuid(801)}`, Reads.refusal(404, "not_found")),
        Reads.route("GET", "/workspace_members", {
          body: {
            data: [
              {
                id: { workspace_id: uuid(9), workspace_member_id: uuid(5) },
                first_name: "Ada",
                last_name: "Lovelace",
                avatar_url: "https://example.com/ada.png",
                email_address: "ada@lumen.example",
                access_level: "admin",
                created_at: "2026-01-01T00:00:00.000000000Z"
              },
              {
                id: { workspace_id: uuid(9), workspace_member_id: uuid(6) },
                first_name: "Sam",
                last_name: "Okafor",
                avatar_url: null,
                email_address: "sam@lumen.example",
                access_level: "suspended",
                created_at: "2026-01-01T00:00:00.000000000Z"
              }
            ]
          }
        })
      ]);
      const entries = (yield* call("attio.listEntries", {
        list: "pipeline",
        parent: uuid(1001),
        eq: { stage: "Demo" },
        orderBy: { attribute: "entered_on", direction: "desc" }
      })) as { rows: Array<{ parent: unknown; values: Record<string, unknown> }>; cursor: unknown };
      assert.deepStrictEqual(entries.rows[0]!.parent, { object: "deals", id: uuid(1001) });
      assert.strictEqual(entries.rows[0]!.values.stage, "Demo");
      assert.isNull(entries.cursor);
      assert.deepStrictEqual(attio.queries()[0]!.body, {
        filter: { $and: [{ stage: "Demo" }, { parent_record: { target_record_id: uuid(1001) } }] },
        sorts: [
          { attribute: "entered_on", direction: "desc" },
          { attribute: "entry_id", direction: "asc" }
        ],
        limit: 101,
        offset: 0
      });
      const one = (yield* call("attio.getEntry", { list: "pipeline", id: uuid(800) })) as {
        rows: ReadonlyArray<unknown>;
      };
      assert.lengthOf(one.rows, 1);
      assert.deepStrictEqual(yield* call("attio.getEntry", { list: "pipeline", id: uuid(801) }), {
        ok: true,
        rows: []
      });
      assert.deepStrictEqual(yield* call("attio.listMembers", {}), {
        ok: true,
        rows: [
          { id: uuid(5), name: "Ada Lovelace", email: "ada@lumen.example", active: true },
          { id: uuid(6), name: "Sam Okafor", email: "sam@lumen.example", active: false }
        ]
      });
    })
  );

  it.effect(
    "reads `null` on a select by the options Attio has now, and checks every row empty",
    () =>
      Effect.gen(function* () {
        // The snapshot knew SMB and Enterprise; Attio has Strategic too now.
        const now: AttioSnapshot = {
          ...Reads.snapshot,
          objects: Reads.snapshot.objects.map((object) =>
            object.slug !== "deals"
              ? object
              : {
                  ...object,
                  attributes: object.attributes.map((attribute) =>
                    attribute.slug === "segment"
                      ? { ...attribute, options: ["SMB", "Enterprise", "Strategic"] }
                      : attribute
                  )
                }
          )
        };
        let answer: ReadonlyArray<unknown> = [deal(1)];
        const { attio, call, refused } = yield* setup(
          [Reads.route("POST", "/objects/deals/records/query", () => page(answer))],
          { revisions: [Reads.snapshot, now] }
        );
        const bound = binding({ id: `conn_attio_${made}`, handle: `crm${made}` });
        yield* call("attio.listRecords", { object: "deals", eq: { segment: null } }, bound);
        const sentOrder = attio.requests.map((sent) => sent.path);
        // The options were read before the query, which excludes each of them.
        assert.isTrue(
          sentOrder.indexOf("/v2/objects/deals/attributes/segment/options") <
            sentOrder.indexOf("/v2/objects/deals/records/query")
        );
        assert.deepStrictEqual((attio.queries()[0]!.body as { filter: unknown }).filter, {
          $and: [
            { $not: { segment: "SMB" } },
            { $not: { segment: "Enterprise" } },
            { $not: { segment: "Strategic" } }
          ]
        });
        // A row Attio answered with a value, from an option added meanwhile, fails the whole call.
        answer = [deal(1, { segment: [items.select("Brand new")] })];
        assert.deepStrictEqual(
          yield* refused("attio.listRecords", { object: "deals", eq: { segment: null } }, bound),
          {
            ok: false,
            source: "patchy",
            code: "source_unavailable",
            error:
              "Attio's attribute segment on object deals changed while Patchy read it. Try again."
          }
        );
      })
  );

  it.effect("refuses before Attio sees anything", () =>
    Effect.gen(function* () {
      const { attio, crm, refused } = yield* setup();
      const cases: ReadonlyArray<
        readonly [
          string,
          keyof typeof Operations.operations | `attio.${string}`,
          Record<string, unknown>,
          Record<string, unknown>,
          Binding.Binding["Service"]?
        ]
      > = [
        [
          "an undeclared alias",
          "attio.listMembers",
          { connection: "nope" },
          { code: "connection_not_declared" }
        ],
        [
          "another integration's alias",
          "attio.listMembers",
          { connection: "warehouse" },
          { code: "connection_not_declared" }
        ],
        [
          "an unknown object",
          "attio.listRecords",
          { object: "invoices" },
          { code: "invalid_request", details: { object: "invoices", reason: "unknown" } }
        ],
        [
          "an unknown list",
          "attio.getEntry",
          { list: "nope", id: uuid(1) },
          { code: "invalid_request", details: { list: "nope", reason: "unknown" } }
        ],
        [
          "an unknown attribute",
          "attio.listRecords",
          { object: "deals", eq: { nope: 1 } },
          {
            code: "invalid_request",
            details: { object: "deals", attribute: "nope", operator: "eq", reason: "unknown" }
          }
        ],
        [
          "an operator the type doesn't take",
          "attio.listRecords",
          { object: "deals", contains: { amount: "5" } },
          {
            code: "invalid_request",
            details: {
              object: "deals",
              attribute: "amount",
              operator: "contains",
              reason: "unsupported"
            }
          }
        ],
        [
          "null on a checkbox",
          "attio.listRecords",
          { object: "deals", eq: { is_hot: null } },
          { code: "invalid_request" }
        ],
        [
          "null on a location",
          "attio.listRecords",
          { object: "deals", eq: { hq_location: null } },
          { code: "invalid_request" }
        ],
        [
          "over 100 values",
          "attio.listRecords",
          { object: "deals", eq: { name: Array.from({ length: 101 }, (_, n) => `d${n}`) } },
          { code: "invalid_request" }
        ],
        [
          "a date-only timestamp",
          "attio.listRecords",
          { object: "deals", range: { attribute: "created_at", gte: "2026-01-01" } },
          {
            code: "invalid_request",
            details: {
              object: "deals",
              attribute: "created_at",
              operator: "range",
              reason: "timestamp"
            }
          }
        ],
        [
          "a foreign cursor",
          "attio.listRecords",
          { object: "deals", cursor: "eyJ2IjoxLCJvZmZzZXQiOjEwMCwiYmluZGluZyI6Im90aGVyIn0" },
          { code: "invalid_cursor" }
        ],
        [
          "over 500 ids",
          "attio.getManyRecords",
          { object: "deals", ids: Array.from({ length: 501 }, (_, n) => uuid(n)) },
          { code: "invalid_request" }
        ],
        [
          "an ambiguous bare id",
          "attio.listRecords",
          { object: "deals", eq: { counterparty: uuid(1) } },
          {
            code: "invalid_request",
            details: {
              object: "deals",
              attribute: "counterparty",
              operator: "eq",
              reason: "target"
            }
          }
        ],
        [
          "a limit past 500",
          "attio.listRecords",
          { object: "deals", limit: 501 },
          { code: "invalid_request" }
        ],
        ["an extra key", "attio.listMembers", { anything: true }, { code: "invalid_request" }],
        [
          "a public page",
          "attio.listMembers",
          {},
          { code: "access_denied" },
          binding(crm, { scope: "public", identity: null, principal: null })
        ],
        [
          "another company's viewer",
          "attio.listMembers",
          {},
          { code: "access_denied" },
          binding(crm, { identity: { ...viewer, company: { ...viewer.company, id: "cmp_other" } } })
        ]
      ];
      for (const [label, op, args, expected, bound] of cases) {
        const failure = yield* refused(op as never, { connection: "crm", ...args }, bound);
        for (const [key, value] of Object.entries(expected))
          assert.deepStrictEqual((failure as Record<string, unknown>)[key], value, label);
      }
      assert.lengthOf(attio.requests, 0);
    })
  );

  it.effect("puts each of Attio's refusals as the wire says, naming only snapshot slugs", () =>
    Effect.gen(function* () {
      let answer: Reads.Answer = { body: { data: [] } };
      const { refused, call } = yield* setup([
        Reads.route("POST", "/objects/deals/records/query", () => answer),
        Reads.route("GET", "/workspace_members", () => answer)
      ]);
      const list = (eq: Record<string, unknown> = { stage: "Lead" }) =>
        refused("attio.listRecords", { object: "deals", eq });
      const cases: ReadonlyArray<readonly [Reads.Answer, Record<string, unknown>]> = [
        [
          Reads.refusal(401, "unauthorized"),
          {
            code: "source_unavailable",
            error: "Attio no longer accepts this connection's key. Replace the key."
          }
        ],
        [
          Reads.refusal(403, "unauthorized"),
          { code: "access_denied", details: { scope: "record_permission:read" } }
        ],
        [Reads.refusal(404, "not_found"), { code: "not_found", details: { object: "deals" } }],
        [Reads.refusal(404, "merge_in_progress"), { code: "source_unavailable" }],
        [
          Reads.refusal(400, "standard_object_disabled"),
          { code: "not_found", details: { object: "deals" } }
        ],
        [
          Reads.refusal(400, "unknown_filter_attribute_slug", ["stage"]),
          {
            code: "shape_mismatch",
            details: { object: "deals", attribute: "stage", reason: "missing" }
          }
        ],
        [
          Reads.refusal(400, "unknown_filter_object_slug", ["associated_company"]),
          {
            code: "shape_mismatch",
            details: { object: "deals", attribute: "associated_company", reason: "target" }
          }
        ],
        [
          Reads.refusal(400, "unknown_filter_status_slug", ["stage"]),
          {
            code: "invalid_request",
            details: { object: "deals", attribute: "stage", operator: "eq", reason: "option" }
          }
        ],
        [
          Reads.refusal(400, "unknown_filter_select_option_slug", ["Lead"]),
          {
            code: "invalid_request",
            details: { object: "deals", operator: "eq", reason: "option" }
          }
        ],
        [
          Reads.refusal(400, "validation_type", ["stage"]),
          {
            code: "invalid_request",
            details: { object: "deals", attribute: "stage", reason: "attio" }
          }
        ],
        [
          Reads.refusal(400, "invalid_filter_operator"),
          { code: "invalid_query", details: { object: "deals", reason: "invalid_filter_operator" } }
        ],
        [Reads.refusal(400, "filter_error"), { code: "invalid_query" }],
        // A code Patchy doesn't know is never repeated.
        [
          Reads.refusal(400, "review_private_sentinel"),
          { code: "invalid_query", details: { object: "deals", reason: "unknown" } }
        ],
        [
          {
            ...Reads.refusal(429, "rate_limit_exceeded"),
            headers: { "retry-after": new Date(-5_000).toUTCString() }
          },
          { code: "source_rate_limited", retryAfter: 1 }
        ],
        [Reads.refusal(500, "internal"), { code: "source_unavailable" }],
        [
          new Response("<html>502 Bad Gateway</html>", {
            status: 502,
            headers: { "content-type": "text/html" }
          }),
          { code: "source_unavailable" }
        ],
        [
          new Response("<html>400</html>", {
            status: 400,
            headers: { "content-type": "text/html" }
          }),
          { code: "source_unavailable" }
        ],
        [{ body: { data: [{ id: "not a record" }] } }, { code: "source_unavailable" }],
        [{ body: "not json at all" }, { code: "source_unavailable" }]
      ];
      for (const [given, expected] of cases) {
        answer = given;
        const failure = yield* list();
        for (const [key, value] of Object.entries(expected))
          assert.deepStrictEqual(
            (failure as Record<string, unknown>)[key],
            value,
            JSON.stringify(expected)
          );
        // Never Attio's words.
        assert.notInclude(JSON.stringify(failure), "Attio's own words");
      }
      answer = Reads.refusal(403, "unauthorized");
      assert.deepStrictEqual(
        ((yield* refused("attio.listMembers", {})) as { details?: unknown }).details,
        { scope: "user_management:read" }
      );
      answer = { body: { data: [] } };
      assert.deepStrictEqual(yield* call("attio.listRecords", { object: "deals" }), {
        ok: true,
        rows: [],
        cursor: null
      });
    })
  );

  it.effect("fails shape_mismatch on a changed attribute, whether or not any row came back", () =>
    Effect.gen(function* () {
      const change = (
        slug: string,
        attribute: Partial<AttioSnapshot["objects"][number]["attributes"][number]> | null
      ): AttioSnapshot => ({
        ...Reads.snapshot,
        objects: Reads.snapshot.objects.map((object) =>
          object.slug !== "deals"
            ? object
            : {
                ...object,
                attributes: object.attributes.flatMap((item) =>
                  item.slug !== slug
                    ? [item]
                    : attribute === null
                      ? []
                      : [{ ...item, ...attribute }]
                )
              }
        )
      });
      for (const [label, current, details, answered] of [
        ["gone", change("amount", null), { attribute: "amount", reason: "missing" }, []],
        [
          "retyped",
          change("amount", { type: "text" }),
          { attribute: "amount", reason: "type" },
          [deal(1)]
        ],
        [
          "made multi",
          change("segment", { multiselect: true }),
          { attribute: "segment", reason: "multiselect" },
          []
        ],
        [
          "renamed",
          change("amount", { slug: "deal_amount" }),
          { attribute: "amount", reason: "renamed", renamedTo: "deal_amount" },
          [deal(1)]
        ]
      ] as const) {
        // The workspace as Attio has it now; the connection's snapshot is as it was.
        const { refused } = yield* setup(
          [Reads.route("POST", "/objects/deals/records/query", page(answered))],
          { revisions: [Reads.snapshot, current] }
        );
        const failure = yield* refused(
          "attio.listRecords",
          { object: "deals" },
          binding({ id: `conn_attio_${made}`, handle: `crm${made}`, revision: 1 })
        );
        assert.strictEqual(failure.code, "shape_mismatch", label);
        assert.deepStrictEqual(failure.details, { object: "deals", ...details }, label);
      }
      // A reference to an object by a slug the snapshot doesn't know: its target was renamed.
      const { refused } = yield* setup([
        Reads.route(
          "POST",
          "/objects/deals/records/query",
          page([deal(1, { associated_company: [items.reference("organisations", uuid(700))] })])
        ),
        Reads.route(
          "POST",
          "/lists/pipeline/entries/query",
          page([Reads.entry(uuid(800), uuid(3), {}, "people")])
        )
      ]);
      assert.deepStrictEqual((yield* refused("attio.listRecords", { object: "deals" })).details, {
        object: "deals",
        attribute: "associated_company",
        reason: "target"
      });
      // An entry on a record of an object the list didn't have.
      assert.deepStrictEqual((yield* refused("attio.listEntries", { list: "pipeline" })).details, {
        list: "pipeline",
        reason: "parent"
      });
    })
  );

  it.effect("refuses answers past the call's raw bytes or the decoded bound", () =>
    Effect.gen(function* () {
      const wide = "x".repeat(20_000);
      const { refused } = yield* setup([
        Reads.route(
          "POST",
          "/objects/deals/records/query",
          () =>
            new Response("{}", {
              headers: {
                "content-type": "application/json",
                "content-length": String(17 * 1024 ** 2)
              }
            })
        ),
        Reads.route("POST", "/objects/companies/records/query", () =>
          page(
            Array.from({ length: 450 }, (_, n) =>
              record("companies", uuid(2000 + n), { name: [items.text(wide)] })
            )
          )
        )
      ]);
      assert.deepStrictEqual(yield* refused("attio.listRecords", { object: "deals" }), {
        ok: false,
        source: "patchy",
        code: "too_large",
        error:
          "Attio's answer is larger than the 16 MiB Patchy reads in one call. Ask for a smaller limit: wide objects page smaller.",
        limitId: "attio.call.bytes",
        details: { maxBytes: 16 * 1024 ** 2 }
      });
      const decoded = yield* refused("attio.getManyRecords", {
        object: "companies",
        ids: Array.from({ length: 450 }, (_, n) => uuid(2000 + n))
      });
      assert.strictEqual(decoded.code, "too_large");
      assert.include(decoded.error, "Ask for fewer ids at once.");
      assert.deepStrictEqual(decoded.details, { maxBytes: 8 * 1024 ** 2 });
      // One record asked 500 times is counted 500 times, before the answer is built.
      const repeated = yield* refused("attio.getManyRecords", {
        object: "companies",
        ids: Array.from({ length: 500 }, () => uuid(2000))
      });
      assert.include(repeated, { code: "too_large", limitId: "runtime.result.bytes" });
    })
  );

  it.effect("holds a call's requests together to one raw budget, however many run at once", () =>
    Effect.gen(function* () {
      // The query and the check, each 9 MiB and under the bound alone, read at the same time.
      const pad = " ".repeat(9 * 1024 ** 2);
      const { refused } = yield* setup([
        Reads.route(
          "GET",
          "/objects/deals/attributes",
          () =>
            new Response(
              `{"data":${JSON.stringify(Reads.currentAttributes(Reads.snapshot.objects[0]!.attributes))}${pad}}`,
              { headers: { "content-type": "application/json" } }
            )
        ),
        Reads.route(
          "POST",
          "/objects/deals/records/query",
          () =>
            new Response(`{"data":[]${pad}}`, { headers: { "content-type": "application/json" } })
        )
      ]);
      assert.include(yield* refused("attio.listRecords", { object: "deals" }), {
        code: "too_large",
        limitId: "attio.call.bytes"
      });
    })
  );

  it("records the object or list a call names, only shaped as a slug, never a value", () => {
    assert.strictEqual(Operations.recorded.listRecords.resource({ object: "deals" }), "deals");
    assert.strictEqual(
      Operations.recorded.getEntry.resource({ list: "sales_pipeline" }),
      "sales_pipeline"
    );
    for (const args of [
      { object: "person@example.invalid" },
      { object: "Probe deal 0001" },
      { list: "deals" },
      { object: 7 },
      "deals"
    ])
      assert.isNull(Operations.recorded.listRecords.resource(args), JSON.stringify(args));
    assert.isNull(Operations.recorded.listMembers.resource({ object: "deals" }));
    assert.strictEqual(
      Operations.recorded.getManyRecords.rowCount({ ok: true, rows: [{}, null, {}] }),
      2
    );
  });

  it.effect(
    "rechecks the viewer and the connection once a queued call holds its slot, and times out",
    () =>
      Effect.gen(function* () {
        const members = { body: { data: [] } };
        const { attio, call, crm, store } = yield* setup(
          [Reads.route("GET", "/workspace_members", members)],
          { limits: { "attio.calls.concurrent": 1 } }
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
          VALUES ('usr_attio_queued', 'user_attio_queued', ${who.companyId}, 'queued@acme.example',
            'Queued', 'member')`;
        const queued: Viewer = {
          ...viewer,
          user: { id: "usr_attio_queued", name: "Queued", email: "queued@acme.example" }
        };
        const isMembers = (sent: Reads.Sent) => sent.path === "/v2/workspace_members";
        const release = yield* Deferred.make<void>();
        attio.hold(isMembers, release);
        const running = yield* call("attio.listMembers", {}).pipe(Effect.forkChild);
        yield* eventually(() => attio.requests.length === 1);
        // A full gate past the caller's deadline is busy, with nothing sent.
        const busy = yield* call("attio.listMembers", {}, binding(crm, { deadline: 2_000 })).pipe(
          Effect.flip,
          Effect.forkChild
        );
        yield* TestClock.adjust("1 second");
        assert.include(Runtime.toFailure(yield* Fiber.join(busy)), { code: "busy" });
        // A viewer deactivated while their call waits sends nothing.
        const byQueued = yield* call(
          "attio.listMembers",
          {},
          binding(crm, { identity: queued, principal: { userId: queued.user.id } })
        ).pipe(Effect.flip, Effect.forkChild);
        yield* sql`UPDATE users SET deactivated_at = now() WHERE id = 'usr_attio_queued'`;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        assert.include(Runtime.toFailure(yield* Fiber.join(byQueued)), { code: "access_denied" });
        assert.lengthOf(attio.requests, 1);
        // So does one whose connection was disconnected while it waited.
        const again = yield* Deferred.make<void>();
        attio.hold(isMembers, again);
        const holding = yield* call("attio.listMembers", {}).pipe(Effect.forkChild);
        yield* eventually(() => attio.requests.length === 2);
        const afterDisconnect = yield* call("attio.listMembers", {}).pipe(
          Effect.flip,
          Effect.forkChild
        );
        yield* store.disconnect({ ...who, id: crm.id });
        yield* Deferred.succeed(again, undefined);
        yield* Fiber.join(holding);
        assert.include(Runtime.toFailure(yield* Fiber.join(afterDisconnect)), {
          code: "access_denied"
        });
        assert.lengthOf(attio.requests, 2);
        // A call Attio doesn't answer within the service deadline times out.
        const slow = yield* setup([Reads.route("GET", "/workspace_members", members)]);
        const never = yield* Deferred.make<void>();
        slow.attio.hold(isMembers, never);
        const late = yield* slow.refused("attio.listMembers", {}).pipe(Effect.forkChild);
        yield* eventually(() => slow.attio.requests.length === 1);
        yield* TestClock.adjust("16 seconds");
        assert.include(yield* Fiber.join(late), { code: "timeout" });
      })
  );
});
