/**
 * The entrypoint. Effect's built-ins stay — `--help`, `--version` (the bare
 * version string), `--completions`, `--wizard`, `--log-level` — with the
 * formatter narrowed to what an agent reads: a parse error is its one line
 * (one document under `--json`), a version is the version. `NodeRuntime.runMain`
 * turns SIGINT and SIGTERM into interruption, which exits 130.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CliOutput from "effect/unstable/cli/CliOutput";
import * as Command from "effect/unstable/cli/Command";
import { Cwd, root, VERSION } from "./commands.js";
import { toJson } from "./Output.js";

/** Read from argv here because a parse error is rendered before any handler runs. */
const json = process.argv.includes("--json");

const formatter = CliOutput.defaultFormatter({ colors: false });
const output = CliOutput.layer({
  ...formatter,
  formatVersion: (_name, version) => version,
  formatErrors: (errors) => {
    const message = errors.map((error) => error.message).join("\n");
    return json ? toJson({ ok: false, error: message, kind: "local" }) : message;
  }
});

Command.run(root, { version: VERSION }).pipe(
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      NodeHttpClient.layerUndici,
      output,
      Layer.succeed(Cwd, process.cwd())
    )
  ),
  NodeRuntime.runMain
);
