import { getServerConfig } from "@patchy/config";
import { openPatchyDb } from "@patchy/db";
import { AzureContentStore, BlobContainer, FilesystemContentStore } from "@patchy/content-store";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { createApp } from "./app.js";
import { layer } from "./runtime.js";

const config = getServerConfig();
const { db, tokens } = await openPatchyDb({
  driver: config.dbDriver,
  databaseUrl: config.databaseUrl,
  jsonDbFile: config.jsonDbFile,
  bootstrapApiToken: config.bootstrapApiToken
});

// Where a patch's bytes go is wiring, not a setting: Azure Blob when its
// container is configured, the local filesystem otherwise.
const contentStore = Layer.unwrap(
  Effect.map(Config.option(BlobContainer.container), (container) =>
    Option.isSome(container) ? AzureContentStore.layer : FilesystemContentStore.layer
  )
);

// The Effect side, built once and up front: analytics reports nothing unless
// a key is configured, a malformed analytics setting fails startup here
// rather than silently discarding every event, the Postgres tokens layer
// seeds the bootstrap token from `PATCHY_BOOTSTRAP_API_TOKEN`, and an
// incomplete Azure config fails startup rather than the first upload.
const runtime = ManagedRuntime.make(Layer.orDie(layer({ tokens, contentStore })));
await runtime.context();

const app = createApp({ config, db, runtime });

/**
 * How often the expiry sweep runs. Nothing depends on the exact period: a
 * draft's clock decides when it expires, and this only decides how long the
 * dead row lingers afterwards. Hourly keeps that lag small without making the
 * sweep a meaningful share of what the process does.
 */
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const runExpirySweep = (): void => {
  void app.sweepExpiredDrafts().catch((error: unknown) => {
    console.error("Expiry sweep failed.", error);
  });
};

const expirySweepTimer = setInterval(runExpirySweep, EXPIRY_SWEEP_INTERVAL_MS);
// The HTTP server holds the process open; the sweep should never be the reason
// it stays up, nor the reason a shutdown waits.
expirySweepTimer.unref();

const shutdown = async (): Promise<void> => {
  clearInterval(expirySweepTimer);
  await app.close();
  // Runs the analytics finalizer: whatever is still queued gets one bounded
  // chance to go out, and a slow analytics backend never holds the shutdown.
  await runtime.dispose();
  await db.close();
};

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

await app.listen({ host: "0.0.0.0", port: config.port });
console.log(`Patchy Cloud server listening on http://0.0.0.0:${config.port}`);

// A restart is exactly when a backlog is most likely, so sweep once on the way
// up rather than waiting out the first interval.
runExpirySweep();
