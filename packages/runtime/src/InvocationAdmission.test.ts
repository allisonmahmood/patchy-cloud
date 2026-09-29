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
          identity: Effect.succeed(viewer)
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
        find: (_patch, id) =>
          Effect.succeed(
            Option.some(
              id === undefined
                ? { ...version, manifest: { ...version.manifest, tier: 1 } }
                : version
            )
          )
      }),
      Effect.provide(Limits.layer)
    )
);

it.effect("a retained tier 1 document gets only me after tier 2 becomes served", () =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.make(
      { me },
      {
        origin: "http://localhost",
        identity: Effect.succeed(viewer)
      }
    );
    for (const op of [
      "tables.list",
      "files.list",
      "shared.list",
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
  }).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.provideService(LoadedVersions.LoadedVersions, {
      find: (_patch, id) =>
        Effect.succeed(
          Option.some(
            id === undefined ? version : { ...version, manifest: { ...version.manifest, tier: 1 } }
          )
        )
    }),
    Effect.provide(Limits.layer)
  )
);
