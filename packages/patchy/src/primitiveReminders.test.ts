import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { Manifest } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { primitiveReminders } from "./primitiveReminders.js";
import { RELEASE, MANIFEST_VERSION } from "./release.js";

it.effect("ignores explicit default flags but notices a newly unique index", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const generated = path.join(root, "patchy/_generated");
    yield* fs.makeDirectory(generated, { recursive: true });
    const before: typeof Manifest.Type = {
      manifestVersion: MANIFEST_VERSION,
      release: RELEASE,
      tier: 1,
      tables: {
        notes: {
          description: "Notes keyed by title.",
          columns: { title: { kind: "text" } },
          indexes: { byTitle: { columns: ["title"] } }
        }
      },
      files: {},
      uses: {}
    };
    yield* fs.writeFileString(path.join(generated, "manifest.json"), JSON.stringify(before));
    const explicit: typeof Manifest.Type = {
      ...before,
      tables: {
        notes: {
          description: "Notes keyed by title.",
          columns: { title: { kind: "text", optional: false } },
          indexes: { byTitle: { columns: ["title"], unique: false } },
          shared: false
        }
      }
    };
    assert.deepStrictEqual(yield* primitiveReminders(root, explicit), []);
    const changed: typeof Manifest.Type = {
      ...explicit,
      tables: {
        notes: {
          ...explicit.tables.notes!,
          indexes: { byTitle: { columns: ["title"], unique: true } }
        }
      }
    };
    assert.deepStrictEqual(yield* primitiveReminders(root, changed), [
      "Table `notes` changed since its last generation; check that its description still holds: 'Notes keyed by title.'"
    ]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)
);
