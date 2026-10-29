import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Api from "./Api.js";
import * as Instance from "./Instance.js";
import * as State from "./State.js";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stdio from "effect/Stdio";
import * as Login from "./Login.js";
import * as Output from "./Output.js";
import { NodeCryptography } from "@patchy/core";

const apiUrl = "http://instance.test";
const pendingLogin = {
  deviceCode: "private-code",
  userCode: "BCDF-GHJK",
  interval: 5,
  verificationUrl: `${apiUrl}/login/device?code=BCDF-GHJK`,
  verificationUrlBare: `${apiUrl}/login/device`,
  expiresAt: "2099-01-01T00:00:00.000Z"
};

const makeLoginHarness = (client: HttpClient.HttpClient, credentialSaveDelay = 0) => {
  const files = new Map<string, string>([
    ["/state/device-login.json", JSON.stringify({ hosts: { [apiUrl]: pendingLogin } })]
  ]);
  const fs = FileSystem.layerNoop({
    exists: (file) => Effect.succeed(files.has(file)),
    readFileString: (file) => {
      const contents = files.get(file);
      return contents === undefined
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: file
            })
          )
        : Effect.succeed(contents);
    },
    makeDirectory: () => Effect.void,
    writeFileString: (file, value) =>
      Effect.sync(() => {
        files.set(file, value);
      }),
    chmod: () => Effect.void,
    rename: (from, to) =>
      Effect.gen(function* () {
        if (to === "/state/credentials.json" && credentialSaveDelay > 0) {
          yield* Effect.sleep(credentialSaveDelay);
        }
        files.set(to, files.get(from)!);
        files.delete(from);
      })
  });
  return {
    files,
    login: (
      wait: number,
      {
        complete = true,
        json = true,
        setup
      }: { complete?: boolean; json?: boolean; setup?: string } = {}
    ) =>
      Login.login({ complete, code: Option.none(), wait, setup: Option.fromNullishOr(setup) }).pipe(
        Effect.provide(State.layer.pipe(Layer.provide(NodeCryptography.layer))),
        Effect.provide(fs),
        Effect.provide(Path.layer),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STATE_DIR: "/state" }))
        ),
        Effect.provideService(Instance.Instance, { apiUrl, source: "env", token: Option.none() }),
        Effect.provideService(Instance.ApiUrlFlag, Option.none()),
        Effect.provideService(Output.JsonFlag, json),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(Api.CurrentCommand, "login"),
        Effect.provide(Stdio.layerTest({})),
        DateTime.withCurrentZone(DateTime.zoneMakeNamedUnsafe("Asia/Kolkata"))
      )
  };
};

it.effect(
  "waits only for a terminal without JSON or any agent marker, including empty markers",
  () =>
    Effect.gen(function* () {
      const markers = [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CURSOR_AGENT",
        "CODEX_SANDBOX",
        "CODEX_SANDBOX_NETWORK_DISABLED",
        "GEMINI_CLI",
        "OPENCODE",
        "CLINE_ACTIVE",
        "AI_AGENT",
        "CI"
      ];
      for (const terminal of [false, true]) {
        for (const json of [false, true]) {
          for (const marker of [undefined, ...markers]) {
            for (const value of marker === undefined ? [""] : ["", "1"]) {
              const result = yield* Login.notWaitingBecause.pipe(
                Effect.provideService(Output.JsonFlag, json),
                Effect.provide(Stdio.layerTest({ stdinIsTerminal: Effect.succeed(terminal) })),
                Effect.provide(
                  ConfigProvider.layer(
                    ConfigProvider.fromUnknown(marker === undefined ? {} : { [marker]: value }, {
                      preserveEmptyStrings: true
                    })
                  )
                )
              );
              assert.strictEqual(
                result === null,
                terminal && !json && marker === undefined,
                JSON.stringify({ terminal, json, marker, value, result })
              );
            }
          }
        }
      }
    })
);

it.effect("starts afresh for a different setup line and resumes the same one", () =>
  Effect.gen(function* () {
    const starts: Array<unknown> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.url.endsWith("/token"))
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ ok: true, status: "pending" })
          );
        if (request.body._tag === "Uint8Array")
          starts.push(JSON.parse(new TextDecoder().decode(request.body.body)));
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ ok: true, ...pendingLogin, userCode: "LMNP-QRST" }, { status: 201 })
        );
      })
    );
    const { files, login } = makeLoginHarness(client);
    const pending = () =>
      JSON.parse(files.get("/state/device-login.json")!).hosts[apiUrl] as { setupLink?: string };
    const abandoned = TestConsole.logLines.pipe(
      Effect.map((lines) =>
        String(JSON.parse(String(lines.at(-1))).agentNextSteps).startsWith(
          "Started a new login for this setup line; the earlier code no longer applies."
        )
      )
    );
    // The harness's pending login came from no line, so a line's --setup can't resume it.
    yield* login(0, { complete: false, setup: "abcdefghijklmnopqrstuvwxyz" });
    assert.strictEqual(starts.length, 1);
    assert.include(starts[0] as object, { setupLink: "abcdefghijklmnopqrstuvwxyz" });
    assert.strictEqual(pending().setupLink, "abcdefghijklmnopqrstuvwxyz");
    assert.isTrue(yield* abandoned);
    // The same line resumes; another line starts again and says the earlier code is gone.
    yield* login(0, { complete: false, setup: "abcdefghijklmnopqrstuvwxyz" });
    assert.strictEqual(starts.length, 1);
    yield* login(0, { complete: false, setup: "zyxwvutsrqponmlkjihgfedcba" });
    assert.strictEqual(starts.length, 2);
    assert.strictEqual(pending().setupLink, "zyxwvutsrqponmlkjihgfedcba");
    assert.isTrue(yield* abandoned);
    // Without --setup a rerun resumes whatever is pending, as before.
    yield* login(0, { complete: false });
    assert.strictEqual(starts.length, 2);
    // --setup starts a login, so it never goes with --complete.
    const refused = yield* Effect.result(
      login(0, { complete: true, setup: "abcdefghijklmnopqrstuvwxyz" })
    );
    assert.isTrue(Result.isFailure(refused));
  }).pipe(Effect.provide(TestConsole.layer))
);

it.effect("gives the handoff's expiry as minutes left and the clock time in the current zone", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            { ok: true, ...pendingLogin, expiresAt: "1970-01-01T00:10:00.000Z" },
            { status: 201 }
          )
        )
      )
    );
    const { files, login } = makeLoginHarness(client);
    // Asia/Kolkata is UTC+05:30 all year, so 00:10 UTC reads 05:40.
    const cases = [
      [1_000, "Expires in about 10 minutes, at 05:40"],
      [570_000, "Expires in about 1 minute, at 05:40"],
      [660_000, "Expired at 05:40"]
    ] as const;
    for (const [now] of cases) {
      files.delete("/state/device-login.json");
      yield* TestClock.setTime(now);
      yield* login(60, { complete: false, json: false });
    }
    assert.deepStrictEqual(
      yield* TestConsole.logLines,
      cases.map(([, expiry]) =>
        [
          `Sign in: ${pendingLogin.verificationUrl}`,
          `Code: ${pendingLogin.userCode}`,
          expiry,
          "Not waiting because stdin is not a terminal.",
          `Then run: patchy login --complete ${pendingLogin.userCode}`
        ].join("\n")
      )
    );
  }).pipe(Effect.provide(TestConsole.layer))
);

it.effect("backs off by five seconds on slow_down without polling past the wait budget", () =>
  Effect.gen(function* () {
    const times: number[] = [];
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        times.push(yield* Clock.currentTimeMillis);
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              ok: true,
              status: times.length === 1 ? "slow_down" : "pending"
            }),
            { headers: { "content-type": "application/json" } }
          )
        );
      })
    );
    const { login } = makeLoginHarness(client);
    const fiber = yield* login(21).pipe(Effect.forkChild);
    yield* TestClock.adjust(21_000);
    yield* Fiber.join(fiber);
    assert.deepStrictEqual(times, [0, 10_000, 20_000]);
  }).pipe(Effect.scoped)
);

for (const delay of ["response", "response body"] as const) {
  it.effect(
    `bounds a delayed ${delay} by the remaining wait budget and retains the pending login`,
    () =>
      Effect.gen(function* () {
        const requests: string[] = [];
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            requests.push(request.url);
            const response = HttpClientResponse.fromWeb(
              request,
              Response.json({ ok: true, status: "pending" })
            );
            if (requests.length === 1) return response;
            if (delay === "response") yield* Effect.sleep(2_000);
            if (delay === "response body") {
              Object.defineProperty(response, "arrayBuffer", {
                value: response.arrayBuffer.pipe(Effect.delay(2_000))
              });
            }
            return response;
          })
        );
        const { files, login } = makeLoginHarness(client);
        const originalPending = files.get("/state/device-login.json");
        const fiber = yield* login(6).pipe(
          Effect.result,
          Effect.bindTo("result"),
          Effect.bind("completedAt", () => Clock.currentTimeMillis),
          Effect.forkChild
        );
        yield* TestClock.adjust(7_000);
        const { result, completedAt } = yield* Fiber.join(fiber);
        assert(Result.isFailure(result));
        assert.strictEqual(result.failure.kind, "unreachable");
        assert.strictEqual(completedAt, 6_000);
        assert.strictEqual(files.get("/state/device-login.json"), originalPending);
        assert.isFalse(files.has("/state/credentials.json"));
        assert.deepStrictEqual(requests, [
          `${apiUrl}/api/login/device/token`,
          `${apiUrl}/api/login/device/token`
        ]);
        assert.deepStrictEqual(yield* TestConsole.logLines, []);
      }).pipe(Effect.provide(TestConsole.layer), Effect.scoped)
  );
}

it.effect("wait zero performs one real poll even when the response is delayed", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        requests.push(request.url);
        yield* Effect.sleep(2_000);
        return HttpClientResponse.fromWeb(request, Response.json({ ok: true, status: "pending" }));
      })
    );
    const { files, login } = makeLoginHarness(client);
    const originalPending = files.get("/state/device-login.json");
    const fiber = yield* login(0).pipe(Effect.forkChild);
    yield* TestClock.adjust(1_999);
    assert.deepStrictEqual(yield* TestConsole.logLines, []);
    yield* TestClock.adjust(1);
    yield* Fiber.join(fiber);
    const logs = yield* TestConsole.logLines;
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(JSON.parse(String(logs[0])).status, "pending");
    assert.deepStrictEqual(requests, [`${apiUrl}/api/login/device/token`]);
    assert.strictEqual(files.get("/state/device-login.json"), originalPending);
  }).pipe(Effect.provide(TestConsole.layer), Effect.scoped)
);

it.effect(
  "saves an in-budget completion past the deadline using its receipt without an identity request",
  () =>
    Effect.gen(function* () {
      const receipt = {
        ok: true,
        status: "complete",
        token: "one-time-key",
        machine: { id: "machine-1", name: "Work laptop" },
        company: { handle: "acme", name: "Acme" },
        user: { email: "person@acme.test" },
        expiresAt: "2099-01-01T00:00:00.000Z"
      };
      const requests: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.url);
          yield* Effect.sleep(500);
          return HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/api/login/device/token")
              ? Response.json(receipt)
              : Response.json({ error: "Unavailable" }, { status: 503 })
          );
        })
      );
      const { files, login } = makeLoginHarness(client, 2_000);
      const fiber = yield* login(1).pipe(Effect.forkChild);
      yield* TestClock.adjust(1_000);
      assert.isFalse(files.has("/state/credentials.json"));
      assert.deepStrictEqual(yield* TestConsole.logLines, []);
      yield* TestClock.adjust(2_000);
      yield* Fiber.join(fiber);
      const credential = JSON.parse(files.get("/state/credentials.json")!).hosts[apiUrl];
      assert.strictEqual(credential.token, "one-time-key");
      assert.strictEqual(credential.source, "login");
      assert.deepStrictEqual(credential.machine, receipt.machine);
      assert.deepStrictEqual(JSON.parse(files.get("/state/device-login.json")!), { hosts: {} });
      assert.deepStrictEqual(requests, [`${apiUrl}/api/login/device/token`]);
      const logs = yield* TestConsole.logLines;
      assert.strictEqual(logs.length, 1);
      assert.deepStrictEqual(JSON.parse(String(logs[0])), {
        ok: true,
        status: "logged_in",
        instanceUrl: apiUrl,
        company: receipt.company,
        user: receipt.user,
        machine: receipt.machine,
        credentialsPath: "/state/credentials.json",
        warnings: []
      });
    }).pipe(Effect.provide(TestConsole.layer), Effect.scoped)
);
