/**
 * The six commands. Each handler yields what it needs — the resolved
 * `Instance`, the `State` dir, the derived client — and fails only with a
 * `CliError`, so the contract in `Output` is the whole of what an agent sees.
 * User-facing copy calls a token a publishing key, except on the own-instance
 * path where operator vocabulary is right.
 *
 * PROTOTYPE for #131 (throwaway): `login` is the device login, in the two
 * shapes the ticket compares, switched by `PATCHY_LOGIN_SHAPE`.
 */
// @effect-diagnostics nodeBuiltinImport:off -- PROTOTYPE #131: the machine's name is the OS's to give.
import { hostname } from "node:os";
import * as Clock from "effect/Clock";
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
  DeviceLoginPollRequest,
  DeviceLoginStartRequest,
  Identity,
  Ok,
  UploadCreated,
  UploadMetadata,
  UploadRequest,
  UploadUpdated
} from "@patchy/api";
import { sha256, validateHtml } from "@patchy/core";
import * as Api from "./Api.js";
import { type CliError, LocalError, RejectedError, UnreachableError } from "./CliError.js";
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

/** Wire literal of the 401 (`Unauthorized` in `@patchy/api`); the hint below keys on it. */
const UNAUTHORIZED = "Missing or invalid API token.";
/** Wire literal of the patch-route 404; `upload` and `delete` each turn it into their next action. */
const PATCH_NOT_FOUND = "Patch not found.";

/**
 * Appended to a 401/403 from the default instance only — the local server this
 * repo runs. Never claims the instance's minting posture: a rejected request
 * means the key that was sent is bad, whatever the policy on handing out new ones.
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

/** A token that arrived with no provenance: `PATCHY_API_TOKEN`, or the one seeded beside a dev-env URL. */
const environmentToken = Effect.gen(function* () {
  const env = yield* Instance.optionalSecret("PATCHY_API_TOKEN");
  const instance = yield* Instance.Instance;
  return Option.orElse(env, () => instance.token);
});

/**
 * The credential chain: the environment's token, then the token stored for
 * this instance. `None` is not a licence to publish without one — it is the
 * signal that this instance has no key yet, which `upload` answers by minting.
 */
const configuredToken = Effect.gen(function* () {
  const env = yield* Instance.optionalSecret("PATCHY_API_TOKEN");
  if (Option.isSome(env)) return env;
  const instance = yield* Instance.Instance;
  const state = yield* State.State;
  const stored = yield* state.readCredential(instance.apiUrl);
  // PROTOTYPE for #131: a `patchy login` on this machine outranks the token
  // the dev env seeded, or the login could never be seen working in a worktree.
  if (Option.isSome(stored) && stored.value.source === "login") {
    return Option.some(Redacted.make(stored.value.token));
  }
  if (Option.isSome(instance.token)) return instance.token;
  return Option.map(stored, (credential) => Redacted.make(credential.token));
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
      const { apiUrl } = yield* Instance.Instance;
      const token = yield* configuredToken;
      if (Option.isNone(token)) {
        // Read-only, so it reports the absence rather than minting: `upload` is
        // the only command that ever creates a token.
        return yield* new LocalError({
          message:
            `No publishing token is stored for ${apiUrl}.\n` +
            "One is minted automatically on your first upload, or save an existing one with: " +
            `patchy auth set --api-url ${apiUrl}`
        });
      }
      const client = yield* Api.client(token);
      const identity = yield* client
        .me()
        .pipe(Effect.catch((error) => refused(error, "Authentication failed.")));
      yield* Output.report(encodeIdentity(identity), [
        `Account: ${identity.accountName} (${identity.accountId})`,
        `API token: ${identity.apiTokenName} (${identity.apiTokenId})`,
        `Scopes: ${identity.scopes.join(", ")}`
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
 * can vouch for" neither loses a token nor mints one.
 */
const status = Command.make("status", {}, () =>
  run(
    Effect.gen(function* () {
      const instance = yield* Instance.Instance;
      const state = yield* State.State;
      const env = yield* environmentToken;
      const stored = Option.isSome(env)
        ? Option.none<State.HostCredential>()
        : yield* state
            .readCredential(instance.apiUrl)
            .pipe(Effect.orElseSucceed(() => Option.none<State.HostCredential>()));
      // JSON is the probe's only format, `--json` or not.
      yield* Console.log(
        Output.toJson({
          instanceUrl: instance.apiUrl,
          instanceSource: instance.source,
          hasToken: Option.isSome(env) || Option.isSome(stored),
          // Only a stored credential carries provenance; an environment token
          // and an entry written before `source` existed both report null.
          tokenSource: Option.getOrNull(
            Option.flatMap(stored, (c) => Option.fromUndefinedOr(c.source))
          ),
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

/**
 * Mints a publishing token for the resolved instance, saves it, and announces
 * it. Only that instance is ever asked: a refusal here is the end of the
 * road, because a token minted anywhere else would control a different set
 * of pages. Saved before it is announced — a token that reached the instance
 * but not the disk would silently orphan every page it went on to create.
 */
const mintPublishingToken = Effect.gen(function* () {
  const { apiUrl } = yield* Instance.Instance;
  const state = yield* State.State;
  const client = yield* Api.client(Option.none());
  const minted = yield* client.mint().pipe(Effect.catch((error) => mintFailure(error, apiUrl)));
  const token = Redacted.make(minted.token);
  yield* state.saveCredential(apiUrl, token, "mint");
  yield* Output.announce(
    `Minted a new publishing token for ${apiUrl}; saved to ${state.credentialsPath}. ` +
      "That file is the only key to these pages — copy it to another machine to publish from " +
      "there with the same editing rights. If you've published from another machine before, " +
      "those pages belong to that machine's token — ask your agent to help copy it over instead " +
      "of using this new one."
  );
  return token;
});

/** One plain-language failure per pinned mint response, cause then next action. */
const mintFailure = (error: Api.ClientFailure, apiUrl: string) => {
  const authSetAction = `patchy auth set --api-url ${apiUrl}`;
  const prefix = "Could not get a publishing token";
  if (Api.isRefusal(error)) {
    switch (error.code) {
      case "self_service_disabled":
        return new RejectedError({
          message:
            `${prefix}: ${apiUrl} does not hand them out on request.\n` +
            `Ask that instance's operator for a token and save it with: ${authSetAction}`
        });
      case "mint_quota_exceeded":
        return new RejectedError({
          // The server's window rolls: the next slot opens 24 hours after the
          // oldest mint in the window, not at midnight.
          message:
            `${prefix}: ${apiUrl} has reached its limit of new tokens for your network over the last 24 hours.\n` +
            `Copy an existing token from another machine and save it with: ${authSetAction}, ` +
            "or try again once the oldest of those tokens is 24 hours old."
        });
      case "rate_limited": {
        const wait =
          error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 0
            ? `${Math.ceil(error.retryAfterSeconds)} seconds`
            : "a moment";
        return new RejectedError({
          message:
            `${prefix}: ${apiUrl} is handing out tokens faster than it allows right now.\n` +
            `Wait ${wait} and run the same command again.`
        });
      }
      default:
        return new RejectedError({
          message:
            `${prefix} from ${apiUrl}: ${Api.refusalMessage(error, "the instance refused.")}\n` +
            `If that instance does not hand out tokens, ask its operator for one and save it with: ${authSetAction}`
        });
    }
  }
  return Api.classify(error, "").pipe(
    Effect.mapError((failure) =>
      failure._tag === "UnreachableError"
        ? new UnreachableError({ ...failure, message: `${prefix}: ${failure.message}` })
        : failure._tag === "RejectedError"
          ? new RejectedError({
              ...failure,
              message: `${prefix} from ${apiUrl}: ${failure.message}\nIf that instance does not hand out tokens, ask its operator for one and save it with: ${authSetAction}`
            })
          : failure
    )
  );
};

const upload = Command.make(
  "upload",
  {
    file: fileArgument,
    patch: Flag.string("patch").pipe(
      Flag.withDescription("Update an existing patch only; never creates a patch"),
      Flag.optional
    ),
    new: Flag.boolean("new").pipe(
      Flag.withDescription("Always create a new patch"),
      Flag.withDefault(false)
    ),
    anonymous: Flag.boolean("anonymous").pipe(
      Flag.withDescription("Deprecated and ignored; uploads always use a token"),
      Flag.withDefault(false)
    )
  },
  (options) =>
    run(
      Effect.gen(function* () {
        if (Option.isSome(options.patch) && options.new) {
          return yield* new LocalError({ message: "--patch and --new cannot be used together." });
        }
        // A no-op rather than an error: the flag's old invocations keep working
        // through the transition, so it is announced and then ignored.
        if (options.anonymous) {
          yield* Output.warn(
            "Warning: --anonymous is deprecated and ignored. Uploads always use a publishing token; " +
              "one is minted automatically when none is stored for the instance."
          );
        }
        const path = yield* Path.Path;
        const { resolved, html } = yield* readHtml(options.file);
        // Local validation gates the network, so an unpublishable file never costs
        // a mint against the instance's per-network quota.
        yield* validated(html);

        const instance = yield* Instance.Instance;
        const state = yield* State.State;
        yield* Output.notice(
          `Publishing to ${instance.apiUrl} (target came from ${Instance.describeSource(instance.source)}).`
        );
        const configured = yield* configuredToken;
        const apiToken = Option.isSome(configured) ? configured.value : yield* mintPublishingToken;

        const cached = yield* state.readCachedPatch(instance.apiUrl, resolved);
        const patchId = options.new
          ? null
          : Option.getOrElse(options.patch, () =>
              Option.getOrNull(Option.map(cached, (c) => c.patchId))
            );

        const client = yield* Api.client(Option.some(apiToken));
        const upload = yield* client
          .upload({
            payload: new UploadRequest({
              html,
              filename: path.basename(resolved),
              ...(patchId !== null ? { patchId } : {}),
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
          `Patch ID: ${upload.patchId}`,
          `Version: ${upload.versionNumber}`
        ]);
        for (const warning of upload.warnings) yield* Output.warn(`Warning: ${warning}`);
      })
    )
).pipe(Command.withDescription("Upload or update an HTML patch."));

// --- delete -----------------------------------------------------------------

/**
 * The patch to delete: the one cached for the file, or the id given outright.
 * Exactly one of the two, because a file and an id that disagree would leave
 * the cache pointing at whichever was not deleted.
 */
const deleteTarget = Effect.fn("deleteTarget")(function* (
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
        "Pass --patch <patch-id> to delete by ID."
    });
  }
  return cached.value.patchId;
});

/**
 * Never mints: a fresh key owns nothing, so with no key there is nothing this
 * machine can delete. The cache forgets the patch only once the instance has
 * said yes, so a refusal leaves the local picture as it was.
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
        const patchId = yield* deleteTarget(options.file, options.patch);
        const instance = yield* Instance.Instance;
        const state = yield* State.State;
        const token = yield* configuredToken;
        if (Option.isNone(token)) {
          return yield* new LocalError({
            message:
              `No publishing key is stored for ${instance.apiUrl}, so nothing there can be deleted from this machine.\n` +
              `Save the one that published the patch with: patchy auth set --api-url ${instance.apiUrl}`
          });
        }
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

// --- login (PROTOTYPE for #131, throwaway) ------------------------------------

/**
 * The environment variables an agent harness sets. Stripe's gate: an agent
 * with a real TTY must not be blocked on an answer nobody at the keyboard
 * will give, so this — not `isatty` — decides whether `login` waits.
 */
const AGENT_SIGNALS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CURSOR_AGENT",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "GEMINI_CLI",
  "OPENCODE",
  "CLINE_ACTIVE",
  "AI_AGENT",
  "CI"
] as const;

const detectAgent = Effect.gen(function* () {
  for (const name of AGENT_SIGNALS) {
    if (Option.isSome(yield* Instance.optionalEnv(name))) return Option.some(name);
  }
  return Option.none<string>();
});

/** `stripe` (default): block for a human, one document plus `--complete` otherwise. `two-step`: never block; the same command resumes. */
const loginShape = Instance.optionalEnv("PATCHY_LOGIN_SHAPE").pipe(
  Effect.map((value) =>
    Option.getOrElse(value, () => "stripe") === "two-step" ? "two-step" : "stripe"
  )
);

const minutesUntil = (iso: string, now: number) =>
  Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));

const nextCommand = (shape: "stripe" | "two-step", userCode: string) =>
  shape === "two-step" ? "patchy login" : `patchy login --complete ${userCode}`;

const handoffLines = (pending: State.PendingLogin, apiUrl: string, now: number) => [
  `Log in to ${apiUrl} from this machine (${hostname()}).`,
  "",
  `  Open   ${pending.verificationUrlComplete}`,
  `  Code   ${pending.userCode}`,
  "",
  `Confirm it in a browser where you are signed in. The code expires in ${minutesUntil(pending.expiresAt, now)} minutes.`
];

const handoffDocument = (
  pending: State.PendingLogin,
  shape: "stripe" | "two-step",
  reason: string
) => ({
  ok: true,
  status: "awaiting_confirmation",
  verificationUrl: pending.verificationUrlComplete,
  verificationUrlBare: pending.verificationUrl,
  userCode: pending.userCode,
  expiresAt: pending.expiresAt,
  interval: pending.interval,
  next: nextCommand(shape, pending.userCode),
  agentNextSteps:
    "Show the person the URL and the code and ask them to confirm it in a browser where they are signed in. Do not open a browser yourself. Then run the next command; it waits up to a minute and says pending if they have not confirmed yet.",
  notWaitingBecause: reason
});

/**
 * Polls until the person answers or `deadline` passes. Complete saves the
 * key and forgets the pending login; denied, expired and unknown forget it
 * and are `rejected`; still pending at the deadline is a document naming the
 * next command, exit 0.
 */
const completeLogin = (
  pending: State.PendingLogin,
  shape: "stripe" | "two-step",
  deadline: number
) =>
  Effect.gen(function* () {
    const instance = yield* Instance.Instance;
    const state = yield* State.State;
    const client = yield* Api.client(Option.none());
    let interval = pending.interval;
    for (;;) {
      const answer = yield* client
        .deviceLoginPoll({
          payload: new DeviceLoginPollRequest({ deviceCode: pending.deviceCode })
        })
        .pipe(
          Effect.catch((error) => {
            if (
              Api.isRefusal(error) &&
              typeof error.code === "string" &&
              error.code !== "rate_limited"
            ) {
              return Effect.succeed({ gone: error.code, error: error.error ?? "" } as const);
            }
            return Api.classify(error, "Could not check the login.");
          })
        );
      if ("gone" in answer) {
        yield* state.forgetPendingLogin(instance.apiUrl);
        const why =
          answer.gone === "expired"
            ? `The login expired before it was confirmed (codes last ten minutes).`
            : answer.gone === "denied"
              ? `The login was denied in the browser. Nothing was saved.`
              : `No login is pending for code ${pending.userCode} on ${instance.apiUrl}; it may already have been reported.`;
        return yield* new RejectedError({ message: `${why}\nRun: patchy login` });
      }
      if (answer.status === "complete") {
        yield* state.saveCredential(
          instance.apiUrl,
          Redacted.make(answer.token),
          "login",
          new State.Machine(answer.machine)
        );
        yield* state.forgetPendingLogin(instance.apiUrl);
        yield* Output.report(
          {
            ok: true,
            status: "logged_in",
            instanceUrl: instance.apiUrl,
            accountId: answer.accountId,
            accountName: answer.accountName,
            machine: answer.machine,
            credentialsPath: state.credentialsPath
          },
          [
            `Logged in to ${instance.apiUrl} as ${answer.accountName}. This machine is "${answer.machine.name}".`,
            `Publishing key saved to ${state.credentialsPath}.`
          ]
        );
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      if (now >= deadline) {
        yield* Output.report(
          {
            ok: true,
            status: "pending",
            verificationUrl: pending.verificationUrlComplete,
            userCode: pending.userCode,
            expiresAt: pending.expiresAt,
            next: nextCommand(shape, pending.userCode),
            agentNextSteps:
              "Not confirmed yet. Check the person has the URL and the code, then run the next command again."
          },
          [
            `Not confirmed yet. The code ${pending.userCode} is good for ${minutesUntil(pending.expiresAt, now)} more minutes.`,
            `Then run: ${nextCommand(shape, pending.userCode)}`
          ]
        );
        return;
      }
      if (answer.status === "slow_down") interval += 5;
      yield* Effect.sleep(`${interval} seconds`);
    }
  });

const login = Command.make(
  "login",
  {
    complete: Flag.boolean("complete").pipe(
      Flag.withDescription(
        "Finish a login started earlier: wait for the confirmation, then save the key"
      ),
      Flag.withDefault(false)
    ),
    wait: Flag.integer("wait").pipe(
      Flag.withDescription(
        "Seconds to wait for the confirmation before reporting pending (default 60; the human path waits until the code expires)"
      ),
      Flag.optional
    ),
    block: Flag.boolean("block").pipe(
      Flag.withDescription("Prototype: wait in this process even when an agent is detected"),
      Flag.withDefault(false)
    ),
    code: Argument.string("code").pipe(
      Argument.withDescription("The code being finished, as a check; optional"),
      Argument.optional
    )
  },
  (options) =>
    run(
      Effect.gen(function* () {
        const instance = yield* Instance.Instance;
        const state = yield* State.State;
        const shape = yield* loginShape;
        const agent = yield* detectAgent;
        const json = yield* Output.JsonFlag;
        const tty = yield* Effect.flatMap(Stdio.Stdio, (stdio) => stdio.stdinIsTerminal);
        const now = yield* Clock.currentTimeMillis;
        const pending = yield* state.readPendingLogin(instance.apiUrl);
        const live = Option.filter(pending, (p) => Date.parse(p.expiresAt) > now);

        // Finishing: `--complete` says so; under two-step the same command
        // resumes whenever a login is in flight.
        if (options.complete || (shape === "two-step" && Option.isSome(live))) {
          if (Option.isNone(live)) {
            yield* state.forgetPendingLogin(instance.apiUrl);
            return yield* new LocalError({
              message: Option.isSome(pending)
                ? `The pending login for ${instance.apiUrl} expired. Run: patchy login`
                : `No login is pending for ${instance.apiUrl}. Run: patchy login`
            });
          }
          if (Option.isSome(options.code)) {
            const given = options.code.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
            if (given !== live.value.userCode.replace("-", "")) {
              return yield* new LocalError({
                message: `The pending login on ${instance.apiUrl} has code ${live.value.userCode}, not ${options.code.value}. Run: ${nextCommand(shape, live.value.userCode)}`
              });
            }
          }
          const waitSeconds = Option.getOrElse(options.wait, () => 60);
          return yield* completeLogin(live.value, shape, now + waitSeconds * 1_000);
        }

        // Starting. A re-login sends the old key's id so the new one inherits
        // its name and the old dies on confirm.
        const stored = yield* state.readCredential(instance.apiUrl);
        const previous = Option.flatMap(stored, (c) =>
          c.source === "login" ? Option.fromUndefinedOr(c.machine) : Option.none()
        );
        const client = yield* Api.client(Option.none());
        const started = yield* client
          .deviceLoginStart({
            payload: new DeviceLoginStartRequest({
              machineName: hostname(),
              previousTokenId: Option.getOrNull(Option.map(previous, (m) => m.id))
            })
          })
          .pipe(Effect.catch((error) => Api.classify(error, "Could not start a login.")));
        const record = new State.PendingLogin({
          deviceCode: started.deviceCode,
          userCode: started.userCode,
          verificationUrl: started.verificationUrl,
          verificationUrlComplete: started.verificationUrlComplete,
          expiresAt: started.expiresAt,
          interval: started.interval,
          startedAt: yield* State.now
        });
        yield* state.savePendingLogin(instance.apiUrl, record);
        if (Option.isSome(previous)) {
          yield* Output.notice(
            `This machine is already logged in as "${previous.value.name}"; confirming replaces that key.`
          );
        }

        const blocking =
          options.block || (shape === "stripe" && !json && tty && Option.isNone(agent));
        if (!blocking) {
          const reason = json
            ? "--json"
            : Option.isSome(agent)
              ? `${agent.value} is set`
              : !tty
                ? "stdin is not a terminal"
                : "PATCHY_LOGIN_SHAPE=two-step";
          yield* Output.report(handoffDocument(record, shape, reason), [
            ...handoffLines(record, instance.apiUrl, now),
            `Then run: ${nextCommand(shape, record.userCode)}`,
            `(Not waiting here: ${reason}.)`
          ]);
          return;
        }

        // Blocking: the handoff before the poll starts, on stderr under
        // --json (stdout is the one document), on stdout otherwise.
        for (const line of handoffLines(record, instance.apiUrl, now)) {
          yield* json ? Console.error(line) : Console.log(line);
        }
        yield* json ? Console.error("Waiting...") : Console.log("Waiting...");
        const deadline = Option.match(options.wait, {
          onNone: () => Date.parse(record.expiresAt),
          onSome: (seconds) => now + seconds * 1_000
        });
        yield* completeLogin(record, shape, deadline);
      })
    )
).pipe(
  Command.withDescription(
    "Log this machine in: a link to confirm in your browser, then a publishing key."
  )
);

// --- the tree ---------------------------------------------------------------

export const root = Command.make("patchy").pipe(
  Command.withDescription("Upload static HTML patches to a Patchy Cloud instance."),
  Command.withSubcommands([auth, login, whoami, status, validate, upload, del]),
  Command.withGlobalFlags([Output.JsonFlag, Instance.ApiUrlFlag])
);
