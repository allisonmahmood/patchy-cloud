import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as ConnectionStore from "../ConnectionStore.js";
import * as Source from "./Source.js";

/**
 * How a call reaches a connected Pidgeon address: it waits for one of the address's slots, then
 * checks its caller and the connection again and loads the key as it stands when the call is
 * sent. A call that waited through Replace key sends the new key; one whose connection was
 * disconnected or moved meanwhile sends nothing.
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

export type Connection = Extract<ConnectionStore.Connection, { readonly integration: "pidgeon" }>;

/** The address as a call found it once it held a slot, and a sender with its key as stored then. */
export interface Address {
  readonly connection: Connection;
  readonly credentials: Source.Credentials;
  /** Sends one request with that key, within the target's deadline. */
  readonly call: (request: Source.Request) => Effect.Effect<Source.Answer, Source.CallError>;
}

/** The company's connected Pidgeon connection by this id and handle, and its key now. */
const load = Effect.fn("PidgeonCalls.load")(function* (
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
  const credentials = yield* Source.parseCredentials(secret);
  return { connection, credentials };
});

/** The company's connected Pidgeon connection by this id and handle, and its key now. */
export const connect = Effect.fn("PidgeonCalls.connect")(function* (
  companyId: string,
  declared: Target["connection"]
) {
  return (yield* load(companyId, declared)).credentials;
});

/**
 * Runs `use` for the connection once it holds a slot, with the connection and key it loads then.
 * The deadline bounds both the wait and every call `use` sends; a full gate refuses `busy` with
 * nothing sent.
 */
export const withAddress = Effect.fn("PidgeonCalls.withAddress")(function* <E, A, E2, R2>(
  target: Target<E>,
  use: (address: Address) => Effect.Effect<A, E2, R2>
) {
  const first = yield* load(target.companyId, target.connection);
  const source = yield* Source.Source;
  return yield* source.withSlot(
    first.credentials.identityId,
    target.deadline
  )(
    Effect.gen(function* () {
      // The caller or the connection may have changed while this call waited: send only as they
      // stand now, with the key stored now, and never to an address the connection left.
      yield* target.recheck;
      const current = yield* load(target.companyId, target.connection);
      if (current.credentials.identityId !== first.credentials.identityId)
        return yield* new ConnectionStore.ConnectionChanged({});
      const token = Redacted.make(current.credentials.key.token);
      return yield* use({
        ...current,
        call: (request) => source.call(token, request, target.deadline)
      });
    })
  );
});
