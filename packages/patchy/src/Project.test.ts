import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PatchDetail } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Instance from "./Instance.js";
import * as Project from "./Project.js";

const apiUrl = "http://sync.test";
const patchId = "abcdefghijkl";
const encodeDetail = Schema.encodeSync(PatchDetail);
const stamp = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;

/**
 * Sync a repo whose patchy.json holds `repo` against an instance whose detail
 * reports `cloud`; returns the result, the file afterwards and the requests made.
 */
const sync = Effect.fn("test.Project.sync")(function* (
  repo: { readonly description?: string; readonly descriptionSyncedAt?: string | null },
  cloud: { readonly description: string; readonly descriptionUpdatedAt: string | null }
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-sync-" });
  const repoFile = path.join(root, "patchy.json");
  yield* fs.writeFileString(
    repoFile,
    JSON.stringify({ instance: apiUrl, patch: patchId, ...repo, custom: { keep: true } })
  );
  const requests: string[] = [];
  const detail = new PatchDetail({
    id: patchId,
    name: "synced",
    address: `${apiUrl}/company/synced`,
    owner: { id: "usr_owner", name: "Owner", deactivated: false },
    mine: true,
    tier: 1,
    scope: "company",
    ...cloud,
    state: "live",
    retiredAt: null,
    deletedAt: null,
    purgeAt: null,
    currentVersion: 1,
    publishedAt: stamp(1),
    title: "Synced",
    inventory: { tables: [], stores: [] },
    reads: []
  });
  const client = HttpClient.make((request) => {
    requests.push(request.url);
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(encodeDetail(detail))));
  });
  const result = yield* Project.syncDescription(root, Redacted.make("sync-token")).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(Instance.Instance, { apiUrl, source: "env", token: Option.none() })
  );
  const saved: unknown = JSON.parse(yield* fs.readFileString(repoFile));
  return { ...result, saved, requests };
});

it.layer(NodeServices.layer)("Project.syncDescription", (it) => {
  it.effect("pulls a newer cloud description over local text and records its stamp", () =>
    Effect.gen(function* () {
      const cloud = { description: "Portal text", descriptionUpdatedAt: stamp(15) };
      for (const syncedAt of [stamp(14), null, undefined]) {
        const { repo, warnings, saved, requests } = yield* sync(
          {
            description: "Local text",
            ...(syncedAt === undefined ? {} : { descriptionSyncedAt: syncedAt })
          },
          cloud
        );
        assert.deepStrictEqual(requests, [`${apiUrl}/api/patches/${patchId}`]);
        assert.deepStrictEqual(warnings, [
          "The description was changed in the portal to 'Portal text'; check it (replaced local description: 'Local text')."
        ]);
        assert.deepStrictEqual(saved, {
          instance: apiUrl,
          patch: patchId,
          description: "Portal text",
          descriptionSyncedAt: stamp(15),
          custom: { keep: true }
        });
        assert.strictEqual(repo.description, "Portal text");
        assert.strictEqual(repo.descriptionSyncedAt, stamp(15));
      }
    })
  );

  it.effect("keeps a local edit while the cloud stamp is the same, older or absent", () =>
    Effect.gen(function* () {
      for (const descriptionUpdatedAt of [stamp(15), stamp(14), null]) {
        const local = { description: "Local edit", descriptionSyncedAt: stamp(15) };
        const { repo, warnings, saved } = yield* sync(local, {
          description: "Portal text",
          descriptionUpdatedAt
        });
        assert.deepStrictEqual(warnings, []);
        assert.deepStrictEqual(saved, {
          instance: apiUrl,
          patch: patchId,
          ...local,
          custom: { keep: true }
        });
        assert.strictEqual(repo.description, "Local edit");
        assert.strictEqual(repo.descriptionSyncedAt, stamp(15));
      }
    })
  );
});

it.effect("normalizes description text and names each refusal for the field it checks", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* Project.normalizeDescription("  A \n useful   tool  "),
      "A useful tool"
    );
    assert.strictEqual(yield* Project.normalizeDescription("𐐀".repeat(500)), "𐐀".repeat(500));
    for (const [text, message] of [
      ["", "The description must not be empty."],
      [" \n ", "The description must not be empty."],
      ["text\u0007", "The description must not contain control characters."],
      ["x".repeat(501), "The description is 501 Unicode code points; the maximum is 500."],
      ["𐐀".repeat(501), "The description is 501 Unicode code points; the maximum is 500."]
    ] as const) {
      const error = yield* Effect.flip(Project.normalizeDescription(text));
      assert.strictEqual(error.code, "invalid_description");
      assert.strictEqual(error.message, message);
    }
    const manifest = yield* Effect.flip(
      Project.normalizeDescription(" ", "patchy.json description", "invalid_manifest")
    );
    assert.strictEqual(manifest.code, "invalid_manifest");
    assert.strictEqual(manifest.message, "patchy.json description must not be empty.");
  })
);
