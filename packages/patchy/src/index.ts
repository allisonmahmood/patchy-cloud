/**
 * The entrypoint. Effect's built-ins stay — `--help`, `--version` (the bare
 * version string), `--completions`, `--wizard`, `--log-level` — with the
 * formatter narrowed to what an agent reads: a parse error is its one line
 * (one document under `--json`, with nothing on stdout), a version is the
 * version, and help marks the flags the parser requires as Effect marks optional
 * arguments. `NodeRuntime.runMain` turns SIGINT and SIGTERM into interruption,
 * which exits 130.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as CliError from "effect/cli/CliError";
import * as CliOutput from "effect/cli/CliOutput";
import * as Command from "effect/cli/Command";
import { Cwd, root } from "./commands.js";
import { RELEASE } from "./release.js";
import { Failed, jsonRequested, toJson } from "./Output.js";
import { NodeCryptography } from "@patchy/core";

const json = jsonRequested(process.argv.slice(2));

/**
 * Effect logs usage to stdout before a parse error's errors, but under `--json`
 * stdout holds only a result. There, help is held back and its empty line is not
 * printed: errors discard it, and the run's end prints the help that `--help` or a
 * command without a handler shows. Effect 4.0.7's `CliOutput.Presenter` replaces this.
 */
let heldHelp = "";

/** A parse error as stderr shows it: its one line, or its document under `--json`. */
const renderErrors = (errors: ReadonlyArray<CliError.CliError>) => {
  const message = errors.map((error) => error.message).join("\n");
  return json ? toJson({ ok: false, error: message, kind: "local" }) : message;
};

const formatter = CliOutput.defaultFormatter({ colors: false });
const output = CliOutput.layer({
  ...formatter,
  formatHelpDoc: (doc) => {
    const help = formatter.formatHelpDoc({
      ...doc,
      flags: doc.flags.map((flag) =>
        flag.required
          ? {
              ...flag,
              description: Option.some(`${Option.getOrElse(flag.description, () => "")} (required)`)
            }
          : flag
      )
    });
    if (!json) return help;
    heldHelp = help;
    return "";
  },
  formatVersion: (_name, version) => version,
  formatErrors: (errors) => {
    heldHelp = "";
    return renderErrors(errors);
  }
});

/** The console under `--json`, which skips the empty line held help leaves. */
const jsonConsole = Layer.effect(
  Console.Console,
  Console.consoleWith((current) =>
    Effect.succeed({
      ...current,
      log: (...args: ReadonlyArray<unknown>) => {
        if (args.length !== 1 || args[0] !== "") current.log(...args);
      }
    })
  )
);

Command.run(root, { version: RELEASE }).pipe(
  // A global flag's own bad value, such as `--log-level loud`, fails without Effect rendering it.
  Effect.catchTags({
    InvalidValue: (error) =>
      Console.error(renderErrors([error])).pipe(Effect.andThen(new Failed({ code: 1 })))
  }),
  Effect.ensuring(Effect.suspend(() => (heldHelp === "" ? Effect.void : Console.log(heldHelp)))),
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      NodeCryptography.layer,
      NodeHttpClient.layerUndici,
      // Login's agent gate tests presence, including explicitly empty variables.
      ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
      output,
      json ? jsonConsole : Layer.empty,
      // Login prints its expiry as a clock time in this machine's zone.
      DateTime.layerCurrentZoneLocal,
      Layer.succeed(Cwd, process.cwd())
    )
  ),
  NodeRuntime.runMain
);
