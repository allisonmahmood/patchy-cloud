import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
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
import * as Api from "./Api.js";
import * as Preparation from "./devPreparation.js";
import * as Instance from "./Instance.js";
import { MANIFEST_VERSION, RELEASE } from "./release.js";
import { lookRevision } from "../../../test/look-fixtures.js";

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
  generatedFiles = [],
  metadata = { postgres: {}, posthog: {}, pidgeon: {}, attio: {}, shared: {} },
  duringGeneration = () => Effect.void
}: {
  readonly index: unknown;
  readonly tier?: 1 | 2;
  readonly uses?: string;
  readonly generatedServer?: string;
  readonly generatedFiles?: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
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
    `import { defineConfig, table, t, members, posthog, sharedTable, sharedStore } from ${JSON.stringify(builders)};\n` +
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
          ...generatedFiles,
          ...(generatedServer === undefined
            ? []
            : [{ path: "patchy/_generated/server.ts", contents: generatedServer }])
        ]
      });
    }).pipe(Effect.provide(NodeServices.layer))
  );
  const prepare = Preparation.prepare(root, Redacted.make("preparation-token")).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(Api.CurrentCommand, "dev"),
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
          posthog: {},
          pidgeon: {},
          attio: {},
          shared: {
            contacts: { declaration: { ...contacts, ...declaration }, tables: {}, uses: {} }
          }
        });
        const { prepare } = yield* harness({ index, tier: 2, uses, metadata: shared(contacts) });
        assert.deepStrictEqual((yield* prepare).manifest.uses, { contacts });
        const stale = yield* harness({ index, tier: 2, uses, metadata: shared({ revision: 4 }) });
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
  it.effect(
    "reminds about a primitive whose definition changed under the same description",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, prepare } = yield* harness({ index: currentIndex });
        yield* fs.makeDirectory(path.join(root, "patchy/_generated"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "patchy/_generated/manifest.json"),
          JSON.stringify({
            manifestVersion: MANIFEST_VERSION,
            release: RELEASE,
            tier: 1,
            tables: { notes: { description: "Notes identified by id.", columns: {}, indexes: {} } },
            files: {},
            uses: {}
          })
        );
        assert.deepStrictEqual((yield* prepare).warnings, [
          "Table `notes` changed since its last generation; check that its description still holds: 'Notes identified by id.'"
        ]);
      }),
    { timeout: 30_000 }
  );
  it.effect(
    "prepares PostHog without a fixture, since dev reads the real connection, and checks its metadata",
    () =>
      Effect.gen(function* () {
        const analytics = {
          kind: "posthog",
          id: "conn_product",
          handle: "product",
          revision: 2
        } as const;
        const index = {
          ...currentIndex,
          uses: [{ alias: "analytics", id: analytics.id, revision: 2, declaration: analytics }]
        };
        const uses = '{ analytics: posthog("product") }';
        const metadata = (declaration: typeof analytics | { revision: number }) => ({
          postgres: {},
          shared: {},
          pidgeon: {},
          attio: {},
          posthog: {
            analytics: {
              declaration: { ...analytics, ...declaration },
              snapshot: { version: 1, events: [], eventProperties: [], personProperties: [] }
            }
          }
        });
        const { prepare } = yield* harness({ index, tier: 2, uses, metadata: metadata(analytics) });
        assert.deepStrictEqual((yield* prepare).manifest.uses, { analytics });
        const stale = yield* harness({
          index,
          tier: 2,
          uses,
          metadata: metadata({ revision: 3 })
        });
        assert.strictEqual(
          (yield* stale.prepare.pipe(Effect.flip)).message,
          "Generation returned inconsistent metadata for analytics."
        );
      }),
    { timeout: 30_000 }
  );
  it.effect("refuses uses below tier 2 before generating anything", () =>
    Effect.gen(function* () {
      const { generated, prepare } = yield* harness({
        index: currentIndex,
        tier: 1,
        uses: '{ members: members(), analytics: posthog("product") }'
      });
      const error = yield* Effect.flip(prepare);
      if (error._tag !== "LocalError") return assert.fail(`Unexpected ${error._tag}`);
      assert.strictEqual(error.code, "tier_mismatch");
      assert.include(error.message, 'cannot declare "members", "analytics"');
      assert.include(error.message, "server handlers");
      assert.deepStrictEqual(generated, []);
    })
  );
  it.effect("prepares members without requiring a fixture or declaration snapshot", () =>
    Effect.gen(function* () {
      const { prepare } = yield* harness({
        index: currentIndex,
        tier: 2,
        uses: "{ members: members() }"
      });
      const prepared = yield* prepare;
      assert.deepStrictEqual(prepared.manifest.uses, { members: { kind: "members" } });
      assert.deepStrictEqual(prepared.metadata, {
        postgres: {},
        posthog: {},
        pidgeon: {},
        attio: {},
        shared: {}
      });
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
        tier: 2,
        uses: '{ assets: sharedStore("abcdefghijkl", "documents") }',
        index: {
          ...currentIndex,
          uses: [{ alias: "assets", id: declaration.id, revision: 3, declaration }]
        },
        metadata: {
          postgres: {},
          posthog: {},
          pidgeon: {},
          attio: {},
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

  describe("look notices", () => {
    const follow =
      "Colours and fonts follow; to restyle this tool's components, ask your agent to update it to the current look.";
    const page = Effect.fn("test.preparation.page")(function* (
      root: string,
      source: string,
      files: Record<string, string> = {}
    ) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${root}/src`, { recursive: true });
      yield* fs.writeFileString(`${root}/src/main.tsx`, source);
      for (const [file, contents] of Object.entries(files))
        yield* fs.writeFileString(`${root}/${file}`, contents);
    });

    it.effect(
      "tells a page that imports the look each time dev start brings in another revision",
      () =>
        Effect.gen(function* () {
          const index: { look: ReturnType<typeof lookRevision> | null } = {
            ...currentIndex,
            look: lookRevision(7, "first green")
          };
          const { root, prepare } = yield* harness({ index });
          yield* page(root, 'import "../patchy/_generated/look.css";\n');
          const notices = Effect.map(prepare, ({ warnings }) => warnings);
          assert.deepStrictEqual(yield* notices, [
            `Preparation's look changed, none → rev 7 by Sam: first green. ${follow}`
          ]);
          index.look = lookRevision(8, "darker green");
          assert.deepStrictEqual(yield* notices, [
            `Preparation's look changed, rev 7 → 8 by Sam: darker green. ${follow}`
          ]);
          assert.deepStrictEqual(yield* notices, []);
          index.look = lookRevision(7, "first green");
          assert.deepStrictEqual(yield* notices, [
            `Preparation's look changed, rev 8 → 7 by Sam: first green. ${follow}`
          ]);
          index.look = null;
          assert.deepStrictEqual(yield* notices, [
            `Preparation's look changed, rev 7 → none, so the Patchy look stands in. ${follow}`
          ]);
        }),
      { timeout: 30_000 }
    );

    it.effect(
      "names the restorer instead of the revision's author when a restore set the look",
      () =>
        Effect.gen(function* () {
          const index: {
            look: ReturnType<typeof lookRevision> | null;
            lookRestore?: {
              by: { id: string; name: string };
              at: string;
              note: string | null;
            } | null;
          } = { ...currentIndex, look: lookRevision(8, "darker green") };
          const { root, prepare } = yield* harness({ index });
          yield* page(root, 'import "../patchy/_generated/look.css";\n');
          yield* prepare;
          const notices = Effect.map(prepare, ({ warnings }) => warnings);
          const ada = { id: "usr_ada", name: "Ada" };
          const at = "2026-10-07T12:00:00.000Z";
          index.look = lookRevision(7, "first green");
          index.lookRestore = { by: ada, at, note: "rev 8 failed dark mode" };
          assert.deepStrictEqual(yield* notices, [
            `Preparation's look changed, rev 8 → 7, restored by Ada: rev 8 failed dark mode. ${follow}`
          ]);
          index.look = null;
          index.lookRestore = { by: ada, at, note: null };
          assert.deepStrictEqual(yield* notices, [
            `Preparation's look changed, rev 7 → none, restored by Ada. The Patchy look stands in. ${follow}`
          ]);
          // A publish clears the record, and its author is credited as before.
          index.look = lookRevision(9, "rebrand");
          index.lookRestore = null;
          assert.deepStrictEqual(yield* notices, [
            `Preparation's look changed, none → rev 9 by Sam: rebrand. ${follow}`
          ]);
        })
    );

    it.effect("hears through a stylesheet at the repo root that imports the look", () =>
      Effect.gen(function* () {
        const index = { ...currentIndex, look: lookRevision(7, "first green") };
        const { root, prepare } = yield* harness({ index });
        yield* page(root, 'import "../theme.css";\n', {
          "theme.css": '@import "./patchy/_generated/look.css";\n'
        });
        yield* prepare;
        index.look = lookRevision(8, "darker green");
        assert.deepStrictEqual((yield* prepare).warnings, [
          `Preparation's look changed, rev 7 → 8 by Sam: darker green. ${follow}`
        ]);
      })
    );

    it.effect("says nothing to a page that keeps its own style or commented the look out", () =>
      Effect.gen(function* () {
        const index = { ...currentIndex, look: lookRevision(7, "first green") };
        const { root, prepare } = yield* harness({ index });
        yield* page(root, '// import "../patchy/_generated/look.css";\nimport "./styles.css";\n', {
          "index.html": '<!-- <link rel="stylesheet" href="/patchy/_generated/look.css"> -->\n'
        });
        yield* prepare;
        index.look = lookRevision(8, "darker green");
        assert.deepStrictEqual((yield* prepare).warnings, []);
      })
    );

    it.effect("tells a page using the logo when the new look has none", () =>
      Effect.gen(function* () {
        const logo = { path: "patchy/_generated/logo.svg", contents: "<svg/>" };
        const generatedFiles = [logo];
        const index = { ...currentIndex, look: lookRevision(7, "first green") };
        const { root, prepare } = yield* harness({ index, generatedFiles });
        yield* page(
          root,
          'import "../patchy/_generated/look.css";\nimport logo from "../patchy/_generated/logo.svg";\n'
        );
        yield* prepare;
        index.look = lookRevision(8, "darker green");
        generatedFiles.pop();
        assert.deepStrictEqual((yield* prepare).warnings, [
          `Preparation's look changed, rev 7 → 8 by Sam: darker green. ${follow} The new look has no logo, so remove the page's reference to patchy/_generated/logo.svg; the next build fails on it.`
        ]);
      })
    );
  });
});
