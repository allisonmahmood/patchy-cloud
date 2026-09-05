import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Instance from "./Instance.js";
import * as State from "./State.js";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Stdio from "effect/Stdio";
import * as Login from "./Login.js";
import * as Output from "./Output.js";

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
    const apiUrl = "http://instance.test";
    const files = new Map<string, string>([
      [
        "/state/device-login.json",
        JSON.stringify({
          hosts: {
            [apiUrl]: {
              deviceCode: "private-code",
              userCode: "BCDF-GHJK",
              interval: 5,
              verificationUrl: `${apiUrl}/login/device?code=BCDF-GHJK`,
              verificationUrlBare: `${apiUrl}/login/device`,
              expiresAt: "2099-01-01T00:00:00.000Z"
            }
          }
        })
      ]
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
        Effect.sync(() => {
          files.set(to, files.get(from)!);
          files.delete(from);
        })
    });
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
    const fiber = yield* Login.login({ complete: true, code: Option.none(), wait: 21 }).pipe(
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
      Effect.provide(Stdio.layerTest({})),
      Effect.forkChild
    );
    yield* TestClock.adjust(21_000);
    yield* Fiber.join(fiber);
    assert.deepStrictEqual(times, [0, 10_000, 20_000]);
  }).pipe(Effect.scoped)
);
