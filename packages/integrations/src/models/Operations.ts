/**
 * The two calls patch code makes on a model role, `models.decide` and `models.generate`. Only an
 * action reaches them: the callback gateway refuses a query and a mutation, and a page's call is
 * refused `server_required` before any handler runs. A read-only action may call a model.
 *
 * Each call is checked twice. First, before it takes any capacity: the alias declares a role, the
 * patch's owner can build with it, the role and its provider are connected, the role is of the
 * call's kind and admits the caller, and the arguments are ones Patchy can send. Then it moves its
 * action into the model pool, waits in the host's admission queue, loads the provider's key and
 * prepares the request; immediately before dispatch the final check finds the same provider,
 * model and credential revision, the role and provider still connected, and the owner and the
 * viewer or guest still allowed. A mismatch sends nothing: a remap or a replaced key answers
 * `source_unavailable` with reason `connection_changed`, a pause or lost access its own refusal.
 * A call past the final check may dispatch and complete.
 *
 * Every attempt the host sees is one `model` event, owned to its settlement apart from the
 * action's: the role, provider record and type, model, kind, outcome, whether a request was
 * dispatched, timing and tokens. Never the instructions, the input or the answer.
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
import { ownerCheck, viewerRecheck } from "../definition.js";
import * as Admission from "./Admission.js";
import * as Errors from "./Errors.js";
import type * as Models from "./Models.js";
import * as Source from "./Source.js";

const FLOOR_MS = registry["models.send.floor"].default;
const ACTION_MS = registry["tier2.action.deadline"].default;

const isAccessDenied = Schema.is(Runtime.AccessDenied);
const isUnavailable = Schema.is(Errors.Unavailable);
const isInvalidRequest = Schema.is(Errors.InvalidRequest);

type Op = "decide" | "generate";
const kindOf: { readonly [K in Op]: ModelRoleKind } = { decide: "decision", generate: "text" };

/** What the first check found, which the final check must find again. */
interface Mapping {
  readonly providerId: string;
  readonly provider: Models.Provider;
  readonly model: string;
  readonly credentialRevision: number;
}

/**
 * The role and its provider as they stand now: gone or paused refuses as any connection does, a
 * provider this release doesn't know is unavailable.
 */
const current = Effect.fn("ModelsOperations.current")(function* (
  companyId: string,
  declared: { readonly id: string; readonly handle: string }
) {
  const store = yield* ConnectionStore.ConnectionStore;
  const absent = (cause: unknown) => new Runtime.AccessDenied({ cause });
  const stored = (cause: unknown) => new Runtime.SourceUnavailable({ cause });
  const role = yield* store.get(companyId, declared.id).pipe(
    Effect.catchTags({
      ConnectionNotFound: (cause) => Effect.fail(absent(cause)),
      ModelsUnavailable: (cause) => Effect.fail(absent(cause))
    }),
    Effect.mapError((error) => (isAccessDenied(error) ? error : stored(error)))
  );
  if (role.integration !== "models" || role.handle !== declared.handle)
    return yield* absent(new ConnectionStore.ConnectionNotFound({ companyId, lookup: declared }));
  if (role.status !== "connected")
    return yield* absent(new ConnectionStore.ConnectionNotConnected({}));
  if (role.role.provider === null)
    return yield* new Errors.Unavailable({ reason: "provider", sent: false });
  const provider = yield* store.provider(companyId, role.role.providerId).pipe(
    Effect.catchTags({
      ConnectionNotFound: (cause) => Effect.fail(absent(cause)),
      ModelsUnavailable: (cause) => Effect.fail(absent(cause))
    }),
    Effect.mapError((error) => (isAccessDenied(error) ? error : stored(error)))
  );
  if (provider.status !== "connected")
    return yield* absent(new ConnectionStore.ConnectionNotConnected({}));
  return {
    role,
    mapping: {
      providerId: provider.id,
      provider: provider.integration,
      model: role.role.model,
      credentialRevision: provider.credentialRevision
    } satisfies Mapping
  };
});

/** The usage a refusal kept, for the attempt record. */
const usageOf = (error: unknown) =>
  Predicate.isObject(error) && "usage" in error && Predicate.isObject(error.usage)
    ? (error.usage as { readonly inputTokens: number | null; readonly outputTokens: number | null })
    : undefined;

/** The provider request a call makes once both checks pass, on the role's model and key. */
type Send<A> = <E>(
  source: Source.Source["Service"],
  target: Source.Target,
  dispatch: Source.Dispatch<E>
) => Effect.Effect<A, Errors.CallError | E>;

/**
 * One call as a loaded version's action made it: the declared role, both checks, the pool, the
 * host's queue, the key, and one provider request under the action's deadline.
 */
const perform = <A extends { readonly usage: ModelUsage }>(
  op: Op,
  connection: string,
  output: HandlerSchema | undefined,
  send: Send<A>
) =>
  Effect.gen(function* () {
    const binding = yield* Binding.Binding;
    const wide = yield* WideEvents.WideEvents;
    const attempt: Source.Attempt = { sent: false };
    const started = yield* Clock.currentTimeMillis;
    const work = Effect.gen(function* () {
      const declaration = Object.hasOwn(binding.manifest.uses, connection)
        ? binding.manifest.uses[connection]
        : undefined;
      if (declaration?.kind !== "models") return yield* new Errors.ConnectionNotDeclared();
      const { identity, principal, companyId } = binding;
      if (
        binding.scope === "public" ||
        identity === null ||
        principal === null ||
        identity.company.id !== companyId ||
        identity.user.id !== principal.userId
      )
        return yield* new Runtime.AccessDenied({});
      yield* WideEvents.enrich({ roleId: declaration.id, modelKind: kindOf[op] });
      // The first check, before the call takes any capacity.
      yield* ownerCheck(binding, declaration.id);
      const first = yield* current(companyId, declaration);
      yield* WideEvents.enrich({
        providerId: first.mapping.providerId,
        provider: first.mapping.provider,
        model: first.mapping.model
      });
      if (first.role.role.kind !== kindOf[op])
        return yield* new Errors.InvalidRequest({
          reason: "kind",
          sent: false,
          kind: first.role.role.kind
        });
      if (identity.guest === true && first.role.blockGuests)
        return yield* new Runtime.AccessDenied({});
      const checked = output === undefined ? undefined : Source.outputSchema(output);
      if (isInvalidRequest(checked)) return yield* checked;
      // The action leaves its ordinary slot for the model pool, once.
      if (binding.modelPool !== undefined) yield* binding.modelPool;
      const deadline = binding.deadline ?? started + ACTION_MS;
      const store = yield* ConnectionStore.ConnectionStore;
      const source = yield* Source.Source;
      const admission = yield* Admission.Admission;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const admitted = yield* admission.acquire(first.mapping.providerId, deadline - FLOOR_MS);
          yield* WideEvents.enrich({ admissionWaitMs: admitted.waitedMs });
          const key = yield* store
            .providerKey(companyId, first.mapping.providerId, first.mapping.credentialRevision)
            .pipe(
              Effect.catchTags({
                // The key was replaced while the call waited: nothing was sent.
                ConnectionChanged: () =>
                  Effect.fail(
                    new Errors.Unavailable({ reason: "connection_changed", sent: false })
                  ),
                ConnectionNotConnected: (cause) => Effect.fail(new Runtime.AccessDenied({ cause })),
                ConnectionNotFound: (cause) => Effect.fail(new Runtime.AccessDenied({ cause }))
              }),
              Effect.mapError((error) =>
                isAccessDenied(error) || isUnavailable(error)
                  ? error
                  : new Runtime.SourceUnavailable({ cause: error })
              )
            );
          // The final check, once the request is prepared and immediately before it is sent.
          const beforeSend = Effect.gen(function* () {
            const now = yield* current(companyId, declaration);
            if (
              now.mapping.providerId !== first.mapping.providerId ||
              now.mapping.model !== first.mapping.model ||
              now.mapping.credentialRevision !== first.mapping.credentialRevision ||
              now.role.role.kind !== first.role.role.kind
            )
              return yield* new Errors.Unavailable({ reason: "connection_changed", sent: false });
            if (identity.guest === true && now.role.blockGuests)
              return yield* new Runtime.AccessDenied({});
            yield* ownerCheck(binding, declaration.id);
            yield* viewerRecheck(binding);
          }).pipe(Effect.provideService(ConnectionStore.ConnectionStore, store));
          return yield* send(
            source,
            { key, model: first.mapping.model },
            { deadline, attempt, beforeSend }
          );
        })
      );
    });
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
          const usage = Exit.isSuccess(exit) ? exit.value.usage : (attempt.usage ?? usageOf(error));
          // A failed attempt reads `failure`; `sent` says whether a request was dispatched.
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
 * `integration.deadline`, and cuts itself off before the action's own deadline. The process's
 * one Source and admission queue serve them, as they will the dev door and the test call.
 */
export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const admission = yield* Admission.Admission;
  const connections = yield* ConnectionStore.ConnectionStore;
  const wide = yield* WideEvents.WideEvents;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Source.Source, source),
      Effect.provideService(Admission.Admission, admission),
      Effect.provideService(ConnectionStore.ConnectionStore, connections),
      Effect.provideService(WideEvents.WideEvents, wide)
    );
  return {
    "models.decide": Runtime.handler(
      {
        kind: "integration",
        fence: "action",
        input: ModelsDecide,
        output: ModelsDecided,
        connectionId,
        resource: () => null
      },
      ({ connection, ...args }) =>
        provide(
          perform("decide", connection, undefined, (source, target, dispatch) =>
            source.decide(target, args, dispatch)
          )
        )
    ),
    "models.generate": Runtime.handler(
      {
        kind: "integration",
        fence: "action",
        input: ModelsGenerate,
        output: ModelsGenerated,
        connectionId,
        resource: () => null
      },
      ({ connection, ...args }) =>
        provide(
          perform("generate", connection, args.output, (source, target, dispatch) =>
            source.generate(target, args, dispatch)
          )
        )
    )
  };
});
