import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type NotionAccess } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { Teams } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { RuntimeLog } from "@patchy/runtime";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Testing from "@patchy/sql/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as AttioSource from "../attio/Source.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as GithubTest from "../test/github.js";
import * as ImapTest from "../test/imap.js";
import * as NotionDouble from "../test/notion.js";
import * as Dev from "./Dev.js";
import * as Operations from "./Operations.js";
import * as Source from "./Source.js";

/**
 * When a published patch's Notion call may reach Notion: only through a connection that is still
 * connected once the call holds its slot. Each case counts what reached the sender.
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const fixture = SqlConnectionStore.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 7).toString("base64")}`)),
      RuntimeLog.layer,
      // Never called: these tests connect only Notion.
      Layer.succeed(
        PostgresSource.Source,
        PostgresSource.Source.of({
          test: () => Effect.die("no Postgres here"),
          inspect: () => Effect.die("no Postgres here")
        })
      ),
      PostHogSource.layer,
      PidgeonSource.layer,
      AttioSource.layer,
      // Connect discovers through the offline workspace.
      NotionDouble.layer,
      ImapTest.offline,
      GithubTest.unconfigured
    )
  ),
  Layer.provideMerge(Teams.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(NodeCryptography.layer)
);

type Viewer = NonNullable<Binding.Binding["Service"]["identity"]>;
const viewer: Viewer = {
  user: { id: who.userId, name: "Dev", email: "dev@patchy.local" },
  company: { id: who.companyId, name: "Patchy Dev", handle: "patchy-dev" },
  admin: false
};
const binding = (connection: ConnectionStore.Connection) =>
  Binding.Binding.of({
    companyId: who.companyId,
    patchId: "notionpatch01",
    versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
    wireVersion: WIRE_VERSION,
    scope: "company",
    correlationId: "notion-test",
    principal: { userId: viewer.user.id },
    identity: viewer,
    reauthorize: Effect.succeed(viewer),
    manifest: {
      manifestVersion: 1,
      release: CURRENT_RELEASE,
      tier: 2,
      tables: {},
      files: {},
      uses: {
        tasks: { kind: "notion", handle: connection.handle, id: connection.id, revision: 1 }
      }
    }
  });

/** Waits, on the real clock, for work a test can't join. */
const eventually = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400; tries++) {
      if (done()) return;
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
    return assert.fail("It never happened.");
  });

let made = 0;
/**
 * A connected Notion connection at `access`, and the handlers over a source with one slot per bot
 * whose sender counts each request and, when `hold` is set, waits for it before answering.
 */
const setup = Effect.fnUntraced(function* (access: NotionAccess = "read") {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name) VALUES ('notionpatch01', ${who.companyId}, ${who.userId}, 'Notion operations', 'notionpatch01') ON CONFLICT (id) DO NOTHING`;
  const store = yield* ConnectionStore.ConnectionStore;
  const connection = yield* store.connect({
    ...who,
    integration: "notion",
    handle: `tasks${++made}`,
    description: "Tasks",
    credentials: Source.connectSecret({ key: NotionDouble.internalToken, access })
  });
  const slots = yield* Source.make.pipe(
    Effect.provideService(ContractLimits.overrides, { "notion.calls.concurrent": 1 }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Sent past the counting sender."))
    )
  );
  const sent: string[] = [];
  const bodies: unknown[] = [];
  const held: { hold?: Deferred.Deferred<void> } = {};
  const source = Source.Source.of({
    ...slots,
    send: (_key, request) =>
      Effect.gen(function* () {
        sent.push(`${request.method} ${request.url}`);
        if (request.body._tag === "Uint8Array") {
          bodies.push(JSON.parse(new TextDecoder().decode(request.body.body)));
        }
        if (held.hold !== undefined) yield* Deferred.await(held.hold);
        if (request.url === `/pages/${pageId}/markdown`) {
          return {
            object: "page_markdown",
            id: pageId,
            markdown: "Original content\n\nHandoff note",
            warnings: [{ code: "unsupported_content", message: "An element was ignored." }]
          };
        }
        return { results: [], has_more: false, next_cursor: null };
      })
  });
  const handlers = yield* Operations.makeHandlers.pipe(
    Effect.provideService(Source.Source, source)
  );
  const call = (op: keyof typeof handlers, args: Record<string, unknown>) =>
    handlers[op]
      .run({ connection: "tasks", ...args })
      .pipe(Effect.provideService(Binding.Binding, binding(connection)));
  const disconnect = store.disconnect({ ...who, id: connection.id });
  const readOnly = store.rotate({
    ...who,
    id: connection.id,
    credentials: Source.changeSecret({ access: "read" })
  });
  return { call, disconnect, readOnly, sent, held, bodies, connection };
});
const pageId = "20000000-0000-4000-8000-000000000001";
const create = { source: "Tasks", properties: { Name: "Review signage" } };

it.layer(fixture)("Notion operations", (it) => {
  it.effect("appends a handoff through the shared connection using a body-only Notion write", () =>
    Effect.gen(function* () {
      const { call, sent, bodies } = yield* setup("write");
      const result = yield* call("notion.appendMarkdown", { id: pageId, markdown: "Handoff note" });
      assert.deepStrictEqual(sent, [`PATCH /pages/${pageId}/markdown`]);
      assert.deepStrictEqual(bodies, [
        {
          type: "insert_content",
          insert_content: { content: "Handoff note" }
        }
      ]);
      assert.deepStrictEqual(result, {
        id: pageId,
        warnings: [{ code: "unsupported_content", message: "An element was ignored." }]
      });
    })
  );

  it.effect("simulates appending with no request to the instance or Notion", () =>
    Effect.gen(function* () {
      const { connection } = yield* setup("write");
      const simulated: Dev.Simulated[] = [];
      const handlers = yield* Dev.handlers(
        { apiUrl: "http://unused.invalid", token: Option.none() },
        {
          tasks: {
            declaration: {
              kind: "notion",
              handle: connection.handle,
              id: connection.id,
              revision: 1
            },
            snapshot: {
              workspace: { id: "workspace", name: "Probe" },
              botId: "bot",
              access: "write",
              dataSources: [],
              exclusions: []
            }
          }
        },
        (entry) => Effect.sync(() => void simulated.push(entry))
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("A simulated write must not reach the network."))
        )
      );
      assert.deepStrictEqual(
        yield* handlers["notion.appendMarkdown"]
          .run({
            connection: "tasks",
            id: pageId,
            markdown: "Private handoff"
          })
          .pipe(Effect.provideService(Binding.Binding, binding(connection))),
        { id: pageId, warnings: [] }
      );
      assert.deepStrictEqual(
        simulated.map(({ summary }) => summary),
        [`notion.appendMarkdown ${pageId}`]
      );
    })
  );

  it.effect("refuses a call through a disconnected connection with nothing sent", () =>
    Effect.gen(function* () {
      const { call, disconnect, sent } = yield* setup();
      yield* call("notion.listPeople", {});
      assert.deepStrictEqual(sent, ["GET /users"]);
      yield* disconnect;
      const refused = yield* call("notion.listPeople", {}).pipe(Effect.flip);
      assert.include(Runtime.toFailure(refused), { code: "access_denied" });
      assert.lengthOf(sent, 1);
    })
  );

  it.effect("refuses a call that waited for its slot while the connection was disconnected", () =>
    Effect.gen(function* () {
      const { call, disconnect, sent, held } = yield* setup();
      held.hold = yield* Deferred.make<void>();
      const holding = yield* call("notion.listPeople", {}).pipe(Effect.forkChild);
      yield* eventually(() => sent.length === 1);
      // The only slot is taken, so this call waits for it.
      const queued = yield* call("notion.listPeople", {}).pipe(Effect.flip, Effect.forkChild);
      yield* disconnect;
      yield* Deferred.succeed(held.hold, undefined);
      yield* Fiber.join(holding);
      assert.include(Runtime.toFailure(yield* Fiber.join(queued)), { code: "access_denied" });
      assert.lengthOf(sent, 1);
    })
  );

  it.effect("refuses a write through a read connection with nothing sent", () =>
    Effect.gen(function* () {
      const { call, sent } = yield* setup("read");
      const refused = yield* call("notion.create", create).pipe(Effect.flip);
      assert.include(Runtime.toFailure(refused), { code: "access_denied" });
      const append = yield* call("notion.appendMarkdown", {
        id: pageId,
        markdown: "Handoff note"
      }).pipe(Effect.flip);
      assert.include(Runtime.toFailure(append), { code: "access_denied" });
      assert.lengthOf(sent, 0);
    })
  );

  it.effect("refuses a write that waited for its slot while the connection became read-only", () =>
    Effect.gen(function* () {
      const { call, readOnly, sent, held } = yield* setup("write");
      held.hold = yield* Deferred.make<void>();
      const holding = yield* call("notion.listPeople", {}).pipe(Effect.forkChild);
      yield* eventually(() => sent.length === 1);
      const queued = yield* call("notion.create", create).pipe(Effect.flip, Effect.forkChild);
      yield* readOnly;
      yield* Deferred.succeed(held.hold, undefined);
      yield* Fiber.join(holding);
      assert.include(Runtime.toFailure(yield* Fiber.join(queued)), { code: "access_denied" });
      assert.deepStrictEqual(sent, ["GET /users"]);
    })
  );

  it("labels a write by its data source, row and property names, never a value", () => {
    assert.strictEqual(
      Operations.recorded.update.resource({
        source: "Tasks",
        id: "20000000-0000-4000-8000-000000000001",
        properties: { Name: "Confidential plan", Status: "Done" }
      }),
      "Tasks · 20000000-0000-4000-8000-000000000001 · Name, Status"
    );
  });

  it("labels a list by its data source and property names, never a value or search text", () => {
    assert.strictEqual(
      Operations.recorded.listRows.resource({
        source: "Tasks",
        eq: { Status: "Confidential plan" },
        contains: { Name: "secret" },
        range: { property: "Due", gte: "2026-01-01" },
        orderBy: { property: "createdTime" },
        select: ["Name"]
      }),
      "Tasks · Status, Name, Due, createdTime"
    );
    assert.isNull(Operations.recorded.search.resource({ text: "secret" }));
  });
});
