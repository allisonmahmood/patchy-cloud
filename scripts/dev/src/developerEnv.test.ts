import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { expect } from "vitest";
import { readCredentialKeys, readDeveloperEnv } from "./developerEnv.js";

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

it.layer(Platform)("readDeveloperEnv", (it) => {
  it.effect("keeps the worktree credential key across restarts without overwriting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "dev.env");
      const first = yield* readCredentialKeys(file);
      const second = yield* readCredentialKeys(file);
      expect(Redacted.value(second)).toBe(Redacted.value(first));
      const encoded = Redacted.value(first).split(":")[1]!;
      expect(Buffer.from(encoded, "base64").byteLength).toBe(32);
      expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
      yield* fs.writeFileString(file, "PATCHY_CREDENTIAL_KEYS=invalid\n");
      expect((yield* readCredentialKeys(file).pipe(Effect.exit))._tag).toBe("Failure");
      expect(yield* fs.readFileString(file)).toBe("PATCHY_CREDENTIAL_KEYS=invalid\n");
    }).pipe(Effect.scoped)
  );

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
