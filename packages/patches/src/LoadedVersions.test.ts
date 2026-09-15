import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LoadedVersions as RuntimeLoadedVersions } from "@patchy/runtime";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

it.layer(
  LoadedVersions.layer.pipe(
    Layer.provideMerge(Patches.layer),
    Layer.provideMerge(Fixtures.database)
  )
)("LoadedVersions lifecycle", (it) => {
  it.effect(
    "denies an already-loaded version while off and admits that same version after restore",
    () =>
      Effect.gen(function* () {
        const identity = Fixtures.identities.uploader;
        const actor = { userId: identity.user.id, admin: false };
        const patchId = "loadedstate1";
        const versionId = "ver_loaded_state";
        yield* Fixtures.record({
          ...Fixtures.publishRecord(),
          intent: "create",
          patchId,
          companyId: identity.company.id,
          ownerUserId: identity.user.id,
          versionId,
          machineTokenId: identity.machine.id,
          title: "Loaded state",
          objectKey: `patches/${patchId}/versions/1.html`,
          contentHash: "sha256:loaded-state",
          fileSize: 1,
          filename: null,
          repoOrg: null,
          repoName: null,
          cliVersion: null,
          gitBranch: null,
          gitCommitSha: null,
          sourceIp: null,
          userAgent: null
        });
        const loaded = yield* RuntimeLoadedVersions.LoadedVersions;
        const patches = yield* Patches.Patches;
        const original = Option.getOrThrow(yield* loaded.find(patchId, versionId));
        yield* patches.retire(patchId, actor);
        assert.isTrue(Option.isNone(yield* loaded.find(patchId, versionId)));
        yield* patches.restore(patchId, actor);
        assert.deepStrictEqual(Option.getOrThrow(yield* loaded.find(patchId, versionId)), original);
        yield* patches.delete(patchId, actor);
        assert.isTrue(Option.isNone(yield* loaded.find(patchId, versionId)));
        yield* patches.restore(patchId, actor);
        assert.deepStrictEqual(Option.getOrThrow(yield* loaded.find(patchId, versionId)), original);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${patchId}`;
        assert.isTrue(Option.isNone(yield* loaded.find(patchId, versionId)));
      })
  );
});
