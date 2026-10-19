/**
 * The sanitizer: every evidence command that writes what a CLI or an agent
 * printed puts it through here first. `pnpm dev transcript` does, and so does
 * `pnpm dev trial`, which calls `collect` after each tool call its agent makes.
 *
 * It collects secrets for the whole run and keeps every value it has seen
 * until the last write, so a login code that a later `patchy logout` cleared
 * is still redacted. It collects from these sources:
 *
 * - **CLI state**: each state dir's JSON files, read on `collect`. Every string
 *   under a key whose name marks it secret, such as `token`, `deviceCode` or
 *   `userCode`.
 * - **Shapes**: anything shaped like a machine token (`pp_…`) or a login code
 *   (`BCDF-GHJK`), wherever it appears. A line that logs in and out in one
 *   `bash -c` can clear its code before any `collect` sees it; the shape
 *   still does. So is any email address outside the reserved domains the
 *   scenarios and the seed use, `@` or `%40`, as a backstop for an address
 *   no source names.
 * - **Variables**: the values of variables the runner passes whose names mark
 *   them secret, such as `PATCHY_API_TOKEN` or `ANTHROPIC_API_KEY`.
 * - **Identities**: values the caller passes for who a run acts as beyond
 *   the scenario, such as the Claude account `trial`'s agent is signed in as,
 *   which Claude Code tells the agent, and git's author email.
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

export const SECRET_SOURCES = [
  "cli-state",
  "machine-token",
  "login-code",
  "email",
  "variable",
  "identity"
] as const;
export type SecretSource = (typeof SECRET_SOURCES)[number];

/** What replaces each secret. */
export const REDACTED = "[redacted]";

const MACHINE_TOKEN = /\bpp_[A-Za-z0-9_-]{8,}/g;
/** The user code `patchy login` prints, from the alphabet in `packages/auth/src/DeviceLogins.ts`. */
const LOGIN_CODE = /\b[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}\b/g;
/**
 * An email address, its `@` written or URL-encoded as `%40`: a quoted or plain
 * local part, Unicode included, and a domain whose top level is letters (or
 * punycode), so `patchy@0.14.0` isn't one. A match only starts where a run
 * of local-part characters does, so a long run with no `@` is scanned once,
 * not once per character. Leading apostrophes, as in `'jane@company.com'` or
 * `'"jane doe"@company.com'`, are matched but left out of the span; a plain
 * local part never starts with one, so they are read once.
 */
const EMAIL =
  /(?<![\p{L}\p{N}._%+'-])'*(?:"[^"\n]+"|[\p{L}\p{N}._%+-][\p{L}\p{N}._%+'-]*)(?:@|%40)(?:[\p{L}\p{N}-]+\.)+(?:\p{L}{2,}|xn--[\p{L}\p{N}-]+)(?![\p{L}\p{N}-])/giu;
/**
 * Domains reserved for examples and tests (RFC 2606, 6761), which every
 * scenario person uses, and the seed's `patchy.local`. Other `.local` names
 * are real machines on a network.
 */
const EXAMPLE_DOMAIN =
  /(?:^|\.)(?:example|test|invalid|localhost)$|^(?:example\.(?:com|net|org)|patchy\.local)$/i;
/** The domain of an address `EMAIL` matched. */
const domainOf = (address: string) => address.replace(/^.*(?:@|%40)/i, "");

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

/** Each shape, its source, and which of its matches are redacted. */
const SHAPES: ReadonlyArray<readonly [RegExp, SecretSource, (match: string) => boolean]> = [
  [MACHINE_TOKEN, "machine-token", () => true],
  [LOGIN_CODE, "login-code", () => true],
  [EMAIL, "email", (address) => !EXAMPLE_DOMAIN.test(domainOf(address))]
];

interface Span {
  readonly start: number;
  readonly end: number;
  /** Null for a `[redacted]` already in the text. */
  readonly source: SecretSource | null;
}

/**
 * `text` with every collected value, anything shaped like a machine token or
 * a login code, and any email address outside the example domains, replaced
 * by `[redacted]`. Every match is found in the
 * original text before anything is replaced, and overlapping matches become
 * one, so a short value can't break up a longer one or a shape. A `[redacted]`
 * already in the text counts as a match, so redacting twice changes nothing.
 * Returns the sources that matched something not already redacted.
 */
export const redactText = (secrets: ReadonlyMap<string, SecretSource>, text: string) => {
  const spans: Array<Span> = [];
  const find = (value: string, source: SecretSource | null) => {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1))
      spans.push({ start: at, end: at + value.length, source });
  };
  find(REDACTED, null);
  for (const [value, source] of secrets) for (const form of forms(value)) find(form, source);
  for (const [shape, source, redacts] of SHAPES)
    for (const match of text.matchAll(shape)) {
      const lead = /^'*/.exec(match[0])![0].length;
      if (redacts(match[0].slice(lead)))
        spans.push({ start: match.index + lead, end: match.index + match[0].length, source });
    }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const done = spans.filter((span) => span.source === null);
  const matched = new Set<SecretSource>();
  let result = "";
  let at = 0;
  for (let index = 0; index < spans.length;) {
    const start = spans[index]!.start;
    let end = start;
    for (; index < spans.length && spans[index]!.start < Math.max(end, start + 1); index++) {
      const span = spans[index]!;
      end = Math.max(end, span.end);
      if (
        span.source !== null &&
        !done.some((already) => already.start <= span.start && span.end <= already.end)
      )
        matched.add(span.source);
    }
    result += `${text.slice(at, start)}${REDACTED}`;
    at = end;
  }
  return { text: result + text.slice(at), matched };
};

/** Every string in a JSON value redacted, its structure untouched. */
const redactJson = (
  secrets: ReadonlyMap<string, SecretSource>,
  value: unknown,
  matched: Set<SecretSource>
): unknown => {
  if (typeof value === "string") {
    const result = redactText(secrets, value);
    for (const source of result.matched) matched.add(source);
    return result.text;
  }
  if (Array.isArray(value)) return value.map((item) => redactJson(secrets, item, matched));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJson(secrets, item, matched)])
    );
  return value;
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
  "login-code": "strings shaped like login codes",
  email: "email addresses outside the scenarios' example domains",
  variable: "secret-named variables the runner passed",
  identity: "the accounts the run acts as"
};

/** The sentence a section carries about what was redacted. */
export const redactionLine = (matched: ReadonlyArray<SecretSource>) =>
  matched.length === 0
    ? "Nothing in it matched a collected secret (each side's CLI state, machine-token and login-code shapes, email addresses outside the scenarios' example domains, secret-named variables, and any accounts the run acts as)."
    : `Redacted before writing: ${matched.map((source) => SOURCE_NAMES[source]).join("; ")}.`;

/**
 * A sanitizer for one run: it reads `stateDirs` and the secret-named values in
 * `envs` (each environment the runner passes) at once and takes `identities`
 * whole, `collect` reads the state dirs again, and `redact` uses every value
 * seen so far. `matched` lists
 * the sources `redact` has replaced something from, in a stable order.
 */
export const makeSanitizer = Effect.fn("Sanitize.makeSanitizer")(function* (input: {
  readonly stateDirs: ReadonlyArray<string>;
  readonly envs: ReadonlyArray<Readonly<Record<string, string>>>;
  readonly identities?: ReadonlyArray<string>;
}) {
  const secrets = yield* Ref.make(new Map<string, SecretSource>());
  const matched = yield* Ref.make(new Set<SecretSource>());
  const add = (values: ReadonlyArray<string>, source: SecretSource) =>
    Ref.update(secrets, (known) => {
      const next = new Map(known);
      // Any length: a short value is still a secret, even if redacting it cuts into other words.
      for (const value of values) if (value !== "" && !next.has(value)) next.set(value, source);
      return next;
    });
  yield* add(
    input.envs.flatMap((env) =>
      Object.entries(env).flatMap(([name, value]) => (marksSecret(name) ? [value] : []))
    ),
    "variable"
  );
  yield* add(input.identities ?? [], "identity");
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
    /** Every string in an encoded JSON value redacted, so the document stays valid however short a secret is. */
    redactJson: (value: unknown) =>
      Effect.gen(function* () {
        const found = new Set<SecretSource>();
        const result = redactJson(yield* Ref.get(secrets), value, found);
        yield* Ref.update(matched, (sources) => new Set([...sources, ...found]));
        return result;
      }),
    matched: Effect.map(Ref.get(matched), (sources) =>
      SECRET_SOURCES.filter((source) => sources.has(source))
    )
  };
});

export type Sanitizer = Effect.Success<ReturnType<typeof makeSanitizer>>;
