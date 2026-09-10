import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { WIRE_VERSION } from "@patchy/api";
import { PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { DEV_SEED } from "@patchy/auth/seed";
import { client, headers, patchId, versionId, publicVersionId } from "./test/fixtures.js";
import * as Fixtures from "./test/fixtures.js";

it.layer(Fixtures.layer())("runtime HTTP admission", (it) => {
  it.effect(
    "public me returns null without a session and never acts as a signed-in principal",
    () =>
      Effect.gen(function* () {
        const api = yield* client;
        for (const cookie of [undefined, signedInCookies()]) {
          const response = yield* api.call({
            payload: {
              patchId,
              versionId: publicVersionId,
              principal: { userId: "another-user" },
              wire: WIRE_VERSION,
              op: "me",
              args: {}
            },
            headers: {
              ...headers({ userId: "another-user" }),
              ...(cookie === undefined ? {} : { cookie })
            },
            responseMode: "response-only"
          });
          assert.strictEqual(response.status, 200);
          assert.deepStrictEqual(yield* response.json, { ok: true, value: null });
          assert.strictEqual(response.headers["cache-control"], "no-store");
        }
      })
  );

  it.effect(
    "company me requires a session and binds the active viewer rather than the patch owner",
    () =>
      Effect.gen(function* () {
        const api = yield* client;
        const payload = {
          patchId,
          versionId,
          principal: null,
          wire: WIRE_VERSION,
          op: "me" as const,
          args: {}
        };
        const absent = yield* api.call({
          payload,
          headers: headers(),
          responseMode: "response-only"
        });
        assert.include(yield* absent.json, { code: "session_expired" });
        assert.strictEqual(absent.status, 401);
        const expired = yield* api.call({
          payload,
          headers: { ...headers(), cookie: signedInCookies(signSession({ exp: 1 })) },
          responseMode: "response-only"
        });
        assert.include(yield* expired.json, { code: "session_expired" });
        assert.strictEqual(expired.status, 401);
        const response = yield* api.call({
          payload,
          headers: { ...headers(), cookie: signedInCookies() },
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(yield* response.json, {
          ok: true,
          value: {
            user: { id: DEV_SEED.userId, name: "Patchy Dev", email: "dev@patchy.local" },
            company: {
              id: DEV_SEED.companyId,
              handle: DEV_SEED.companyHandle,
              name: DEV_SEED.companyName
            },
            admin: true
          }
        });
        const changed = yield* api.call({
          payload: { ...payload, principal: { userId: "changed" } },
          headers: { ...headers({ userId: "changed" }), cookie: signedInCookies() },
          responseMode: "response-only"
        });
        assert.include(yield* changed.json, { code: "principal_changed" });
        assert.strictEqual(changed.status, 409);
        const mismatched = yield* api.call({
          payload,
          headers: { ...headers({ userId: DEV_SEED.userId }), cookie: signedInCookies() },
          responseMode: "response-only"
        });
        assert.include(yield* mismatched.json, { code: "invalid_request" });
        assert.strictEqual(mismatched.status, 400);
      })
  );

  it.effect(
    "requires both custom headers, matching envelope values, a supported wire and no bearer",
    () =>
      Effect.gen(function* () {
        const api = yield* client;
        const payload = {
          patchId,
          versionId: publicVersionId,
          principal: null,
          wire: WIRE_VERSION,
          op: "me" as const,
          args: {}
        };
        for (const [extra, code] of [
          [{ "x-patchy-principal": "null" }, "invalid_request"],
          [{ "x-patchy-wire": "1" }, "invalid_request"],
          [{ ...headers(), authorization: "Bearer patchy-dev-token" }, "access_denied"]
        ] as const) {
          const response = yield* api.call({
            payload,
            headers: extra,
            responseMode: "response-only"
          });
          assert.include(yield* response.json, { code });
          assert.strictEqual(response.status, code === "access_denied" ? 403 : 400);
        }
        const wire = yield* api.call({
          payload: { ...payload, wire: 2 },
          headers: { ...headers(), "x-patchy-wire": "2" },
          responseMode: "response-only"
        });
        assert.include(yield* wire.json, { code: "shell_outdated" });
        assert.strictEqual(wire.status, 409);
      })
  );

  it.effect(
    "file reads require same-origin fetch metadata and public refusals precede principal checks",
    () =>
      Effect.gen(function* () {
        const api = yield* client;
        const params = {
          patchId,
          versionId: publicVersionId,
          store: "images",
          "*": "folder/photo.png"
        };
        for (const site of [undefined, "cross-site", "same-origin"]) {
          const response = yield* api.getFile({
            params,
            headers: {
              ...headers({ userId: "changed" }),
              cookie: signedInCookies(),
              ...(site === undefined ? {} : { "sec-fetch-site": site })
            },
            responseMode: "response-only"
          });
          assert.include(yield* response.json, {
            code: site === "same-origin" ? "not_available_on_public" : "access_denied"
          });
          assert.strictEqual(response.status, 403);
          assert.strictEqual(response.headers["cache-control"], "no-store");
        }
        const nullPrincipal = yield* api.getFile({
          params: { ...params, versionId },
          headers: { ...headers(), cookie: signedInCookies(), "sec-fetch-site": "same-origin" },
          responseMode: "response-only"
        });
        assert.include(yield* nullPrincipal.json, { code: "principal_changed" });
        assert.strictEqual(nullPrincipal.status, 409);
        const admitted = yield* api.getFile({
          params: { ...params, versionId },
          headers: {
            ...headers({ userId: DEV_SEED.userId }),
            cookie: signedInCookies(),
            "sec-fetch-site": "same-origin"
          },
          responseMode: "response-only"
        });
        assert.include(yield* admitted.json, { code: "invalid_request" });
        assert.strictEqual(admitted.status, 400);
      })
  );

  it.effect("PUT requires the exact shell Origin, never a fetch-metadata fallback", () =>
    Effect.gen(function* () {
      const api = yield* client;
      for (const origin of [undefined, "null", "https://evil.example", PUBLIC_BASE_URL]) {
        const response = yield* api.putFile({
          params: { patchId, versionId: publicVersionId, store: "images", "*": "a.png" },
          payload: new Uint8Array([1]),
          headers: {
            ...headers(),
            "sec-fetch-site": "same-origin",
            ...(origin === undefined ? {} : { origin })
          },
          responseMode: "response-only"
        });
        assert.include(yield* response.json, {
          code: origin === PUBLIC_BASE_URL ? "not_available_on_public" : "access_denied"
        });
        assert.strictEqual(response.status, 403);
      }
    })
  );

  it.effect(
    "refuses unavailable patches, foreign or unregistered viewers and oversized me calls",
    () =>
      Effect.gen(function* () {
        const api = yield* client;
        const payload = {
          patchId,
          versionId,
          principal: null,
          wire: WIRE_VERSION,
          op: "me" as const,
          args: {}
        };
        const missing = yield* api.call({
          payload: { ...payload, patchId: "unknownpatch" },
          headers: headers(),
          responseMode: "response-only"
        });
        assert.include(yield* missing.json, { code: "access_denied" });
        assert.strictEqual(missing.status, 403);
        const unregistered = yield* api.call({
          payload,
          headers: { ...headers(), cookie: signedInCookies(signSession({ sub: "unknown-user" })) },
          responseMode: "response-only"
        });
        assert.include(yield* unregistered.json, { code: "access_denied" });
        assert.strictEqual(unregistered.status, 403);
        const large = yield* api.call({
          payload,
          headers: { ...headers(), "content-length": String(9 * 1024 * 1024) },
          responseMode: "response-only"
        });
        assert.include(yield* large.json, { code: "too_large" });
        assert.strictEqual(large.status, 413);
      })
  );

  it.effect(
    "limits each viewer and patch and returns Retry-After without a read correlation id",
    () =>
      Effect.gen(function* () {
        const api = yield* client;
        yield* TestClock.adjust("1 minute");
        for (let i = 0; i < 3; i++) {
          const admitted = yield* api.call({
            payload: {
              patchId,
              versionId,
              principal: null,
              wire: WIRE_VERSION,
              op: "me",
              args: {}
            },
            headers: { ...headers(), cookie: signedInCookies() },
            responseMode: "response-only"
          });
          assert.strictEqual(admitted.status, 200);
        }
        const response = yield* api.call({
          payload: { patchId, versionId, principal: null, wire: WIRE_VERSION, op: "me", args: {} },
          headers: { ...headers(), cookie: signedInCookies() },
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, 429);
        assert.include(yield* response.json, { code: "rate_limited" });
        assert.notProperty(yield* response.json, "correlationId");
        assert.isAbove(Number(response.headers["retry-after"]), 0);
      })
  );
});

it.effect(
  "company admission refuses foreign and deactivated viewers but admits an active member",
  () =>
    Effect.gen(function* () {
      const api = yield* client;
      for (const sub of ["user_other", "user_inactive"]) {
        const response = yield* api.call({
          payload: { patchId, versionId, principal: null, wire: WIRE_VERSION, op: "me", args: {} },
          headers: {
            ...headers(),
            cookie: signedInCookies(signSession({ sub, email: `${sub.slice(5)}@patchy.local` }))
          },
          responseMode: "response-only"
        });
        assert.include(yield* response.json, { code: "access_denied" });
      }
      const response = yield* api.call({
        payload: {
          patchId,
          versionId,
          principal: { userId: "usr_member" },
          wire: WIRE_VERSION,
          op: "me",
          args: {}
        },
        headers: {
          ...headers({ userId: "usr_member" }),
          cookie: signedInCookies(
            signSession({ sub: "user_member", name: "Member", email: "member@patchy.local" })
          )
        },
        responseMode: "response-only"
      });
      assert.deepStrictEqual(yield* response.json, {
        ok: true,
        value: {
          user: { id: "usr_member", name: "Member", email: "member@patchy.local" },
          company: {
            id: DEV_SEED.companyId,
            handle: DEV_SEED.companyHandle,
            name: DEV_SEED.companyName
          },
          admin: false
        }
      });
    }).pipe(Effect.provide(Fixtures.layer()))
);

it.effect("me rejects arguments outside its operation schema without a log correlation", () =>
  Effect.gen(function* () {
    const api = yield* client;
    const response = yield* api.call({
      payload: {
        patchId,
        versionId,
        principal: null,
        wire: WIRE_VERSION,
        op: "me",
        args: { admin: true }
      },
      headers: { ...headers(), cookie: signedInCookies() },
      responseMode: "response-only"
    });
    assert.include(yield* response.json, { code: "invalid_request" });
    assert.notProperty(yield* response.json, "correlationId");
  }).pipe(Effect.provide(Fixtures.layer()))
);
