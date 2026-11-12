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
      // Keys that redact alike, or meet a placeholder already there, keep every entry.
      const collided = yield* sanitizer.redactJson({
        "[redacted]": 1,
        "pp_AbC123-_xyzDEF456": 2,
        "pp_ZyX987-_abcGHI654": 3
      });
      assert.deepStrictEqual(collided, { "[redacted]": 1, "[redacted] 2": 2, "[redacted] 3": 3 });
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

  it.effect(
    "redacts a secret-named headers variable header by header, a colon in a value kept",
    () =>
      Effect.gen(function* () {
        const sanitizer = yield* makeSanitizer({
          stateDirs: [],
          envs: [{ COOKIE_HEADERS: "X-Key: dummy-alpha\nX-Other: dummy:beta" }]
        });
        assert.strictEqual(
          yield* sanitizer.redact("sent dummy-alpha, then dummy:beta"),
          "sent [redacted], then [redacted]"
        );
      })
  );

  it.effect("takes a header line's value whole, commas and all, and nothing else of it", () =>
    Effect.gen(function* () {
      const sanitizer = yield* makeSanitizer({
        stateDirs: [],
        envs: [
          {
            ANTHROPIC_CUSTOM_HEADERS:
              "X-Key: dummy-alpha,dummy-beta, X-Other: dummy-gamma\nX-Forwarded-For: 192.0.2.1, ::"
          }
        ]
      });
      assert.strictEqual(
        yield* sanitizer.redact(
          "401 for dummy-alpha,dummy-beta, X-Other: dummy-gamma at http://localhost:4000"
        ),
        "401 for [redacted] at http://localhost:4000"
      );
    })
  );

  it.effect(
    "redacts the model provider's address, its credentials and its host as written, unless the host is this machine's or too short to name",
    () =>
      Effect.gen(function* () {
        const redact = (address: string, text: string) =>
          makeSanitizer({ stateDirs: [], envs: [{ ANTHROPIC_BASE_URL: address }] }).pipe(
            Effect.flatMap((sanitizer) => sanitizer.redact(text))
          );
        assert.strictEqual(
          yield* redact(
            "https://user:dummy-pass@Models.Example.ts.net:8317/v1?region=eu",
            "via https://user:dummy-pass@Models.Example.ts.net:8317/v1/messages, connect Models.Example.ts.net:8317, ENOTFOUND models.example.ts.net, password dummy-pass"
          ),
          "via https://[redacted]/v1/messages, connect [redacted], ENOTFOUND [redacted], password [redacted]"
        );
        assert.strictEqual(
          yield* redact(
            "http://127.0.0.1:8317",
            "via http://127.0.0.1:8317, served on 127.0.0.1:8317 and 127.0.0.1:4000"
          ),
          "via [redacted], served on 127.0.0.1:8317 and 127.0.0.1:4000"
        );
        assert.strictEqual(
          yield* redact("http://localhost.:8317", "served on localhost.:8317"),
          "served on localhost.:8317"
        );
        assert.strictEqual(
          yield* redact("https://h", "the handler at https://h returned healthy"),
          "the handler at [redacted] returned healthy"
        );
        assert.strictEqual(
          yield* redact("http://gpubox:8317", "connect gpubox:8317 failed; gpubox users are fine"),
          "connect [redacted] failed; gpubox users are fine"
        );
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
