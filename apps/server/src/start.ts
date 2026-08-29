import { getServerConfig, requireConfigValue } from "@patchy/config";
import { migrateDatabase } from "@patchy/db";
import { AzureContentStore, BlobContainer, FilesystemContentStore } from "@patchy/content-store";
import { ExpirySweep } from "@patchy/patches";
import { layerFromUrl } from "@patchy/sql";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createApp } from "./app.js";
import { layer } from "./runtime.js";

const config = getServerConfig();
const databaseUrl = requireConfigValue("DATABASE_URL", config.databaseUrl);
await migrateDatabase(databaseUrl);

// Where a patch's bytes go is wiring, not a setting: Azure Blob when its
// container is configured, the local filesystem otherwise.
const contentStore = Layer.unwrap(
  Effect.map(Config.option(BlobContainer.container), (container) =>
    Option.isSome(container) ? AzureContentStore.layer : FilesystemContentStore.layer
  )
);

// The Effect side, built once and up front: analytics reports nothing unless
// a key is configured, a malformed analytics setting fails startup here
// rather than silently discarding every event, the tokens layer seeds the
// bootstrap token from `PATCHY_BOOTSTRAP_API_TOKEN`, and an incomplete Azure
// config fails startup rather than the first upload.
const runtime = ManagedRuntime.make(
  Layer.orDie(layer({ sql: layerFromUrl(Redacted.make(databaseUrl)), contentStore }))
);
await runtime.context();

const app = createApp({ config, runtime });

/**
 * The expiry sweep, once on the way up — a restart is exactly when a backlog
 * is most likely — and then hourly. Nothing depends on the exact period: a
 * patch's clock decides when it expires, and this only decides how long the
 * dead row lingers afterwards.
 */
const sweeper = runtime.runFork(
  Effect.flatMap(ExpirySweep.ExpirySweep, (sweep) => sweep.sweep).pipe(
    Effect.repeat(Schedule.spaced("1 hour"))
  )
);

const shutdown = async (): Promise<void> => {
  await runtime.runPromise(Fiber.interrupt(sweeper));
  await app.close();
  // Runs the analytics finalizer: whatever is still queued gets one bounded
  // chance to go out, and a slow analytics backend never holds the shutdown.
  await runtime.dispose();
};

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

await app.listen({ host: "0.0.0.0", port: config.port });
console.log(`Patchy Cloud server listening on http://0.0.0.0:${config.port}`);
