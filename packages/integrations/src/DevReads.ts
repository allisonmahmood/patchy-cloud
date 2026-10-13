/**
 * The instance's door for `patchy dev` reads of integrations that read the real connection in
 * development (ADR-0013, #647). A machine token is the only authority: its current person,
 * company and machine decide every call, and are checked again once a read holds its slot. The
 * repo's manifest only routed the call here; the connection it names must be the company's.
 *
 * The runtime's bounds hold: its argument and result sizes, the integration deadline, the
 * project's slots shared with published patches, and draining. A per-person limit keys on no
 * patch, so naming patches can't widen it. Every call with a valid token and envelope is logged
 * as a machine call with no patch or version, refusals included. Published runtime calls still
 * refuse bearer tokens; this door shares none of their admission.
 */
import { CurrentIdentity, DevReadEnvelope, PatchyApi, RuntimeSuccess } from "@patchy/api";
import { Authorization, MachineTokens } from "@patchy/auth";
import { newInternalId } from "@patchy/core";
import { ContractLimits, Limits } from "@patchy/limits";
import { Runtime, RuntimeApi, RuntimeLog } from "@patchy/runtime";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as ConnectionStore from "./ConnectionStore.js";
import { postgres } from "./postgres/index.js";
import { posthog } from "./posthog/index.js";
import * as PostHogOperations from "./posthog/Operations.js";
import * as PostHogSource from "./posthog/Source.js";

/** The token stopped authenticating while the read waited for a slot; nothing was sent. */
export class KeyRefused extends Schema.TaggedError<KeyRefused>()("DevReadKeyRefused", {}) {
  readonly code = "access_denied" as const;
  readonly status = 401;
  override get message() {
    return "This machine's key stopped working while the read waited: it expired or was revoked, or its person was deactivated. Run `patchy login`, then `patchy dev stop` and `patchy dev`.";
  }
}

/** No such connection in the token's company; another company's answers the same. */
export class ConnectionNotFound extends Schema.TaggedError<ConnectionNotFound>()(
  "DevReadConnectionNotFound",
  { connection: Schema.String, cause: ConnectionStore.ConnectionNotFound }
) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return `Your company has no connection ${this.connection} by the id this repo was generated with. Restart \`patchy dev\` to pick up connection changes.`;
  }
}

export class ConnectionNotConnected extends Schema.TaggedError<ConnectionNotConnected>()(
  "DevReadConnectionNotConnected",
  { connection: Schema.String, cause: ConnectionStore.ConnectionNotConnected }
) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return `The connection ${this.connection} is disconnected. Ask a company administrator to reconnect it at /company/connections.`;
  }
}

/** Only what a definition's `live` names reaches this door; every Postgres operation is refused. */
const live = new Set(
  [postgres, posthog].flatMap((integration) =>
    (integration.live ?? []).map((operation) => `${integration.name}.${operation}`)
  )
);
const runners = PostHogOperations.devReads;
const isLive = (op: string): op is keyof typeof runners =>
  live.has(op) && Object.hasOwn(runners, op);

/**
 * The log keeps text as the caller sent it, but Postgres text can't hold NUL: an argument that
 * carries one is refused after logging, never before.
 */
const audit = (text: string | null | undefined) => text?.replaceAll("\u0000", "\uFFFD");

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(DevReadEnvelope), {
  onExcessProperty: "error"
});
const encodeSuccess = Schema.encodeUnknownEffect(RuntimeSuccess);
const noStore = { "cache-control": "no-store" };

export const layer = HttpApiBuilder.group(PatchyApi, "devReads", (handlers) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const limits = yield* Limits.Limits;
    const log = yield* RuntimeLog.RuntimeLog;
    const tokens = yield* MachineTokens.MachineTokens;
    const connections = yield* ConnectionStore.ConnectionStore;
    const source = yield* PostHogSource.Source;
    const settings = yield* Effect.all({
      callsPerMinute: ContractLimits.get("runtime.calls.perMinute"),
      maxBytes: ContractLimits.get("runtime.posthog.bytes"),
      deadlineMs: ContractLimits.get("integration.deadline")
    });

    const read = Effect.fn("DevReads.read")(function* () {
      const identity = yield* CurrentIdentity;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { text } = yield* RuntimeApi.readText(settings.maxBytes, "runtime.posthog.bytes");
      const input = yield* decodeEnvelope(text).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const operation = isLive(input.op) ? runners[input.op] : undefined;
      const named = `${input.op.slice(0, input.op.indexOf("."))}/${input.connection.handle}`;
      // Attribute the call only to a connection of the token's company: another company's id is
      // neither recorded nor confirmed. A lookup that failed refuses the call once it is logged.
      const lookup = yield* connections.get(identity.company.id, input.connection.id).pipe(
        Effect.map((found): string | null => found.id),
        Effect.catchTags({ ConnectionNotFound: () => Effect.succeed(null) }),
        Effect.result
      );
      const connectionId = lookup._tag === "Success" ? lookup.success : null;
      const correlationId = newInternalId("call");
      const startedAt = yield* Clock.currentTimeMillis;
      yield* log
        .begin({
          companyId: identity.company.id,
          userId: identity.user.id,
          credentialKind: "machine",
          machine: identity.machine,
          patchId: null,
          versionId: null,
          op: input.op,
          resource: audit(operation?.resource(input.args)) ?? null,
          connectionId,
          ...(operation === undefined ? {} : { sql: audit(operation.sql(input.args)) }),
          correlationId,
          deadlineMs: settings.deadlineMs
        })
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
      // The same token, person, company and machine, once a slot is held and before PostHog hears.
      const recheck = Authorization.identify.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(MachineTokens.MachineTokens, tokens),
        Effect.flatMap((current) =>
          Option.isSome(current) &&
          current.value.user.id === identity.user.id &&
          current.value.company.id === identity.company.id &&
          current.value.machine.id === identity.machine.id
            ? Effect.void
            : Effect.fail(new KeyRefused({}))
        )
      );
      const run = Effect.gen(function* () {
        if (lookup._tag === "Failure")
          return yield* new Runtime.SourceUnavailable({ cause: lookup.failure });
        if (yield* runtime.draining) return yield* new Runtime.Draining();
        const attempt = yield* limits.consume({
          key: `dev-read:${identity.user.id}`,
          limit: settings.callsPerMinute,
          window: "1 minute"
        });
        if (!attempt.allowed)
          return yield* new Runtime.RateLimited({
            retryAfterSeconds: attempt.retryAfterSeconds,
            limitId: attempt.reason === "capacity" ? "rate.trackedKeys" : "runtime.calls.perMinute",
            value: attempt.reason === "capacity" ? Limits.MAX_TRACKED_KEYS : settings.callsPerMinute
          });
        if (operation === undefined) return yield* new Runtime.InvalidRequest({});
        return yield* operation
          .run(
            {
              companyId: identity.company.id,
              connection: input.connection,
              deadline: startedAt + settings.deadlineMs,
              recheck
            },
            input.args
          )
          .pipe(
            Effect.provideService(PostHogSource.Source, source),
            Effect.provideService(ConnectionStore.ConnectionStore, connections),
            Effect.catchTags({
              ConnectionNotFound: (cause) =>
                Effect.fail(new ConnectionNotFound({ connection: named, cause })),
              ConnectionNotConnected: (cause) =>
                Effect.fail(new ConnectionNotConnected({ connection: named, cause }))
            })
          );
      }).pipe(
        Effect.timeoutOrElse({
          duration: settings.deadlineMs,
          orElse: () =>
            Effect.fail(
              new Runtime.Timeout({
                deadlineMs: settings.deadlineMs,
                limitId: "integration.deadline"
              })
            )
        })
      );
      const result = yield* Effect.exit(run);
      // A lost client or shutdown leaves the row pending, and so unknown, as the runtime's do.
      if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause))
        return yield* Effect.failCause(result.cause);
      const failure = Exit.isFailure(result)
        ? Option.getOrUndefined(Cause.findErrorOption(result.cause))
        : undefined;
      yield* log
        .finish({
          correlationId,
          outcome: Exit.isSuccess(result) ? "success" : "failure",
          outcomeCode: Exit.isSuccess(result) ? null : (failure?.code ?? "source_unavailable"),
          durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          rowCount:
            Exit.isSuccess(result) && operation !== undefined
              ? operation.rowCount(result.value)
              : null
        })
        .pipe(Effect.mapError((cause) => new Runtime.UnknownOutcome({ cause, correlationId })));
      if (Exit.isFailure(result))
        // A refusal of a live operation names it, as a published patch's refusal reaches its
        // caller, so the patch reads that integration's details in dev too.
        return yield* RuntimeApi.recordFailure(
          failure ?? new Runtime.SourceUnavailable({ cause: result.cause }),
          { correlationId, ...(operation === undefined ? {} : { operation: input.op }) }
        );
      const body = yield* encodeSuccess({ ok: true, value: result.value }).pipe(
        Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
      );
      return HttpServerResponse.jsonUnsafe(body, { headers: noStore });
    });

    return handlers.handleRaw("devRead", () =>
      read().pipe(Effect.catch((error) => RuntimeApi.recordFailure(error)))
    );
  })
);
