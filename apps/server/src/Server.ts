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
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Analytics, WideEventsPostHog } from "@patchy/analytics";
import { PatchyApi } from "@patchy/api";
import {
  AuthApi,
  AuthPages,
  Authorization,
  DevPersonas,
  DeviceLogins,
  MachineTokens,
  RequireSession,
  Session
} from "@patchy/auth";
import { Companies, InviteMail, Users } from "@patchy/companies";
import {
  Inventory,
  PgCompanyDatabases,
  OrphanSweep,
  ResourceChanges
} from "@patchy/company-database";
import { FilesystemContentStore, S3ContentStore } from "@patchy/content-store";
import {
  ConnectionPages,
  ConnectionsApi,
  SqlConnectionStore,
  CredentialKeys,
  PostgresSource,
  PostgresExecution,
  PostgresOperations
} from "@patchy/integrations";
import { Limits, OperatingLimits } from "@patchy/limits";
import {
  AgentAccess,
  Content,
  LoadedVersions,
  DeletionSweep,
  Patches,
  PatchesApi
} from "@patchy/patches";
import { PortalPages } from "@patchy/portal";
import { Tables, TableOperations, Files, Members, SubscriptionReads } from "@patchy/primitives";
import { Pages, renderHome, servingHeaders, TrustedProxies } from "@patchy/serving";
import {
  InvocationLog,
  AgentRuntime,
  AgentRuntimeApi,
  Runtime,
  RuntimeProduction,
  RuntimeApi,
  RuntimeLog,
  RuntimeStream,
  RuntimeStreamApi,
  StreamAdmission,
  StreamLimits,
  Subscriptions,
  Wakes,
  WakesPostgres,
  me
} from "@patchy/runtime";
import { Artifact, FrontDoor, SdkApi } from "@patchy/sdk";
import { migrate } from "@patchy/sql";
import * as ApiGuard from "./ApiGuard.js";
import * as DevelopmentInvocation from "./DevelopmentInvocation.js";
import * as FleetInvocation from "./FleetInvocation.js";
import * as MemberDirectory from "./MemberDirectory.js";
import { migrations } from "./migrations.js";
import * as RequestEvents from "./RequestEvents.js";

/** The port the server listens on. */
export const port = Config.Int("PORT").pipe(Config.withDefault(3000));

/**
 * Where a patch's bytes go is wiring, not a setting: Neon Object Storage when
 * its S3 bucket is configured, the local filesystem otherwise. An incomplete
 * S3 configuration fails startup here rather than the first publish.
 */
const contentStore = Layer.unwrap(
  Effect.map(Config.option(S3ContentStore.bucket), (bucket) =>
    Option.isSome(bucket) ? S3ContentStore.layer : FilesystemContentStore.layer
  )
);

/** Every capability's migrations, applied before anything reads the database. */
const migrated = Layer.effectDiscard(migrate(migrations));

/** Persona environments record invitations instead of mailing them through Clerk. */
const recordedInvites = Layer.effect(
  InviteMail.InviteMail,
  Effect.provide(Effect.service(InviteMail.InviteMail), InviteMail.layerRecording)
);

/**
 * Who signs people in. Clerk, unless the dev runner's environment set the
 * personas secret: then anyone signs in as any email. Personas refuse
 * production and public origins.
 */
const identity = Layer.unwrap(
  Effect.map(
    DevPersonas.enabled,
    (
      personas
    ): Layer.Layer<
      Session.Session | InviteMail.InviteMail,
      | Config.ConfigError
      | Session.SessionError
      | DevPersonas.DevPersonasOutsideDevelopment
      | DevPersonas.DevPersonasOnPublicOrigin
    > =>
      personas
        ? Layer.merge(DevPersonas.layer, recordedInvites)
        : Layer.merge(Session.layer, InviteMail.layer)
  )
);

const resourceChanges = Layer.effect(
  ResourceChanges.ResourceChanges,
  Effect.map(Wakes.Wakes, (wakes) => ResourceChanges.ResourceChanges.of({ publish: wakes.publish }))
);

/** The services over a migrated database, with stdout events and optional PostHog delivery. */
const services = Layer.mergeAll(
  AgentAccess.layer,
  Artifact.layer,
  Content.layer,
  DeletionSweep.layer,
  DeviceLogins.layer,
  OrphanSweep.layer,
  Layer.unwrap(
    Effect.gen(function* () {
      const tables = yield* TableOperations.make;
      const files = yield* Files.make;
      const members = yield* Members.make;
      const postgres = yield* PostgresOperations.makeHandlers;
      const handlers = { me, ...tables, ...files, ...members, ...postgres };
      const runtime = Layer.mergeAll(
        AgentRuntime.layer.pipe(
          Layer.provide(AgentAccess.policiesLayer),
          Layer.provide(AgentAccess.layer)
        ),
        RuntimeProduction.layer(handlers),
        RuntimeStream.layer.pipe(
          Layer.provide(Subscriptions.layer),
          Layer.provide([SubscriptionReads.layer, StreamLimits.layer])
        )
      ).pipe(Layer.provide(StreamAdmission.layer));
      if (yield* FleetInvocation.enabled)
        return runtime.pipe(
          Layer.provide(
            FleetInvocation.layer(handlers).pipe(Layer.provide(Content.serverBundlesLayer))
          )
        );
      return (yield* DevelopmentInvocation.enabled)
        ? runtime.pipe(
            Layer.provide(
              DevelopmentInvocation.layer(handlers).pipe(Layer.provide(Content.serverBundlesLayer))
            )
          )
        : runtime;
    })
  ).pipe(Layer.provide([LoadedVersions.layer, PostgresExecution.layer]))
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Analytics.layer,
      WideEventsPostHog.layer,
      Limits.layer,
      OperatingLimits.layer,
      contentStore,
      MachineTokens.layer,
      Patches.layer,
      Companies.layer,
      Users.layer,
      identity
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
  Layer.provideMerge(InvocationLog.layer),
  Layer.provideMerge(MemberDirectory.layer),
  Layer.provideMerge(resourceChanges),
  Layer.provideMerge(WakesPostgres.layer),
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
    PatchesApi.layer,
    ConnectionsApi.layer,
    SdkApi.layer,
    RuntimeApi.layer,
    RuntimeStreamApi.layer,
    AgentRuntimeApi.layer
  ]),
  Layer.provide(Authorization.layer)
);

/**
 * What every request passes through, outermost first: the request events'
 * edge, so an event names the method the client sent; the trusted-proxy walk,
 * so everything after it keys on the client's address rather than the proxy's;
 * the serving headers, so a refusal is covered as well as a page; the API
 * guard, ahead of the router. One global middleware rather than four, so
 * the order is written down instead of left to how layers build.
 */
const middleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const events = yield* RequestEvents.edge;
    const trustedProxies = yield* TrustedProxies.make;
    const guard = yield* ApiGuard.make;
    return (app) => events(trustedProxies(servingHeaders(guard(app))));
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

/**
 * The routes and middleware as one router application. Request events wrap
 * every route from outside, so a route's own middleware runs inside its event.
 */
const app = Layer.mergeAll(
  Layer.mergeAll(
    api,
    SdkApi.tarballLayer,
    FrontDoor.layer,
    Pages.layer,
    PortalPages.layer,
    landing,
    AuthPages.layer,
    Layer.unwrap(
      Effect.map(DevPersonas.enabled, (personas) => (personas ? DevPersonas.routes : Layer.empty))
    ),
    ConnectionPages.layer
  ).pipe(Layer.provide(RequestEvents.layer)),
  middleware
);

/** The server: serving the app, sweeping, and closing both with the scope. */
export const layer = Layer.mergeAll(
  HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }),
  sweeper,
  Layer.effectContext(Effect.context<Runtime.Runtime | RuntimeStream.RuntimeStream>())
).pipe(Layer.provide(services));
