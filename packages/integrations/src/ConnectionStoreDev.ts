import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ConnectionStore from "./ConnectionStore.js";

export interface DevConnection {
  readonly connection: ConnectionStore.Connection;
  readonly snapshots: ReadonlyArray<{
    readonly revision: number;
    readonly metadata: ConnectionStore.Metadata;
    /** Absent when local generated metadata does not carry the immutable row's timestamp. */
    readonly takenAt?: string;
  }>;
}

/** Metadata only: no platform SQL, credential keyring, credentials or network source. */
export const layer = (metadata: ReadonlyArray<DevConnection> = []) => {
  const unavailable = () => Effect.fail(new ConnectionStore.ConnectionMutationUnavailable({}));
  // Sends counted in this process only, by connection and UTC day.
  const sends = new Map<string, number>();
  const sendKey = (companyId: string, id: string, day: string) => `${companyId}\n${id}\n${day}`;
  return Layer.succeed(
    ConnectionStore.ConnectionStore,
    ConnectionStore.ConnectionStore.of({
      list: (companyId) =>
        Effect.succeed(
          metadata
            .filter((item) => item.connection.companyId === companyId)
            .map((item) => item.connection)
        ),
      get: (companyId, id) => {
        const item = metadata.find(
          (item) => item.connection.companyId === companyId && item.connection.id === id
        );
        return item === undefined
          ? Effect.fail(new ConnectionStore.ConnectionNotFound({ companyId, lookup: { id } }))
          : Effect.succeed(item.connection);
      },
      // Dev holds no stored patch versions, so it cannot say who declares a connection.
      usage: unavailable,
      versions: unavailable,
      detail: (companyId, integration, handle) => {
        const item = metadata.find(
          (item) =>
            item.connection.companyId === companyId &&
            item.connection.integration === integration &&
            item.connection.handle === handle
        );
        if (item === undefined)
          return Effect.fail(
            new ConnectionStore.ConnectionNotFound({ companyId, lookup: { integration, handle } })
          );
        const { description, status, blockGuests, metadataRevision: revision } = item.connection;
        const found = item.snapshots.find((snapshot) => snapshot.revision === revision);
        const base = {
          handle,
          description,
          status,
          ...(blockGuests === undefined ? {} : { blockGuests })
        };
        if (found?.takenAt === undefined)
          return Effect.succeed({ ...base, integration, snapshot: null });
        const stamp = { revision, takenAt: found.takenAt };
        const kept = found.metadata;
        switch (kept.integration) {
          case "postgres":
            return Effect.succeed({
              ...base,
              integration: kept.integration,
              snapshot: { ...kept.snapshot, ...stamp }
            });
          case "posthog":
            return Effect.succeed({
              ...base,
              integration: kept.integration,
              snapshot: { ...kept.snapshot, ...stamp }
            });
          case "pidgeon":
            return Effect.succeed({
              ...base,
              integration: kept.integration,
              snapshot: { ...kept.snapshot, ...stamp }
            });
          case "attio":
            return Effect.succeed({
              ...base,
              integration: kept.integration,
              snapshot: { ...kept.snapshot, ...stamp }
            });
        }
      },
      snapshot: (companyId, id, revision) => {
        const item = metadata.find(
          (item) => item.connection.companyId === companyId && item.connection.id === id
        );
        const snapshot = item?.snapshots.find((snapshot) => snapshot.revision === revision);
        return snapshot === undefined
          ? Effect.fail(
              new ConnectionStore.ConnectionNotFound({ companyId, lookup: { id, revision } })
            )
          : Effect.succeed(snapshot.metadata);
      },
      resolve: (companyId, declaration) => {
        const item = metadata.find(
          (item) =>
            item.connection.companyId === companyId &&
            item.connection.id === declaration.id &&
            item.connection.integration === declaration.kind &&
            item.connection.handle === declaration.handle
        );
        if (item === undefined || item.connection.status !== "connected")
          return Effect.fail(new ConnectionStore.ConnectionNotConnected({}));
        if (item.connection.metadataRevision !== declaration.revision)
          return Effect.fail(new ConnectionStore.StaleGenerated({}));
        return Effect.succeed({
          ...declaration,
          id: item.connection.id,
          revision: item.connection.metadataRevision
        });
      },
      poolCredentials: unavailable,
      connect: unavailable,
      test: unavailable,
      rotate: unavailable,
      retarget: unavailable,
      refresh: unavailable,
      disconnect: unavailable,
      reconnect: unavailable,
      describe: unavailable,
      setGuestBlock: unavailable,
      delete: unavailable,
      countSend: (companyId, id, day, budget) =>
        Effect.sync(() => {
          const key = sendKey(companyId, id, day);
          const count = sends.get(key) ?? 0;
          if (count >= budget) return false;
          sends.set(key, count + 1);
          return true;
        }),
      sends: (companyId, id, day) => Effect.sync(() => sends.get(sendKey(companyId, id, day)) ?? 0)
    })
  );
};
