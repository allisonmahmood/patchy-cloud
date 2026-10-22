// Writes local secrets only. Does not start services or contact any endpoint.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const directory = new URL("../../.local/nango/", import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
const secret = () => randomBytes(32).toString("base64url");
const environment = {
  NANGO_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  NANGO_DB_PASSWORD: secret(),
  NANGO_ADMIN_KEY: secret(),
  NANGO_DASHBOARD_USERNAME: "patchy-local",
  NANGO_DASHBOARD_PASSWORD: secret(),
  NANGO_SECRET_KEY_DEV: randomUUID()
};
try {
  await writeFile(
    new URL("env", directory),
    Object.entries(environment)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" }
  );
  console.log("Prepared .local/nango/env. No services started.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Existing .local/nango/env kept. No services started.");
}
