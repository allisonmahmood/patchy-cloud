import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect } from "vitest";
import { loadScenario, publisherToken } from "./scenario.js";

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const repo = new URL("../../..", import.meta.url).pathname;

it.layer(Platform)("scenarios", (it) => {
  it.effect("loads every committed scenario and finds each repo patch's source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const name of ["team", "brightline"]) {
        const { dir, scenario } = yield* loadScenario(repo, name);
        for (const patch of scenario.patches) {
          const source =
            "repo" in patch
              ? path.join(dir, "patches", patch.repo, "patchy.config.ts")
              : path.join(dir, "files", patch.file);
          expect(yield* fs.exists(source), source).toBe(true);
        }
      }
      const { scenario } = yield* loadScenario(repo, "brightline");
      expect(publisherToken(scenario)).toBe("patchy-env-brightline-allison");
    })
  );

  it.effect("names the available scenarios when one is missing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadScenario(repo, "nope"));
      expect(error._tag).toBe("ScenarioNotFound");
      expect(error.message).toContain("brightline, team");
    })
  );

  it.effect("refuses a publisher who is not an admin", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, "scenarios", "bad"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "scenarios", "bad", "scenario.json"),
        `{"company":{"name":"Bad","handle":"bad"},"publisher":"m","patches":[],
          "people":[{"key":"m","name":"M","email":"m@bad.example","role":"member"}]}`
      );
      const error = yield* Effect.flip(loadScenario(root, "bad"));
      expect(error.message).toContain("the publisher must be an admin");
    }).pipe(Effect.scoped)
  );
});
