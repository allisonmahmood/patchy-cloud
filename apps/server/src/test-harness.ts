/**
 * A Fastify app over a fresh Postgres clone of the migrated template, for
 * the server's tests. Each harness owns its database and drops it on close;
 * `restart` opens a second app on the same database to prove what survives a
 * process restart. Excluded from `tsc` (it reaches into `test/postgres.ts`),
 * imported by the test files only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Analytics } from "@patchy/analytics";
import type { ServerConfig } from "@patchy/config";
import { Tokens } from "@patchy/auth";
import type { ContentStore } from "@patchy/content-store";
import { Content, Patches } from "@patchy/patches";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import pg from "pg";
import { createPostgresTestDatabase, type PostgresTestDatabase } from "../../../test/postgres.js";
import { createApp } from "./app.js";
import type { ServerRuntime, ServerServices } from "./runtime.js";
import { createTestRuntime } from "./testing.js";

export interface TestAppOptions {
  readonly config?: Partial<ServerConfig>;
  /** Epoch milliseconds the app, the limiter and the retention clock all read. */
  readonly clock?: () => number;
  readonly analytics?: Layer.Layer<Analytics.Analytics>;
  readonly contentStore?: Layer.Layer<ContentStore.ContentStore>;
}

export interface TestApp {
  readonly app: ReturnType<typeof createApp>;
  readonly runtime: ServerRuntime;
  readonly config: ServerConfig;
  /** Where the filesystem content store writes, unless a test brought its own store. */
  readonly storageDir: string;
  /** Runs an Effect on the app's runtime: the door to the capability services. */
  run<A, E>(effect: Effect.Effect<A, E, ServerServices>): Promise<A>;
  /** Runs one statement on the app's database, for what only the store can be made to do. */
  sql(
    text: string,
    values?: ReadonlyArray<string>
  ): Promise<ReadonlyArray<Record<string, unknown>>>;
  /** Issues a token for the bootstrap principal; the plaintext is `token`. */
  createToken(input: { name: string; scopes: string[]; token: string }): Promise<{ id: string }>;
  /** Revokes a token by id. */
  revokeToken(apiTokenId: string): Promise<void>;
  /** Records an upload straight into the store, bypassing the API. */
  upload(input: Omit<Content.UploadInput, "sourceIp" | "userAgent">): Promise<Patches.Recorded>;
  /** The version the latest URL serves, or `null`; see `Patches.find`. */
  currentVersion(patchId: string): Promise<Patches.PatchVersion | null>;
  /** Disables a patch as its owner; see `Patches.disable`. */
  disable(patchId: string, accountId: string, reason: string): Promise<boolean>;
  /** Deletes a patch as its owner; see `Patches.delete`. */
  delete(patchId: string, accountId: string): Promise<boolean>;
  /** A second app over the same database and store, as a restart would open. Closes this one. */
  restart(options?: TestAppOptions): Promise<TestApp>;
  close(): Promise<void>;
}

/** The app's configuration with every field set; a test overrides what it tests. */
export function testConfig(
  storageDir: string,
  overrides: Partial<ServerConfig> = {}
): ServerConfig {
  return {
    port: 3000,
    publicBaseUrl: "http://localhost:3000",
    trustProxy: false,
    bootstrapApiToken: "dev-token",
    allowSelfServiceTokens: false,
    maxHtmlBytes: 512 * 1024,
    protectedApiRateLimitPerMinute: 60,
    authenticatedUploadRateLimitPerMinute: 20,
    selfServiceMintRateLimitPerMinute: 5,
    selfServiceMintsPerIpPerDay: 5,
    patchCreateRateLimitPerMinute: 10,
    livePatchesPerToken: 1_000,
    databaseUrl: null,
    storageDir,
    ...overrides
  };
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = await createPostgresTestDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "patchy-server-"));
  return open(database, tempDir, options, true);
}

async function open(
  database: PostgresTestDatabase,
  tempDir: string,
  options: TestAppOptions,
  owner: boolean
): Promise<TestApp> {
  const storageDir = options.config?.storageDir ?? path.join(tempDir, "patches");
  const config = testConfig(storageDir, options.config);
  const runtime = createTestRuntime({
    config,
    databaseUrl: database.connectionString,
    clock: options.clock,
    analytics: options.analytics,
    contentStore: options.contentStore
  });
  // Builds the layer stack now, so a misconfiguration fails the test that
  // made it rather than the first request.
  await runtime.context();
  const app = createApp({ config, runtime });
  const run = <A, E>(effect: Effect.Effect<A, E, ServerServices>) => runtime.runPromise(effect);

  const harness: TestApp = {
    app,
    runtime,
    config,
    storageDir,
    run,
    async sql(text, values = []) {
      const client = new pg.Client({ connectionString: database.connectionString });
      await client.connect();
      try {
        return (await client.query(text, [...values])).rows as Record<string, unknown>[];
      } finally {
        await client.end();
      }
    },
    createToken: (input) =>
      run(
        Effect.flatMap(Tokens.Tokens, (tokens) =>
          tokens.create({ accountId: Tokens.BOOTSTRAP_PRINCIPAL_ID, ...input })
        )
      ),
    revokeToken: (apiTokenId) =>
      run(Effect.flatMap(Tokens.Tokens, (tokens) => tokens.revoke(apiTokenId)).pipe(Effect.asVoid)),
    upload: (input) =>
      run(
        Effect.flatMap(Content.Content, (content) =>
          content.upload({ ...input, sourceIp: null, userAgent: "vitest" })
        )
      ),
    currentVersion: (patchId) =>
      run(
        Effect.flatMap(Patches.Patches, (patches) => patches.find(patchId)).pipe(
          Effect.map((found) => Option.getOrNull(Option.map(found, (it) => it.version)))
        )
      ),
    disable: (patchId, accountId, reason) =>
      run(
        Effect.flatMap(Patches.Patches, (patches) =>
          patches.disable(patchId, accountId, reason, { canModerateAnyPrincipal: false })
        )
      ),
    delete: (patchId, accountId) =>
      run(
        Effect.flatMap(Patches.Patches, (patches) =>
          patches.delete(patchId, accountId, { canModerateAnyPrincipal: false })
        )
      ),
    async restart(next = {}) {
      await app.close();
      await runtime.dispose();
      return open(database, tempDir, { ...options, ...next }, owner);
    },
    async close() {
      await app.close();
      // Lets every forked `track` land before a recording layer is read.
      await runtime.dispose();
      if (owner) {
        await database.drop();
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  };
  return harness;
}
