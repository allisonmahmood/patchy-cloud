import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { Binding, RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import * as ts from "typescript";
import * as ClientError from "../../../patchy/src/clientError.js";
import * as Store from "../ConnectionStore.js";
import * as SqlStore from "../SqlConnectionStore.js";
import * as Keys from "../CredentialKeys.js";
import * as Nango from "../Nango.js";
import * as Connect from "../NangoConnect.js";
import * as Postgres from "../postgres/Source.js";
import * as PostHogDouble from "../test/posthog.js";
import * as Operations from "./Operations.js";
import { generate } from "./Generate.js";

// Only Nango and Salesforce are simulated. Real SQL, encryption, ownership and runtime handlers.
const upstream = new Map<string, Record<string, string>>();
const requests: Array<{ method: string; path: string; mapping?: string }> = [];
let tags: Record<string, string> = {};
let badResponse: unknown;
let failure = false;
const http = HttpClient.make((request, url) =>
  Effect.sync(() => {
    const target = new URL(url);
    const mapping = request.headers["connection-id"];
    requests.push({
      method: request.method,
      path: target.pathname,
      ...(mapping === undefined ? {} : { mapping })
    });
    assert.equal(request.headers.authorization, "Bearer test-private-nango-key");
    const reply = (body: unknown, status = 200) =>
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" }
        })
      );
    if (target.pathname === "/connect/sessions") {
      assert.equal(request.method, "POST");
      assert.equal(request.body._tag, "Uint8Array");
      if (request.body._tag === "Uint8Array")
        tags = (
          JSON.parse(new TextDecoder().decode(request.body.body)) as {
            tags: Record<string, string>;
          }
        ).tags;
      return reply(
        { data: { connect_link: "http://127.0.0.1:3009/?session_token=single-use" } },
        201
      );
    }
    if (target.pathname === "/connections")
      return reply({
        connections: [...upstream]
          .filter(
            ([, value]) => value.patchy_attempt === target.searchParams.get("tags[patchy_attempt]")
          )
          .map(([connection_id, tags]) => ({
            connection_id,
            provider_config_key: "salesforce",
            provider: "salesforce",
            tags
          }))
      });
    if (request.method === "DELETE") {
      upstream.delete(target.pathname.split("/").at(-1)!);
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
    }
    assert.equal(request.headers["provider-config-key"], "salesforce");
    if (mapping === undefined || !upstream.has(mapping)) return reply({}, 404);
    if (failure) return reply({}, 503);
    if (target.pathname.endsWith("/userinfo"))
      return reply({ organization_id: "00D000000000001AAA" });
    if (target.pathname.endsWith("/sobjects/"))
      return reply({ sobjects: [{ name: "Account", label: "Account", queryable: true }] });
    if (target.pathname.endsWith("/describe"))
      return reply({
        name: "Account",
        fields: [{ name: "Name", label: "Account name", type: "string", nillable: false }]
      });
    return reply(
      badResponse ??
        (target.searchParams.has("q")
          ? {
              records: [{ Id: "001", Name: "First" }],
              done: false,
              totalSize: 2,
              nextRecordsUrl: "/services/data/v61.0/query/locator-200"
            }
          : { records: [{ Id: "002", Name: "Second" }], done: true, totalSize: 2 })
    );
  })
);
const adapter = Layer.effect(Nango.Nango, Nango.make).pipe(
  Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        PATCHY_NANGO_URL: "http://127.0.0.1:3003",
        PATCHY_NANGO_SECRET_KEY: "test-private-nango-key"
      })
    )
  )
);
const fixture = SqlStore.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      adapter,
      RuntimeLog.layer,
      Keys.layerFromKeys(Redacted.make("test:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")),
      PostHogDouble.make(PostHogDouble.project()).layer,
      Layer.succeed(Postgres.Source, {
        test: () => Effect.die("Postgres must not run"),
        inspect: () => Effect.die("Postgres must not run")
      })
    )
  ),
  Layer.provideMerge(Testing.layer())
);
const viewer: RequireSession.Viewer["Service"] = {
  user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
  company: { id: DEV_SEED.companyId, handle: DEV_SEED.companyHandle, name: DEV_SEED.companyName },
  role: "admin",
  whatsNewSeen: 0
};
const binding = (connection: Store.Connection): Binding.Binding["Service"] => ({
  companyId: viewer.company.id,
  patchId: "salesforce01",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 1,
    tables: {},
    files: {},
    uses: {
      crm: {
        kind: "salesforce",
        handle: connection.handle,
        id: connection.id,
        revision: connection.metadataRevision
      }
    }
  },
  wireVersion: WIRE_VERSION,
  scope: "company",
  correlationId: "salesforce-test",
  principal: { userId: viewer.user.id },
  identity: { user: viewer.user, company: viewer.company, admin: true }
});
const connect = Effect.fn(function* (handle: string) {
  const attempt = yield* Connect.begin(viewer, {
    integration: "salesforce",
    handle,
    description: "CRM test data"
  });
  upstream.set(attempt.id, { ...tags }); // Simulated successful OAuth, not a real Salesforce login.
  return { attempt, connection: yield* Connect.finish(viewer, attempt.id) };
});

it.layer(fixture)("Salesforce through the shared Nango adapter", (it) => {
  it.effect("binds completion to the initiating admin, company and one unexpired attempt", () =>
    Effect.gen(function* () {
      const attempt = yield* Connect.begin(viewer, {
        integration: "salesforce",
        handle: "auth-test",
        description: "Test"
      });
      upstream.set(attempt.id, { ...tags });
      const foreign = { ...viewer, company: { ...viewer.company, id: "another-company" } };
      assert.equal(
        (yield* Effect.flip(Connect.finish(foreign, attempt.id))).code,
        "source_unavailable"
      );
      assert.equal(
        (yield* Effect.flip(
          Connect.finish({ ...viewer, user: { ...viewer.user, id: "another-admin" } }, attempt.id)
        )).code,
        "source_unavailable"
      );
      upstream.set(attempt.id, { ...tags, patchy_company: "another-company" });
      assert.equal(
        (yield* Effect.flip(Connect.finish(viewer, attempt.id))).code,
        "source_unavailable"
      );
      upstream.set(attempt.id, { ...tags });
      const connection = yield* Connect.finish(viewer, attempt.id);
      assert.equal(connection.companyId, viewer.company.id);
      assert.equal(
        (yield* Effect.flip(Connect.finish(viewer, attempt.id))).code,
        "source_unavailable"
      );
      yield* (yield* Store.ConnectionStore).delete({
        companyId: viewer.company.id,
        userId: viewer.user.id,
        id: connection.id
      });
      assert.isFalse(upstream.has(attempt.id));
      const expired = yield* Connect.begin(viewer, {
        integration: "salesforce",
        handle: "expired",
        description: "Test"
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE connector_attempts SET expires_at = now() - interval '1 second' WHERE id = ${expired.id}`;
      assert.equal(
        (yield* Effect.flip(Connect.finish(viewer, expired.id))).code,
        "source_unavailable"
      );
      assert.equal(
        (yield* Effect.flip(
          Connect.begin(
            { ...viewer, role: "member" },
            { integration: "salesforce", handle: "member", description: "Test" }
          )
        )).code,
        "source_unavailable"
      );
    })
  );

  it.effect(
    "executes the generated client, validates pagination, isolates ownership and disconnects",
    () =>
      Effect.gen(function* () {
        const { connection, attempt } = yield* connect("runtime-test");
        const store = yield* Store.ConnectionStore;
        const handlers = yield* Operations.makeHandlers;
        const declared = binding(connection);
        const run = (
          op: "salesforce.query" | "salesforce.describe",
          args: unknown,
          as = declared
        ) => handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, as));
        const first = yield* run("salesforce.query", {
          connection: "crm",
          request: { query: "SELECT Id, Name FROM Account" }
        });
        assert.deepEqual(first, {
          ok: true,
          rows: [{ Id: "001", Name: "First" }],
          totalSize: 2,
          cursor: "locator-200"
        });
        assert.deepInclude(
          yield* run("salesforce.query", { connection: "crm", request: { cursor: "locator-200" } }),
          { cursor: null, rows: [{ Id: "002", Name: "Second" }] }
        );
        const snapshot = yield* store.snapshot(viewer.company.id, connection.id, 1);
        assert.equal(snapshot.integration, "salesforce");
        if (snapshot.integration !== "salesforce") return;
        const generated = generate(
          declared.manifest.uses.crm as {
            kind: "salesforce";
            id: string;
            handle: string;
            revision: number;
          },
          snapshot.snapshot
        );
        assert.notInclude(generated.client + generated.context, attempt.id);
        const javascript = ts.transpileModule(generated.client, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        const exports = new Function("exports", "require", `${javascript}\nreturn exports;`)(
          {},
          () => ClientError
        ) as {
          createClient: (
            alias: string,
            call: (
              op: "salesforce.query" | "salesforce.describe",
              args: unknown
            ) => Promise<unknown>
          ) => { describe: (object: string) => Promise<unknown> };
        };
        const described = yield* run("salesforce.describe", {
          connection: "crm",
          object: "Account"
        });
        const description = yield* Effect.promise(() =>
          exports
            .createClient("crm", async (op, args) => {
              assert.equal(op, "salesforce.describe");
              assert.deepEqual(args, { connection: "crm", object: "Account" });
              return described;
            })
            .describe("Account")
        );
        assert.deepInclude(description, {
          object: "Account",
          fields: [{ name: "Name", label: "Account name", type: "string", nillable: false }]
        });
        const count = requests.length;
        assert.equal(
          (yield* Effect.flip(
            run("salesforce.query", {
              connection: "missing",
              request: { query: "SELECT Id FROM Account" }
            })
          )).code,
          "invalid_request"
        );
        assert.equal(
          (yield* Effect.flip(
            run(
              "salesforce.query",
              { connection: "crm", request: { query: "SELECT Id FROM Account" } },
              { ...declared, companyId: "foreign" }
            )
          )).code,
          "access_denied"
        );
        assert.equal(
          (yield* Effect.flip(
            run("salesforce.query", {
              connection: "crm",
              request: { cursor: "https://attacker.test" }
            })
          )).code,
          "invalid_request"
        );
        assert.equal(requests.length, count);
        yield* store.disconnect({
          companyId: viewer.company.id,
          userId: viewer.user.id,
          id: connection.id
        });
        assert.isFalse(upstream.has(attempt.id));
        assert.equal(
          (yield* Effect.flip(
            run("salesforce.query", {
              connection: "crm",
              request: { query: "SELECT Id FROM Account" }
            })
          )).code,
          "access_denied"
        );
        // Authorize again keeps Patchy's connection identity, and needs no new patch declaration.
        const again = yield* Connect.begin(viewer, {
          integration: "salesforce",
          handle: connection.handle,
          description: "Test",
          connectionId: connection.id,
          action: "reconnect"
        });
        upstream.set(again.id, { ...tags });
        assert.equal((yield* Connect.finish(viewer, again.id)).id, connection.id);
        assert.deepInclude(
          yield* run("salesforce.query", { connection: "crm", request: { cursor: "locator-200" } }),
          { cursor: null }
        );
      })
  );

  it.effect(
    "fails provider errors and malformed results without following supplied next URLs",
    () =>
      Effect.gen(function* () {
        const { connection } = yield* connect("failure-test");
        const handlers = yield* Operations.makeHandlers;
        const call = () =>
          handlers["salesforce.query"]
            .run({ connection: "crm", request: { query: "SELECT Id FROM Account" } })
            .pipe(Effect.provideService(Binding.Binding, binding(connection)));
        failure = true;
        assert.equal((yield* Effect.flip(call())).code, "source_unavailable");
        failure = false;
        for (const result of [
          { records: "wrong", done: true, totalSize: 1 },
          {
            records: [],
            done: false,
            totalSize: 2,
            nextRecordsUrl: "https://attacker.test/secrets"
          },
          { records: [], done: false, totalSize: 2 }
        ]) {
          badResponse = result;
          assert.equal((yield* Effect.flip(call())).code, "source_unavailable");
        }
        badResponse = undefined;
      })
  );
});
