/**
 * The operations patch code calls on a model role: `models.decide` and `models.generate`, in
 * actions only. Each loads the role as it stands now, so an admin's remap reaches published
 * patches at once, then the provider connection it points at and that connection's key. One
 * provider request per call, never retried, cut off a second before the action's own deadline so
 * the handler hears why. Calls to one provider connection pass a fair gate (CallGate): a call past
 * its limits waits its turn until that cut-off, then rechecks its viewer and reloads the key. Each
 * call adds an entry to the request's wide event: role, model, gate wait, duration, tokens and
 * outcome, never the prompt or the answer. PROTOTYPE.
 */
import {
  ModelsDecide,
  ModelsDecided,
  ModelsGenerate,
  ModelsGenerated,
  type ModelUsage
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import * as CallGate from "../CallGate.js";
import * as ConnectionStore from "../ConnectionStore.js";
import { operation, ownerCheck, viewerRecheck, ViewerRefusal } from "../definition.js";
import * as Errors from "./Errors.js";
import * as Source from "./Source.js";

export class ConnectionNotDeclared extends Schema.TaggedError<ConnectionNotDeclared>()(
  "ModelsConnectionNotDeclared",
  {}
) {
  readonly code = "connection_not_declared" as const;
  readonly status = 400;
  override get message() {
    return "This model role is not declared by this version.";
  }
}

export const ModelErrors = Schema.Union([
  ConnectionNotDeclared,
  Errors.Timeout,
  Errors.Busy,
  Errors.RateLimited,
  Errors.Unavailable,
  Errors.InvalidRequest,
  Errors.ShapeMismatch,
  Errors.OutputTruncated,
  Errors.Refused,
  Runtime.InvalidRequest,
  ...ViewerRefusal.members
]);

/** How much of the action's time a model call leaves its handler to hear why it stopped. */
export const RESERVE_MS = 1_000;
const FALLBACK_MS = 60_000;

/**
 * The gate's starting numbers, per provider connection in each replica. 16 running keeps one
 * company's calls a small share of a process's outbound requests while leaving a provider's usual
 * request rate far off (16 calls of 20 s are under 50 a minute); 4 per person lets a page's few
 * calls run together and stops one agent's burst taking the connection; 32 waiting, 8 of them a
 * person's, bounds a queue whose tail would mostly wait out its cut-off anyway.
 */
export const GATE: CallGate.Limits = { concurrent: 16, perPerson: 4, waiting: 32, perPersonWaiting: 8 };

export class GateConfigRefused extends Schema.TaggedError<GateConfigRefused>()(
  "ModelsGateConfigRefused",
  { value: Schema.String }
) {
  override get message() {
    return `PATCHY_DEV_MODEL_GATE=${this.value} is honoured only with NODE_ENV=development or test, as names concurrent, perPerson, waiting and perPersonWaiting with whole numbers.`;
  }
}

/** The gate's limits: the starting numbers, or a dev instance's `PATCHY_DEV_MODEL_GATE` for a load test. */
const gateLimits = Effect.gen(function* () {
  const override = yield* Config.option(Config.String("PATCHY_DEV_MODEL_GATE"));
  if (Option.isNone(override)) return GATE;
  const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("production"));
  const parsed = CallGate.parseLimits(override.value, GATE);
  if ((environment !== "development" && environment !== "test") || parsed === undefined)
    return yield* new GateConfigRefused({ value: override.value });
  return parsed;
});

const isUnavailable = Schema.is(Errors.Unavailable);
const isBusy = Schema.is(Errors.Busy);
const isAbsent = Schema.is(
  Schema.Union([ConnectionStore.ConnectionNotFound, ConnectionStore.ConnectionNotConnected])
);
/**
 * A role or provider gone or paused refuses the caller as any connection does; a key that doesn't
 * read is the provider's; anything else stored is unavailable.
 */
const loaded = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, Runtime.AccessDenied | Errors.Unavailable | Runtime.SourceUnavailable, R> =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.fail(
        isAbsent(error)
          ? new Runtime.AccessDenied({ cause: error })
          : isUnavailable(error)
            ? error
            : new Runtime.SourceUnavailable({ cause: error })
      )
    )
  );

type Role = Extract<ConnectionStore.Connection, { readonly integration: "models" }>;
type Provider = Extract<ConnectionStore.Connection, { readonly integration: "openai" }>;

/** The role as it stands now, by its declaration's id and handle; paused or gone sends nothing. */
const role = Effect.fn("ModelsOperations.role")(function* (
  companyId: string,
  declared: { readonly id: string; readonly handle: string }
) {
  const connections = yield* ConnectionStore.ConnectionStore;
  const found = yield* connections.get(companyId, declared.id);
  if (found.integration !== "models" || found.handle !== declared.handle)
    return yield* new ConnectionStore.ConnectionNotFound({
      companyId,
      lookup: { id: declared.id }
    });
  if (found.status !== "connected") return yield* new ConnectionStore.ConnectionNotConnected({});
  return found satisfies Role;
});

/** The provider connection a role points at now, and its key now. */
const provider = Effect.fn("ModelsOperations.provider")(function* (companyId: string, id: string) {
  const connections = yield* ConnectionStore.ConnectionStore;
  const found = yield* connections.get(companyId, id);
  if (found.integration !== "openai")
    return yield* new ConnectionStore.ConnectionNotFound({ companyId, lookup: { id } });
  if (found.status !== "connected") return yield* new ConnectionStore.ConnectionNotConnected({});
  const secret = yield* connections.poolCredentials(
    companyId,
    { kind: "openai", id: found.id, handle: found.handle, revision: found.metadataRevision },
    found.credentialRevision
  );
  const credentials = yield* Source.parseOpenAiCredentials(secret);
  return { connection: found satisfies Provider, key: Redacted.make(credentials.apiKey) };
});

/**
 * One call as a loaded version's door admitted it: the declared role, its viewer and the patch's
 * owner, who must be able to build with the role. A role of the other kind refuses before the
 * provider sees anything.
 */
const perform = Effect.fn("ModelsOperations.perform")(function* <
  A extends { readonly usage: ModelUsage }
>(
  gate: CallGate.Gate,
  alias: string,
  op: "decide" | "generate",
  send: (
    target: { readonly key: Redacted.Redacted<string>; readonly model: string },
    source: Source.Source["Service"]
  ) => Effect.Effect<A, Errors.CallError>
) {
  const binding = yield* Binding.Binding;
  const declaration = binding.manifest.uses[alias];
  if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "models")
    return yield* new ConnectionNotDeclared({});
  const { identity, principal, companyId } = binding;
  if (
    binding.scope === "public" ||
    identity === null ||
    principal === null ||
    identity.company.id !== companyId ||
    identity.user.id !== principal.userId
  )
    return yield* new Runtime.AccessDenied({});
  const started = yield* Clock.currentTimeMillis;
  // The gateway hands a model call its action's remaining time, not the integration deadline.
  const deadline = binding.deadline ?? started + FALLBACK_MS;
  yield* ownerCheck(binding, declaration.id);
  const found = yield* loaded(role(companyId, declaration));
  const kind = found.display.kind;
  if ((op === "decide") !== (kind === "decision"))
    return yield* new Errors.InvalidRequest({ reason: "kind", kind });
  const model = found.display.model;
  const source = yield* Source.Source;
  let admitted: CallGate.Admitted | undefined;
  const record = (exit: Exit.Exit<A, unknown>) =>
    Effect.gen(function* () {
      const ended = yield* Clock.currentTimeMillis;
      const failed = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      const error = Option.getOrUndefined(failed);
      // Truncation, refusal and a mismatched shape keep what the provider counted.
      const usage: ModelUsage | undefined = Exit.isSuccess(exit)
        ? exit.value.usage
        : Predicate.isObject(error) && "usage" in error && Predicate.isObject(error.usage)
          ? (error.usage as ModelUsage)
          : undefined;
      const gated =
        admitted !== undefined
          ? {
              gateWaitMs: admitted.waitedMs,
              gateRunning: admitted.running,
              gateWaiting: admitted.waiting
            }
          : isBusy(error)
            ? { gateWaitMs: error.waitedMs }
            : {};
      yield* WideEvents.modelCall({
        op,
        role: declaration.handle,
        model,
        ...gated,
        durationMs: ended - started,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        outcome: Exit.isSuccess(exit)
          ? "ok"
          : Predicate.isObject(error) && typeof error.code === "string"
            ? error.code
            : "interrupted"
      });
    });
  const until = deadline - RESERVE_MS;
  const work = gate
    .run({ connection: found.display.provider, person: identity.user.id }, until, (through) =>
      Effect.gen(function* () {
        admitted = through;
        // A call that waited asks again whether its viewer may still call, as other gates do.
        if (through.waitedMs > 0) yield* viewerRecheck(binding);
        // The key as it is now, after any wait.
        const target = yield* loaded(provider(companyId, found.display.provider));
        const cutoff = Math.max(1, until - (yield* Clock.currentTimeMillis));
        return yield* send({ key: target.key, model }, source).pipe(
          // Interrupting the request aborts its fetch, which closes the provider's connection.
          Effect.timeoutOrElse({
            duration: cutoff,
            orElse: () => Effect.fail(new Errors.Timeout({ milliseconds: cutoff }))
          })
        );
      })
    )
    .pipe(
      Effect.catchTags({
        CallGateRefused: (refused) =>
          Effect.fail(
            new Errors.Busy({
              limit: refused.limit,
              value: refused.value,
              waitedMs: Math.round(refused.waitedMs)
            })
          )
      })
    );
  return yield* Effect.onExit(work, record);
});

const operationsWith = (gate: CallGate.Gate) => ({
  decide: operation({
    input: ModelsDecide,
    output: ModelsDecided,
    errors: ModelErrors,
    run: ({ connection, input, questions }: typeof ModelsDecide.Type) =>
      perform(gate, connection, "decide", (target, source) =>
        source.decide({ key: target.key, model: target.model, input, questions })
      )
  }),
  generate: operation({
    input: ModelsGenerate,
    output: ModelsGenerated,
    errors: ModelErrors,
    run: ({ connection, ...request }: typeof ModelsGenerate.Type) =>
      perform(gate, connection, "generate", (target, source) =>
        source.generate({ key: target.key, model: target.model, ...request })
      )
  })
});

/** The operations' shapes, for the integration's definition; the handlers below run them. */
export const operations = operationsWith(CallGate.make(GATE));

/** The role a call names, for recent calls; never its input or questions. */
const connectionId = (args: unknown, binding: Binding.Binding["Service"]): string | null => {
  if (
    !Predicate.isObject(args) ||
    typeof args.connection !== "string" ||
    !Object.hasOwn(binding.manifest.uses, args.connection)
  )
    return null;
  const declaration = binding.manifest.uses[args.connection];
  return declaration?.kind === "models" ? declaration.id : null;
};

/** Both handlers take their action's remaining time (`deadline: "attempt"`), not 15 seconds. */
export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const connections = yield* ConnectionStore.ConnectionStore;
  // One gate for this server process: every model call to a provider connection passes it.
  const { decide, generate } = operationsWith(CallGate.make(yield* gateLimits));
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Source.Source, source),
      Effect.provideService(ConnectionStore.ConnectionStore, connections)
    );
  return {
    "models.decide": {
      ...Runtime.handler(
        { kind: "integration", input: decide.input, output: decide.output, connectionId },
        (args) => provide(decide.run(args))
      ),
      deadline: "attempt" as const
    },
    "models.generate": {
      ...Runtime.handler(
        { kind: "integration", input: generate.input, output: generate.output, connectionId },
        (args) => provide(generate.run(args))
      ),
      deadline: "attempt" as const
    }
  };
});
