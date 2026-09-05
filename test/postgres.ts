import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { applyDevSeed } from "@patchy/auth/seed";
import { migrations as companiesMigrations } from "../packages/companies/src/migrations.js";
import { migrations as authMigrations } from "../packages/auth/src/migrations.js";
import { migrations as patchesMigrations } from "../packages/patches/src/migrations.js";
import { layerFromUrl, migrate } from "../packages/sql/src/index.js";
import { PG_FLAGS, PG_PASSWORD, PG_USER } from "../scripts/dev/src/postgres.js";

const USER = PG_USER;
const PASSWORD = PG_PASSWORD;
const TEMPLATE_DATABASE = "patchy_test_template";

interface PostgresTestContext {
  adminUrl: string;
  templateDatabase: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    postgres: PostgresTestContext;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const databaseDir = await mkdtemp(path.join(os.tmpdir(), "patchy-postgres-"));
  const port = await availablePort();
  const embedded = new EmbeddedPostgres({
    databaseDir,
    port,
    user: USER,
    password: PASSWORD,
    persistent: false,
    postgresFlags: [...PG_FLAGS],
    onLog() {},
    onError(error) {
      console.error(error);
    }
  });

  try {
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase(TEMPLATE_DATABASE);

    const adminUrl = connectionString(port, "postgres");
    const templateUrl = connectionString(port, TEMPLATE_DATABASE);
    // vitest's globalSetup is not Effect code, so the Migrator runs from a
    // Promise here: one migrated template, cloned per test database.
    await Effect.runPromise(
      migrate({ ...companiesMigrations, ...authMigrations, ...patchesMigrations }).pipe(
        Effect.provide(layerFromUrl(Redacted.make(templateUrl)))
      )
    );
    // The same rows `pnpm dev` seeds, so a test and the dev instance agree
    // on which token works.
    await applyDevSeed(templateUrl);

    project.provide("postgres", { adminUrl, templateDatabase: TEMPLATE_DATABASE });
  } catch (error) {
    await embedded.stop();
    await rm(databaseDir, { recursive: true, force: true });
    throw error;
  }

  return async () => {
    await embedded.stop();
    await rm(databaseDir, { recursive: true, force: true });
  };
}

function connectionString(port: number, database: string): string {
  return `postgresql://${USER}:${PASSWORD}@127.0.0.1:${port}/${database}`;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a Postgres test port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
