import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Instance from "./Instance.js";
import * as State from "./State.js";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Stdio from "effect/Stdio";
import * as Login from "./Login.js";
import * as Output from "./Output.js";

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
    readFileString: (file) => Effect.succeed(files.get(file)!),
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
    login: (wait: number) =>
      Login.login({ complete: true, code: Option.none(), wait }).pipe(
        Effect.provide(State.layer),
        Effect.provide(fs),
        Effect.provide(Path.layer),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STATE_DIR: "/state" }))
        ),
        Effect.provideService(Instance.Instance, { apiUrl, source: "env", token: Option.none() }),
        Effect.provideService(Instance.ApiUrlFlag, Option.none()),
        Effect.provideService(Output.JsonFlag, true),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(Stdio.layerTest({}))
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
        credentialsPath: "/state/credentials.json"
      });
    }).pipe(Effect.provide(TestConsole.layer), Effect.scoped)
);
