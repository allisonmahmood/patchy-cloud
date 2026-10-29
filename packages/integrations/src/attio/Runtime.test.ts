import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv } from "@patchy/auth/testing";
import { Companies, Directory, Users } from "@patchy/companies";
import { Limits, OperatingLimits } from "@patchy/limits";
import { Binding, InvocationCapabilities, InvocationLog, RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as CompanyTesting from "../../../company-database/src/testing.js";
import type { AttioClient } from "../../../patchy/src/attio.js";
import * as MutationTransaction from "../../../primitives/src/MutationTransaction.js";
import * as QuerySnapshot from "../../../primitives/src/QuerySnapshot.js";
import * as TestWakes from "../../../primitives/src/test/wakes.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as Reads from "../test/attioReads.js";
import * as RuntimeTest from "../test/runtime.js";
import { generate } from "./Generate.js";
import * as Operations from "./Operations.js";
import { NodeCryptography } from "@patchy/core";

/**
 * Attio journeys over answers in the probe's shapes: the generated client calling back through
 * the gateway as a tier 2 action's viewer, and a tier 2 action in real workerd doing the same,
 * both from the packed `patchy` package. The parent's journey: deals by stage and owner, sorted by
 * value, page by page, one opened, its company resolved, its pipeline listed. The same journey
 * against Attio itself is in the live tier (`packages/integrations/live`).
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
/** Text no recent call or log line may ever hold: a filter, a value, an email, Attio's words. */
const SENTINEL = "SENTINEL-attio-9c41";
const { uuid, items, record } = Reads;
const crm = { id: "conn_attio_journey", handle: "journey" };
const uses = { crm: { kind: "attio" as const, ...crm, revision: 1 } };
const owner = uuid(5);

const deals = [1, 2, 3].map((n) =>
  record("deals", uuid(1000 + n), {
    name: [items.text(n === 1 ? SENTINEL : `Deal ${n}`)],
    stage: [items.status("Lead")],
    owner: [items.actor(owner)],
    value: [items.currency(30_000 - n)],
    associated_company: [items.reference("companies", uuid(700 + n))]
  })
);
const routes: ReadonlyArray<Reads.Route> = [
  Reads.route("POST", "/objects/deals/records/query", (sent) => {
    const body = sent.body as { offset: number; limit: number; filter?: unknown };
    if (JSON.stringify(body.filter ?? null).includes("refuse-me"))
      return {
        status: 400,
        body: { code: "validation_type", message: `Bad ${SENTINEL}`, path: ["name"] }
      };
    if (JSON.stringify(body.filter ?? null).includes("garble-me"))
      return { body: { data: [{ id: SENTINEL }] } };
    return { body: { data: deals.slice(body.offset, body.offset + body.limit) } };
  }),
  Reads.route("GET", `/objects/deals/records/${uuid(1001)}`, { body: { data: deals[0] } }),
  Reads.route("POST", "/objects/companies/records/query", {
    body: { data: [record("companies", uuid(701)), record("companies", uuid(702))] }
  }),
  Reads.route("POST", "/lists/pipeline/entries/query", {
    body: { data: [Reads.entry(uuid(800), uuid(1001), { stage: [items.status("Demo")] })] }
  }),
  Reads.route("GET", "/workspace_members", {
    body: {
      data: [
        {
          id: { workspace_id: uuid(9), workspace_member_id: owner },
          first_name: "Ada",
          last_name: "Lovelace",
          avatar_url: null,
          email_address: `${SENTINEL.toLowerCase()}@lumen.example`,
          access_level: "admin",
          created_at: "2026-01-01T00:00:00.000000000Z"
        }
      ]
    }
  })
];

/** The Attio handlers as the server builds them, over the scripted answers, and one connection. */
const handlers = Effect.gen(function* () {
  const attio = Reads.scripted(routes);
  const store = yield* SqlConnectionStore.make.pipe(Effect.provide(attio.layer));
  yield* Reads.seed({ ...who, ...crm });
  const built = yield* Operations.makeHandlers.pipe(
    Effect.provide(Layer.merge(attio.layer, Directory.layer)),
    Effect.provideService(ConnectionStore.ConnectionStore, store)
  );
  return { handlers: built, attio };
});

/** Every recent call and log line, as text, for the sentinel to be looked for in. */
const everything = Effect.fn("AttioJourney.everything")(function* (logs: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly row: string;
  }>`SELECT row_to_json(c)::text AS row FROM runtime_calls c WHERE company_id = ${who.companyId}`;
  return { rows: rows.length, text: [...rows.map((row) => row.row), ...logs].join("\n") };
});

const credentials = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 7).toString("base64")}`)),
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
);

/** The part of the fixture's workspace the journey reads, as generation describes it. */
type Objects = {
  readonly deals: {
    readonly name: { readonly type: "text" };
    readonly stage: { readonly type: "status"; readonly options: "Lead" };
    readonly owner: { readonly type: "actor-reference" };
    readonly value: { readonly type: "currency" };
    readonly associated_company: {
      readonly type: "record-reference";
      readonly targets: "companies";
    };
  };
  readonly companies: { readonly name: { readonly type: "text" } };
};
type Lists = {
  readonly pipeline: {
    readonly parents: "deals";
    readonly attributes: { readonly stage: { readonly type: "status" } };
  };
};
/** The declaration's generated client, bundled from the packed package and loaded as a page does. */
const generatedClient = (call: RuntimeTest.Call) =>
  RuntimeTest.bundle(
    generate({ kind: "attio", ...crm, revision: 1, description: "The CRM" }, Reads.snapshot).client,
    "crm.ts"
  ).pipe(
    Effect.flatMap((code) =>
      Effect.promise(
        () =>
          import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Promise<{
            createClient: (alias: string, call: RuntimeTest.Call) => AttioClient<Objects, Lists>;
          }>
      )
    ),
    Effect.map((module) => module.createClient("crm", call))
  );

const patchId = "attiocallbak";
const versionId = "ver_aaaaaaaaaaaaaaaaaaaaaaaa";
const tier1 = Layer.mergeAll(
  Session.layer,
  WideEvents.layerNoop,
  Companies.layer,
  Users.layer,
  Limits.layer,
  OperatingLimits.layer,
  RuntimeLog.layer,
  credentials,
  RuntimeTest.versions(patchId, versionId, () => uses)
)
  .pipe(
    Layer.provideMerge(Testing.layer()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
  )
  .pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCryptography.layer));

it.layer(tier1)("Attio from a tier 2 action's callbacks", (it) => {
  it.effect(
    "the generated client walks the journey as the viewer, and records no value",
    () => {
      const logs: string[] = [];
      return Effect.gen(function* () {
        const { handlers: built, attio } = yield* handlers;
        const call = yield* RuntimeTest.page(built, patchId, versionId);
        const client = yield* generatedClient(call);
        const deals = client.objects.deals;
        const args = {
          eq: { stage: "Lead", owner },
          orderBy: { attribute: "value" as const, direction: "desc" as const },
          limit: 2
        };
        const first = yield* Effect.promise(() => deals.list(args));
        assert.deepStrictEqual(
          first.rows.map((row) => row.id),
          [uuid(1001), uuid(1002)]
        );
        const second = yield* Effect.promise(() =>
          deals.list({ ...args, cursor: first.cursor ?? undefined })
        );
        assert.deepStrictEqual(
          second.rows.map((row) => row.id),
          [uuid(1003)]
        );
        assert.isNull(second.cursor);
        const deal = (yield* Effect.promise(() => deals.get(uuid(1001))))!;
        assert.deepStrictEqual(deal.values.associated_company, {
          object: "companies",
          id: uuid(701)
        });
        const companies = yield* Effect.promise(() =>
          client.objects.companies.getMany([uuid(702), uuid(709), uuid(701)])
        );
        assert.deepStrictEqual(
          companies.map((row) => row?.id ?? null),
          [uuid(702), null, uuid(701)]
        );
        const entries = yield* Effect.promise(() =>
          client.lists.pipeline.list({ parent: deal.id })
        );
        assert.deepStrictEqual(entries.rows[0]!.parent, { object: "deals", id: uuid(1001) });
        const members = yield* Effect.promise(() => client.members.list());
        assert.isTrue(members[0]!.active);
        // A filter with the sentinel in it, refused by Attio in its own words; and a garbled answer.
        for (const name of [`refuse-me ${SENTINEL}`, `garble-me ${SENTINEL}`]) {
          const failure = yield* Effect.promise(() =>
            deals.list({ eq: { name } }).catch((error: unknown) => error)
          );
          assert.notInclude(JSON.stringify(failure), SENTINEL);
          assert.notInclude(String(failure), SENTINEL);
        }
        // An alias the version doesn't declare, and arguments past the wire, are refused unsent.
        const before = attio.requests.length;
        assert.include(
          yield* Effect.promise(() => call("attio.listMembers", { connection: "nope" })),
          { code: "connection_not_declared" }
        );
        assert.include(
          yield* Effect.promise(() =>
            call("attio.listRecords", {
              connection: "crm",
              object: "deals",
              eq: { name: SENTINEL },
              limit: 0
            })
          ),
          { code: "invalid_request" }
        );
        assert.strictEqual(attio.requests.length, before);

        // Recent calls name the object or list and the rows; nothing holds a value or the key.
        const log = yield* RuntimeLog.RuntimeLog;
        const calls = yield* log.recent({ companyId: who.companyId, connectionId: crm.id });
        assert.includeMembers(
          calls.map((recent) => recent.resource),
          ["deals", "companies", "pipeline", null]
        );
        const seen = yield* everything(logs);
        assert.isAbove(seen.rows, 8);
        assert.notInclude(seen.text, SENTINEL);
        assert.notInclude(seen.text, SENTINEL.toLowerCase());
        assert.notInclude(seen.text, Reads.key);
      }).pipe(
        Effect.provide(
          Logger.layer([Logger.make((event) => void logs.push(JSON.stringify(event.message)))], {
            mergeWithExisting: true
          })
        ),
        Effect.scoped
      );
    },
    60_000
  );
});

const tier2 = Layer.mergeAll(
  RuntimeLog.layer,
  InvocationLog.layer,
  OperatingLimits.layer,
  QuerySnapshot.layer,
  MutationTransaction.layer,
  credentials
).pipe(
  Layer.provideMerge(InvocationCapabilities.layer),
  Layer.provideMerge(CompanyTesting.layer()),
  Layer.provideMerge(TestWakes.layer),
  Layer.provideMerge(FetchHttpClient.layer)
);

const desk = `import { action, createGuest, t } from "patchy/server";
const journey = action({
  args: { stage: t.text(), owner: t.text() },
  result: t.json(),
  handler: async (ctx, { stage, owner }) => {
    const crm = ctx.connections.crm;
    const rows = [];
    let cursor;
    do {
      const page = await crm.objects.deals.list({ eq: { stage, owner }, orderBy: { attribute: "value", direction: "desc" }, limit: 2, cursor });
      rows.push(...page.rows);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    const deal = await crm.objects.deals.get(rows[0].id);
    const companies = await crm.objects.companies.getMany(rows.map((row) => row.values.associated_company.id));
    const entries = await crm.lists.pipeline.list({ parent: deal.id });
    const members = await crm.members.list();
    return { deals: rows.length, opened: deal.id, companies: companies.map((row) => row?.id ?? null), entries: entries.rows.length, members: members.length };
  }
});
const peek = action({ readOnly: true, args: {}, result: t.json(), handler: async (ctx) => (await ctx.connections.crm.members.list()).length });
export default createGuest({ desk: { journey, peek } }, [], {}, [], ["crm"]);
`;

it.layer(tier2, { excludeTestServices: true, timeout: 60_000 })(
  "Attio in a tier 2 action",
  (it) => {
    it.effect(
      "an action in workerd walks the journey through ctx.connections, read-only ones too",
      () =>
        Effect.gen(function* () {
          const { handlers: built } = yield* handlers;
          const binding = Binding.Binding.of({
            companyId: who.companyId,
            patchId: "attiotier2pg",
            versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
            wireVersion: WIRE_VERSION,
            scope: "company",
            correlationId: "attio-tier2",
            principal: { userId: who.userId },
            identity: {
              user: { id: who.userId, name: "Dev", email: "dev@patchy.local" },
              company: { id: who.companyId, name: "Patchy Dev", handle: "patchy-dev" },
              admin: false
            },
            manifest: {
              manifestVersion: 1,
              release: CURRENT_RELEASE,
              tier: 2,
              tables: {},
              files: {},
              uses,
              handlers: {
                "desk.journey": {
                  kind: "action",
                  args: { stage: { kind: "text" }, owner: { kind: "text" } },
                  result: { kind: "json" }
                },
                "desk.peek": { kind: "action", readOnly: true, args: {}, result: { kind: "json" } }
              }
            }
          });
          const invoke = yield* RuntimeTest.invoker(built, binding, desk);
          assert.deepStrictEqual(yield* invoke("desk.journey", { stage: "Lead", owner }), {
            ok: true,
            value: {
              deals: 3,
              opened: uuid(1001),
              companies: [uuid(701), uuid(702), null],
              entries: 1,
              members: 1
            }
          });
          assert.deepStrictEqual(yield* invoke("desk.peek"), { ok: true, value: 1 });
          // Queries and mutations have no connections; the gateway's own test refuses forced calls.
        }),
      60_000
    );
  }
);
