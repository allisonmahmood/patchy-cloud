/**
 * The operations patch code calls on a model role: `models.decide` and `models.generate`, in
 * actions only. Each loads the role as it stands now, so an admin's remap reaches published
 * patches at once, then the provider connection it points at and that connection's key. One
 * provider request per call, never retried, cut off a second before the action's own deadline so
 * the handler hears why. Each call adds an entry to the request's wide event: role, model,
 * duration, tokens and outcome, never the prompt or the answer. PROTOTYPE.
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
import * as Schema from "effect/Schema";
import * as ConnectionStore from "../ConnectionStore.js";
import { operation, ownerCheck, ViewerRefusal } from "../definition.js";
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

const isUnavailable = Schema.is(Errors.Unavailable);
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
      yield* WideEvents.modelCall({
        op,
        role: declaration.handle,
        model,
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
  const work = Effect.gen(function* () {
    const target = yield* loaded(provider(companyId, found.display.provider));
    const cutoff = Math.max(1, deadline - RESERVE_MS - (yield* Clock.currentTimeMillis));
    return yield* send({ key: target.key, model }, source).pipe(
      // Interrupting the request aborts its fetch, which closes the provider's connection.
      Effect.timeoutOrElse({
        duration: cutoff,
        orElse: () => Effect.fail(new Errors.Timeout({ milliseconds: cutoff }))
      })
    );
  });
  return yield* Effect.onExit(work, record);
});

const decide = operation({
  input: ModelsDecide,
  output: ModelsDecided,
  errors: ModelErrors,
  run: ({ connection, input, questions }: typeof ModelsDecide.Type) =>
    perform(connection, "decide", (target, source) =>
      source.decide({ key: target.key, model: target.model, input, questions })
    )
});
const generate = operation({
  input: ModelsGenerate,
  output: ModelsGenerated,
  errors: ModelErrors,
  run: ({ connection, ...request }: typeof ModelsGenerate.Type) =>
    perform(connection, "generate", (target, source) =>
      source.generate({ key: target.key, model: target.model, ...request })
    )
});

export const operations = { decide, generate };

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
