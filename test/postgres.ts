import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { inject } from "vitest";
import type { TestProject } from "vitest/node";
import { PostgresPatchyDb } from "../packages/db/src/postgres-db.js";

const USER = "postgres";
const PASSWORD = "postgres";
const TEMPLATE_DATABASE = "patchy_test_template";

interface PostgresTestContext {
  adminUrl: string;
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
    postgresFlags: [
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off"
    ],
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
    const templateDb = new PostgresPatchyDb(templateUrl);
    try {
      await templateDb.initialize("dev-token");
    } finally {
      await templateDb.close();
    }

    project.provide("postgres", { adminUrl });
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

export interface PostgresTestDatabase {
  connectionString: string;
  drop(): Promise<void>;
}

/** Clones the migrated template so every test starts with the same isolated store. */
export async function createPostgresTestDatabase(): Promise<PostgresTestDatabase> {
  return createDatabase(TEMPLATE_DATABASE);
}

async function createDatabase(template: string | undefined): Promise<PostgresTestDatabase> {
  const { adminUrl } = inject("postgres");
  const databaseName = `patchy_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)}${template === undefined ? "" : ` TEMPLATE ${quoteIdentifier(template)}`}`
    );
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;

  return {
    connectionString: url.toString(),
    async drop() {
      const databaseAdmin = new pg.Client({ connectionString: adminUrl });
      await databaseAdmin.connect();
      try {
        await databaseAdmin.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
        );
      } finally {
        await databaseAdmin.end();
      }
    }
  };
}

/** PROTOTYPE (#55): an empty database the Effect Migrator migrates itself. */
export async function createEmptyPostgresDatabase(): Promise<PostgresTestDatabase> {
  return createDatabase(undefined);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
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
