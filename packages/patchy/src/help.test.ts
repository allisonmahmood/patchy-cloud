// Agents read `--help` before calling a command, so every listed command describes all it takes.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as CliOutput from "effect/cli/CliOutput";
import * as Command from "effect/cli/Command";
import type { HelpDoc } from "effect/cli/HelpDoc";
import * as TestConsole from "effect/testing/TestConsole";
import { Cwd, root } from "./commands.js";

/** Blank, or only the `(choices: …)` Effect appends to a choice flag. */
const undescribed = (description: Option.Option<string>) =>
  !/\S/.test(Option.getOrElse(description, () => "").replace(/\(choices: [^)]*\)$/, ""));

it.effect("describes every argument and flag, and requires only look publish's --note", () => {
  const captured: HelpDoc[] = [];
  return Effect.gen(function* () {
    const help = Command.runWith(root, { version: "test" });
    const visited: string[] = [];
    const gaps: string[] = [];
    const required: string[] = [];
    // Breadth-first from `patchy --help`; unlisted commands such as `__generate` are not in it.
    const pending: Array<ReadonlyArray<string>> = [[]];
    while (pending.length > 0) {
      const path = pending.shift()!;
      const command = ["patchy", ...path].join(" ");
      captured.length = 0;
      yield* help([...path, "--help"]);
      assert.lengthOf(captured, 1, `${command} --help printed no help`);
      const doc = captured[0]!;
      visited.push(command);
      for (const arg of doc.args ?? [])
        if (undescribed(arg.description)) gaps.push(`${command} <${arg.name}>`);
      for (const flag of [...doc.flags, ...(doc.globalFlags ?? [])]) {
        if (undescribed(flag.description)) gaps.push(`${command} --${flag.name}`);
        if (flag.required) required.push(`${command} --${flag.name}`);
      }
      for (const group of doc.subcommands ?? [])
        for (const sub of group.commands) pending.push([...path, sub.name]);
    }
    assert.include(visited, "patchy look publish");
    assert.deepStrictEqual(gaps, []);
    // The entrypoint marks these `(required)`; prose-required flags such as init's --purpose
    // and delete's --yes stay optional to the parser.
    assert.deepStrictEqual(required, ["patchy look publish --note"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        CliOutput.layer({
          ...CliOutput.defaultFormatter({ colors: false }),
          formatHelpDoc: (doc) => {
            captured.push(doc);
            return "";
          }
        }),
        NodeServices.layer,
        NodeHttpClient.layerUndici,
        TestConsole.layer,
        DateTime.layerCurrentZoneOffset(0),
        Layer.succeed(Cwd, process.cwd())
      )
    )
  );
});
