// @effect-diagnostics globalDate:off -- Clerk verifies JWT expiry against Date, independently of Effect's clock.
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { vi } from "vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv, PUBLIC_BASE_URL, signSession, signedInCookies } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { Limits, OperatingLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Invocation from "./Invocation.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as RuntimeProduction from "./RuntimeProduction.js";
import * as StreamAdmission from "./StreamAdmission.js";

const NOW = 1_800_000_000_000;
const liveSession = {
  object: "session",
  id: "sess_offline",
  client_id: "client_offline",
  user_id: DEV_SEED.clerkUserId,
  status: "active",
  actor: null,
  last_active_at: NOW,
  expire_at: NOW + 86_400_000,
  abandon_at: NOW + 86_400_000,
  created_at: NOW - 86_400_000,
  updated_at: NOW
};
class Backend extends Context.Service<
  Backend,
  Ref.Ref<{ readonly status: number; readonly body: Record<string, unknown> }>
>()("RuntimeProductionTest/Backend") {}
class BackendCalls extends Context.Service<BackendCalls, Ref.Ref<number>>()(
  "RuntimeProductionTest/BackendCalls"
) {}

const backend = HttpRouter.serve(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const state = yield* Backend;
      const calls = yield* BackendCalls;
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        "/v1/sessions/sess_offline",
        Effect.gen(function* () {
          yield* Ref.update(calls, (count) => count + 1);
          const reply = yield* Ref.get(state);
          return HttpServerResponse.jsonUnsafe(reply.body, { status: reply.status });
        })
      );
    })
  ),
  { disableLogger: true, disableListenLog: true }
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(Layer.effect(BackendCalls, Ref.make(0))),
  Layer.provideMerge(
    Layer.effect(
      Backend,
      Ref.make<{ readonly status: number; readonly body: Record<string, unknown> }>({
        status: 200,
        body: liveSession
      })
    )
  )
);
const session = Layer.effect(
  Session.Session,
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    if (server.address._tag === "UnixPathAddress")
      return yield* Effect.die("Expected a TCP listener");
    return yield* Session.make.pipe(
      Effect.provideService(Session.backendApiUrl, `http://127.0.0.1:${server.address.port}`)
    );
  })
).pipe(Layer.provideMerge(backend));
const version: LoadedVersions.LoadedVersion = {
  companyId: DEV_SEED.companyId,
  patchId: "runtimepatch",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  scope: "company",
  wireVersion: WIRE_VERSION,
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {}
  }
};
const dependencies = Layer.mergeAll(
  Users.layer,
  Companies.layer,
  OperatingLimits.layer,
  RuntimeLog.layer,
  Limits.layer,
  Layer.succeed(LoadedVersions.LoadedVersions, {
    find: () => Effect.succeed(Option.some({ ...version, patchTier: version.manifest.tier }))
  })
).pipe(
  Layer.provideMerge(session),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);

const admit = Effect.fn("RuntimeProductionTest.admit")(function* (token = signSession()) {
  yield* TestClock.setTime(NOW);
  const captured = yield* Deferred.make<{
    readonly binding: Parameters<Invocation.Invocation["Service"]["call"]>[1];
    readonly reauthorize: Runtime.AdmittedIdentity["reauthorize"];
  }>();
  const runtime = yield* RuntimeProduction.make({}).pipe(
    Effect.provide(StreamAdmission.layer),
    Effect.provideService(Invocation.Invocation, {
      call: (_args, binding, reauthorize) =>
        Deferred.succeed(captured, { binding, reauthorize }).pipe(
          Effect.as({ ok: true as const, value: null })
        )
    })
  );
  yield* runtime
    .call({
      patchId: version.patchId,
      versionId: version.versionId,
      wire: WIRE_VERSION,
      principal: { userId: DEV_SEED.userId },
      op: "server.call",
      args: { handler: "leads.list", args: {} }
    })
    .pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`${PUBLIC_BASE_URL}/api/runtime/call`, {
            method: "POST",
            headers: {
              cookie: signedInCookies(token),
              origin: PUBLIC_BASE_URL,
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": JSON.stringify({ userId: DEV_SEED.userId })
            }
          })
        )
      )
    );
  return yield* Deferred.await(captured);
});

it.effect(
  "shares one post-expiry backend check per invocation while rechecking database authority",
  () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(NOW);
        }),
        () => Effect.sync(() => vi.useRealTimers())
      );
      const token = signSession({ exp: NOW / 1_000 + 60 });
      const { binding, reauthorize } = yield* admit(token);
      assert.deepStrictEqual(binding.identity, {
        user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
        company: {
          id: DEV_SEED.companyId,
          handle: DEV_SEED.companyHandle,
          name: DEV_SEED.companyName
        },
        admin: true
      });
      const calls = yield* BackendCalls;
      yield* TestClock.setTime(NOW + 59_999);
      yield* Effect.all(
        Array.from({ length: 10 }, () => reauthorize),
        { concurrency: "unbounded" }
      );
      assert.strictEqual(yield* Ref.get(calls), 0);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE users SET role = 'member' WHERE id = ${DEV_SEED.userId}`;
      assert.isFalse((yield* reauthorize).admin);
      assert.strictEqual(yield* Ref.get(calls), 0);

      yield* TestClock.setTime(NOW + 60_000);
      yield* Effect.all(
        Array.from({ length: 10 }, () => reauthorize),
        { concurrency: "unbounded" }
      );
      assert.strictEqual(yield* Ref.get(calls), 1);
      vi.setSystemTime(NOW + 120_000);
      yield* TestClock.setTime(NOW + 120_000);
      const auth = yield* Session.Session;
      assert.strictEqual(
        (yield* auth.authenticate(
          new Request(`${PUBLIC_BASE_URL}/api/runtime/call`, {
            headers: { cookie: signedInCookies(token) }
          })
        )).status,
        "signed-out"
      );
      yield* sql`UPDATE users SET role = 'admin' WHERE id = ${DEV_SEED.userId}`;
      assert.isTrue((yield* reauthorize).admin);
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${DEV_SEED.userId}`;
      assert.instanceOf(yield* reauthorize.pipe(Effect.flip), Runtime.AccessDenied);
      assert.strictEqual(yield* Ref.get(calls), 1);

      yield* sql`UPDATE users SET deactivated_at = NULL WHERE id = ${DEV_SEED.userId}`;
      const next = yield* admit(signSession({ exp: NOW / 1_000 + 180 }));
      yield* TestClock.setTime(NOW + 180_000);
      yield* next.reauthorize;
      assert.strictEqual(yield* Ref.get(calls), 2);
    }).pipe(Effect.scoped, Effect.provide(dependencies))
);

it.effect(
  "refuses revoked, replaced, missing and expired live sessions without replaying JWTs",
  () =>
    Effect.gen(function* () {
      const state = yield* Backend;
      for (const change of [
        { status: "revoked" },
        { status: "ended" },
        { user_id: "user_rebound" },
        { id: "sess_rebound" },
        { expire_at: NOW },
        { abandon_at: NOW }
      ]) {
        yield* Ref.set(state, { status: 200, body: { ...liveSession, ...change } });
        const { reauthorize } = yield* admit();
        assert.instanceOf(yield* reauthorize.pipe(Effect.flip), Runtime.SessionExpired);
        assert.instanceOf(yield* reauthorize.pipe(Effect.flip), Runtime.SessionExpired);
      }
      yield* Ref.set(state, {
        status: 404,
        body: { errors: [{ code: "resource_not_found", message: "Session not found" }] }
      });
      const missing = yield* admit();
      assert.instanceOf(yield* missing.reauthorize.pipe(Effect.flip), Runtime.SessionExpired);
      yield* Ref.set(state, {
        status: 401,
        body: { errors: [{ code: "authentication_invalid", message: "Backend unavailable" }] }
      });
      const unavailable = yield* admit();
      assert.instanceOf(
        yield* unavailable.reauthorize.pipe(Effect.flip),
        Runtime.SourceUnavailable
      );
      assert.instanceOf(
        yield* unavailable.reauthorize.pipe(Effect.flip),
        Runtime.SourceUnavailable
      );
      assert.strictEqual(yield* Ref.get(yield* BackendCalls), 8);
    }).pipe(Effect.provide(dependencies))
);

it.effect("refuses a viewer deactivated after invocation admission", () =>
  Effect.gen(function* () {
    const { reauthorize } = yield* admit();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${DEV_SEED.userId}`;
    assert.instanceOf(yield* reauthorize.pipe(Effect.flip), Runtime.AccessDenied);
  }).pipe(Effect.provide(dependencies))
);

it.effect("does not move an invocation to the viewer's new company", () =>
  Effect.gen(function* () {
    const { reauthorize } = yield* admit();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_moved', 'moved', 'Moved')`;
    yield* sql`UPDATE users SET company_id = 'cmp_moved' WHERE id = ${DEV_SEED.userId}`;
    assert.instanceOf(yield* reauthorize.pipe(Effect.flip), Runtime.AccessDenied);
  }).pipe(Effect.provide(dependencies))
);

it.effect("does not rebind an invocation when the Clerk subject resolves to another user", () =>
  Effect.gen(function* () {
    const { reauthorize } = yield* admit();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE users SET clerk_user_id = 'user_replaced', email = 'replaced@example.test'
      WHERE id = ${DEV_SEED.userId}`;
    yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES ('usr_rebound', ${DEV_SEED.clerkUserId}, ${DEV_SEED.companyId},
        ${DEV_SEED.email}, 'Rebound', 'admin')`;
    assert.instanceOf(yield* reauthorize.pipe(Effect.flip), Runtime.AccessDenied);
  }).pipe(Effect.provide(dependencies))
);
