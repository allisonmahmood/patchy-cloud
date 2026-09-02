/**
 * The state dir: everything the CLI remembers between runs, filed per
 * instance. `credentials.json` holds one token per instance, `patches.json`
 * one cache entry per instance and file, `config.json` the saved instance
 * URL; `style.md` is the skill's and is only ever checked for existence.
 *
 * Both host-keyed files are read without interpreting the other instances'
 * entries, so a write is a real merge — an entry this command neither reads
 * nor understands is carried across untouched — and corruption over there can
 * neither block publishing here nor be mistaken for a reason to discard it.
 * Only whole-document problems are errors, because only those say nothing
 * survives. A file in the retired single-instance format fails closed
 * everywhere: the token it holds is the only key to the pages it created.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the home directory is the OS's to name.
import { homedir } from "node:os";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { LocalError } from "./CliError.js";

export type CredentialSource = "mint" | "auth-set";

export class HostCredential extends Schema.Class<HostCredential>("HostCredential")({
  token: Schema.NonEmptyString,
  updatedAt: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Literals(["mint", "auth-set"]))
}) {}

/** One entry of `patches.json`, keyed per instance then per absolute file path. */
export class CachedPatch extends Schema.Class<CachedPatch>("CachedPatch")({
  patchId: Schema.NonEmptyString,
  publicUrl: Schema.String,
  latestVersionNumber: Schema.Number,
  updatedAt: Schema.String
}) {}

/**
 * An entry written before the wire renamed `draftId` to `patchId` is the same
 * page: read as-is, rewritten under the new key on the next upload.
 */
const StoredPatch = Schema.Struct({
  patchId: Schema.optionalKey(Schema.NonEmptyString),
  draftId: Schema.optionalKey(Schema.NonEmptyString),
  publicUrl: Schema.String,
  latestVersionNumber: Schema.Number,
  updatedAt: Schema.String
});

const Hosts = Schema.Record(Schema.String, Schema.Unknown);
const HostKeyed = Schema.Struct({ hosts: Hosts });
const Files = Schema.Struct({
  files: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
});
const SavedConfig = Schema.Struct({ apiUrl: Schema.optionalKey(Schema.String) });
const Json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(Json);
const encodeJson = Schema.encodeSync(Json);
const isRecord = Schema.is(Hosts);
const decodeHostKeyed = Schema.decodeUnknownEffect(HostKeyed);
const decodeSavedConfig = Schema.decodeUnknownEffect(SavedConfig);
const decodeHostCredential = Schema.decodeUnknownEffect(HostCredential);
const decodeFiles = Schema.decodeUnknownEffect(Files);
const decodeStoredPatch = Schema.decodeUnknownEffect(StoredPatch);
const encodeCachedPatch = Schema.encodeSync(CachedPatch);

/** The moment an entry was written, as the ISO string the files have always held. */
export const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** Errors for a host-keyed state file, all at the level of the whole document. */
interface HostKeyedErrors {
  readonly unreadable: string;
  readonly invalid: string;
  readonly legacy: string;
}

export class State extends Context.Service<
  State,
  {
    readonly dir: string;
    readonly credentialsPath: string;
    readonly hasDefaultStyle: Effect.Effect<boolean>;
    readonly readConfigUrl: Effect.Effect<Option.Option<string>>;
    readonly saveConfigUrl: (apiUrl: string) => Effect.Effect<void, LocalError>;
    /** The token stored for one instance; a neighbouring instance's entry is never parsed. */
    readonly readCredential: (
      apiUrl: string
    ) => Effect.Effect<Option.Option<HostCredential>, LocalError>;
    /**
     * The single writer for a token. The operator pasting it and the instance
     * minting it record the same shape, so the two sources cannot drift in
     * what they persist or how tightly the file is locked. A file with no
     * salvageable host map is overwritten — `auth set` is the documented way
     * to replace credentials that cannot be read — but a retired flat file
     * still fails closed, and every other instance's entry is kept verbatim.
     */
    readonly saveCredential: (
      apiUrl: string,
      token: Redacted.Redacted,
      source: CredentialSource
    ) => Effect.Effect<void, LocalError>;
    readonly readCachedPatch: (
      apiUrl: string,
      file: string
    ) => Effect.Effect<Option.Option<CachedPatch>, LocalError>;
    /** Rewrites this instance's entry for `file`; every other instance's cache is carried across as stored. */
    readonly cachePatch: (
      apiUrl: string,
      file: string,
      patch: CachedPatch
    ) => Effect.Effect<void, LocalError>;
  }
>()("@patchy/cli/State") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configured = yield* Config.string("PATCHY_STATE_DIR").pipe(Config.option, Effect.orDie);
  const dir = path.resolve(
    Option.getOrElse(
      Option.filter(configured, (value) => value !== ""),
      () => path.join(homedir(), ".patchy")
    )
  );
  const configPath = path.join(dir, "config.json");
  const credentialsPath = path.join(dir, "credentials.json");
  const patchesPath = path.join(dir, "patches.json");
  // The cache before patch replaced draft. Never read: an upload that forgot it
  // would create a new patch at a new URL instead of updating the one it had.
  const retiredPatchesPath = path.join(dir, "drafts.json");
  const stylePath = path.join(dir, "style.md");

  const credentialErrors: HostKeyedErrors = {
    unreadable:
      "Stored credentials could not be read. Check permissions or run: patchy auth set to replace them.",
    invalid: "Stored credentials are invalid. Run: patchy auth set to replace them.",
    legacy:
      `Stored credentials use the retired single-instance format: ${credentialsPath}\n` +
      "Patchy Cloud now stores one token per instance and does not migrate the old file.\n" +
      "Copy the token out of that file if you still need it, delete the file, then run: patchy auth set"
  };
  const patchErrors: HostKeyedErrors = {
    unreadable: `The stored patch cache could not be read: ${patchesPath}\nCheck permissions, or delete that file to start a fresh cache.`,
    invalid: `The stored patch cache is invalid: ${patchesPath}\nDelete that file to start a fresh cache. Patches already published are unaffected.`,
    legacy:
      `The stored patch cache uses the retired single-instance format: ${patchesPath}\n` +
      "Patchy Cloud now caches patches per instance and does not migrate the old file.\n" +
      "Delete that file to start a fresh cache. Patches already published are unaffected."
  };
  const cacheMoved =
    `The patch cache is now ${patchesPath} but the old file is still here: ${retiredPatchesPath}\n` +
    "Rename it to patches.json to keep updating the patches it remembers, or delete it to start a fresh cache.";

  /** `None` when the file does not exist; the caller's errors for anything else. */
  const readDocument = (file: string, errors: { unreadable: string; invalid: string }) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => true)))) {
        return Option.none<unknown>();
      }
      const text = yield* fs
        .readFileString(file)
        .pipe(Effect.mapError((cause) => new LocalError({ message: errors.unreadable, cause })));
      return Option.some(
        yield* decodeJson(text).pipe(
          Effect.mapError((cause) => new LocalError({ message: errors.invalid, cause }))
        )
      );
    });

  /** The retired flat file, by shape: the one document nothing may overwrite. */
  const isRetired = (root: unknown, legacyKey: string) => isRecord(root) && legacyKey in root;

  const readHostKeyed = (file: string, legacyKey: string, errors: HostKeyedErrors) =>
    Effect.gen(function* () {
      const document = yield* readDocument(file, errors);
      if (Option.isNone(document)) return { hosts: {} as Record<string, unknown> };
      if (isRetired(document.value, legacyKey)) {
        return yield* new LocalError({ message: errors.legacy });
      }
      return yield* decodeHostKeyed(document.value).pipe(
        Effect.mapError((cause) => new LocalError({ message: errors.invalid, cause }))
      );
    });

  const readCredentialFile = readHostKeyed(credentialsPath, "apiToken", credentialErrors);
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const readPatchFile = Effect.gen(function* () {
    if (!(yield* exists(patchesPath)) && (yield* exists(retiredPatchesPath))) {
      return yield* new LocalError({ message: cacheMoved });
    }
    return yield* readHostKeyed(patchesPath, "files", patchErrors);
  });

  /**
   * Written whole, to a sibling temp file first, and owner-only from the first
   * byte: a token never sits on disk with wider permissions, even briefly.
   */
  const writeJson = (file: string, value: unknown) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
      const tempFile = path.join(
        dir,
        `.${path.basename(file)}.${yield* Clock.currentTimeMillis}.tmp`
      );
      yield* fs.writeFileString(tempFile, `${encodeJson(value)}\n`, {
        flag: "wx",
        mode: 0o600
      });
      yield* fs.chmod(tempFile, 0o600).pipe(Effect.ignore);
      yield* fs
        .rename(tempFile, file)
        .pipe(Effect.tapError(() => fs.remove(tempFile, { force: true }).pipe(Effect.ignore)));
    }).pipe(
      Effect.mapError(
        (cause) => new LocalError({ message: `Could not write ${file}. Check permissions.`, cause })
      )
    );

  const empty: typeof SavedConfig.Type = {};
  // Unreadable or invalid config is not a reason to stop: it only holds a preference.
  const readConfig = readDocument(configPath, { unreadable: "", invalid: "" }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(empty),
        onSome: (root) => decodeSavedConfig(root)
      })
    ),
    Effect.orElseSucceed(() => empty)
  );

  /** A per-instance entry read through its schema; the caller's message when it does not fit. */
  const entry = <A>(decoded: Effect.Effect<A, Schema.SchemaError>, message: string) =>
    decoded.pipe(Effect.mapError((cause) => new LocalError({ message, cause })));

  return State.of({
    dir,
    credentialsPath,
    hasDefaultStyle: fs.exists(stylePath).pipe(Effect.orElseSucceed(() => false)),
    readConfigUrl: readConfig.pipe(
      Effect.map((config) =>
        Option.fromUndefinedOr(config.apiUrl).pipe(Option.filter((url) => url !== ""))
      )
    ),
    saveConfigUrl: (apiUrl) =>
      readConfig.pipe(Effect.flatMap((config) => writeJson(configPath, { ...config, apiUrl }))),
    readCredential: (apiUrl) =>
      Effect.gen(function* () {
        const { hosts } = yield* readCredentialFile;
        if (!(apiUrl in hosts)) return Option.none<HostCredential>();
        return Option.some(
          yield* entry(
            decodeHostCredential(hosts[apiUrl]),
            `Stored credentials for ${apiUrl} are invalid. Run: patchy auth set --api-url ${apiUrl} to replace them.`
          )
        );
      }),
    saveCredential: (apiUrl, token, source) =>
      Effect.gen(function* () {
        // Read in two steps so the retired file is refused by its shape, and a
        // document with no salvageable host map is replaced rather than fatal.
        const document = yield* readDocument(credentialsPath, credentialErrors).pipe(
          Effect.orElseSucceed(() => Option.none<unknown>())
        );
        if (Option.isSome(document) && isRetired(document.value, "apiToken")) {
          return yield* new LocalError({ message: credentialErrors.legacy });
        }
        const { hosts } = yield* Option.match(document, {
          onNone: () => Effect.succeed({ hosts: {} as Record<string, unknown> }),
          onSome: (root) =>
            decodeHostKeyed(root).pipe(
              Effect.orElseSucceed(() => ({ hosts: {} as Record<string, unknown> }))
            )
        });
        const entry = { token: Redacted.value(token), updatedAt: yield* now, source };
        yield* writeJson(credentialsPath, { hosts: { ...hosts, [apiUrl]: entry } });
      }),
    readCachedPatch: (apiUrl, file) =>
      Effect.gen(function* () {
        const { hosts } = yield* readPatchFile;
        if (!(apiUrl in hosts)) return Option.none<CachedPatch>();
        const files = (yield* entry(decodeFiles(hosts[apiUrl]), patchErrors.invalid)).files ?? {};
        if (!(file in files)) return Option.none<CachedPatch>();
        const stored = yield* entry(decodeStoredPatch(files[file]), patchErrors.invalid);
        const patchId = stored.patchId ?? stored.draftId;
        if (patchId === undefined) return yield* new LocalError({ message: patchErrors.invalid });
        return Option.some(new CachedPatch({ ...stored, patchId }));
      }),
    cachePatch: (apiUrl, file, patch) =>
      Effect.gen(function* () {
        const { hosts } = yield* readPatchFile;
        const existing =
          apiUrl in hosts ? yield* entry(decodeFiles(hosts[apiUrl]), patchErrors.invalid) : {};
        const files = { ...existing.files, [file]: encodeCachedPatch(patch) };
        yield* writeJson(patchesPath, { hosts: { ...hosts, [apiUrl]: { files } } });
      })
  });
});

export const layer = Layer.effect(State, make);
