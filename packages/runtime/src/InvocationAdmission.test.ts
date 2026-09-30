import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import { Limits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import { me } from "./me.js";

const viewer = {
  user: { id: "usr_viewer", name: "Viewer", email: "viewer@example.test" },
  company: { id: "cmp_test", name: "Test", handle: "test" },
  admin: false
};
const version: LoadedVersions.LoadedVersion = {
  patchId: "testpatch001",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  companyId: viewer.company.id,
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {}
  },
  scope: "company",
  wireVersion: WIRE_VERSION
};
const request = HttpServerRequest.fromWeb(
  new Request("http://localhost/api/runtime/call", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "x-patchy-wire": String(WIRE_VERSION),
      "x-patchy-principal": JSON.stringify({ userId: viewer.user.id })
    }
  })
);

it.effect(
  "refuses direct primitive operations from a tier 2 document even after rollback to tier 1",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const operations = [
        "tables.list",
        "tables.insert",
        "files.list",
        "shared.list",
        "shared.files.list",
        "shared.files.stat",
        "shared.files.get",
        "postgres.list"
      ];
      const handlers = Object.fromEntries(
        operations.map((op) => [
          op,
          {
            kind: "read" as const,
            run: () =>
              Effect.sync(() => {
                calls++;
                return null;
              })
          }
        ])
      );
      const runtime = yield* Runtime.make(
        { me, ...handlers },
        {
          origin: "http://localhost",
          identity: Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
        }
      );
      for (const op of operations) {
        const error = yield* runtime
          .call({
            patchId: version.patchId,
            versionId: version.versionId,
            wire: WIRE_VERSION,
            principal: { userId: viewer.user.id },
            op,
            args: {}
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "server_required");
      }
      assert.strictEqual(calls, 0);
      assert.deepStrictEqual(
        yield* runtime.call({
          patchId: version.patchId,
          versionId: version.versionId,
          wire: WIRE_VERSION,
          principal: { userId: viewer.user.id },
          op: "me",
          args: {}
        }),
        viewer
      );
    }).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(LoadedVersions.LoadedVersions, {
        find: () => Effect.succeed(Option.some({ ...version, patchTier: 1 }))
      }),
      Effect.provide(Limits.layer)
    )
);

it.effect(
  "a retained tier 1 document gets only me while tier 2 is served, and writes reopen on rollback",
  () =>
    Effect.gen(function* () {
      let patchTier = 2;
      const directWrite = { kind: "mutation" as const, run: () => Effect.succeed({ id: "saved" }) };
      const runtime = yield* Runtime.make(
        { me, "tables.insert": directWrite },
        {
          origin: "http://localhost",
          identity: Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
        }
      ).pipe(
        Effect.provideService(LoadedVersions.LoadedVersions, {
          find: () =>
            Effect.sync(() =>
              Option.some({ ...version, manifest: { ...version.manifest, tier: 1 }, patchTier })
            )
        })
      );
      const call = {
        patchId: version.patchId,
        versionId: version.versionId,
        wire: WIRE_VERSION,
        principal: { userId: viewer.user.id },
        args: {}
      };
      for (const op of [
        "tables.list",
        "tables.insert",
        "files.list",
        "shared.list",
        "shared.files.list",
        "shared.files.stat",
        "shared.files.get",
        "members.list",
        "postgres.query",
        "server.call"
      ]) {
        const error = yield* runtime
          .call({
            patchId: version.patchId,
            versionId: version.versionId,
            wire: WIRE_VERSION,
            principal: { userId: viewer.user.id },
            op,
            args: {}
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "server_required");
      }
      assert.deepStrictEqual(
        yield* runtime.call({
          patchId: version.patchId,
          versionId: version.versionId,
          wire: WIRE_VERSION,
          principal: { userId: viewer.user.id },
          op: "me",
          args: {}
        }),
        viewer
      );
      patchTier = 1;
      assert.deepStrictEqual(yield* runtime.call({ ...call, op: "tables.insert" }), {
        id: "saved"
      });
    }).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provide(Limits.layer)
    )
);

it.effect("reports unavailable host wiring for an admitted server call", () =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.make(
      {},
      {
        origin: "http://localhost",
        identity: Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
      }
    );
    const error = yield* runtime
      .call({
        patchId: version.patchId,
        versionId: version.versionId,
        wire: WIRE_VERSION,
        principal: { userId: viewer.user.id },
        op: "server.call",
        args: { handler: "leads.list", args: {} }
      })
      .pipe(Effect.flip);
    assert.instanceOf(error, Runtime.InvocationUnavailable);
    assert.strictEqual(error.code, "source_unavailable");
    assert.strictEqual(error.status, 503);
    assert.notProperty(error, "cause");
  }).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.provideService(LoadedVersions.LoadedVersions, {
      find: () => Effect.succeed(Option.some({ ...version, patchTier: 2 }))
    }),
    Effect.provide(Limits.layer)
  )
);
