/**
 * The server as one layer: the capability services over a migrated
 * database, the `/api/*` contract with bearer middleware on protected
 * endpoints, the pages, the middleware every request passes through,
 * and the deletion sweep forked in the same scope. Wiring only; every rule
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
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
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
  RequireSession,
  Session
} from "@patchy/auth";
import { Companies, InviteMail, Users, migrations as companiesMigrations } from "@patchy/companies";
import {
  Inventory,
  PgCompanyDatabases,
  OrphanSweep,
  migrations as companyDatabaseMigrations
} from "@patchy/company-database";
import {
  AzureContentStore,
  BlobContainer,
  ContentStore,
  FilesystemContentStore
} from "@patchy/content-store";
// PROTOTYPE for #314: the execution engine beside the runtime, one process per server.
import { Engine, ServerCall, Transaction, bundledWorkerdBinary } from "@patchy/execution";
import {
  ConnectionPages,
  ConnectionsApi,
  SqlConnectionStore,
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
  DeletionSweep,
  migrations as patchesMigrations,
  Patches,
  PatchesApi
} from "@patchy/patches";
import { PortalPages } from "@patchy/portal";
import { Tables, TableOperations, Files } from "@patchy/primitives";
import { CompanyDatabases } from "@patchy/company-database";
import { Pages, renderHome, servingHeaders, TrustedProxies } from "@patchy/serving";
import {
  Runtime,
  RuntimeProduction,
  RuntimeApi,
  RuntimeLog,
  // PROTOTYPE for #314 round 3: tier 2 query subscriptions.
  SubscriptionStream,
  me,
  migrations as runtimeMigrations
} from "@patchy/runtime";
import { Artifact, SdkApi } from "@patchy/sdk";
import { migrate } from "@patchy/sql";
import * as ApiGuard from "./ApiGuard.js";

/** The port the server listens on. */
export const port = Config.Int("PORT").pipe(Config.withDefault(3000));

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
    ...companyDatabaseMigrations,
    ...runtimeMigrations,
    ...integrationsMigrations,
    ...patchesMigrations
  })
);

/** PROTOTYPE for #314: one workerd process for the server's lifetime. */
const engine = Layer.unwrap(Effect.map(bundledWorkerdBinary, (binary) => Engine.layer({ binary })));

/**
 * The services, over the migrated database. Analytics reports nothing unless
 * a key is configured.
 */
const services = Layer.mergeAll(
  Artifact.layer,
  Content.layer,
  DeletionSweep.layer,
  DeviceLogins.layer,
  OrphanSweep.layer,
  Layer.unwrap(
    Effect.gen(function* () {
      const tables = yield* TableOperations.make;
      const files = yield* Files.make;
      const postgres = yield* PostgresOperations.makeHandlers;
      const store = yield* ContentStore.ContentStore;
      const handlers = { me, ...tables, ...files, ...postgres };
      // PROTOTYPE for #314: `server.call` resolves callbacks to sibling handlers built over the
      // joining databases, so a callback runs on the invocation's held connection (round 3);
      // the bundle is the version's recorded object, read on the engine's first load.
      const databases = yield* CompanyDatabases.CompanyDatabases;
      const joiningTables = yield* TableOperations.make.pipe(
        Effect.provideService(
          CompanyDatabases.CompanyDatabases,
          Transaction.joiningDatabases(databases)
        )
      );
      const serverCall = yield* ServerCall.make(
        { ...handlers, ...joiningTables },
        {
          bundle: (binding) =>
            binding.server === undefined
              ? Effect.fail(new Runtime.InvalidRequest({}))
              : store
                  .get(binding.server.objectKey)
                  .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))),
          log: (binding, line, details) =>
            Effect.logInfo(line).pipe(
              Effect.annotateLogs({
                patchId: binding.patchId,
                versionId: binding.versionId,
                userId: binding.identity?.user.id ?? "",
                correlationId: binding.correlationId,
                ...(details === undefined ? {} : { details })
              })
            )
        }
      );
      return RuntimeProduction.layer({ ...handlers, "server.call": serverCall });
    })
  ).pipe(Layer.provide([LoadedVersions.layer, PostgresExecution.layer, engine]))
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
        SqlConnectionStore.layer.pipe(Layer.provide([CredentialKeys.layer, PostgresSource.layer]))
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
 * A slow or defective orphan pass must not stop deletion. Contain pass failures
 * inside each repeat so the next tick retries, but never swallow shutdown.
 */
export const sweeper = Layer.effectDiscard(
  Effect.gen(function* () {
    const deletion = yield* DeletionSweep.DeletionSweep;
    const orphan = yield* OrphanSweep.OrphanSweep;
    for (const [name, sweep] of [
      ["deletion", Effect.asVoid(deletion.sweep)],
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
  Layer.provide([
    AuthApi.layer,
    // PROTOTYPE for #314: publish discovery loads tier 2 bundles through the engine.
    PatchesApi.layer.pipe(Layer.provide(engine)),
    ConnectionsApi.layer,
    SdkApi.layer,
    RuntimeApi.layer
  ]),
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

/** Root and fallback have one owner; no capability's registration order chooses /. */
const landing = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "GET",
      "/",
      PortalPages.errors(
        RequireSession.withViewer(PortalPages.index).pipe(
          Effect.map((response) =>
            response.status === 401 && response.headers["x-patchy-sign-in-url"]
              ? HttpServerResponse.setBody(
                  response,
                  HttpServerResponse.html(
                    renderHome({ signInUrl: response.headers["x-patchy-sign-in-url"] })
                  ).body
                )
              : response
          )
        )
      )
    );
    yield* router.add("*", "/*", Pages.notFound);
  })
);

/** The routes and middleware as one router application. */
const app = Layer.mergeAll(
  api,
  // PROTOTYPE for #314 round 3: the subscription stream beside the runtime call route.
  SubscriptionStream.layer,
  SdkApi.tarballLayer,
  Pages.layer,
  PortalPages.layer,
  landing,
  AuthPages.layer,
  ConnectionPages.layer,
  middleware
);

/** The server: serving the app, sweeping, and closing both with the scope. */
export const layer = Layer.mergeAll(
  HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }),
  sweeper
).pipe(Layer.provide(services));
