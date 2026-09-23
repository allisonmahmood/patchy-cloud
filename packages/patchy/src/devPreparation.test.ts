import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GenerateRequest, Identity } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Preparation from "./devPreparation.js";
import * as Instance from "./Instance.js";
import { MANIFEST_VERSION, RELEASE } from "./release.js";

const apiUrl = "http://preparation.test";
const builders = new URL("./config.ts", import.meta.url).href;
const decodeGenerate = Schema.decodeUnknownSync(Schema.fromJsonString(GenerateRequest));
const identity = new Identity({
  user: { id: "preparation-user", email: "preparation@example.test", name: "Preparation" },
  company: { id: "preparation-company", handle: "preparation", name: "Preparation" },
  role: "admin",
  machine: { id: "preparation-machine", name: "Preparation test" }
});

/** A repo whose config takes its column name from an imported file, and an instance that answers generation with `index`. */
const harness = Effect.fn("test.preparation.harness")(function* (
  index: unknown,
  duringGeneration: (root: string) => Effect.Effect<void, unknown, FileSystem.FileSystem>
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-preparation-" });
  yield* fs.writeFileString(path.join(root, "patchy.json"), JSON.stringify({ instance: apiUrl }));
  yield* fs.writeFileString(path.join(root, "package.json"), '{"type":"module"}');
  yield* fs.writeFileString(path.join(root, "fields.ts"), 'export const column = "title";\n');
  yield* fs.writeFileString(
    path.join(root, "patchy.config.ts"),
    `import { defineConfig, table, t } from ${JSON.stringify(builders)};\n` +
      'import { column } from "./fields.ts";\n' +
      'export default defineConfig({ name: "preparation-test", tier: 1, tables: { notes: table("Notes identified by id.", { [column]: t.text() }) } });\n'
  );
  const generated: Array<typeof GenerateRequest.Type> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const respond = (body: unknown) => HttpClientResponse.fromWeb(request, Response.json(body));
      if (request.url === `${apiUrl}/api/me`) return respond(identity);
      if (request.url !== `${apiUrl}/api/sdk/generate` || request.body._tag !== "Uint8Array")
        return HttpClientResponse.fromWeb(request, Response.json({ ok: false }, { status: 404 }));
      generated.push(decodeGenerate(new TextDecoder().decode(request.body.body)));
      yield* duringGeneration(root).pipe(Effect.orDie);
      return respond({
        ok: true,
        uses: [],
        metadata: { postgres: {}, shared: {} },
        files: [{ path: "patchy/_generated/index.json", contents: JSON.stringify(index) }]
      });
    }).pipe(Effect.provide(NodeServices.layer))
  );
  const prepare = Preparation.prepare(root, Redacted.make("preparation-token")).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(Instance.Instance, { apiUrl, source: "env", token: Option.none() })
  );
  return { root, generated, prepare };
});

const currentIndex = { release: RELEASE, manifestVersion: MANIFEST_VERSION, uses: [], skills: [] };

it.layer(NodeServices.layer)("DevPreparation.prepare", (it) => {
  it.effect(
    "returns the manifest it generated from, even when an imported file changes mid-generation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { generated, prepare } = yield* harness(currentIndex, (root) =>
          fs.writeFileString(`${root}/fields.ts`, 'export const column = "body";\n')
        );
        const prepared = yield* prepare;
        assert.deepStrictEqual(Object.keys(generated[0]!.manifest.tables.notes!.columns), [
          "title"
        ]);
        assert.deepStrictEqual(Object.keys(prepared.manifest.tables.notes!.columns), ["title"]);
      }),
    { timeout: 30_000 }
  );

  it.effect(
    "refuses a generated index from another release",
    () =>
      Effect.gen(function* () {
        const { prepare } = yield* harness(
          { ...currentIndex, release: `${RELEASE}-stale` },
          () => Effect.void
        );
        const exit = yield* Effect.exit(prepare);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit))
          assert.strictEqual(
            Option.getOrUndefined(Exit.findErrorOption(exit))?.code,
            "stale_generated"
          );
      }),
    { timeout: 30_000 }
  );
});
