/**
 * The server as one layer: the capability services over a migrated
 * database, the `/api/*` contract with bearer middleware on protected
 * endpoints, the pages, the middleware every request passes through,
 * and the expiry sweep forked in the same scope. Wiring only — every rule
 * lives in the package that owns it.
 *
 * Needs a `SqlClient` and an `HttpServer` from whoever launches it: `start.ts`
 * brings Postgres from `DATABASE_URL` and a Node server on `PORT`; a test
 * brings a fresh database and `NodeHttpServer.layerTest`.
 */
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Analytics } from "@patchy/analytics";
import { PatchyApi } from "@patchy/api";
import {
  AuthApi,
  AuthPages,
  Authorization,
  DeviceLogins,
  migrations as authMigrations,
  MachineTokens,
  Session
} from "@patchy/auth";
import { Companies, InviteMail, Users, migrations as companiesMigrations } from "@patchy/companies";
import {
  Inventory,
  PgCompanyDatabases,
  OrphanSweep,
  migrations as companyDatabaseMigrations
} from "@patchy/company-database";
import { AzureContentStore, BlobContainer, FilesystemContentStore } from "@patchy/content-store";
import {
  ConnectionPages,
  ConnectionStore,
  CredentialKeys,
  PostgresSource,
  PostgresExecution,
  PostgresOperations,
  migrations as integrationsMigrations
} from "@patchy/integrations";
import { Limits } from "@patchy/limits";
import {
  Content,
  LoadedVersions,
  ExpirySweep,
  migrations as patchesMigrations,
  Patches,
  PatchesApi
} from "@patchy/patches";
import { Tables, TableOperations, Files } from "@patchy/primitives";
import { Pages, servingHeaders, TrustedProxies } from "@patchy/serving";
import {
  Runtime,
  RuntimeApi,
  RuntimeLog,
  me,
  migrations as runtimeMigrations
} from "@patchy/runtime";
import { Artifact, Generation, SdkApi } from "@patchy/sdk";
import { migrate } from "@patchy/sql";
import * as ApiGuard from "./ApiGuard.js";

/** The port the server listens on. */
export const port = Config.int("PORT").pipe(Config.withDefault(3000));

/**
 * Where a patch's bytes go is wiring, not a setting: Azure Blob when its
 * container is configured, the local filesystem otherwise. An incomplete
 * Azure configuration fails startup here rather than the first publish.
 */
const contentStore = Layer.unwrap(
  Effect.map(Config.option(BlobContainer.container), (container) =>
    Option.isSome(container) ? AzureContentStore.layer : FilesystemContentStore.layer
  )
);

/** Every capability's migrations as one record, applied before anything reads the database. */
const migrated = Layer.effectDiscard(
  migrate({
    ...companiesMigrations,
    ...authMigrations,
    ...patchesMigrations,
    ...companyDatabaseMigrations,
    ...runtimeMigrations,
    ...integrationsMigrations
  })
);

/**
 * The services, over the migrated database. Analytics reports nothing unless
 * a key is configured.
 */
const services = Layer.mergeAll(
  Artifact.layer,
  Generation.layer,
  Content.layer,
  ExpirySweep.layer,
  DeviceLogins.layer,
  OrphanSweep.layer,
  Layer.unwrap(
    Effect.gen(function* () {
      const tables = yield* TableOperations.make;
      const files = yield* Files.make;
      const postgres = yield* PostgresOperations.makeHandlers;
      return Runtime.layer({ me, ...tables, ...files, ...postgres });
    })
  ).pipe(Layer.provide([LoadedVersions.layer, PostgresExecution.layer]))
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Analytics.layer,
      Limits.layer,
      contentStore,
      MachineTokens.layer,
      Patches.layer,
      Companies.layer,
      InviteMail.layer,
      Users.layer,
      Session.layer
    ).pipe(
      Layer.provideMerge(
        ConnectionStore.layer.pipe(Layer.provide([CredentialKeys.layer, PostgresSource.layer]))
      ),
      Layer.provideMerge(Tables.layer),
      Layer.provideMerge(Inventory.layer),
      Layer.provideMerge(PgCompanyDatabases.layer)
    )
  ),
  Layer.provideMerge(RuntimeLog.layer),
  Layer.provide(migrated)
);

/**
 * Each sweep runs once on the way up and then hourly in its own scoped fiber.
 * A slow or defective orphan pass must not stop expiry. Contain pass failures
 * inside each repeat so the next tick retries, but never swallow shutdown.
 */
export const sweeper = Layer.effectDiscard(
  Effect.gen(function* () {
    const expiry = yield* ExpirySweep.ExpirySweep;
    const orphan = yield* OrphanSweep.OrphanSweep;
    for (const [name, sweep] of [
      ["expiry", Effect.asVoid(expiry.sweep)],
      ["orphan", Effect.asVoid(orphan.sweep)]
    ] as const) {
      yield* sweep.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logError("Background sweep pass failed.").pipe(
                Effect.annotateLogs({ sweep: name })
              )
        ),
        Effect.repeat(Schedule.spaced("1 hour")),
        Effect.forkScoped
      );
    }
  })
);

/** `/api/*`: the groups' handlers, bearer middleware on protected endpoints, and catch-all. */
const api = Layer.mergeAll(HttpApiBuilder.layer(PatchyApi), ApiGuard.notFound).pipe(
  Layer.provide([AuthApi.layer, PatchesApi.layer, SdkApi.layer, RuntimeApi.layer]),
  Layer.provide(Authorization.layer)
);

/**
 * What every request passes through, outermost first: the trusted-proxy walk,
 * so everything after it keys on the client's address rather than the proxy's;
 * the serving headers, so a refusal is covered as well as a page; the API
 * guard, ahead of the router. One global middleware rather than three, so
 * the order is written down instead of left to how layers build.
 */
const middleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const trustedProxies = yield* TrustedProxies.make;
    const guard = yield* ApiGuard.make;
    return (app) => trustedProxies(servingHeaders(guard(app)));
  }),
  { global: true }
);

/** The routes and middleware as one router application. */
const app = Layer.mergeAll(
  api,
  SdkApi.tarballLayer,
  Pages.layer,
  AuthPages.layer,
  ConnectionPages.layer,
  middleware
);

/** The server: serving the app, sweeping, and closing both with the scope. */
export const layer = Layer.mergeAll(
  HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }),
  sweeper
).pipe(Layer.provide(services));
