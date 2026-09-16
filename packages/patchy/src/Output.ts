/**
 * What an agent sees: the `--json` global flag, the two success shapes, and
 * the contract every command's failure is rendered through. In text mode a
 * result is the lines agents already read and a failure follows any warnings on
 * stderr. Under `--json` a result is exactly one document on stdout and a
 * failure is `{ ok: false, error, kind, code?, state?, owner?, dependants?,
 * sources?, purgeAt?, warnings? }` on stderr, with the other stream empty.
 * The exit code comes from the failure's kind and from nowhere else.
 */
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Flag from "effect/unstable/cli/Flag";
import * as GlobalFlag from "effect/unstable/cli/GlobalFlag";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { type CliError, type RejectedError, exitCode, refusalDetails } from "./CliError.js";

export const JsonFlag = GlobalFlag.Setting("json")({
  flag: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the result as one JSON document on stdout"),
    Flag.withDefault(false)
  )
});

/** One JSON document; the wire shapes are encoded through their schemas before they get here. */
export const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A success: the document under `--json`, the text lines otherwise. */
export const report = (document: unknown, text: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const json = yield* JsonFlag;
    yield* Console.log(json ? toJson(document) : text.join("\n"));
  });

/** A remark beside the result, on stdout in text mode; dropped under `--json`, where stdout is the document. */
export const notice = (line: string) =>
  Effect.gen(function* () {
    if (!(yield* JsonFlag)) yield* Console.log(line);
  });

/** A warning, on stderr in text mode; dropped under `--json`, where warnings ride in the document. */
export const warn = (line: string) =>
  Effect.gen(function* () {
    if (!(yield* JsonFlag)) yield* Console.error(line);
  });

class WarningBuffer extends Context.Service<WarningBuffer, Set<string>>()(
  "patchy/Output/WarningBuffer"
) {}

/** Retain discovered notices until this command can report them, even if it fails. */
export const rememberWarnings = Effect.fn("Output.rememberWarnings")(function* (
  lines: readonly string[]
): Effect.fn.Return<void> {
  const buffer = yield* Effect.serviceOption(WarningBuffer);
  if (Option.isSome(buffer)) for (const line of lines) buffer.value.add(line);
});

/** Already rendered; carries only the exit code, so the runtime prints nothing more. */
class Failed extends Data.Error<{ readonly code: number }> {
  readonly [Runtime.errorExitCode]: number;
  readonly [Runtime.errorReported] = false;
  constructor(props: { readonly code: number }) {
    super(props);
    this[Runtime.errorExitCode] = props.code;
  }
}

const isDebug = (level: Option.Option<string>) =>
  Option.exists(level, (value) => value === "Debug" || value === "Trace" || value === "All");

/**
 * The contract: a known failure is its one message and its kind's exit code;
 * a defect is `Unexpected error: <message>` and exit 1, with the stack only
 * at `--log-level debug`. Interruption is left to the runtime, which exits 130.
 */
export const contract = <A, R>(handler: Effect.Effect<A, CliError, R>) =>
  Effect.gen(function* () {
    const json = yield* JsonFlag;
    const debug = isDebug(yield* GlobalFlag.LogLevel);
    const warnings = new Set<string>();
    const fail = (error: string, kind: CliError["kind"], details = {}) =>
      Console.error(
        json
          ? toJson({
              ok: false,
              error,
              kind,
              ...details,
              ...(warnings.size === 0 ? {} : { warnings: [...warnings] })
            })
          : warnings.size === 0
            ? error
            : [...warnings, error].join("\n")
      ).pipe(Effect.andThen(new Failed({ code: exitCode(kind) })));
    const failKnown = (error: Exclude<CliError, RejectedError>) =>
      fail(error.message, error.kind, error.code === undefined ? {} : { code: error.code });
    const failRejected = (error: RejectedError) =>
      fail(error.message, error.kind, refusalDetails(error));
    return yield* handler.pipe(
      Effect.provideService(WarningBuffer, warnings),
      Effect.catchTags({
        LocalError: failKnown,
        RejectedError: failRejected,
        UnreachableError: failKnown,
        ReleaseMismatch: failKnown,
        InstanceMismatch: failKnown
      }),
      Effect.catchDefect((defect) => {
        const message = defect instanceof Error ? defect.message : String(defect);
        const stack = debug && defect instanceof Error && defect.stack ? `\n${defect.stack}` : "";
        return fail(`Unexpected error: ${message}${stack}`, "local");
      })
    );
  });
