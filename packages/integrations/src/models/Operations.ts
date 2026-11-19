/**
 * The operations patch code calls on a model role: `models.decide` and `models.generate`, in
 * actions only. Each loads the role as it stands now, so an admin's remap reaches published
 * patches at once, then the provider connection it points at and that connection's key. One
 * provider request per call, never retried, cut off a second before the action's own deadline so
 * the handler hears why. Calls to one provider connection pass a fair gate (CallGate): a call past
 * its limits waits its turn until that cut-off, then rechecks its viewer and reloads the key. Each
 * call adds an entry to the request's wide event: role, model, gate wait, duration, tokens and
 * outcome, never the prompt or the answer.
 *
 * `patchy dev` makes the same calls for real through the instance's dev door (`devReads`,
 * ADR-0013), as the machine token's person, through the same gate, with its local action's
 * remaining time, each counted against that person's daily allowance before the provider hears
 * it. PROTOTYPE.
 */
import {
  ModelsDecide,
  ModelsDecideArgs,
  ModelsDecided,
  ModelsGenerate,
  ModelsGenerateArgs,
  ModelsGenerated,
  type ModelUsage
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as CallGate from "../CallGate.js";
import * as ConnectionStore from "../ConnectionStore.js";
import {
  type DevRead,
  operation,
  ownerCheck,
  viewerRecheck,
  ViewerRefusal
} from "../definition.js";
import * as Admission from "./Admission.js";
import * as Errors from "./Errors.js";
import * as Source from "./Source.js";

export const ModelErrors = Schema.Union([
  Errors.ConnectionNotDeclared,
  Errors.Timeout,
  Errors.Busy,
  Errors.RateLimited,
  Errors.Unavailable,
  Errors.InvalidRequest,
  Errors.ShapeMismatch,
  Errors.OutputTruncated,
  Errors.Refused,
  Errors.TooLarge,
  Errors.DevDailySpent,
  Runtime.InvalidRequest,
  ...ViewerRefusal.members
]);

/** How much of the action's time a model call leaves its handler to hear why it stopped. */
export const RESERVE_MS = 1_000;
const FALLBACK_MS = 60_000;
const DAY_MS = 86_400_000;

const isUnavailable = Schema.is(Errors.Unavailable);
const isBusy = Schema.is(Errors.Busy);
const isRefused = Schema.is(CallGate.Refused);
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

type Send<A> = (
  target: { readonly key: Redacted.Redacted<string>; readonly model: string },
  source: Source.Source["Service"]
) => Effect.Effect<A, Errors.CallError>;

/** One call a door admitted: who makes it, to which role as loaded now, and until when. */
interface Call<E> {
  readonly companyId: string;
  readonly person: string;
  readonly role: Role;
  readonly started: number;
  /** When the caller stops waiting, in epoch milliseconds; the call is cut off a second before. */
  readonly deadline: number;
  /** Once the gate lets the call through, with how long it waited, before anything is sent. */
  readonly admitted: (waitedMs: number) => Effect.Effect<void, E, ConnectionStore.ConnectionStore>;
}

/**
 * The call itself, for either door: the role's kind, the gate, the door's own check once through,
 * the key as it is then, the provider request under the cut-off, and the wide-event entry.
 */
const send = Effect.fn("ModelsOperations.send")(function* <
  A extends { readonly usage: ModelUsage },
  E
>(gate: CallGate.Gate, call: Call<E>, op: "decide" | "generate", request: Send<A>) {
  const kind = call.role.display.kind;
  if ((op === "decide") !== (kind === "decision"))
    return yield* new Errors.InvalidRequest({ reason: "kind", kind });
  const model = call.role.display.model;
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
        role: call.role.handle,
        model,
        ...gated,
        durationMs: ended - call.started,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        outcome: Exit.isSuccess(exit)
          ? "ok"
          : Predicate.isObject(error) && typeof error.code === "string"
            ? error.code
            : "interrupted"
      });
    });
  const until = call.deadline - RESERVE_MS;
  const work = gate
    .run({ connection: call.role.display.provider, person: call.person }, until, (through) =>
      Effect.gen(function* () {
        admitted = through;
        yield* call.admitted(through.waitedMs);
        // The key as it is now, after any wait.
        const target = yield* loaded(provider(call.companyId, call.role.display.provider));
        const cutoff = Math.max(1, until - (yield* Clock.currentTimeMillis));
        return yield* request({ key: target.key, model }, source).pipe(
          // Interrupting the request aborts its fetch, which closes the provider's connection.
          Effect.timeoutOrElse({
            duration: cutoff,
            orElse: () => Effect.fail(new Errors.Timeout({ milliseconds: cutoff }))
          })
        );
      })
    )
    .pipe(
      Effect.mapError((error) =>
        isRefused(error)
          ? new Errors.Busy({
              limit: error.limit,
              value: error.value,
              waitedMs: Math.round(error.waitedMs)
            })
          : error
      )
    );
  return yield* Effect.onExit(work, record);
});

/**
 * One call as a loaded version's door admitted it: the declared role, its viewer and the patch's
 * owner, who must be able to build with the role. A role of the other kind refuses before the
 * provider sees anything.
 */
const perform = Effect.fn("ModelsOperations.perform")(function* <
  A extends { readonly usage: ModelUsage }
>(gate: CallGate.Gate, alias: string, op: "decide" | "generate", request: Send<A>) {
  const binding = yield* Binding.Binding;
  const declaration = binding.manifest.uses[alias];
  if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "models")
    return yield* new Errors.ConnectionNotDeclared({});
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
  return yield* send(
    gate,
    {
      companyId,
      person: identity.user.id,
      role: found,
      started,
      deadline,
      // A call that waited asks again whether its viewer may still call, as other gates do.
      admitted: (waitedMs) => (waitedMs > 0 ? viewerRecheck(binding) : Effect.void)
    },
    op,
    request
  );
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
export const operations = operationsWith(CallGate.make(Admission.GATE));

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
  // The process's gate: published calls and the dev door's pass the same one.
  const { decide, generate } = operationsWith((yield* Admission.Admission).gate);
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

// ---------- patchy dev, through the instance's dev door ----------

/** A role gone or paused comes back as it is, for the door to say; anything else is unavailable. */
const devLoaded = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  | ConnectionStore.ConnectionNotFound
  | ConnectionStore.ConnectionNotConnected
  | Runtime.SourceUnavailable,
  R
> =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.fail(isAbsent(error) ? error : new Runtime.SourceUnavailable({ cause: error }))
    )
  );

/**
 * Counts the call against the person's `patchy dev` allowance for the UTC day, or refuses it
 * before the provider hears anything.
 */
const countDev = Effect.fn("ModelsOperations.countDev")(function* (
  companyId: string,
  person: string,
  budget: number
) {
  const now = yield* Clock.currentTimeMillis;
  const counted = yield* (yield* ConnectionStore.ConnectionStore)
    .countDevModelCall({
      companyId,
      userId: person,
      day: DateTime.formatIsoDateUtc(DateTime.makeUnsafe(now)),
      budget
    })
    .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
  if (counted === undefined)
    return yield* new Errors.DevDailySpent({
      budget,
      retryAfterSeconds: Math.ceil((DAY_MS - (now % DAY_MS)) / 1_000)
    });
});

const decodeDecide = Schema.decodeUnknownEffect(ModelsDecideArgs);
const decodeGenerate = Schema.decodeUnknownEffect(ModelsGenerateArgs);

/**
 * A dev door call: the role the repo's manifest routed to, in the token's company, as the token's
 * person once the gate lets them through, counted before the provider hears it.
 */
const devCall =
  <Args, A extends { readonly usage: ModelUsage }>(
    op: "decide" | "generate",
    decode: (args: unknown) => Effect.Effect<Args, Schema.SchemaError>,
    request: (args: Args) => Send<A>
  ): DevRead<Source.Source | Admission.Admission>["run"] =>
  (target, args) =>
    Effect.gen(function* () {
      const decoded = yield* decode(args).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      if (target.person === undefined) return yield* new Runtime.AccessDenied({});
      const person = target.person;
      const admission = yield* Admission.Admission;
      const started = yield* Clock.currentTimeMillis;
      const found = yield* devLoaded(role(target.companyId, target.connection));
      return yield* send(
        admission.gate,
        {
          companyId: target.companyId,
          person,
          role: found,
          started,
          deadline: target.deadline,
          // The door's check of the token's person and their access, then the day's count.
          admitted: () =>
            target.recheck.pipe(
              Effect.andThen(countDev(target.companyId, person, admission.devDaily))
            )
        },
        op,
        request(decoded)
      );
    });

/**
 * Both calls as the instance's dev door runs them (ADR-0013). Real calls on the company's
 * provider, through the process's gate, given the local action's remaining time.
 */
export const devReads: {
  readonly [Op in "models.decide" | "models.generate"]: DevRead<
    Source.Source | Admission.Admission
  >;
} = {
  "models.decide": {
    resource: () => null,
    rowCount: () => null,
    run: devCall(
      "decide",
      decodeDecide,
      ({ input, questions }) =>
        (target, source) =>
          source.decide({ key: target.key, model: target.model, input, questions })
    )
  },
  "models.generate": {
    resource: () => null,
    rowCount: () => null,
    run: devCall(
      "generate",
      decodeGenerate,
      (args) => (target, source) =>
        source.generate({ key: target.key, model: target.model, ...args })
    )
  }
};
