import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as ConnectionStore from "../ConnectionStore.js";
import * as Source from "./Source.js";

/**
 * How a call reaches a connected Pidgeon address, for the operations #825 adds: it waits for one
 * of the address's slots, then checks its caller and the connection again and loads the key as it
 * stands when the call is sent. A call that waited through a rotation sends the new secret; one
 * whose connection was disconnected or moved meanwhile sends nothing.
 */

/** Which connection a call goes to and until when, for a caller its door already admitted. */
export interface Target<E = never> {
  readonly companyId: string;
  readonly connection: { readonly id: string; readonly handle: string };
  /** When the caller stops waiting, in epoch milliseconds; a queued call gives up before it. */
  readonly deadline: number;
  /** The caller, checked again once the call holds a slot and before anything is sent. */
  readonly recheck: Effect.Effect<void, E>;
}

/** The company's connected Pidgeon connection by this id and handle, and its key now. */
export const connect = Effect.fn("PidgeonCalls.connect")(function* (
  companyId: string,
  declared: Target["connection"]
) {
  const connections = yield* ConnectionStore.ConnectionStore;
  const connection = yield* connections.get(companyId, declared.id);
  if (
    connection.companyId !== companyId ||
    connection.integration !== "pidgeon" ||
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
    {
      kind: "pidgeon",
      id: connection.id,
      handle: connection.handle,
      revision: connection.metadataRevision
    },
    connection.credentialRevision
  );
  return yield* Source.parseCredentials(secret);
});

/**
 * Sends `request` for the connection once it holds a slot, built from the key it loads then. The
 * deadline bounds both the wait and the call; a full gate refuses `busy` with nothing sent.
 */
export const send = Effect.fn("PidgeonCalls.send")(function* <E>(
  target: Target<E>,
  request: (credentials: Source.Credentials) => Source.Request
) {
  const first = yield* connect(target.companyId, target.connection);
  const source = yield* Source.Source;
  return yield* source.withSlot(
    first.identityId,
    target.deadline
  )(
    Effect.gen(function* () {
      // The caller or the connection may have changed while this call waited: send only as they
      // stand now, with the key stored now, and never to an address the connection left.
      yield* target.recheck;
      const current = yield* connect(target.companyId, target.connection);
      if (current.identityId !== first.identityId)
        return yield* new ConnectionStore.ConnectionChanged({});
      return yield* source.call(
        Redacted.make(current.key.token),
        request(current),
        target.deadline
      );
    })
  );
});
