import { getServerConfig, requireConfigValue } from "@patchy/config";
import { createPatchyDb, migrateDatabase } from "@patchy/db";
import { createHtmlStorage } from "@patchy/storage";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { createApp } from "./app.js";
import { layer } from "./runtime.js";

const config = getServerConfig();
const db = createPatchyDb({
  driver: config.dbDriver,
  databaseUrl: config.databaseUrl,
  jsonDbFile: config.jsonDbFile
});
const storage = createHtmlStorage({
  driver: config.storageDriver,
  storageDir: config.storageDir,
  azureStorageAccount: config.azureStorageAccount,
  azureStorageContainer: config.azureStorageContainer,
  azureStorageConnectionString: config.azureStorageConnectionString
});

if (config.dbDriver === "postgres") {
  await migrateDatabase(requireConfigValue("DATABASE_URL", config.databaseUrl));
}
await db.initialize(config.bootstrapApiToken);

// The Effect side, built once and up front: analytics reports nothing unless
// a key is configured, and a malformed analytics setting fails startup here
// rather than silently discarding every event.
const runtime = ManagedRuntime.make(Layer.orDie(layer));
await runtime.context();

const app = createApp({ config, db, storage, runtime });

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
