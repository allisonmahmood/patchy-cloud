import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import { Limits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Invocation from "./Invocation.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";

it.effect(
  "machine queries admit only a current company query and retain admission and revocation checks",
  () =>
    Effect.gen(function* () {
      const viewer = {
        user: { id: "usr_reader", name: "Reader", email: "reader@example.test" },
        company: { id: "cmp_test", name: "Test", handle: "test" },
        admin: false
      };
      let active = true;
      let allowed = true;
      let calls = 0;
      let expectedHandler = "queue.blocked";
      let version: LoadedVersions.LoadedVersion & { patchTier: number } = {
        patchId: "launchqueue1",
        versionId: "ver_current",
        companyId: "cmp_test",
        scope: "company",
        wireVersion: WIRE_VERSION,
        patchTier: 2,
        manifest: {
          manifestVersion: 1,
          release: CURRENT_RELEASE,
          tier: 2,
          tables: {},
          files: {},
          uses: {},
          handlers: {
            "queue.blocked": { kind: "query", args: {}, result: { kind: "integer" } },
            "queue.write": { kind: "mutation", args: {}, result: { kind: "integer" } },
            "queue.action": { kind: "action", args: {}, result: { kind: "integer" } }
          }
        }
      };
      const reauthorize = Effect.suspend(() =>
        active ? Effect.succeed(viewer) : Effect.fail(new Runtime.AccessDenied({}))
      );
      const runtime = yield* Runtime.make(
        {},
        {
          origin: "http://localhost",
          identity: Effect.fail(new Runtime.SessionExpired({})),
          bootstrapIdentity: Effect.fail(new Runtime.SessionExpired({})),
          machineIdentity: Effect.succeed({ viewer, reauthorize }),
          admitCompany: () =>
            Effect.suspend(() =>
              allowed ? Effect.void : Effect.fail(new Runtime.AccessDenied({}))
            )
        }
      ).pipe(
        Effect.provideService(LoadedVersions.LoadedVersions, {
          find: (_id, versionId) => {
            assert.strictEqual(versionId, undefined);
            return Effect.succeed(Option.some(version));
          }
        }),
        Effect.provideService(Invocation.Invocation, {
          call: (input, binding, recheck) =>
            Effect.gen(function* () {
              calls++;
              assert.deepStrictEqual(input, {
                handler: expectedHandler,
                args: {},
                ...(expectedHandler === "queue.write" ? { mutationKey: "retained-key" } : {})
              });
              assert.strictEqual(binding.identity?.user.id, viewer.user.id);
              assert.strictEqual(binding.versionId, version.versionId);
              yield* recheck;
              return { ok: true as const, value: 2 };
            })
        })
      );
      const input = { handler: "queue.blocked", args: {} };
      const query = runtime.query(version.patchId, input);
      assert.deepStrictEqual(yield* query, {
        patchId: version.patchId,
        versionId: "ver_current",
        result: { ok: true, value: 2 }
      });
      for (const handler of ["queue.write", "queue.action", "queue.missing", "toString"])
        assert.instanceOf(
          yield* runtime.query(version.patchId, { ...input, handler }).pipe(Effect.flip),
          Runtime.InvalidRequest
        );
      assert.instanceOf(
        yield* runtime
          .query(version.patchId, { ...input, args: { write: true } })
          .pipe(Effect.flip),
        Runtime.InvalidRequest
      );
      const mutation = {
        handler: "queue.write",
        args: {},
        versionId: version.versionId,
        mutationKey: "retained-key"
      };
      expectedHandler = "queue.write";
      assert.deepStrictEqual(yield* runtime.mutation(version.patchId, mutation), {
        patchId: version.patchId,
        versionId: version.versionId,
        result: { ok: true, value: 2 }
      });
      assert.instanceOf(
        yield* runtime
          .mutation(version.patchId, { ...mutation, versionId: "ver_old" })
          .pipe(Effect.flip),
        Runtime.VersionChanged
      );
      for (const handler of ["queue.blocked", "queue.action", "queue.missing", "toString"])
        assert.instanceOf(
          yield* runtime.mutation(version.patchId, { ...mutation, handler }).pipe(Effect.flip),
          Runtime.InvalidRequest
        );
      active = false;
      assert.instanceOf(
        yield* runtime.mutation(version.patchId, mutation).pipe(Effect.flip),
        Runtime.AccessDenied
      );
      active = true;
      version = { ...version, companyId: "cmp_other" };
      assert.instanceOf(yield* query.pipe(Effect.flip), Runtime.AccessDenied);
      assert.instanceOf(
        yield* runtime.mutation(version.patchId, mutation).pipe(Effect.flip),
        Runtime.AccessDenied
      );
      version = { ...version, companyId: "cmp_test", scope: "public" };
      assert.instanceOf(yield* query.pipe(Effect.flip), Runtime.AccessDenied);
      assert.instanceOf(
        yield* runtime.mutation(version.patchId, mutation).pipe(Effect.flip),
        Runtime.AccessDenied
      );
      version = { ...version, scope: "company", manifest: { ...version.manifest, tier: 1 } };
      assert.instanceOf(yield* query.pipe(Effect.flip), Runtime.InvalidRequest);
      version = { ...version, manifest: { ...version.manifest, tier: 2 } };
      active = false;
      assert.instanceOf(yield* query.pipe(Effect.flip), Runtime.AccessDenied);
      active = true;
      allowed = false;
      assert.instanceOf(yield* query.pipe(Effect.flip), Runtime.AccessDenied);
      allowed = true;
      yield* runtime.drain;
      assert.instanceOf(yield* query.pipe(Effect.flip), Runtime.Draining);
      assert.strictEqual(calls, 2);
    }).pipe(
      Effect.provide(Limits.layer),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://localhost/api/patches/launch-queue/query", {
            method: "POST",
            headers: { authorization: "Bearer test" }
          })
        )
      )
    )
);
