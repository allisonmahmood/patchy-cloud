/**
 * The sanitizer: every evidence command that writes what a CLI or an agent
 * printed puts it through here first. `pnpm dev transcript` does, and `trial`
 * (#793) calls `collect` after each agent command.
 *
 * It collects secrets for the whole run and keeps every value it has seen
 * until the last write, so a login code that a later `patchy logout` cleared
 * is still redacted. It collects from three sources:
 *
 * - **CLI state**: each state dir's JSON files, read on `collect`. Every string
 *   under a key whose name marks it secret, such as `token`, `deviceCode` or
 *   `userCode`.
 * - **Machine tokens**: anything shaped like one (`pp_…`), wherever it appears.
 * - **Variables**: the values of variables the runner passes whose names mark
 *   them secret, such as `PATCHY_API_TOKEN` or `ANTHROPIC_API_KEY`.
 *
 * Redaction is a backstop, not a guarantee. The closed environment, which keeps
 * the developer's own secrets out of reach, is the first line.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export type SecretSource = "cli-state" | "machine-token" | "variable";

/** What replaces each secret. */
export const REDACTED = "[redacted]";

/** Shorter values are left alone: redacting them would cut ordinary words out of the output. */
const MIN_SECRET_LENGTH = 8;

const MACHINE_TOKEN = /\bpp_[A-Za-z0-9_-]{8,}/g;

/** Anywhere in a name, these mark it secret: `PGPASSWORD` as much as `token`. */
const SECRET_PARTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "apikey",
  "cookie"
];
const CODE_KINDS = new Set(["device", "user", "auth", "login"]);

/**
 * Whether a variable's or JSON key's name marks its value secret:
 * `PATCHY_API_TOKEN`, `CLERK_SECRET_KEY`, `deviceCode` and `userCode` do;
 * `HOME`, `verificationUrl` and a bare `key` or `code` don't.
 */
export const marksSecret = (name: string) => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  const [last, before] = [words.at(-1), words.at(-2)];
  return (
    SECRET_PARTS.some((part) => words.join("").includes(part)) ||
    (before !== undefined && (last === "key" || (last === "code" && CODE_KINDS.has(before))))
  );
};

/** Every string under a secret-named key, at any depth. */
export const secretsInJson = (value: unknown, secret = false): ReadonlyArray<string> => {
  if (typeof value === "string") return secret ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => secretsInJson(item, secret));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, item]) =>
      secretsInJson(item, secret || marksSecret(key))
    );
  return [];
};

/** A collected value, and the forms it takes inside a URL or a JSON string. */
const forms = (value: string) => [
  ...new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
];

/**
 * `text` with every collected value, and anything shaped like a machine token,
 * replaced by `[redacted]`. Longer values go first, so one that contains
 * another is replaced whole. Returns the sources that matched.
 */
export const redactText = (secrets: ReadonlyMap<string, SecretSource>, text: string) => {
  const matched = new Set<SecretSource>();
  let result = text;
  const ordered = [...secrets].flatMap(([value, source]) =>
    forms(value).map((form) => [form, source] as const)
  );
  ordered.sort(([a], [b]) => b.length - a.length);
  for (const [value, source] of ordered) {
    if (!result.includes(value)) continue;
    result = result.split(value).join(REDACTED);
    matched.add(source);
  }
  result = result.replace(MACHINE_TOKEN, () => {
    matched.add("machine-token");
    return REDACTED;
  });
  return { text: result, matched };
};

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The secrets in one CLI state dir now: every JSON file in it, at any depth. A missing dir holds none. */
const secretsInStateDir = Effect.fn("Sanitize.secretsInStateDir")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(dir))) return [];
  const found: Array<string> = [];
  for (const name of yield* fs.readDirectory(dir, { recursive: true })) {
    if (!name.endsWith(".json")) continue;
    // A file another process is writing reads as invalid JSON; the next collect sees it whole.
    const parsed = yield* fs
      .readFileString(path.join(dir, name))
      .pipe(Effect.flatMap(decodeJson), Effect.option);
    if (Option.isSome(parsed)) found.push(...secretsInJson(parsed.value));
  }
  return found;
});

/** How the section names each source that matched. */
const SOURCE_NAMES: Record<SecretSource, string> = {
  "cli-state": "tokens and login codes from each side's CLI state",
  "machine-token": "strings shaped like machine tokens (`pp_…`)",
  variable: "secret-named variables the runner passed"
};

/** The sentence a section carries about what was redacted. */
export const redactionLine = (matched: ReadonlyArray<SecretSource>) =>
  matched.length === 0
    ? "Nothing in it matched a collected secret (each side's CLI state, machine-token shapes and secret-named variables)."
    : `Redacted before writing: ${matched.map((source) => SOURCE_NAMES[source]).join("; ")}.`;

/**
 * A sanitizer for one run: it reads `stateDirs` and the secret-named values in
 * `envs` (each environment the runner passes) at once, `collect` reads the
 * state dirs again, and `redact` uses every value seen so far. `matched` lists
 * the sources `redact` has replaced something from, in a stable order.
 */
export const makeSanitizer = Effect.fn("Sanitize.makeSanitizer")(function* (input: {
  readonly stateDirs: ReadonlyArray<string>;
  readonly envs: ReadonlyArray<Readonly<Record<string, string>>>;
}) {
  const secrets = yield* Ref.make(new Map<string, SecretSource>());
  const matched = yield* Ref.make(new Set<SecretSource>());
  const add = (values: ReadonlyArray<string>, source: SecretSource) =>
    Ref.update(secrets, (known) => {
      const next = new Map(known);
      for (const value of values)
        if (value.length >= MIN_SECRET_LENGTH && !next.has(value)) next.set(value, source);
      return next;
    });
  yield* add(
    input.envs.flatMap((env) =>
      Object.entries(env).flatMap(([name, value]) => (marksSecret(name) ? [value] : []))
    ),
    "variable"
  );
  const collect = Effect.forEach(input.stateDirs, (dir) =>
    secretsInStateDir(dir).pipe(Effect.flatMap((values) => add(values, "cli-state")))
  ).pipe(Effect.asVoid);
  yield* collect;
  return {
    collect,
    redact: (text: string) =>
      Effect.gen(function* () {
        const result = redactText(yield* Ref.get(secrets), text);
        yield* Ref.update(matched, (sources) => new Set([...sources, ...result.matched]));
        return result.text;
      }),
    matched: Effect.map(Ref.get(matched), (sources) =>
      (["cli-state", "machine-token", "variable"] as const).filter((source) => sources.has(source))
    )
  };
});

export type Sanitizer = Effect.Success<ReturnType<typeof makeSanitizer>>;
