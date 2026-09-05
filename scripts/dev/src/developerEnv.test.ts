import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect } from "vitest";
import { readDeveloperEnv } from "./developerEnv.js";

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

it.layer(Platform)("readDeveloperEnv", (it) => {
  it.effect("reads only Clerk keys and the seed user override from the developer file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "dev.env");
      expect(yield* readDeveloperEnv(file)).toEqual({});
      yield* fs.writeFileString(
        file,
        [
          "# written by clerk env pull",
          "CLERK_PUBLISHABLE_KEY=pk_test_abc",
          'CLERK_SECRET_KEY="sk_test_with=equals"',
          "PATCHY_DEV_CLERK_USER_ID=user_my_development_account",
          "DATABASE_URL=postgres://elsewhere"
        ].join("\n")
      );
      expect(yield* readDeveloperEnv(file)).toEqual({
        CLERK_PUBLISHABLE_KEY: "pk_test_abc",
        CLERK_SECRET_KEY: "sk_test_with=equals",
        PATCHY_DEV_CLERK_USER_ID: "user_my_development_account"
      });
    }).pipe(Effect.scoped)
  );
});
