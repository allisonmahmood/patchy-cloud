import type { Snapshot } from "@patchy/api/postgres-snapshot";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ConnectionStore from "./ConnectionStore.js";

export interface DevConnection {
  readonly connection: ConnectionStore.Connection;
  readonly snapshots: ReadonlyArray<{
    readonly revision: number;
    readonly snapshot: typeof Snapshot.Type;
  }>;
}

/** Metadata only: no platform SQL, credential keyring, credentials or network source. */
export const layer = (metadata: ReadonlyArray<DevConnection> = []) => {
  const unavailable = () => Effect.fail(new ConnectionStore.ConnectionMutationUnavailable({}));
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
          ? Effect.fail(new ConnectionStore.ConnectionNotFound({ companyId, id }))
          : Effect.succeed(item.connection);
      },
      snapshot: (companyId, id, revision) => {
        const item = metadata.find(
          (item) => item.connection.companyId === companyId && item.connection.id === id
        );
        const snapshot = item?.snapshots.find((snapshot) => snapshot.revision === revision);
        return snapshot === undefined
          ? Effect.fail(new ConnectionStore.ConnectionNotFound({ companyId, id, revision }))
          : Effect.succeed(snapshot.snapshot);
      },
      resolve: (companyId, declaration) => {
        const item = metadata.find(
          (item) =>
            item.connection.companyId === companyId &&
            item.connection.id === declaration.id &&
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
      delete: unavailable
    })
  );
};
