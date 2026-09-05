// @effect-diagnostics nodeBuiltinImport:off -- the login hint is the OS hostname.
import { hostname } from "node:os";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stdio from "effect/Stdio";
import { PollDeviceLoginRequest, StartDeviceLoginRequest } from "@patchy/api";
import * as Api from "./Api.js";
import { LocalError, RejectedError } from "./CliError.js";
import * as Instance from "./Instance.js";
import * as Output from "./Output.js";
import * as State from "./State.js";

const agentVariables = [
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

/** Presence, including an empty value, identifies an agent even inside a pty. */
export const notWaitingBecause = Effect.gen(function* () {
  if (yield* Output.JsonFlag) return "--json";
  for (const name of agentVariables) {
    const value = yield* Config.string(name).pipe(Config.option, Effect.orDie);
    if (Option.isSome(value)) return `${name} is set`;
  }
  const stdio = yield* Stdio.Stdio;
  return (yield* stdio.stdinIsTerminal) ? null : "stdin is not a terminal";
});

const agentNextSteps =
  "Show the person the URL and the code and ask them to confirm it in a browser where they are signed in. Do not open a browser yourself. Then run the next command; it waits up to a minute and says pending if they have not confirmed yet.";
const nextCommand = Effect.fn("Login.nextCommand")(function* (login: State.PendingLogin) {
  const { apiUrl, source } = yield* Instance.Instance;
  // Config cannot preserve a flag override: the worktree and environment outrank it.
  const target = source === "flag" ? ` --api-url '${apiUrl.replaceAll("'", "'\\''")}'` : "";
  return `patchy login --complete ${login.userCode}${target}`;
});

const pendingReport = (login: State.PendingLogin, next: string) =>
  Output.report(
    {
      ok: true,
      status: "pending",
      userCode: login.userCode,
      expiresAt: login.expiresAt,
      next,
      agentNextSteps
    },
    [`Not confirmed yet. Code: ${login.userCode}`, `Then run: ${next}`]
  );

/** Always ask the instance, including for a locally expired record: it owns the terminal answer. */
const poll = Effect.fn("Login.poll")(function* (
  initial: State.PendingLogin,
  waitSeconds: number | null
) {
  const { apiUrl } = yield* Instance.Instance;
  const state = yield* State.State;
  const client = yield* Api.client();
  const deadline =
    waitSeconds === null ? null : (yield* Clock.currentTimeMillis) + waitSeconds * 1000;
  let login = initial;
  const next = yield* nextCommand(login);
  while (true) {
    const result = yield* client
      .pollDeviceLogin({ payload: new PollDeviceLoginRequest({ deviceCode: login.deviceCode }) })
      .pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if ("code" in error) {
              yield* state.forgetPendingLogin(apiUrl);
              const message =
                error.code === "denied"
                  ? "The login was denied in the browser. Nothing was saved. Run: patchy login"
                  : error.code === "expired"
                    ? "The login expired before it was confirmed (codes last ten minutes). Run: patchy login"
                    : `No login is pending for code ${login.userCode} on ${apiUrl}; it may already have been reported. Run: patchy login`;
              return yield* new RejectedError({ message, cause: error });
            }
            return yield* Api.classify(error, "Login could not complete.");
          })
        )
      );
    if (result.status === "complete") {
      const token = Redacted.make(result.token);
      // Persist the one-time secret before the additional identity request can fail.
      yield* state.saveCredential(apiUrl, token, { source: "login", machine: result.machine });
      yield* state.forgetPendingLogin(apiUrl);
      const authenticated = yield* Api.client(token);
      const identity = yield* authenticated
        .me()
        .pipe(Effect.catch((error) => Api.classify(error, "Authentication failed.")));
      yield* Output.report(
        {
          ok: true,
          status: "logged_in",
          instanceUrl: apiUrl,
          company: { handle: identity.company.handle, name: identity.company.name },
          user: { email: identity.user.email },
          machine: result.machine,
          credentialsPath: state.credentialsPath
        },
        [
          `Logged in to ${apiUrl} as ${identity.company.name}. This machine is "${result.machine.name}".`
        ]
      );
      return;
    }
    if (result.status === "slow_down") {
      login = new State.PendingLogin({ ...login, interval: login.interval + 5 });
      yield* state.savePendingLogin(apiUrl, login);
    }
    const remaining = deadline === null ? Infinity : deadline - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) return yield* pendingReport(login, next);
    if (remaining <= login.interval * 1000) {
      yield* Effect.sleep(remaining);
      return yield* pendingReport(login, next);
    }
    yield* Effect.sleep(login.interval * 1000);
  }
});

export const login = Effect.fn("Login.login")(function* (options: {
  readonly complete: boolean;
  readonly code: Option.Option<string>;
  readonly wait: number;
}) {
  if (!Number.isFinite(options.wait) || options.wait < 0) {
    return yield* new LocalError({ message: "--wait must be a non-negative number of seconds." });
  }
  if (!options.complete && Option.isSome(options.code)) {
    return yield* new LocalError({
      message: "A code requires --complete. Run: patchy login --complete <code>"
    });
  }
  const { apiUrl } = yield* Instance.Instance;
  const state = yield* State.State;
  const pending = yield* state.readPendingLogin(apiUrl);
  if (options.complete) {
    if (Option.isNone(pending))
      return yield* new LocalError({
        message: `No login is pending for ${apiUrl}. Run: patchy login`
      });
    if (Option.isSome(options.code) && options.code.value !== pending.value.userCode) {
      return yield* new LocalError({
        message: `The pending login for ${apiUrl} has code ${pending.value.userCode}, not ${options.code.value}. Run: ${yield* nextCommand(pending.value)}`
      });
    }
    if (Option.isSome(yield* Instance.ApiUrlFlag)) yield* state.saveConfigUrl(apiUrl);
    return yield* poll(pending.value, options.wait);
  }
  if (Option.isSome(yield* Instance.ApiUrlFlag)) yield* state.saveConfigUrl(apiUrl);
  const reason = yield* notWaitingBecause;
  let current: State.PendingLogin;
  if (Option.isSome(pending)) {
    current = pending.value;
    // A rerun resumes rather than creating a second code, even after local expiry.
    if (reason !== null) return yield* poll(current, 0);
  } else {
    const stored = yield* state.readCredential(apiUrl);
    const previousMachineTokenId =
      Option.isSome(stored) && stored.value.source === "login"
        ? stored.value.machine.id
        : undefined;
    const client = yield* Api.client();
    const started = yield* client
      .startDeviceLogin({
        payload: new StartDeviceLoginRequest({
          machineNameHint: hostname(),
          ...(previousMachineTokenId === undefined ? {} : { previousMachineTokenId })
        })
      })
      .pipe(Effect.catch((error) => Api.classify(error, "Login could not start.")));
    current = new State.PendingLogin(started);
    yield* state.savePendingLogin(apiUrl, current);
  }
  const next = yield* nextCommand(current);
  yield* Output.report(
    {
      ok: true,
      status: "awaiting_confirmation",
      verificationUrl: current.verificationUrl,
      verificationUrlBare: current.verificationUrlBare,
      userCode: current.userCode,
      expiresAt: current.expiresAt,
      interval: current.interval,
      next,
      agentNextSteps,
      notWaitingBecause: reason
    },
    [
      `Sign in: ${current.verificationUrl}`,
      `Code: ${current.userCode}`,
      `Expires: ${current.expiresAt}`,
      ...(reason === null
        ? ["Waiting for confirmation..."]
        : [`Not waiting because ${reason}.`, `Then run: ${next}`])
    ]
  );
  if (reason === null) yield* poll(current, null);
});

const courtesyWarning =
  "Logged out on this machine. The key could not be revoked; it expires on its own after 30 idle days, or revoke it now on Your machines.";

export const logout = Effect.fn("Login.logout")(function* (cwd: string) {
  const instance = yield* Instance.Instance;
  const state = yield* State.State;
  const stored = yield* state.readCredential(instance.apiUrl);
  yield* state.forgetCredential(instance.apiUrl);
  yield* state.forgetPendingLogin(instance.apiUrl);
  const warnings: string[] = [];
  let revoked = false;
  if (Option.isSome(stored)) {
    const client = yield* Api.client(Redacted.make(stored.value.token));
    revoked = yield* client.logout().pipe(
      Effect.as(true),
      Effect.catch((error) => {
        if (Api.isRefusal(error) && error.error === "Missing or invalid API token.")
          return Effect.succeed(true);
        warnings.push(courtesyWarning);
        return Effect.succeed(false);
      })
    );
  }
  const devToken =
    instance.source === "flag"
      ? Option.flatMap(yield* Instance.devEnv(cwd), (dev) => dev.token)
      : instance.token;
  if (Option.isSome(devToken))
    warnings.push("This worktree's dev instance still publishes with its seeded key");
  if (Option.isSome(yield* Instance.optionalSecret("PATCHY_API_TOKEN"))) {
    warnings.push(
      "PATCHY_API_TOKEN is still set. The publishing key from the environment is not logout's to remove."
    );
  }
  yield* Output.report({ ok: true, instanceUrl: instance.apiUrl, revoked, warnings }, [
    `Logged out on this machine from ${instance.apiUrl}.`,
    ...warnings
  ]);
});
