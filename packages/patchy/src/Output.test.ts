// When a failure offers `patchy feedback`: after a defect or an answer the CLI could not use,
// never after no answer at all, a refusal, a local mistake, or in `patchy feedback` itself.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import * as Api from "./Api.js";
import {
  type CliError,
  LocalError,
  RejectedError,
  UnreachableError,
  type UnreachableReason
} from "./CliError.js";
import * as Output from "./Output.js";

const hint = `If Patchy got this wrong, tell Patchy's team: patchy feedback "<what you ran and what happened>"`;

const unreachable = (reason: UnreachableReason) =>
  new UnreachableError({
    instanceUrl: "https://patchy.test",
    reason,
    message: "https://patchy.test gave no usable answer."
  });
const defect = Effect.die(new Error("boom"));

/** The failure as text mode prints it, and as the `--json` document, both from stderr. */
const render = (failure: Effect.Effect<never, CliError>) =>
  Effect.gen(function* () {
    for (const json of [false, true])
      yield* Output.contract(failure).pipe(
        Effect.provideService(Output.JsonFlag, json),
        Effect.exit
      );
    const [text, json] = (yield* TestConsole.errorLines).map(String);
    const document: Record<string, unknown> = JSON.parse(json!);
    return { text: text!.split("\n"), document };
  }).pipe(
    Effect.provideService(GlobalFlag.LogLevel, Option.none()),
    Effect.provide(TestConsole.layer)
  );

describe("the feedback hint", () => {
  it.effect.each([
    { path: "an unmodelled 5xx", failure: unreachable("response") },
    { path: "an unreadable body", failure: unreachable("decode") },
    { path: "an unexpected error", failure: defect }
  ])("follows $path, once", ({ failure }) =>
    Effect.gen(function* () {
      const { text, document } = yield* render(failure);
      assert.strictEqual(text.at(-1), hint);
      assert.strictEqual(text.filter((line) => line === hint).length, 1);
      assert.strictEqual(document.feedbackHint, hint);
    })
  );

  it.effect.each([
    { path: "no answer at all", failure: unreachable("transport") },
    {
      path: "a refusal such as name_taken",
      failure: new RejectedError({
        refusal: { ok: false, error: "A patch with that name exists.", code: "name_taken" }
      })
    },
    { path: "a local mistake", failure: new LocalError({ message: "File does not exist: x.html" }) }
  ])("never follows $path", ({ failure }) =>
    Effect.gen(function* () {
      const { text, document } = yield* render(failure);
      assert.notInclude(text, hint);
      assert.notProperty(document, "feedbackHint");
    })
  );

  it.effect("never follows a failure of patchy feedback itself", () =>
    Effect.gen(function* () {
      for (const failure of [unreachable("response"), defect]) {
        const { text, document } = yield* render(failure).pipe(
          Effect.provideService(Api.CurrentCommand, "feedback")
        );
        assert.notInclude(text, hint);
        assert.notProperty(document, "feedbackHint");
      }
    })
  );
});
