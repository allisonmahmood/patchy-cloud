import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeSanitizer, marksSecret, redactText } from "./sanitize.js";

describe("marksSecret", () => {
  it("marks tokens, keys, passwords and login codes, and leaves other names alone", () => {
    const marked = [
      "token",
      "PATCHY_API_TOKEN",
      "ANTHROPIC_API_KEY",
      "CLERK_SECRET_KEY",
      "PGPASSWORD",
      "deviceCode",
      "userCode",
      "publishKey"
    ];
    const plain = [
      "HOME",
      "PATH",
      "PATCHY_STATE_DIR",
      "verificationUrl",
      "key",
      "code",
      "expiresAt"
    ];
    assert.deepStrictEqual(marked.filter(marksSecret), marked);
    assert.deepStrictEqual(plain.filter(marksSecret), []);
  });
});

describe("redactText", () => {
  it("replaces a value whole, in a URL and in JSON, and anything shaped like a machine token", () => {
    const secrets = new Map([
      ["BCDF-GHJK", "cli-state" as const],
      ["BCDF-GHJK-LONGER", "cli-state" as const]
    ]);
    const { text, matched } = redactText(
      secrets,
      [
        "Sign in: http://x.localhost/login/device?code=BCDF-GHJK",
        "Code: BCDF-GHJK-LONGER",
        'key pp_AbC123-_xyzDEF456 in {"token":"pp_AbC123-_xyzDEF456"}',
        "an app_3ImZu8038U0oFds84 id stays"
      ].join("\n")
    );
    assert.strictEqual(
      text,
      [
        "Sign in: http://x.localhost/login/device?code=[redacted]",
        "Code: [redacted]",
        'key [redacted] in {"token":"[redacted]"}',
        "an app_3ImZu8038U0oFds84 id stays"
      ].join("\n")
    );
    assert.deepStrictEqual([...matched].sort(), ["cli-state", "machine-token"]);
  });
});

it.layer(NodeServices.layer)("a sanitizer", (it) => {
  it.effect("still redacts a login code after a logout cleared it from the CLI state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* fs.makeTempDirectoryScoped();
      const url = "http://after.localhost:4000";
      yield* fs.writeFileString(
        path.join(state, "credentials.json"),
        `{"hosts":{"${url}":{"token":"patchy-env-acme-ada","source":"auth-set"}}}`
      );
      const sanitizer = yield* makeSanitizer({
        stateDirs: [state, path.join(state, "missing")],
        envs: [{ HOME: "/home/someone", ANTHROPIC_API_KEY: "sk-ant-0123456789" }]
      });

      // `patchy login` saves a pending login; the next line's logout clears it and the token.
      yield* fs.writeFileString(
        path.join(state, "device-login.json"),
        `{"hosts":{"${url}":{"deviceCode":"dc_9f8e7d6c5b4a39281706","userCode":"BCDF-GHJK","verificationUrl":"${url}/login/device?code=BCDF-GHJK"}}}`
      );
      yield* sanitizer.collect;
      yield* fs.remove(path.join(state, "device-login.json"));
      yield* fs.writeFileString(path.join(state, "credentials.json"), '{"hosts":{}}');
      yield* sanitizer.collect;

      const text = yield* sanitizer.redact(
        [
          `Sign in: ${url}/login/device?code=BCDF-GHJK`,
          "Code: BCDF-GHJK",
          "Then run: patchy login --complete BCDF-GHJK",
          "device dc_9f8e7d6c5b4a39281706, key patchy-env-acme-ada",
          "agent key sk-ant-0123456789 in /home/someone"
        ].join("\n")
      );

      assert.strictEqual(
        text,
        [
          `Sign in: ${url}/login/device?code=[redacted]`,
          "Code: [redacted]",
          "Then run: patchy login --complete [redacted]",
          "device [redacted], key [redacted]",
          "agent key [redacted] in /home/someone"
        ].join("\n")
      );
      assert.deepStrictEqual(yield* sanitizer.matched, ["cli-state", "variable"]);
    })
  );
});
