/**
 * Opens the metadata store the hosting server runs on, and with it the
 * `Tokens` layer that reads the same store: `@patchy/auth` over the Postgres
 * client, or the JSON adapter over the JSON driver.
 */
import { requireConfigValue } from "@patchy/config";
import { Tokens } from "@patchy/auth";
import { layerFromUrl } from "@patchy/sql";
import type { ConfigError } from "effect/Config";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { JsonFilePatchyDb } from "./json-db.js";
import { jsonTokensLayer } from "./json-tokens.js";
import { migrateDatabase } from "./migrate.js";
import { PostgresPatchyDb } from "./postgres-db.js";
import type { DbFactoryOptions, PatchyDb } from "./types.js";

export interface OpenedPatchyDb {
  readonly db: PatchyDb;
  /** Tokens over the same store; the Postgres layer also seeds the bootstrap token from config. */
  readonly tokens: Layer.Layer<Tokens.Tokens, ConfigError | SqlError>;
}

/** Migrates (Postgres) or initialises (JSON) the store, then opens it. */
export async function openPatchyDb(
  options: DbFactoryOptions & { bootstrapApiToken: string | null }
): Promise<OpenedPatchyDb> {
  if (options.driver === "postgres") {
    const url = requireConfigValue("DATABASE_URL", options.databaseUrl);
    await migrateDatabase(url);
    return {
      db: new PostgresPatchyDb(url),
      tokens: Tokens.layer.pipe(Layer.provide(layerFromUrl(Redacted.make(url))))
    };
  }

  const db = new JsonFilePatchyDb(options.jsonDbFile);
  await db.initialize(options.bootstrapApiToken);
  return { db, tokens: jsonTokensLayer(db) };
}
