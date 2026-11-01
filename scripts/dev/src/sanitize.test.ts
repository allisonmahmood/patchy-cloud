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
  it("redacts an email address outside the example domains in any form, and leaves the scenarios' and versions alone", () => {
    const redacted = [
      "someone@company.co.uk",
      "jane@bücher.de",
      '"jane doe"@company.com',
      "o'hara@company.com",
      "privateuser@private-laptop.local",
      "JANE@Company.COM"
    ];
    for (const address of redacted)
      assert.strictEqual(redactText(new Map(), `as ${address}.`).text, "as [redacted].", address);
    assert.strictEqual(
      redactText(
        new Map(),
        '[account](https://x.co/?email=jane%40company.com) {"email":"jane@company.com"}'
      ).text,
      '[account](https://x.co/?email=[redacted]) {"email":"[redacted]"}'
    );
    for (const quoted of [
      "'jane@company.com'",
      `'"jane doe"@company.com'`,
      `'"jane doe"%40company.com'`
    ])
      assert.strictEqual(
        redactText(new Map(), `git config user.email ${quoted}`).text,
        "git config user.email '[redacted]'",
        quoted
      );
    // Apostrophes may be the whole local part.
    assert.strictEqual(
      redactText(new Map(), "'@company.com ''%40company.com").text,
      "'[redacted] ''[redacted]"
    );
    // A run with no `@` is scanned once: quadratic scanning takes seconds here.
    const started = performance.now();
    for (const run of ["a'", "'"]) redactText(new Map(), run.repeat(64 * 1024));
    assert.isBelow(performance.now() - started, 1_000);
    const kept =
      "ada@acme.example, ada%40acme.example, dev@patchy.local, patchy@0.14.0, @effect/vitest@4.0.1, user@host";
    assert.deepStrictEqual(redactText(new Map(), kept), { text: kept, matched: new Set() });
  });

  it.effect("redacts a secret in a JSON document's keys as well as its values", () =>
    Effect.gen(function* () {
      const sanitizer = yield* makeSanitizer({
        stateDirs: [],
        envs: [],
        identities: ["s3cret-value"]
      });
      const redacted = yield* sanitizer.redactJson({
        refusals: { "s3cret-value": 1, stale_generated: 2 }
      });
      assert.deepStrictEqual(redacted, { refusals: { "[redacted]": 1, stale_generated: 2 } });
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it("redacts what is shaped like a provider's access token or API key, and nothing like it", () => {
    const text =
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U and key sk-ant-api03-abcdefghijklmnop-QRSTUV";
    const found = redactText(new Map(), text);
    assert.strictEqual(found.text, "token [redacted] and key [redacted]");
    assert.deepStrictEqual([...found.matched], ["credential"]);
    const kept = "eyJ alone, a sk-short key, task-ant-heap";
    assert.deepStrictEqual(redactText(new Map(), kept), { text: kept, matched: new Set() });
  });

  it("finds every match before replacing, so a short value can't break up a token, and twice is once", () => {
    const secrets = new Map([
      ["p", "cli-state" as const],
      ["B", "cli-state" as const]
    ]);
    const once = redactText(secrets, "pp_AbC123-_xyzDEF456 and BCDF-GHJK, then pq");
    assert.strictEqual(once.text, "[redacted] and [redacted], then [redacted]q");
    assert.deepStrictEqual([...once.matched].sort(), ["cli-state", "login-code", "machine-token"]);

    const twice = redactText(secrets, once.text);
    assert.strictEqual(twice.text, once.text);
    assert.deepStrictEqual([...twice.matched], []);
  });

  it("replaces a value whole, in a URL and in JSON, and anything shaped like a machine token or login code", () => {
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
        "an app_3ImZu8038U0oFds84 id stays",
        "a code it never saw: QRST-VWXZ"
      ].join("\n")
    );
    assert.strictEqual(
      text,
      [
        "Sign in: http://x.localhost/login/device?code=[redacted]",
        "Code: [redacted]",
        'key [redacted] in {"token":"[redacted]"}',
        "an app_3ImZu8038U0oFds84 id stays",
        "a code it never saw: [redacted]"
      ].join("\n")
    );
    assert.deepStrictEqual([...matched].sort(), ["cli-state", "login-code", "machine-token"]);
  });
});

it.layer(NodeServices.layer)("a sanitizer", (it) => {
  it.effect("redacts the identities it is given in every form", () =>
    Effect.gen(function* () {
      const sanitizer = yield* makeSanitizer({
        stateDirs: [],
        envs: [],
        identities: ["Jane.Doe+work@company.com"]
      });
      assert.strictEqual(
        yield* sanitizer.redact("Jane.Doe+work@company.com or ?u=Jane.Doe%2Bwork%40company.com"),
        "[redacted] or ?u=[redacted]"
      );
      assert.include(yield* sanitizer.matched, "identity");
    })
  );

  it.effect("keeps a JSON report valid however short a secret is", () =>
    Effect.gen(function* () {
      const sanitizer = yield* makeSanitizer({ stateDirs: [], envs: [{ GH_TOKEN: "0" }] });
      const report = yield* sanitizer.redactJson({ exitCode: 0, stdout: "0 rows", lines: ["10"] });
      assert.deepStrictEqual(report, {
        exitCode: 0,
        stdout: "[redacted] rows",
        lines: ["1[redacted]"]
      });
    })
  );

  it.effect("still redacts a login code after a logout cleared it from the CLI state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* fs.makeTempDirectoryScoped();
      const url = "http://after.localhost:4000";
      yield* fs.writeFileString(
        path.join(state, "credentials.json"),
        `{"hosts":{"${url}":{"token":"hunter2","source":"auth-set"}}}`
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
          "device dc_9f8e7d6c5b4a39281706, key hunter2",
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
      assert.deepStrictEqual(yield* sanitizer.matched, ["cli-state", "login-code", "variable"]);
    })
  );
});
