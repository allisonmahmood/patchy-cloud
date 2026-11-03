/**
 * What an agent sees: the `--json` global flag, the two success shapes, and
 * the contract every command's failure is rendered through. In text mode a
 * result is the lines agents already read and a failure follows any warnings on
 * stderr. Under `--json` a result is exactly one document on stdout and a
 * failure is `{ ok: false, error, kind, code?, state?, owner?, dependants?,
 * sources?, purgeAt?, versionNumber?, baseVersion?, latestVersion?, publishedBy?,
 * publishedAt?, admins?, reason?, from?, details?, retryAfterSeconds?, feedbackHint?,
 * warnings? }` on stderr, with the other stream empty.
 * The exit code comes from the failure's kind and from nowhere else.
 */
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Api from "./Api.js";
import { type CliError, type RejectedError, exitCode, refusalDetails } from "./CliError.js";

export const JsonFlag = GlobalFlag.Setting("json")({
  flag: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the result as one JSON document on stdout"),
    Flag.withDefault(false)
  )
});

const falseLiterals = new Set(["false", "no", "off", "0", "n"]);
const booleanLiterals = new Set([...falseLiterals, "true", "yes", "on", "1", "y"]);

/**
 * Whether argv asks for `--json`, read as Effect reads the flag: the first `--json`,
 * `--json=<b>`, `-json=<b>`, `--json <b>` or `--no-json` before `--` decides. The
 * entrypoint needs it before any handler runs, because that is where a parse error
 * is rendered.
 */
export const jsonRequested = (args: ReadonlyArray<string>) => {
  for (const [index, arg] of args.entries()) {
    if (arg === "--") return false;
    // Effect refuses `--no-json <b>` without recording a value, so the next one decides.
    if (arg === "--no-json" && !booleanLiterals.has(args[index + 1] ?? "")) return false;
    if (arg === "--json") return !falseLiterals.has(args[index + 1] ?? "");
    if (/^--?json=/.test(arg)) return !falseLiterals.has(arg.slice(arg.indexOf("=") + 1));
  }
  return false;
};

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
export class Failed extends Data.Error<{ readonly code: number }> {
  readonly [Runtime.errorExitCode]: number;
  readonly [Runtime.errorReported] = false;
  constructor(props: { readonly code: number }) {
    super(props);
    this[Runtime.errorExitCode] = props.code;
  }
}

const isDebug = (level: Option.Option<string>) =>
  Option.exists(level, (value) => value === "Debug" || value === "Trace" || value === "All");

/** Offered after a failure Patchy may have caused; it names the command, it doesn't order a call. */
const FEEDBACK_HINT = `If Patchy got this wrong, tell Patchy's team: patchy feedback "<what you ran and what happened>"`;

/** Commands whose own failures never offer it, so a failed `patchy feedback` doesn't point at itself. */
const unhintedCommands: ReadonlySet<string> = new Set(["feedback"]);

/**
 * The contract: a known failure is its one message and its kind's exit code;
 * a defect is `Unexpected error: <message>` and exit 1, with the stack only
 * at `--log-level debug`. Interruption is left to the runtime, which exits 130.
 * A defect, or an instance answer the CLI could not use, also offers `patchy
 * feedback`: the line after the message, or `feedbackHint` under `--json`.
 */
export const contract = <A, R>(handler: Effect.Effect<A, CliError, R>) =>
  Effect.gen(function* () {
    const json = yield* JsonFlag;
    const debug = isDebug(yield* GlobalFlag.LogLevel);
    const command = yield* Effect.serviceOption(Api.CurrentCommand);
    const hintable = !Option.exists(command, (name) => unhintedCommands.has(name));
    const warnings = new Set<string>();
    const fail = (error: string, kind: CliError["kind"], details = {}, unexpected = false) => {
      const offer = unexpected && hintable;
      return Console.error(
        json
          ? toJson({
              ok: false,
              error,
              kind,
              ...details,
              ...(offer ? { feedbackHint: FEEDBACK_HINT } : {}),
              ...(warnings.size === 0 ? {} : { warnings: [...warnings] })
            })
          : [...warnings, error, ...(offer ? [FEEDBACK_HINT] : [])].join("\n")
      ).pipe(Effect.andThen(new Failed({ code: exitCode(kind) })));
    };
    // No answer at all may be the network's; only an answer the CLI could not use offers feedback.
    const failKnown = (error: Exclude<CliError, RejectedError>) =>
      fail(
        error.message,
        error.kind,
        error.code === undefined ? {} : { code: error.code },
        error._tag === "UnreachableError" && error.reason !== "transport"
      );
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
        return fail(`Unexpected error: ${message}${stack}`, "local", {}, true);
      })
    );
  });
