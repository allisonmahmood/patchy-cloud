import { requireConfigValue } from "@patchy/config";
import { JsonFilePatchyDb } from "./json-db.js";
import { PostgresPatchyDb } from "./postgres-db.js";
import type { DbFactoryOptions, PatchyDb } from "./types.js";

export function createPatchyDb(options: DbFactoryOptions): PatchyDb {
  if (options.driver === "postgres") {
    return new PostgresPatchyDb(requireConfigValue("DATABASE_URL", options.databaseUrl));
  }

  return new JsonFilePatchyDb(options.jsonDbFile);
}
