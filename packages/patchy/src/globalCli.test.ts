import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as TestClock from "effect/testing/TestClock";
import { NodeCryptography } from "@patchy/core";
import { updateGlobalCli } from "./globalCli.js";
import * as Instance from "./Instance.js";
import { installLine } from "./ReleaseCheck.js";
import * as State from "./State.js";

// Nothing listens on port 9, so a download attempted by mistake fails at once, offline.
const instanceUrl = "http://127.0.0.1:9";
const release = "2.0.0";

/**
 * A loopback instance that answers `/install.mjs` with `answer` and resolves `requested` once it
 * has been asked; closed, with any connection it left open, at the end of the test.
 */
const instance = Effect.fn("instance")(function* (answer: (response: ServerResponse) => void) {
  let asked = () => {};
  const requested = new Promise<void>((resolve) => (asked = resolve));
  const server = createServer((request, response) => {
    asked();
    if (request.url === "/install.mjs") answer(response);
    else response.writeHead(404).end();
  });
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
    () =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      })
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requested: Effect.promise(() => requested)
  };
});

/**
 * A throwaway home whose saved instance is `saved`, or `instance`. State reads `~/.patchy` there, as it does on
 * a person's machine, while the step sees `env` as the process environment: none by default.
 */
const machine = Effect.fn("machine")(function* (
  options: {
    readonly saved?: string;
    readonly instance?: string;
    readonly env?: (stateDir: string) => Record<string, string>;
    readonly source?: Instance.Source;
    readonly state?: (state: State.State["Service"]) => State.State["Service"];
    readonly http?: Layer.Layer<HttpClient.HttpClient>;
  } = {}
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy global cli " });
  const home = path.join(root, "home");
  const stateDir = path.join(home, ".patchy");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ apiUrl: options.saved ?? options.instance ?? instanceUrl })
  );
  /** The managed install's manifest, or bytes in its place. */
  const managed = (contents: string) => {
    const pkg = path.join(home, ".patchy/cli/node_modules/patchy");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), contents);
  };
  /** An install from before ~/.patchy/cli: npm's global `patchy`, its skill linked for agents. */
  const earlier = () => {
    const pkg = path.join(root, "npm prefix/lib/node_modules/patchy");
    mkdirSync(path.join(pkg, "skills/patchy"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "patchy" }));
    writeFileSync(path.join(pkg, "skills/patchy/SKILL.md"), "# Patchy\n");
    mkdirSync(path.join(home, ".claude/skills"), { recursive: true });
    symlinkSync(path.join(pkg, "skills/patchy"), path.join(home, ".claude/skills/patchy"));
  };
  const state = Layer.effect(
    State.State,
    Effect.map(State.make, (service) => options.state?.(service) ?? service)
  ).pipe(
    Layer.provide(NodeCryptography.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STATE_DIR: stateDir })))
  );
  const update = updateGlobalCli(release, home).pipe(
    Effect.provide(
      Layer.mergeAll(
        state,
        Layer.succeed(
          Instance.Instance,
          Instance.Instance.of({
            apiUrl: options.instance ?? instanceUrl,
            source: options.source ?? "project",
            token: Option.none()
          })
        ),
        // Fetch, so the suite runs on Bun too; the CLI provides undici on Node.
        options.http ?? FetchHttpClient.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown(options.env?.(stateDir) ?? {}))
      )
    )
  );
  return { stateDir, managed, earlier, update };
});

const manifest = (version: string) => JSON.stringify({ name: "patchy", version });
const nothing = { warnings: [] };

it.layer(NodeServices.layer)("refresh and this machine's global CLI", (it) => {
  it.effect("tells an install from before ~/.patchy/cli to run the install line once", () =>
    Effect.gen(function* () {
      const { earlier, update } = yield* machine();
      earlier();
      const { warnings, ...rest } = yield* update;
      assert.deepStrictEqual(rest, {});
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0], "installed before the installer kept them under ~/.patchy");
      assert.include(warnings[0], installLine(instanceUrl));
    })
  );

  it.effect("compares the saved instance the way instance_mismatch does", () =>
    Effect.gen(function* () {
      const { earlier, update } = yield* machine({ saved: ` ${instanceUrl}/ ` });
      earlier();
      assert.strictEqual((yield* update).warnings.length, 1);
    })
  );

  it.effect("leaves a machine whose saved instance is another one alone", () =>
    Effect.gen(function* () {
      const { earlier, managed, update } = yield* machine({ saved: "https://other.example" });
      earlier();
      managed(manifest("1.0.0"));
      assert.deepStrictEqual(yield* update, nothing);
    })
  );

  it.effect("leaves the home alone whenever PATCHY_STATE_DIR is set, even to ~/.patchy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "patchy state " });
      for (const env of [
        () => ({ PATCHY_STATE_DIR: elsewhere }),
        (own: string) => ({ PATCHY_STATE_DIR: own })
      ]) {
        const { earlier, managed, update } = yield* machine({ env });
        earlier();
        managed(manifest("1.0.0"));
        assert.deepStrictEqual(yield* update, nothing);
      }
    })
  );

  it.effect("leaves the home alone when a worktree's dev env names the instance", () =>
    Effect.gen(function* () {
      const { earlier, managed, update } = yield* machine({ source: "dev-env" });
      earlier();
      managed(manifest("1.0.0"));
      assert.deepStrictEqual(yield* update, nothing);
    })
  );

  it.effect.each(["2.0.0", "2.1.0"])("never touches a managed install at %s", (version) =>
    Effect.gen(function* () {
      const { earlier, managed, update } = yield* machine();
      earlier();
      managed(manifest(version));
      assert.deepStrictEqual(yield* update, nothing);
    })
  );

  it.effect("says nothing on a machine with no global install", () =>
    Effect.gen(function* () {
      const { update } = yield* machine();
      assert.deepStrictEqual(yield* update, nothing);
    })
  );

  it.effect("does nothing rather than warn when the managed install can't be read", () =>
    Effect.gen(function* () {
      const { earlier, managed, update } = yield* machine();
      earlier();
      managed("{ not json");
      assert.deepStrictEqual(yield* update, nothing);
    })
  );

  it.effect("stays silent when reading this machine's state dies", () =>
    Effect.gen(function* () {
      const { earlier, update } = yield* machine({
        state: (state) => ({ ...state, readConfigUrl: Effect.die(new Error("the disk broke")) })
      });
      earlier();
      assert.deepStrictEqual(yield* update, nothing);
    })
  );

  it.effect(
    "downloads the instance's installer for an older managed install, relaying why it stopped",
    () =>
      Effect.gen(function* () {
        const { managed, update } = yield* machine();
        managed(manifest("1.9.0"));
        const { warnings, ...rest } = yield* update;
        assert.deepStrictEqual(rest, {});
        assert.deepStrictEqual(warnings, [
          `Updating this machine's patchy CLI and skill from 1.9.0 to 2.0.0 stopped:\nCould not download ${instanceUrl}/install.mjs.\nInstall line: ${installLine(instanceUrl)}`
        ]);
      })
  );

  it.effect("warns instead of failing the refresh when the installer step dies", () =>
    Effect.gen(function* () {
      const { managed, update } = yield* machine({
        http: Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die(new Error("the client broke")))
        )
      });
      managed(manifest("1.9.0"));
      const { warnings } = yield* update;
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0], "stopped:\nthe client broke\nInstall line: ");
    })
  );
  it.effect.each([
    {
      name: "a 204",
      answer: (response: ServerResponse) => response.writeHead(204).end(),
      reason: "answered 204, not the installer."
    },
    {
      name: "an empty 200",
      answer: (response: ServerResponse) => response.writeHead(200).end(),
      reason: "The installer finished, but ~/.patchy/cli holds patchy 1.9.0, not 2.0.0."
    }
  ])("reports no update from $name, only a warning", ({ answer, reason }) =>
    Effect.gen(function* () {
      const { url } = yield* instance(answer);
      const { managed, update } = yield* machine({ instance: url });
      managed(manifest("1.9.0"));
      const { warnings, ...rest } = yield* update;
      assert.deepStrictEqual(rest, {});
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0], reason);
    })
  );

  it.effect("abandons an installer larger than 1 MiB before running anything", () =>
    Effect.gen(function* () {
      // A comment, so even running it would do nothing.
      const { url } = yield* instance((response) =>
        response.writeHead(200).end(`//${"x".repeat(1024 * 1024)}\n`)
      );
      const { managed, update } = yield* machine({ instance: url });
      managed(manifest("1.9.0"));
      const { warnings, ...rest } = yield* update;
      assert.deepStrictEqual(rest, {});
      assert.deepStrictEqual(warnings, [
        `Updating this machine's patchy CLI and skill from 1.9.0 to 2.0.0 stopped:\n${url}/install.mjs sent more than 1 MiB, which is not the installer.\nInstall line: ${installLine(url)}`
      ]);
    })
  );

  it.effect("abandons an installer that doesn't finish within 30 seconds", () =>
    Effect.gen(function* () {
      const { url, requested } = yield* instance((response) => {
        response.writeHead(200);
        response.write("// and nothing more");
      });
      const { managed, update } = yield* machine({ instance: url });
      managed(manifest("1.9.0"));
      const running = yield* Effect.forkChild(update);
      yield* requested;
      yield* TestClock.adjust("31 seconds");
      // Real time, so a step that never gives up fails here instead of hanging the suite.
      const ended = yield* TestClock.withLive(
        Effect.timeoutOption(Fiber.join(running), "2 seconds")
      );
      assert.isTrue(Option.isSome(ended), "the step was still waiting on the download");
      assert.include(
        Option.getOrThrow(ended).warnings[0],
        `stopped:\n${url}/install.mjs did not send the installer within 30 seconds.\n`
      );
    })
  );
});
