import { getServerConfig } from "@patchy/config";
import { createPatchyDb } from "./factory.js";

const config = getServerConfig();
const db = createPatchyDb({
  driver: config.dbDriver,
  databaseUrl: config.databaseUrl,
  jsonDbFile: config.jsonDbFile
});

try {
  await db.initialize(config.bootstrapApiToken);
  console.log(`Patchy Cloud ${config.dbDriver} database is initialized.`);
} finally {
  await db.close();
}
