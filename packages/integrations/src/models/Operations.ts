/**
 * The two calls patch code makes on a model role, `models.decide` and `models.generate`. Only an
 * action reaches them: the callback gateway refuses a query and a mutation, and a page's call is
 * refused `server_required` before any handler runs. A read-only action may call a model.
 *
 * Each call is checked twice against one read of the role, its provider and the patch owner's
 * authority. First, before it takes any capacity: the alias declares a role, the role and its
 * provider are connected, the owner may build with it, it is of the call's kind and admits the
 * caller, and the arguments are ones Patchy can send. Then it moves its action into the model
 * pool and waits in the host's admission queue. Once the request is prepared, the final check
 * asks the viewer's door again, then reads everything once more from one snapshot: the same
 * provider, model and credential revision, both still connected, the owner still allowed, the
 * guest policy for the viewer as the door now answers, and the provider's key from that read,
 * which is the key sent. A mismatch sends nothing: a remap or a replaced key answers
 * `source_unavailable` with reason `connection_changed`, a pause or lost access its own refusal.
 * A change that lands after that read may still see the request sent.
 *
 * Every refusal says in `details.sent` whether a request reached the transport. Every attempt the
 * host sees is one `model` event, owned to its settlement apart from the action's: the role,
 * provider record and type, model, kind, outcome, whether a request was sent, timing and tokens.
 * Never the instructions, the input or the answer. The pool move's limits land on the action's
 * own event.
 */
import {
  ModelsDecide,
  ModelsDecided,
  ModelsGenerate,
  ModelsGenerated,
  type HandlerSchema,
  type ModelRoleKind,
  type ModelUsage
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { registry } from "@patchy/limits/registry";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ConnectionStore from "../ConnectionStore.js";
import { ViewerRefusal } from "../definition.js";
import * as Admission from "./Admission.js";
import * as Errors from "./Errors.js";
import * as Source from "./Source.js";

const FLOOR_MS = registry["models.send.floor"].default;
const CUTOFF_MS = registry["models.cutoff"].default;
const ACTION_MS = registry["tier2.action.deadline"].default;

const isAccessDenied = Schema.is(Runtime.AccessDenied);
const isInvalidRequest = Schema.is(Errors.InvalidRequest);
const isViewerRefusal = Schema.is(ViewerRefusal);
const strict = { onExcessProperty: "error" } as const;
const decodeDecide = Schema.decodeUnknownEffect(ModelsDecide, strict);
const decodeGenerate = Schema.decodeUnknownEffect(ModelsGenerate, strict);
const encodeDecided = Schema.encodeEffect(ModelsDecided);
const encodeGenerated = Schema.encodeEffect(ModelsGenerated);

type Op = "decide" | "generate";
const kindOf: { readonly [K in Op]: ModelRoleKind } = { decide: "decision", generate: "text" };

/**
 * A refusal as the page reads it, saying whether a request reached the transport. One that
 * already says so keeps its own word.
 */
const withSent = (error: Runtime.RuntimeError, sent: boolean): Runtime.RuntimeError => {
  const details = "details" in error ? error.details : undefined;
  if (details !== undefined && "sent" in details) return error;
  return {
    code: error.code,
    status: error.status,
    message: error.message,
    ...("correlationId" in error && error.correlationId !== undefined
      ? { correlationId: error.correlationId }
      : {}),
    ...("retryAfterSeconds" in error && error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
    ...("limitId" in error && typeof error.limitId === "string"
      ? {
          limitId: error.limitId,
          ...("scope" in error && error.scope !== undefined ? { scope: error.scope } : {}),
          ...("value" in error && typeof error.value === "number" ? { value: error.value } : {})
        }
      : {}),
    details: { ...details, sent }
  };
};

/** The role, its provider and the owner's authority as one read found them; refusals mapped. */
const read = (
  binding: Binding.Binding["Service"],
  declared: { readonly id: string; readonly handle: string },
  key: boolean
) =>
  Effect.gen(function* () {
    const store = yield* ConnectionStore.ConnectionStore;
    return yield* store
      .modelCall({
        companyId: binding.companyId,
        patchId: binding.patchId,
        roleId: declared.id,
        key
      })
      .pipe(
        Effect.catchTags({
          ConnectionNotFound: (cause) => Effect.fail(new Runtime.AccessDenied({ cause })),
          ModelsUnavailable: (cause) => Effect.fail(new Runtime.AccessDenied({ cause }))
        }),
        Effect.mapError((error) =>
          isAccessDenied(error) ? error : new Runtime.SourceUnavailable({ cause: error })
        )
      );
  });

/**
 * Why a call can't go to the role as read, or nothing: gone or paused refuses as any connection
 * does, a provider this release doesn't know is unavailable, then the owner's authority, the
 * call's kind and the guest policy for `guest`, the viewer as the door last answered.
 */
const refusalOf = (
  found: ConnectionStore.ModelCall,
  declared: { readonly handle: string },
  op: Op,
  guest: boolean
): Runtime.RuntimeError | undefined => {
  const { role, provider } = found;
  if (role.handle !== declared.handle || role.status !== "connected")
    return new Runtime.AccessDenied({});
  if (role.role.provider === null || provider === undefined)
    return new Errors.Unavailable({ reason: "provider", sent: false });
  if (provider.status !== "connected" || !found.ownerCanUse) return new Runtime.AccessDenied({});
  if (role.role.kind !== kindOf[op])
    return new Errors.InvalidRequest({ reason: "kind", sent: false, kind: role.role.kind });
  if (guest && role.blockGuests) return new Runtime.AccessDenied({});
  return undefined;
};

/** The viewer as the door answers now, the same person in the same company, or its refusal. */
const reauthorized = (binding: Binding.Binding["Service"]) =>
  binding.reauthorize.pipe(
    Effect.mapError((error) =>
      isViewerRefusal(error) ? error : new Runtime.SourceUnavailable({ cause: error })
    ),
    Effect.flatMap((viewer) =>
      viewer.user.id === binding.identity?.user.id && viewer.company.id === binding.companyId
        ? Effect.succeed(viewer)
        : Effect.fail(new Runtime.AccessDenied({}))
    )
  );

/** The usage a refusal kept, for the attempt record. */
const usageOf = (error: unknown) =>
  Predicate.isObject(error) && "usage" in error && Predicate.isObject(error.usage)
    ? (error.usage as ModelUsage)
    : undefined;

/** The provider request a call makes once both checks pass, on the role's model. */
type Send<A> = <E>(
  source: Source.Source["Service"],
  target: Source.Target,
  dispatch: Source.Dispatch<E>
) => Effect.Effect<A, Errors.CallError | E>;

/**
 * One call as a loaded version's action made it: its arguments, both checks, the pool, the host's
 * queue and one provider request, all within the action's cut-off.
 */
const perform = <A extends { readonly usage: ModelUsage }>(
  op: Op,
  connection: string,
  output: HandlerSchema | undefined,
  attempt: Source.Attempt,
  send: Send<A>
) =>
  Effect.gen(function* () {
    const binding = yield* Binding.Binding;
    const declaration = Object.hasOwn(binding.manifest.uses, connection)
      ? binding.manifest.uses[connection]
      : undefined;
    if (declaration?.kind !== "models") return yield* new Errors.ConnectionNotDeclared();
    const { identity, principal } = binding;
    if (
      binding.scope === "public" ||
      identity === null ||
      principal === null ||
      identity.company.id !== binding.companyId ||
      identity.user.id !== principal.userId
    )
      return yield* new Runtime.AccessDenied({});
    yield* WideEvents.enrich({ roleId: declaration.id });
    // The first check, before the call takes any capacity.
    const first = yield* read(binding, declaration, false);
    const refused = refusalOf(first, declaration, op, identity.guest === true);
    if (refused !== undefined) return yield* Effect.fail(refused);
    const provider = first.provider!;
    yield* WideEvents.enrich({
      providerId: provider.id,
      provider: provider.integration,
      model: first.role.role.model
    });
    const checked = output === undefined ? undefined : Source.outputSchema(output);
    if (isInvalidRequest(checked)) return yield* checked;
    // The action leaves its ordinary slot for the model pool, once; the move's limits go on the
    // action's own event, not this attempt's.
    if (binding.modelPool !== undefined) yield* binding.modelPool;
    const deadline = binding.deadline ?? (yield* Clock.currentTimeMillis) + ACTION_MS;
    const store = yield* ConnectionStore.ConnectionStore;
    const source = yield* Source.Source;
    const admission = yield* Admission.Admission;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const admitted = yield* admission.acquire(provider.id, deadline - FLOOR_MS);
        yield* WideEvents.enrich({ admissionWaitMs: admitted.waitedMs });
        // The final check: the door first, then one read of everything, whose key is sent.
        const beforeSend = Effect.gen(function* () {
          const viewer = yield* reauthorized(binding);
          const now = yield* read(binding, declaration, true);
          if (
            now.provider?.id !== provider.id ||
            now.role.role.providerId !== provider.id ||
            now.role.role.model !== first.role.role.model ||
            now.provider.credentialRevision !== provider.credentialRevision
          ) {
            const paused = refusalOf(now, declaration, op, viewer.guest === true);
            return yield* Effect.fail(
              paused !== undefined && isAccessDenied(paused)
                ? paused
                : new Errors.Unavailable({ reason: "connection_changed", sent: false })
            );
          }
          const refusal = refusalOf(now, declaration, op, viewer.guest === true);
          if (refusal !== undefined) return yield* Effect.fail(refusal);
          return now.key!;
        }).pipe(Effect.provideService(ConnectionStore.ConnectionStore, store));
        return yield* send(
          source,
          { model: first.role.role.model },
          { deadline, attempt, beforeSend }
        );
      })
    );
  });

/** The role a call names, for recent calls; never its input, questions or instructions. */
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

/**
 * Both handlers. Each takes what is left of its action (`fence: "action"`), not
 * `integration.deadline`, and ends `models.cutoff` before the action's own deadline, so even a
 * slow store or door is answered with whether anything was sent. The process's one Source and
 * admission queue serve them.
 */
export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const admission = yield* Admission.Admission;
  const connections = yield* ConnectionStore.ConnectionStore;
  const wide = yield* WideEvents.WideEvents;
  /** One handler: decode, the call within its cut-off, encode, one attempt event. */
  const handler = <
    I extends { readonly connection: string },
    A extends { readonly usage: ModelUsage }
  >(
    op: Op,
    decode: (args: unknown) => Effect.Effect<I, Schema.SchemaError>,
    encode: (value: A) => Effect.Effect<unknown, Schema.SchemaError>,
    plan: (input: I) => { readonly output?: HandlerSchema; readonly send: Send<A> }
  ): Runtime.JsonHandler => ({
    kind: "integration",
    fence: "action",
    connectionId,
    resource: () => null,
    run: (args) =>
      Effect.gen(function* () {
        const binding = yield* Binding.Binding;
        const attempt: Source.Attempt = { sent: false };
        const started = yield* Clock.currentTimeMillis;
        const cutoff = Math.max(0, (binding.deadline ?? started + ACTION_MS) - CUTOFF_MS - started);
        // Captured here, inside the action's event, so the pool move records its limits there.
        const onAction = yield* WideEvents.capture;
        const work = Effect.gen(function* () {
          yield* WideEvents.enrich({ modelKind: kindOf[op] });
          const input = yield* decode(args).pipe(
            Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
          );
          const { output, send } = plan(input);
          const value = yield* perform(op, input.connection, output, attempt, send).pipe(
            Effect.provideService(Binding.Binding, {
              ...binding,
              ...(binding.modelPool === undefined ? {} : { modelPool: onAction(binding.modelPool) })
            })
          );
          return yield* encode(value).pipe(
            Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
          );
        }).pipe(
          Effect.timeoutOrElse({
            duration: cutoff,
            orElse: () =>
              Effect.fail(new Errors.Timeout({ sent: attempt.sent, milliseconds: cutoff }))
          }),
          Effect.mapError((error) => withSent(error, attempt.sent))
        );
        return yield* wide.withEvent(
          {
            type: "model",
            companyId: binding.companyId,
            patchId: binding.patchId,
            versionId: binding.versionId,
            door: "published",
            ...(binding.identity === null ? {} : { viewerId: binding.identity.user.id })
          },
          work.pipe(
            Effect.onExit((exit) => {
              const error = Exit.isFailure(exit)
                ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
                : undefined;
              const usage = attempt.usage ?? usageOf(error);
              // A failed attempt reads `failure`; `sent` says whether a request was sent.
              return WideEvents.enrich({
                sent: attempt.sent,
                ...(Predicate.isObject(error) && typeof error.code === "string"
                  ? { code: error.code }
                  : {}),
                ...(usage === undefined
                  ? {}
                  : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
              });
            })
          )
        );
      }).pipe(
        Effect.provideService(Source.Source, source),
        Effect.provideService(Admission.Admission, admission),
        Effect.provideService(ConnectionStore.ConnectionStore, connections)
      )
  });
  return {
    // The source reads only the call's own fields; the alias was already resolved to its role.
    "models.decide": handler("decide", decodeDecide, encodeDecided, (input) => ({
      send: (source, target, dispatch) => source.decide(target, input, dispatch)
    })),
    "models.generate": handler("generate", decodeGenerate, encodeGenerated, (input) => ({
      ...(input.output === undefined ? {} : { output: input.output }),
      send: (source, target, dispatch) => source.generate(target, input, dispatch)
    }))
  };
});
