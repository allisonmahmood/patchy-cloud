/**
 * Each command handler yields what it needs — the resolved
 * `Instance`, the `State` dir, the derived client — and fails only with a
 * `CliError`, so the contract in `Output` is the whole of what an agent sees.
 * User-facing copy calls a token a publishing key.
 */
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as Prompt from "effect/unstable/cli/Prompt";
import {
  Identity,
  Ok,
  Shared,
  ShareRequest,
  SharingScope,
  UploadCreated,
  UploadMetadata,
  UploadRequest,
  UploadUpdated
} from "@patchy/api";
import { sha256, validateHtml } from "@patchy/core";
import * as Api from "./Api.js";
import { type CliError, LocalError, RejectedError } from "./CliError.js";
import * as Git from "./Git.js";
import * as Instance from "./Instance.js";
import * as Output from "./Output.js";
import * as State from "./State.js";

export const VERSION = typeof __PATCHY_VERSION__ === "string" ? __PATCHY_VERSION__ : "0.0.0-dev";

/** The working directory the entrypoint started in; where the dev-env walk begins. */
export class Cwd extends Context.Service<Cwd, string>()("@patchy/cli/commands/Cwd") {}

/** The instance and the state dir, resolved once per command from the working directory. */
const local = Layer.provideMerge(
  Layer.unwrap(Effect.map(Cwd, (cwd) => Instance.layer(cwd))),
  State.layer
);

/** Every handler runs under the output contract with `Instance` and `State` resolved. */
const run = <A, R>(handler: Effect.Effect<A, CliError, R>) =>
  Output.contract(handler).pipe(Effect.provide(local));

const encodeIdentity = Schema.encodeSync(Identity);
// A create is 201, an update 200; the wire names them separately.
const encodeUpload = Schema.encodeSync(Schema.Union([UploadCreated, UploadUpdated]));
const encodeOk = Schema.encodeSync(Ok);
const encodeShared = Schema.encodeSync(Shared);
const decodeSharingScope = Schema.decodeUnknownEffect(SharingScope);
const scopeLines = {
  company: "Scope: company (signed-in colleagues in your company)",
  public: "Scope: public (anyone with the link)"
} satisfies Record<typeof SharingScope.Type, string>;

/** Wire literal of the 401 (`Unauthorized` in `@patchy/api`); the hint below keys on it. */
const UNAUTHORIZED = "Missing or invalid API token.";
/** Wire literal of the patch-route 404; `upload` and `delete` each turn it into their next action. */
const PATCH_NOT_FOUND = "Patch not found.";

/**
 * Appended to a 401/403 from the default instance only — the local server this
 * repo runs. A rejected request means the key that was sent is bad.
 */
const defaultHostHint = (apiUrl: string) =>
  apiUrl === Instance.DEFAULT_API_URL
    ? `\nThe publishing key sent to ${apiUrl} was not accepted. Save a working one with: patchy auth set --api-url ${apiUrl}\nTo publish to an instance somewhere else, point the CLI at it with --api-url or PATCHY_API_URL.`
    : "";

/** A refusal of a protected route, with the hint when the key itself was refused. */
const refused = (error: Api.ClientFailure, fallback: string) =>
  Effect.gen(function* () {
    const { apiUrl } = yield* Instance.Instance;
    if (Api.isRefusal(error) && error.error === UNAUTHORIZED) {
      return yield* new RejectedError({ message: `${error.error}${defaultHostHint(apiUrl)}` });
    }
    return yield* Api.classify(error, fallback);
  });

/** Credential precedence: environment, stored key, then the worktree's seed. */
const configuredCredential = Effect.gen(function* () {
  const env = yield* Instance.optionalSecret("PATCHY_API_TOKEN");
  if (Option.isSome(env)) return Option.some({ token: env.value, source: null });
  const instance = yield* Instance.Instance;
  const state = yield* State.State;
  const stored = yield* state.readCredential(instance.apiUrl);
  if (Option.isSome(stored)) {
    return Option.some({
      token: Redacted.make(stored.value.token),
      source: stored.value.source ?? null
    });
  }
  return Option.map(instance.token, (token) => ({ token, source: null }));
});

/** Protected commands fail locally before making a request without a key. */
const requiredToken = Effect.fn("requiredToken")(function* (nextCommand = "auth set") {
  const credential = yield* configuredCredential;
  if (Option.isSome(credential)) return credential.value.token;
  const { apiUrl } = yield* Instance.Instance;
  return yield* new LocalError({
    message: `No publishing key is stored for ${apiUrl}.\nRun: patchy ${nextCommand} --api-url ${apiUrl}`
  });
});

const readHtml = Effect.fn("readHtml")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(file);
  if (!(yield* fs.exists(resolved).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new LocalError({ message: `File does not exist: ${resolved}` });
  }
  const html = yield* fs
    .readFileString(resolved)
    .pipe(
      Effect.mapError((cause) => new LocalError({ message: `Could not read ${resolved}.`, cause }))
    );
  return { resolved, html };
});

const validated = Effect.fn("validated")(function* (html: string) {
  const validation = validateHtml(html);
  if (!validation.ok) {
    return yield* new LocalError({
      message: `HTML failed Patchy Cloud validation:\n- ${validation.errors.join("\n- ")}`
    });
  }
  return validation.warnings;
});

// --- auth set ---------------------------------------------------------------

const parseApiToken = (input: string, fromStdin: boolean) =>
  Effect.gen(function* () {
    const token = fromStdin ? input.replace(/\r?\n$/, "") : input;
    if (/[\r\n]/.test(token)) {
      return yield* new LocalError({ message: "API token must be provided as a single line." });
    }
    if (!token.trim()) return yield* new LocalError({ message: "API token cannot be empty." });
    if (token !== token.trim()) {
      return yield* new LocalError({ message: "API token cannot begin or end with whitespace." });
    }
    return Redacted.make(token);
  });

/**
 * The hidden prompt. Effect's terminal owns raw mode, so interruption restores
 * it by construction; Ctrl-C and end of input are `QuitError`, rendered as
 * interruption — exit 130, like any other signal.
 */
const promptForToken = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (!(yield* stdio.stdinIsTerminal)) {
    return yield* new LocalError({
      message:
        "Interactive token entry requires a terminal. For automation, pipe the token to patchy auth set --token-stdin."
    });
  }
  return yield* Prompt.run(Prompt.password({ message: "Patchy Cloud API token" })).pipe(
    Effect.catchTags({ QuitError: () => Effect.interrupt })
  );
});

const readStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    return yield* new LocalError({
      message:
        "--token-stdin requires redirected input. Run patchy auth set to use the hidden interactive prompt."
    });
  }
  return yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.mkString,
    Effect.mapError((cause) => new LocalError({ message: "Could not read the API token.", cause }))
  );
});

const authSet = Command.make(
  "set",
  {
    tokenStdin: Flag.boolean("token-stdin").pipe(
      Flag.withDescription("Read the Patchy Cloud API token from stdin"),
      Flag.withDefault(false)
    )
  },
  ({ tokenStdin }) =>
    run(
      Effect.gen(function* () {
        const token = tokenStdin
          ? yield* Effect.flatMap(readStdin, (input) => parseApiToken(input, true))
          : yield* promptForToken;
        const { apiUrl } = yield* Instance.Instance;
        const state = yield* State.State;
        if (Option.isSome(yield* Instance.ApiUrlFlag)) yield* state.saveConfigUrl(apiUrl);
        yield* state.saveCredential(apiUrl, token, "auth-set");
        yield* Output.report({ ok: true, instanceUrl: apiUrl }, [
          `Patchy Cloud credentials saved for ${apiUrl}.`
        ]);
      })
    )
).pipe(
  Command.withDescription(
    "Save an API token for the resolved instance; with --api-url, also save that instance."
  )
);

const auth = Command.make("auth").pipe(
  Command.withDescription("Manage CLI authentication."),
  Command.withSubcommands([authSet])
);

// --- whoami -----------------------------------------------------------------

const whoami = Command.make("whoami", {}, () =>
  run(
    Effect.gen(function* () {
      const token = yield* requiredToken();
      const client = yield* Api.client(token);
      const identity = yield* client
        .me()
        .pipe(Effect.catch((error) => refused(error, "Authentication failed.")));
      yield* Output.report(encodeIdentity(identity), [
        `User: ${identity.user.name} (${identity.user.email})`,
        `Company: ${identity.company.name} (${identity.company.handle})`,
        `Role: ${identity.role}`,
        `Machine: ${identity.machine.name} (${identity.machine.id})`
      ]);
    })
  )
).pipe(Command.withDescription("Check the configured Patchy Cloud credentials."));

// --- status -----------------------------------------------------------------

/**
 * Assembled from local state alone; nothing on this path may reach the
 * network. The probe never fails on state it cannot read: failing closed on a
 * corrupt credentials file protects the commands that would spend a token,
 * and those keep doing it; reporting the same condition here as "no token we
 * can vouch for" leaves the stored credential untouched.
 */
const status = Command.make("status", {}, () =>
  run(
    Effect.gen(function* () {
      const instance = yield* Instance.Instance;
      const state = yield* State.State;
      const credential = yield* configuredCredential.pipe(
        Effect.orElseSucceed(() => Option.none())
      );
      // JSON is the probe's only format, `--json` or not.
      yield* Console.log(
        Output.toJson({
          instanceUrl: instance.apiUrl,
          instanceSource: instance.source,
          hasToken: Option.isSome(credential),
          // Only a stored credential carries provenance; an environment token
          // and an entry written before `source` existed both report null.
          tokenSource: Option.getOrNull(Option.map(credential, (c) => c.source)),
          stateDir: state.dir,
          hasDefaultStyle: yield* state.hasDefaultStyle,
          cliVersion: VERSION
        })
      );
    })
  )
).pipe(
  Command.withDescription(
    "Report local publishing state for the resolved instance, as JSON. Never uses the network."
  )
);

// --- validate ---------------------------------------------------------------

const fileArgument = Argument.string("file").pipe(Argument.withDescription("HTML file path"));

const validate = Command.make("validate", { file: fileArgument }, ({ file }) =>
  run(
    Effect.gen(function* () {
      const { html } = yield* readHtml(file);
      const warnings = yield* validated(html);
      yield* Output.report({ ok: true, warnings }, ["HTML passed Patchy Cloud validation."]);
      for (const warning of warnings) yield* Output.warn(`Warning: ${warning}`);
    })
  )
).pipe(Command.withDescription("Validate a static HTML patch without uploading it."));

// --- upload -----------------------------------------------------------------

const upload = Command.make(
  "upload",
  {
    file: fileArgument,
    patch: Flag.string("patch").pipe(
      Flag.withDescription("Update an existing patch only; never creates a patch"),
      Flag.optional
    ),
    share: Flag.choice("share", SharingScope.literals).pipe(
      Flag.withDescription("Who can open the patch: your company or anyone with the link"),
      Flag.optional
    ),
    new: Flag.boolean("new").pipe(
      Flag.withDescription("Always create a new patch"),
      Flag.withDefault(false)
    )
  },
  (options) =>
    run(
      Effect.gen(function* () {
        if (Option.isSome(options.patch) && options.new) {
          return yield* new LocalError({ message: "--patch and --new cannot be used together." });
        }
        const path = yield* Path.Path;
        const { resolved, html } = yield* readHtml(options.file);
        // Local validation gates the network.
        yield* validated(html);

        const instance = yield* Instance.Instance;
        const state = yield* State.State;
        const apiToken = yield* requiredToken();
        yield* Output.notice(
          `Publishing to ${instance.apiUrl} (target came from ${Instance.describeSource(instance.source)}).`
        );

        const cached = yield* state.readCachedPatch(instance.apiUrl, resolved);
        const patchId = options.new
          ? null
          : Option.getOrElse(options.patch, () =>
              Option.getOrNull(Option.map(cached, (c) => c.patchId))
            );

        const client = yield* Api.client(apiToken);
        const upload = yield* client
          .upload({
            payload: new UploadRequest({
              html,
              filename: path.basename(resolved),
              ...(patchId !== null ? { patchId } : {}),
              ...(Option.isSome(options.share) ? { scope: options.share.value } : {}),
              metadata: new UploadMetadata({
                ...(yield* Git.metadata(path.dirname(resolved))),
                cliVersion: VERSION,
                fileSha256: sha256(html)
              })
            })
          })
          .pipe(
            Effect.catch((error) => {
              if (patchId !== null && Api.isRefusal(error) && error.error === PATCH_NOT_FOUND) {
                return new RejectedError({
                  message: Option.isSome(options.patch)
                    ? "Patch is unavailable for update. --patch never creates a new patch."
                    : "Cached patch is unavailable for update. Use --new to create a new patch."
                });
              }
              return refused(error, "Upload failed.");
            })
          );

        yield* state.cachePatch(
          instance.apiUrl,
          resolved,
          new State.CachedPatch({
            patchId: upload.patchId,
            publicUrl: upload.publicUrl,
            latestVersionNumber: upload.versionNumber,
            updatedAt: yield* State.now
          })
        );
        yield* Output.report(encodeUpload(upload), [
          patchId !== null ? "Updated patch" : "Uploaded patch",
          `URL: ${upload.publicUrl}`,
          scopeLines[upload.scope],
          `Patch ID: ${upload.patchId}`,
          `Version: ${upload.versionNumber}`
        ]);
        for (const warning of upload.warnings) yield* Output.warn(`Warning: ${warning}`);
      })
    )
).pipe(Command.withDescription("Upload or update an HTML patch."));

// --- patch targets ----------------------------------------------------------

/**
 * The patch to change: the one cached for the file, or the id given outright.
 * Exactly one of the two, so disagreeing targets never choose a patch silently.
 */
const patchTarget = Effect.fn("patchTarget")(function* (
  file: Option.Option<string>,
  patch: Option.Option<string>
) {
  if (Option.isSome(file) && Option.isSome(patch)) {
    return yield* new LocalError({
      message: "Pass the file the patch was uploaded from, or --patch <patch-id>, not both."
    });
  }
  if (Option.isSome(patch)) return patch.value;
  if (Option.isNone(file)) {
    return yield* new LocalError({
      message: "Pass the file the patch was uploaded from, or --patch <patch-id>."
    });
  }
  const path = yield* Path.Path;
  const { apiUrl } = yield* Instance.Instance;
  const state = yield* State.State;
  const resolved = path.resolve(file.value);
  const cached = yield* state.readCachedPatch(apiUrl, resolved);
  if (Option.isNone(cached)) {
    return yield* new LocalError({
      message:
        `No patch on ${apiUrl} was uploaded from ${resolved}.\n` +
        "Pass --patch <patch-id> to use a patch ID."
    });
  }
  return cached.value.patchId;
});

// --- share ------------------------------------------------------------------

const share = Command.make(
  "share",
  {
    fileOrScope: Argument.string("file-or-scope").pipe(
      Argument.withDescription("The uploaded HTML file, or company|public when using --patch"),
      Argument.optional
    ),
    scope: Argument.choice("scope", SharingScope.literals).pipe(Argument.optional),
    patch: Flag.string("patch").pipe(
      Flag.withDescription("Change sharing for this patch by ID instead of by file"),
      Flag.optional
    )
  },
  (options) =>
    run(
      Effect.gen(function* () {
        // The last positional is always the scope. With --patch it is also the
        // first, so an optional file argument must not swallow it as a path.
        const file = Option.isSome(options.scope) ? options.fileOrScope : Option.none<string>();
        const scope = yield* decodeSharingScope(
          Option.getOrUndefined(Option.orElse(options.scope, () => options.fileOrScope))
        ).pipe(
          Effect.mapError(
            (cause) =>
              new LocalError({
                message: "Pass a sharing scope: company or public.",
                cause
              })
          )
        );
        const patchId = yield* patchTarget(file, options.patch);
        const token = yield* requiredToken("login");
        const client = yield* Api.client(token);
        const shared = yield* client
          .share({ params: { patchId }, payload: new ShareRequest({ scope }) })
          .pipe(Effect.catch((error) => refused(error, "Sharing failed.")));
        yield* Output.report(encodeShared(shared), [
          "Changed patch sharing",
          `URL: ${shared.publicUrl}`,
          scopeLines[shared.scope],
          `Patch ID: ${shared.patchId}`
        ]);
      })
    )
).pipe(
  Command.withDescription(
    "Change who can open a patch: share <file> company|public or share --patch <id> company|public."
  )
);

// --- delete -----------------------------------------------------------------

/**
 * The cache forgets the patch only once the instance has said yes, so a
 * refusal leaves the local picture as it was.
 */
const del = Command.make(
  "delete",
  {
    file: Argument.string("file").pipe(
      Argument.withDescription("The HTML file the patch was uploaded from"),
      Argument.optional
    ),
    patch: Flag.string("patch").pipe(
      Flag.withDescription("Delete this patch by ID instead of by file"),
      Flag.optional
    )
  },
  (options) =>
    run(
      Effect.gen(function* () {
        const patchId = yield* patchTarget(options.file, options.patch);
        const instance = yield* Instance.Instance;
        const state = yield* State.State;
        const token = yield* requiredToken();
        yield* Output.notice(
          `Deleting from ${instance.apiUrl} (target came from ${Instance.describeSource(instance.source)}).`
        );
        const client = yield* Api.client(token);
        const ok = yield* client.delete({ params: { patchId } }).pipe(
          Effect.catch((error) => {
            if (Api.isRefusal(error) && error.error === PATCH_NOT_FOUND) {
              return new RejectedError({
                message: `Patch ${patchId} is unavailable for deletion: it is not on ${instance.apiUrl}, or this publishing key does not own it.`
              });
            }
            return refused(error, "Delete failed.");
          })
        );
        yield* state.forgetPatch(instance.apiUrl, patchId);
        yield* Output.report(encodeOk(ok), ["Deleted patch", `Patch ID: ${patchId}`]);
      })
    )
).pipe(
  Command.withDescription(
    "Delete a patch from the instance. Irreversible. Confirm with the user first."
  )
);

// --- the tree ---------------------------------------------------------------

export const root = Command.make("patchy").pipe(
  Command.withDescription("Upload static HTML patches to a Patchy Cloud instance."),
  Command.withSubcommands([auth, whoami, status, validate, upload, share, del]),
  Command.withGlobalFlags([Output.JsonFlag, Instance.ApiUrlFlag])
);
