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
  it.effect("reads only Clerk settings and the seed user override from the developer file", () =>
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
          "CLERK_AUTHORIZED_PARTIES=http://127.0.0.1:3000",
          "PATCHY_DEV_CLERK_USER_ID=user_my_development_account",
          "DATABASE_URL=postgres://elsewhere",
          "PATCHY_PUBLIC_BASE_URL=https://elsewhere.invalid",
          "PATCHY_STORAGE_DIR=/elsewhere"
        ].join("\n")
      );
      expect(yield* readDeveloperEnv(file)).toEqual({
        CLERK_PUBLISHABLE_KEY: "pk_test_abc",
        CLERK_SECRET_KEY: "sk_test_with=equals",
        CLERK_AUTHORIZED_PARTIES: "http://127.0.0.1:3000",
        PATCHY_DEV_CLERK_USER_ID: "user_my_development_account"
      });
    }).pipe(Effect.scoped)
  );

  it.effect("preserves a quoted multiline JWT public key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "dev.env");
      const pem = [
        "-----BEGIN PUBLIC KEY-----",
        "bXVsdGlsaW5l",
        "cHVibGljLWtleQ==",
        "-----END PUBLIC KEY-----"
      ].join("\n");
      yield* fs.writeFileString(
        file,
        `CLERK_JWT_KEY="${pem}"\nPATCHY_DEV_CLERK_USER_ID=user_after_pem\n`
      );
      expect(yield* readDeveloperEnv(file)).toEqual({
        CLERK_JWT_KEY: pem,
        PATCHY_DEV_CLERK_USER_ID: "user_after_pem"
      });
    }).pipe(Effect.scoped)
  );
});
