import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ConnectionStore from "../ConnectionStore.js";
import * as Source from "./Source.js";

/**
 * How a call reaches a connected Attio workspace: it reads the snapshot its client was generated
 * from, then waits for one of the workspace's slots and one of Attio's, then checks its caller and the
 * connection again and loads the key as it stands when the call is sent. A call that waited
 * through Replace key sends the new key; one whose connection was disconnected meanwhile sends
 * nothing. Every request the call sends shares its bounds: a few at once, its deadline, and one
 * budget of raw bytes across all of them.
 */

/** Which connection and snapshot a call reads, and until when, for a caller its door admitted. */
export interface Target<E = never> {
  readonly companyId: string;
  readonly connection: {
    readonly id: string;
    readonly handle: string;
    /** The snapshot revision the caller's client was generated from. */
    readonly revision: number;
  };
  /** When the caller stops waiting, in epoch milliseconds; a queued call gives up before it. */
  readonly deadline: number;
  /** The caller, checked again once the call holds a slot and before anything is sent. */
  readonly recheck: Effect.Effect<void, E>;
}

/** The workspace as a call found it once it held a slot: a sender with its key then. */
export interface Workspace {
  /** Sends one request within the call's bounds; Attio's 4xx answers come back to read. */
  readonly send: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<Source.Answer, Source.SendError>;
}

/** The company's connected Attio connection by this id and handle, and its key now. */
export const current = Effect.fn("AttioCalls.current")(function* (
  companyId: string,
  declared: Target["connection"]
) {
  const connections = yield* ConnectionStore.ConnectionStore;
  const connection = yield* connections.get(companyId, declared.id);
  if (
    connection.companyId !== companyId ||
    connection.integration !== "attio" ||
    connection.mode !== "company" ||
    connection.handle !== declared.handle
  )
    return yield* new ConnectionStore.ConnectionNotFound({
      companyId,
      lookup: { id: declared.id }
    });
  if (connection.status !== "connected")
    return yield* new ConnectionStore.ConnectionNotConnected({});
  const secret = yield* connections.poolCredentials(
    companyId,
    { kind: "attio", id: connection.id, handle: connection.handle, revision: declared.revision },
    connection.credentialRevision
  );
  return yield* Source.parseCredentials(secret);
});

/**
 * The snapshot at the caller's revision, of this connection only: a revision of another
 * connection isn't found.
 */
export const snapshot = Effect.fn("AttioCalls.snapshot")(function* (
  companyId: string,
  declared: Target["connection"]
) {
  const connections = yield* ConnectionStore.ConnectionStore;
  const metadata = yield* connections.snapshot(companyId, declared.id, declared.revision);
  if (metadata.integration !== "attio")
    return yield* new ConnectionStore.ConnectionNotFound({
      companyId,
      lookup: { id: declared.id, revision: declared.revision }
    });
  return metadata.snapshot;
});

/**
 * Runs `use` for the connection once the call holds its slots, with a sender holding the key
 * loaded then. The deadline, capped at the integration deadline, bounds
 * the wait and everything `use` sends; a full gate refuses `busy` with nothing sent.
 */
export const withWorkspace = Effect.fn("AttioCalls.withWorkspace")(function* <E, A, E2, R2>(
  target: Target<E>,
  use: (workspace: Workspace) => Effect.Effect<A, E2, R2>
) {
  const first = yield* current(target.companyId, target.connection);
  const source = yield* Source.Source;
  return yield* source.withSlot(
    first.workspaceId,
    target.deadline
  )(
    Effect.gen(function* () {
      // The caller or the connection may have changed while this call waited: send only as they
      // stand now, with the key stored now, and never to a workspace the connection left.
      yield* target.recheck;
      const now = yield* current(target.companyId, target.connection);
      if (now.workspaceId !== first.workspaceId)
        return yield* new ConnectionStore.ConnectionChanged({});
      const key = Redacted.make(now.key);
      const inFlight = yield* Semaphore.make(registry["attio.call.concurrent"].default);
      const budget = { remaining: registry["attio.call.bytes"].default };
      const milliseconds = Math.max(
        1,
        Math.min(
          target.deadline - (yield* Clock.currentTimeMillis),
          registry["integration.deadline"].default
        )
      );
      return yield* use({
        send: (request) =>
          inFlight.withPermits(1)(
            source.send(key, request, { max: registry["attio.call.bytes"].default, budget })
          )
      }).pipe(
        Effect.timeoutOrElse({
          duration: milliseconds,
          orElse: () => Effect.fail(new Source.Timeout({ milliseconds }))
        })
      );
    })
  );
});
