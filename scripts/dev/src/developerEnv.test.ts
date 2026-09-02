import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect } from "vitest";
import { readClerkKeys } from "./developerEnv.js";

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

it.layer(Platform)("readClerkKeys", (it) => {
  it.effect("is empty without a file, and takes only the two Clerk keys from one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "dev.env");
      expect(yield* readClerkKeys(file)).toEqual({});
      yield* fs.writeFileString(
        file,
        [
          "# written by clerk env pull",
          "CLERK_PUBLISHABLE_KEY=pk_test_abc",
          'CLERK_SECRET_KEY="sk_test_with=equals"',
          "DATABASE_URL=postgres://elsewhere"
        ].join("\n")
      );
      expect(yield* readClerkKeys(file)).toEqual({
        CLERK_PUBLISHABLE_KEY: "pk_test_abc",
        CLERK_SECRET_KEY: "sk_test_with=equals"
      });
    }).pipe(Effect.scoped)
  );
});
