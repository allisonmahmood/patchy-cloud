/**
 * The instance's door for `patchy dev` reads of integrations that read the real connection in
 * development (ADR-0013): PostHog's queries, Pidgeon's reads, Attio's and IMAP's. A machine token is the only
 * authority: its current person, company and machine decide every call, and are checked again
 * once a read holds its slot. The repo's manifest only routed the call here; the connection it
 * names must be the company's. Writes never come here: `patchy dev` simulates them.
 *
 * The runtime's bounds hold: each operation's argument and result sizes, the integration
 * deadline, the project's, address's, workspace's or mailbox's slots shared with published patches, and
 * draining. A
 * per-person limit keys on no patch, so naming patches can't widen it. Every call with a valid
 * token and envelope is logged as a machine call with no patch or version, refusals included.
 * Published runtime calls still refuse bearer tokens; this door shares none of their admission.
 */
import {
  CurrentIdentity,
  DEV_ATTACHMENT_HEADER,
  DevAttachment,
  DevAttachmentMeta,
  DevReadEnvelope,
  PatchyApi,
  RuntimeSuccess,
  runtimeBodyLimitId
} from "@patchy/api";
import { Authorization, MachineTokens } from "@patchy/auth";
import { Cryptography } from "@patchy/core";
import { ContractLimits, Limits } from "@patchy/limits";
import { Runtime, RuntimeApi, RuntimeLog } from "@patchy/runtime";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as ConnectionStore from "./ConnectionStore.js";
import { attio } from "./attio/index.js";
import * as AttioOperations from "./attio/Operations.js";
import * as AttioSource from "./attio/Source.js";
import { imap } from "./imap/index.js";
import * as ImapOperations from "./imap/Operations.js";
import * as ImapSessions from "./imap/Sessions.js";
import type { DevRead, Target } from "./definition.js";
import { pidgeon } from "./pidgeon/index.js";
import * as PidgeonOperations from "./pidgeon/Operations.js";
import * as PidgeonSource from "./pidgeon/Source.js";
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
    return `The connection ${this.connection} is paused. Ask a company administrator to resume it at /settings/integrations.`;
  }
}

/**
 * Only what a definition's `live` names reaches this door: every Postgres operation and every
 * Pidgeon write is refused.
 */
const live = new Set(
  [postgres, posthog, pidgeon, attio, imap].flatMap((integration) =>
    (integration.live ?? []).map((operation) => `${integration.name}.${operation}`)
  )
);
const runners: {
  readonly [
    Op in
      | "posthog.query"
      | "pidgeon.read"
      | keyof typeof AttioOperations.devReads
      | keyof typeof ImapOperations.devReads
  ]: DevRead<
    | PostHogSource.Source
    | PidgeonSource.Source
    | AttioSource.Source
    | ImapSessions.Sessions
    | Cryptography.Cryptography
  >;
} = {
  ...PostHogOperations.devReads,
  ...PidgeonOperations.devReads,
  ...AttioOperations.devReads,
  ...ImapOperations.devReads
};
const isLive = (op: string): op is keyof typeof runners =>
  live.has(op) && Object.hasOwn(runners, op);
/** Each live operation's own argument bound, as the published runtime holds it. */
const bounds = [...new Set([...live].map(runtimeBodyLimitId))];

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(DevReadEnvelope), {
  onExcessProperty: "error"
});
const decodeAttachment = Schema.decodeUnknownEffect(Schema.fromJsonString(DevAttachment), {
  onExcessProperty: "error"
});
const encodeMeta = Schema.encodeEffect(Schema.fromJsonString(DevAttachmentMeta));
const encodeSuccess = Schema.encodeUnknownEffect(RuntimeSuccess);
const noStore = { "cache-control": "no-store" };
/** How much of an attachment's body is written before waiting for the socket to drain. */
const BODY_CHUNK = 64 * 1024;

export const layer = HttpApiBuilder.group(PatchyApi, "devReads", (handlers) =>
  Effect.gen(function* () {
    const cryptography = yield* Cryptography.Cryptography;
    const runtime = yield* Runtime.Runtime;
    const limits = yield* Limits.Limits;
    const log = yield* RuntimeLog.RuntimeLog;
    const tokens = yield* MachineTokens.MachineTokens;
    const connections = yield* ConnectionStore.ConnectionStore;
    const posthogSource = yield* PostHogSource.Source;
    const pidgeonSource = yield* PidgeonSource.Source;
    const attioSource = yield* AttioSource.Source;
    const imapSessions = yield* ImapSessions.Sessions;
    const settings = yield* Effect.all({
      callsPerMinute: ContractLimits.get("runtime.calls.perMinute"),
      deadlineMs: ContractLimits.get("integration.deadline")
    });
    const sizes = new Map(
      yield* Effect.forEach(bounds, (limitId) =>
        Effect.map(ContractLimits.get(limitId), (maxBytes) => [limitId, maxBytes] as const)
      )
    );
    // The body is read up to the largest live bound, then held to its own operation's.
    const [widest, widestBytes] = [...sizes].reduce((largest, next) =>
      next[1] > largest[1] ? next : largest
    );

    /**
     * One dev call as the token's person, logged before anything is checked and finished with
     * its outcome: rate limited per person, refused while draining, rechecked once a slot is held,
     * bounded by the integration deadline. `run` is undefined for an operation dev doesn't read.
     */
    const devCall = Effect.fnUntraced(function* <A>(call: {
      readonly op: string;
      readonly connection: { readonly id: string; readonly handle: string };
      readonly resource: string | null;
      readonly sql?: string | undefined;
      readonly run:
        | ((
            target: Target<KeyRefused | Runtime.AccessDenied | Runtime.SourceUnavailable>
          ) => Effect.Effect<
            A,
            | Runtime.RuntimeError
            | KeyRefused
            | ConnectionStore.ConnectionNotFound
            | ConnectionStore.ConnectionNotConnected,
            | PostHogSource.Source
            | PidgeonSource.Source
            | AttioSource.Source
            | ImapSessions.Sessions
            | Cryptography.Cryptography
            | ConnectionStore.ConnectionStore
          >)
        | undefined;
      readonly rowCount: (value: A) => number | null;
      readonly bytes?: (value: A) => number | null;
      readonly respond: (
        value: A
      ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Runtime.RuntimeError>;
    }) {
      const identity = yield* CurrentIdentity;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const named = `${call.op.slice(0, call.op.indexOf("."))}/${call.connection.handle}`;
      // Attribute the call only to a connection of the token's company: another company's id is
      // neither recorded nor confirmed. A lookup that failed refuses the call once it is logged.
      const lookup = yield* connections.get(identity.company.id, call.connection.id).pipe(
        Effect.map((found): string | null => found.id),
        Effect.catchTags({ ConnectionNotFound: () => Effect.succeed(null) }),
        Effect.result
      );
      const connectionId = lookup._tag === "Success" ? lookup.success : null;
      const correlationId = yield* cryptography.internalId("call");
      const startedAt = yield* Clock.currentTimeMillis;
      yield* log
        .begin({
          companyId: identity.company.id,
          userId: identity.user.id,
          credentialKind: "machine",
          machine: identity.machine,
          patchId: null,
          versionId: null,
          op: call.op,
          resource: call.resource,
          connectionId,
          ...(call.sql === undefined ? {} : { sql: call.sql }),
          correlationId,
          deadlineMs: settings.deadlineMs
        })
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
      // The same token, person, company and machine, once a slot is held and before the source hears.
      const recheck = Authorization.identify("build").pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(MachineTokens.MachineTokens, tokens),
        Effect.flatMap(
          (
            current
          ): Effect.Effect<void, KeyRefused | Runtime.AccessDenied | Runtime.SourceUnavailable> =>
            Option.isSome(current) &&
            current.value.user.id === identity.user.id &&
            current.value.company.id === identity.company.id &&
            current.value.machine.id === identity.machine.id
              ? connections.canUse(identity.company.id, call.connection.id, identity.user.id).pipe(
                  Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })),
                  Effect.flatMap((allowed) =>
                    allowed ? Effect.void : Effect.fail(new Runtime.AccessDenied({}))
                  )
                )
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
        if (call.run === undefined) return yield* new Runtime.InvalidRequest({});
        return yield* call
          .run({
            companyId: identity.company.id,
            connection: call.connection,
            deadline: startedAt + settings.deadlineMs,
            recheck
          })
          .pipe(
            Effect.provideService(PostHogSource.Source, posthogSource),
            Effect.provideService(PidgeonSource.Source, pidgeonSource),
            Effect.provideService(AttioSource.Source, attioSource),
            Effect.provideService(ImapSessions.Sessions, imapSessions),
            Effect.provideService(Cryptography.Cryptography, cryptography),
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
          rowCount: Exit.isSuccess(result) ? call.rowCount(result.value) : null,
          bytes: Exit.isSuccess(result) ? (call.bytes?.(result.value) ?? null) : null
        })
        .pipe(Effect.mapError((cause) => new Runtime.UnknownOutcome({ cause, correlationId })));
      if (Exit.isFailure(result))
        // A refusal of a live operation names it, as a published patch's refusal reaches its
        // caller, so the patch reads that integration's details in dev too.
        return yield* RuntimeApi.recordFailure(
          failure ?? new Runtime.SourceUnavailable({ cause: result.cause }),
          { correlationId, ...(call.run === undefined ? {} : { operation: call.op }) }
        );
      return yield* call.respond(result.value);
    });

    const read = Effect.fn("DevReads.read")(function* () {
      const { text, byteLength } = yield* RuntimeApi.readText(widestBytes, widest);
      const input = yield* decodeEnvelope(text).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const limitId = runtimeBodyLimitId(input.op);
      const maxBytes = sizes.get(limitId) ?? (yield* ContractLimits.get(limitId));
      if (byteLength > maxBytes) return yield* new Runtime.TooLarge({ maxBytes, limitId });
      const operation = isLive(input.op) ? runners[input.op] : undefined;
      return yield* devCall({
        op: input.op,
        connection: input.connection,
        resource: operation?.resource(input.args) ?? null,
        sql: operation?.sql?.(input.args),
        run: operation === undefined ? undefined : (target) => operation.run(target, input.args),
        rowCount: (value) => operation?.rowCount(value) ?? null,
        respond: (value) =>
          encodeSuccess({ ok: true, value }).pipe(
            Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })),
            Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: noStore }))
          )
      });
    });

    /**
     * An attachment's bytes for `patchy dev`, downloaded as a published stage downloads it and
     * answered with what the daemon checks them by. The call holds one of the process's attachment
     * places in the request's own scope, which closes once the body is sent or the client goes,
     * and the body streams a chunk at a time as the socket drains, so the bytes a slow client
     * hasn't read yet still count against the process's places.
     */
    const attachment = Effect.fn("DevReads.attachment")(function* () {
      const request = yield* Scope.Scope;
      const imapBytes =
        sizes.get("runtime.imap.bytes") ?? (yield* ContractLimits.get("runtime.imap.bytes"));
      const { text } = yield* RuntimeApi.readText(imapBytes, "runtime.imap.bytes");
      const input = yield* decodeAttachment(text).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      return yield* devCall({
        op: input.op,
        connection: input.connection,
        resource: null,
        run: (target) =>
          imapSessions
            .placeIn(target.deadline, request)
            .pipe(Effect.andThen(ImapOperations.downloadAttachment(target, input.args))),
        rowCount: () => null,
        bytes: (found) => found.bytes.byteLength,
        respond: (found) =>
          Effect.gen(function* () {
            const meta = yield* encodeMeta({
              size: found.bytes.byteLength,
              sha256: yield* cryptography.sha256(found.bytes),
              contentType: found.contentType,
              filename: found.filename
            }).pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
            const chunks = Array.from(
              { length: Math.ceil(found.bytes.byteLength / BODY_CHUNK) },
              (_, index) => found.bytes.subarray(index * BODY_CHUNK, (index + 1) * BODY_CHUNK)
            );
            return HttpServerResponse.stream(Stream.fromIterable(chunks), {
              contentType: "application/octet-stream",
              contentLength: found.bytes.byteLength,
              headers: {
                ...noStore,
                [DEV_ATTACHMENT_HEADER]: Buffer.from(meta).toString("base64url")
              }
            });
          })
      });
    });

    return handlers
      .handleRaw("devRead", () =>
        read().pipe(Effect.catch((error) => RuntimeApi.recordFailure(error)))
      )
      .handleRaw("devAttachment", () =>
        attachment().pipe(Effect.catch((error) => RuntimeApi.recordFailure(error)))
      );
  })
);
