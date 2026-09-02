import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { describe, expect } from "vitest";
import { parseEnv, readDeveloperEnv } from "./developerEnv.js";

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

describe("parseEnv", () => {
  it("takes KEY=value lines, drops comments and blanks, strips a matching pair of quotes", () => {
    expect(
      parseEnv(
        [
          "# written by clerk env pull",
          "",
          "CLERK_PUBLISHABLE_KEY=pk_test_abc",
          'CLERK_SECRET_KEY="sk_test_with=equals"',
          "NOT A LINE"
        ].join("\n")
      )
    ).toEqual({ CLERK_PUBLISHABLE_KEY: "pk_test_abc", CLERK_SECRET_KEY: "sk_test_with=equals" });
  });
});

it.layer(Platform)("readDeveloperEnv", (it) => {
  it.effect("is empty when the developer has written no file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      expect(yield* readDeveloperEnv(path.join(root, "dev.env"))).toEqual({});
      yield* fs.writeFileString(path.join(root, "dev.env"), "CLERK_SECRET_KEY=sk_test_abc\n");
      expect(yield* readDeveloperEnv(path.join(root, "dev.env"))).toEqual({
        CLERK_SECRET_KEY: "sk_test_abc"
      });
    }).pipe(Effect.scoped)
  );
});
