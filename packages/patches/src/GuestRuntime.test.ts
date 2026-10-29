import { describe } from "vitest";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";
import {
  RuntimeMe,
  runtimeOperations,
  runtimePrincipal,
  WIRE_VERSION,
  type RuntimeEnvelope,
  type RuntimePrincipal
} from "@patchy/api";
import { Analytics } from "@patchy/analytics";
import { Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Guests, Users } from "@patchy/companies";
import { Limits, OperatingLimits } from "@patchy/limits";
import {
  CompanyAdmission,
  Binding,
  Runtime,
  RuntimeProduction,
  RuntimeLog,
  StreamAdmission,
  me
} from "@patchy/runtime";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const owner = Fixtures.identities.uploader;
const actor = { userId: owner.user.id, admin: false };
const claims = { sub: "clerk_runtime_guest", email: "guest@runtime.example", name: "Real Guest" };
const companyId = owner.company.id;
const dependencies = Layer.mergeAll(
  Patches.layer,
  Session.layer,
  Companies.layer,
  Users.layer,
  RuntimeLog.layer,
  Limits.layer,
  OperatingLimits.layer
).pipe(
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provideMerge(Fixtures.database),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);
const layer = Layer.mergeAll(LoadedVersions.layer, StreamAdmission.layer).pipe(
  Layer.provideMerge(dependencies)
);
const decodeMe = Schema.decodeUnknownSync(RuntimeMe);
const handlers: Record<string, Runtime.Handler> = Object.fromEntries(
  Object.entries(runtimeOperations).map(([op, definition]) => [
    op,
    {
      kind: definition.kind,
      run: () => Effect.die(`Guest operation reached handler: ${op}`)
    }
  ])
);
handlers.me = me;
handlers["future.read"] = { kind: "read", run: () => Effect.die("Unlisted read ran") };

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_runtime_home', 'runtime-home', 'Home')`;
  yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
    VALUES ('usr_runtime_home', ${claims.sub}, 'cmp_runtime_home', ${claims.email}, ${claims.name}, 'admin')`;
  const guest = yield* Guests.create({
    companyId,
    clerkUserId: claims.sub,
    email: claims.email,
    name: claims.name
  });
  const published = yield* Fixtures.record(Fixtures.recordInput(owner));
  const patches = yield* Patches.Patches;
  const grant = yield* patches.grantGuest(published.patchId, guest.id, actor);
  const runtime = yield* RuntimeProduction.make(handlers).pipe(
    Effect.provide(CompanyAdmission.layer)
  );
  return { guest, published, grant, patches, runtime };
});

const call = (
  runtime: Runtime.Runtime["Service"],
  target: { patchId: string; versionId: string },
  op = "me",
  principal: RuntimePrincipal = null,
  headers: Record<string, string> = {},
  input: Partial<RuntimeEnvelope> = {}
) =>
  runtime
    .call({
      ...target,
      op,
      args: {},
      wire: WIRE_VERSION,
      principal,
      ...input
    })
    .pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`${PUBLIC_BASE_URL}/api/runtime/call`, {
            method: "POST",
            headers: {
              cookie: signedInCookies(signSession(claims)),
              origin: PUBLIC_BASE_URL,
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": JSON.stringify(principal),
              ...headers
            }
          })
        )
      )
    );

describe("guest runtime authority", () => {
  it.effect("resolves A's admin as B's guest, with only the explicit identity handshake", () =>
    Effect.gen(function* () {
      const { guest, published, grant, runtime } = yield* setup;
      const identity = decodeMe(yield* call(runtime, published));
      assert.deepStrictEqual(identity, {
        kind: "guest",
        guest: { id: guest.id, email: claims.email, name: claims.name },
        company: { id: companyId },
        patchId: published.patchId,
        versionId: published.versionId,
        grantId: grant.id
      });
      assert.notProperty(identity, "user");
      assert.notProperty(identity, "admin");
      const principal = runtimePrincipal(identity);
      for (const op of [
        ...Object.keys(runtimeOperations),
        "future.read",
        "subscriptions.subscribe",
        "subscriptions.unsubscribe"
      ]) {
        if (op === "me") continue;
        const error = yield* call(runtime, published, op, principal).pipe(Effect.flip);
        assert.instanceOf(error, Runtime.AccessDenied, op);
      }
      // An unrelated company's membership suspension conveys no control over B's grant.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = 'usr_runtime_home'`;
      assert.deepStrictEqual(decodeMe(yield* call(runtime, published, "me", principal)), identity);
      const member = decodeMe(
        yield* call(runtime, published, "me", null, {
          cookie: signedInCookies(
            signSession({
              sub: `clerk_${owner.user.id}`,
              email: owner.user.email,
              name: owner.user.name
            })
          )
        })
      );
      assert.deepStrictEqual(member, { user: owner.user, company: owner.company, admin: false });
    }).pipe(Effect.provide(layer))
  );

  it.effect(
    "keeps an explicitly shared deactivated same-company admin a guest until membership returns",
    () =>
      Effect.gen(function* () {
        const { guest, published, patches, runtime } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const ref = { companyId, clerkUserId: claims.sub };
        yield* Guests.end(ref);
        yield* sql`UPDATE users SET deactivated_at = now(), company_id = ${companyId}
        WHERE id = 'usr_runtime_home'`;
        yield* Guests.reopenForShare(ref);
        const grant = yield* patches.grantGuest(published.patchId, guest.id, actor);
        const identity = decodeMe(yield* call(runtime, published));
        assert.deepStrictEqual(identity, {
          kind: "guest",
          guest: { id: guest.id, email: claims.email, name: claims.name },
          company: { id: companyId },
          patchId: published.patchId,
          versionId: published.versionId,
          grantId: grant.id
        });
        assert.deepStrictEqual(
          yield* sql`SELECT role, deactivated_at IS NOT NULL AS deactivated
        FROM users WHERE id = 'usr_runtime_home'`,
          [{ role: "admin", deactivated: true }]
        );
        yield* sql`UPDATE users SET deactivated_at = NULL WHERE id = 'usr_runtime_home'`;
        assert.instanceOf(
          yield* call(runtime, published, "me", runtimePrincipal(identity)).pipe(Effect.flip),
          Runtime.PrincipalChanged
        );
        assert.include(decodeMe(yield* call(runtime, published)), { admin: true });
        yield* sql`UPDATE users SET deactivated_at = now() WHERE id = 'usr_runtime_home'`;
        assert.instanceOf(yield* call(runtime, published).pipe(Effect.flip), Runtime.AccessDenied);
      }).pipe(Effect.provide(layer))
  );

  it.effect("refuses forged patch, company, guest, grant, principal and browser boundaries", () =>
    Effect.gen(function* () {
      const { published, runtime } = yield* setup;
      const principal = runtimePrincipal(decodeMe(yield* call(runtime, published)));
      if (principal === null || !("guestId" in principal))
        return assert.fail("Expected a guest principal");
      const unrelated = yield* Fixtures.record(Fixtures.recordInput(owner));
      assert.instanceOf(yield* call(runtime, unrelated).pipe(Effect.flip), Runtime.AccessDenied);
      for (const replacement of [
        { guestId: "gst_forged" },
        { grantId: "grt_forged" },
        { companyId: "cmp_runtime_home" },
        { patchId: unrelated.patchId },
        { versionId: unrelated.versionId },
        { userId: "usr_runtime_home" }
      ]) {
        const forged: RuntimePrincipal =
          "userId" in replacement
            ? { userId: replacement.userId! }
            : { ...principal, ...replacement };
        assert.instanceOf(
          yield* call(runtime, published, "me", forged).pipe(Effect.flip),
          Runtime.PrincipalChanged
        );
      }
      assert.instanceOf(
        yield* call(runtime, published, "me", principal, {
          "x-patchy-principal": "null"
        }).pipe(Effect.flip),
        Runtime.InvalidRequest
      );
      const refusedHeaders: Array<Record<string, string>> = [
        { authorization: "Bearer fake" },
        { "x-patchy-wire": "999" },
        { cookie: "" },
        { cookie: signedInCookies(signSession({ ...claims, exp: 1 })) }
      ];
      for (const headers of refusedHeaders) {
        assert.isTrue(
          (yield* call(runtime, published, "me", principal, headers).pipe(Effect.exit))._tag ===
            "Failure"
        );
      }
      assert.instanceOf(
        yield* call(runtime, published, "tables.insert", principal, {
          origin: "https://elsewhere.example"
        }).pipe(Effect.flip),
        Runtime.AccessDenied
      );
      assert.instanceOf(
        yield* call(runtime, published, "principal", principal).pipe(Effect.flip),
        Runtime.AccessDenied
      );
    }).pipe(Effect.provide(layer))
  );

  it.effect(
    "refuses revoked grants, suspended or ended guests, stale versions and non-live patches",
    () =>
      Effect.gen(function* () {
        const { guest, published, grant, patches, runtime } = yield* setup;
        const principal = runtimePrincipal(decodeMe(yield* call(runtime, published)));
        const ref = { companyId, clerkUserId: claims.sub };
        yield* Guests.setDeactivated({ ...ref, deactivated: true });
        assert.instanceOf(
          yield* call(runtime, published, "me", principal).pipe(Effect.flip),
          Runtime.AccessDenied
        );
        yield* Guests.setDeactivated({ ...ref, deactivated: false });
        yield* call(runtime, published, "me", principal);
        yield* patches.revokeGuest(published.patchId, guest.id, actor);
        assert.instanceOf(
          yield* call(runtime, published, "me", principal).pipe(Effect.flip),
          Runtime.AccessDenied
        );
        const fresh = yield* patches.grantGuest(published.patchId, guest.id, actor);
        assert.notStrictEqual(fresh.id, grant.id);
        assert.instanceOf(
          yield* call(runtime, published, "me", principal).pipe(Effect.flip),
          Runtime.PrincipalChanged
        );
        const freshPrincipal = runtimePrincipal(decodeMe(yield* call(runtime, published)));
        const next = yield* Fixtures.record(
          Fixtures.recordInput(owner, {
            intent: "update",
            patchId: published.patchId,
            manifest: { ...Fixtures.manifest, tier: 1 }
          })
        );
        assert.instanceOf(yield* call(runtime, published).pipe(Effect.flip), Runtime.AccessDenied);
        yield* call(runtime, next);
        // The handshake does not expose scripted patches in customer-facing sharing.
        assert.deepStrictEqual(yield* patches.sharedWithGuest(claims.sub, PUBLIC_BASE_URL), []);
        yield* patches.rollback(published.patchId, actor, 1);
        assert.instanceOf(yield* call(runtime, next).pipe(Effect.flip), Runtime.AccessDenied);
        yield* call(runtime, published, "me", freshPrincipal);
        yield* patches.retire(published.patchId, actor);
        assert.instanceOf(yield* call(runtime, published).pipe(Effect.flip), Runtime.AccessDenied);
        yield* patches.restore(published.patchId, actor);
        yield* call(runtime, published);
        yield* Guests.end(ref);
        assert.instanceOf(yield* call(runtime, published).pipe(Effect.flip), Runtime.AccessDenied);
      }).pipe(Effect.provide(layer))
  );

  it.effect(
    "retains real guest and grant attribution after access ends, including an admitted request finishing",
    () =>
      Effect.gen(function* () {
        const { guest, published, grant, patches } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        let correlationId = "";
        const runtime = yield* RuntimeProduction.make({
          ...handlers,
          me: {
            kind: "read",
            run: () =>
              Effect.gen(function* () {
                const binding = yield* Binding.Binding;
                correlationId = binding.correlationId;
                yield* patches.revokeGuest(published.patchId, guest.id, actor).pipe(Effect.orDie);
                yield* Guests.setDeactivated({
                  companyId,
                  clerkUserId: claims.sub,
                  deactivated: true
                }).pipe(Effect.orDie);
                yield* Guests.end({ companyId, clerkUserId: claims.sub }).pipe(Effect.orDie);
                return binding.identity;
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
          }
        }).pipe(Effect.provide(CompanyAdmission.layer));
        const identity = decodeMe(yield* call(runtime, published));
        assert.isTrue(identity !== null && "guest" in identity);
        const log = yield* RuntimeLog.RuntimeLog;
        const retained = yield* log.find({ companyId, correlationId });
        assert.include(retained, {
          userId: null,
          companyId,
          patchId: published.patchId,
          versionId: published.versionId,
          effectivePrincipal: guest.id,
          outcome: "success"
        });
        assert.deepStrictEqual(retained?.guest, { id: guest.id, grantId: grant.id });
        assert.strictEqual((yield* Guests.findById(retained!.guest!.id))?.name, claims.name);
        assert.instanceOf(yield* call(runtime, published).pipe(Effect.flip), Runtime.AccessDenied);
      }).pipe(Effect.provide(layer))
  );
});
