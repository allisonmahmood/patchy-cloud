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
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
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

/**
 * A repo whose config takes its column name from an imported file and declares `uses`, and an
 * instance that answers generation with `index` and `metadata`.
 */
const harness = Effect.fn("test.preparation.harness")(function* ({
  index,
  tier = 1,
  uses = "{}",
  generatedServer,
  metadata = { postgres: {}, shared: {} },
  duringGeneration = () => Effect.void
}: {
  readonly index: unknown;
  readonly tier?: 0 | 1 | 2;
  readonly uses?: string;
  readonly generatedServer?: string;
  readonly metadata?: unknown;
  readonly duringGeneration?: (root: string) => Effect.Effect<void, unknown, FileSystem.FileSystem>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-preparation-" });
  yield* fs.writeFileString(path.join(root, "patchy.json"), JSON.stringify({ instance: apiUrl }));
  yield* fs.writeFileString(path.join(root, "package.json"), '{"type":"module"}');
  yield* fs.writeFileString(path.join(root, "fields.ts"), 'export const column = "title";\n');
  yield* fs.makeDirectory(path.join(root, "fixtures"));
  yield* fs.writeFileString(path.join(root, "fixtures/shared-contacts.sql"), "");
  yield* fs.writeFileString(
    path.join(root, "patchy.config.ts"),
    `import { defineConfig, table, t, members, sharedTable, sharedStore } from ${JSON.stringify(builders)};\n` +
      'import { column } from "./fields.ts";\n' +
      `export default defineConfig({ name: "preparation-test", tier: ${tier}, tables: { notes: table("Notes identified by id.", { [column]: t.text() }) }, uses: ${uses} });\n`
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
        metadata,
        files: [
          { path: "patchy/_generated/index.json", contents: JSON.stringify(index) },
          ...(generatedServer === undefined
            ? []
            : [{ path: "patchy/_generated/server.ts", contents: generatedServer }])
        ]
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
    "discovers server modules without evaluating them or rewriting refresh-owned types",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, generated, prepare } = yield* harness({
          index: currentIndex,
          tier: 2,
          generatedServer: "new module list"
        });
        yield* fs.makeDirectory(path.join(root, "patchy/_generated"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "patchy/_generated/server.ts"),
          "refresh-owned list"
        );
        yield* fs.makeDirectory(path.join(root, "server"));
        yield* fs.writeFileString(path.join(root, "server/leads.ts"), "incomplete TypeScript {");
        yield* prepare;
        assert.deepStrictEqual(generated[0]!.serverModules, ["leads"]);
        assert.isUndefined(generated[0]!.manifest.handlers);
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "patchy/_generated/server.ts")),
          "refresh-owned list"
        );
      })
  );
  it.effect(
    "returns the manifest it generated from, even when an imported file changes mid-generation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { generated, prepare } = yield* harness({
          index: currentIndex,
          duringGeneration: (root) =>
            fs.writeFileString(`${root}/fields.ts`, 'export const column = "body";\n')
        });
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
        const { prepare } = yield* harness({
          index: { ...currentIndex, release: `${RELEASE}-stale` }
        });
        const error = yield* Effect.flip(prepare);
        if (error._tag !== "LocalError") return assert.fail(`Unexpected ${error._tag}`);
        assert.strictEqual(error.code, "stale_generated");
      }),
    { timeout: 30_000 }
  );

  it.effect(
    "stamps declarations from the generated index and checks them against its metadata",
    () =>
      Effect.gen(function* () {
        const contacts = {
          kind: "sharedTable",
          patchId: "abcdefghijkl",
          table: "contacts",
          id: "abcdefghijkl/contacts",
          revision: 3
        } as const;
        const index = {
          ...currentIndex,
          uses: [{ alias: "contacts", id: contacts.id, revision: 3, declaration: contacts }]
        };
        const uses = '{ contacts: sharedTable("abcdefghijkl", "contacts") }';
        const shared = (declaration: typeof contacts | { revision: number }) => ({
          postgres: {},
          shared: {
            contacts: { declaration: { ...contacts, ...declaration }, tables: {}, uses: {} }
          }
        });
        const { prepare } = yield* harness({ index, uses, metadata: shared(contacts) });
        assert.deepStrictEqual((yield* prepare).manifest.uses, { contacts });
        const stale = yield* harness({ index, uses, metadata: shared({ revision: 4 }) });
        const exit = yield* Effect.exit(stale.prepare);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit))
          assert.strictEqual(
            Option.getOrUndefined(Exit.findErrorOption(exit))?.message,
            "Generation returned inconsistent metadata for contacts."
          );
      }),
    { timeout: 30_000 }
  );
  it.effect("prepares members without requiring a fixture or declaration snapshot", () =>
    Effect.gen(function* () {
      const { prepare } = yield* harness({
        index: currentIndex,
        uses: "{ members: members() }"
      });
      const prepared = yield* prepare;
      assert.deepStrictEqual(prepared.manifest.uses, { members: { kind: "members" } });
      assert.deepStrictEqual(prepared.metadata, { postgres: {}, shared: {} });
    })
  );
  it.effect("requires a directory for shared-store fixtures and preserves it while stamping", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const declaration = {
        kind: "sharedStore" as const,
        patchId: "abcdefghijkl",
        store: "documents",
        id: "abcdefghijkl/documents",
        revision: 3
      };
      const fixture = yield* harness({
        uses: '{ assets: sharedStore("abcdefghijkl", "documents") }',
        index: {
          ...currentIndex,
          uses: [{ alias: "assets", id: declaration.id, revision: 3, declaration }]
        },
        metadata: {
          postgres: {},
          shared: {
            assets: { declaration, definition: { description: "Source documents", shared: true } }
          }
        }
      });
      const relative = "fixtures/shared-assets";
      const missing = yield* fixture.prepare.pipe(Effect.flip);
      assert.instanceOf(missing, Preparation.FixtureMissing);
      yield* fs.writeFileString(`${fixture.root}/${relative}`, "Not a directory");
      const wrongKind = yield* fixture.prepare.pipe(Effect.flip);
      assert.instanceOf(wrongKind, Preparation.FixtureMissing);
      yield* fs.remove(`${fixture.root}/${relative}`);
      yield* fs.makeDirectory(`${fixture.root}/${relative}`);
      yield* fs.writeFile(`${fixture.root}/${relative}/asset.bin`, new Uint8Array([0, 255]));
      assert.deepStrictEqual((yield* fixture.prepare).manifest.uses, { assets: declaration });
      assert.deepStrictEqual(
        yield* fs.readFile(`${fixture.root}/${relative}/asset.bin`),
        new Uint8Array([0, 255])
      );
    })
  );
});
