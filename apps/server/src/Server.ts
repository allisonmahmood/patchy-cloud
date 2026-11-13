/**
 * The server as one layer: the capability services over a migrated
 * database, the `/api/*` contract with bearer middleware on protected
 * endpoints, the pages, the middleware every request passes through,
 * and the deletion sweep forked in the same scope. Wiring only; every rule
 * lives in the package that owns it.
 *
 * Needs a `SqlClient`, an `HttpServer`, the client document network and the
 * mail network from whoever launches it: `start.ts` brings Postgres from
 * `DATABASE_URL`, a Node server on `PORT` and production's networks; the dev
 * runner the same with its loopback mailboxes; a test brings a fresh database,
 * `NodeHttpServer.layerTest` and, when it connects agents, fixture documents.
 */
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { Analytics, WideEventsPostHog } from "@patchy/analytics";
import { PatchyApi } from "@patchy/api";
import { Cryptography } from "@patchy/core";
import {
  AgentConnections,
  AuthApi,
  AuthPages,
  Authorization,
  BetaLinkPages,
  type ClientDocumentNetwork,
  ClientDocuments,
  Consents,
  DemoLink,
  DevPersonas,
  DeviceLogins,
  MachineTokens,
  OAuthEndpoints,
  OAuthMetadata,
  RequireSession,
  Session,
  ViewerApi
} from "@patchy/auth";
import {
  Companies,
  CompanyPage,
  InviteMail,
  LookApi,
  Looks,
  Teams,
  TeamsPage,
  Users
} from "@patchy/companies";
import {
  Inventory,
  PgCompanyDatabases,
  OrphanSweep,
  ResourceChanges
} from "@patchy/company-database";
import { FilesystemContentStore, S3ContentStore } from "@patchy/content-store";
import { Feedback, FeedbackApi } from "@patchy/feedback";
import {
  ConnectionPages,
  ConnectionStore,
  ConnectionsApi,
  connectionPath,
  DevReads,
  SqlConnectionStore,
  CredentialKeys,
  PostgresSource,
  PostgresExecution,
  PostgresOperations,
  PostHogSource,
  PostHogOperations,
  PidgeonSource,
  AttioSource,
  AttioOperations,
  ImapOperations,
  ImapSessions,
  ImapSource,
  type ImapNetwork,
  PatchVisibility,
  PidgeonOperations
} from "@patchy/integrations";
import { Limits, OperatingLimits } from "@patchy/limits";
import { ChangeKeys, Door } from "@patchy/mcp";
import {
  ConnectionVisibility,
  Content,
  LoadedVersions,
  DeletionSweep,
  GuestGrants,
  Patches,
  PatchesApi,
  Audiences
} from "@patchy/patches";
import { Fonts, Gallery, PortalPages } from "@patchy/portal";
import { Tables, TableOperations, Files, Members, SubscriptionReads } from "@patchy/primitives";
import { Pages, servingHeaders, TrustedProxies } from "@patchy/serving";
import {
  FileStaging,
  GrantedGuests,
  InvocationLog,
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
import * as Moved from "./Moved.js";
import { migrations } from "./migrations.js";
import * as RequestEvents from "./RequestEvents.js";
import * as SetupPickup from "./SetupPickup.js";

/** Where client documents come from, which the launcher brings: the pinned network, or fixtures. */
export type DocumentNetwork = ClientDocumentNetwork.ClientDocumentNetwork;
/**
 * Where mailboxes are reached, which the launcher brings too: production's network, or the
 * loopback one only the dev runner and tests provide.
 */
export type MailNetwork = ImapNetwork.Network;

/** The port the server listens on. */
export const port = Config.Int("PORT").pipe(Config.withDefault(3000));

/**
 * Where a patch's bytes go is wiring, not a setting: Neon Object Storage when
 * its S3 bucket is configured, the local filesystem otherwise. An incomplete
 * S3 configuration fails startup here rather than the first publish, and
 * `start.ts` refuses a production host without one.
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
      | DevPersonas.DevPersonasOnPublicOrigin,
      Cryptography.Cryptography
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

/**
 * Runtime's doors admit members by a patch's current audience and guests by its grants, both
 * Patches' decisions, which Runtime cannot depend on.
 */
const grantedGuests = Layer.effect(
  GrantedGuests.GrantedGuests,
  Effect.gen(function* () {
    const grants = yield* GuestGrants.GuestGrants;
    const patches = yield* Patches.Patches;
    return GrantedGuests.GrantedGuests.of({
      member: (loaded, userId) =>
        patches
          .admitsMember(loaded.patchId, loaded.companyId, userId)
          .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))),
      host: (loaded, userId) =>
        grants
          .host({
            patchId: loaded.patchId,
            userId,
            state: "live",
            current: loaded.current === true,
            version: { tier: loaded.manifest.tier, manifest: loaded.manifest }
          })
          .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })))
    });
  })
);

/** People's Patches column comes from Patches, which Companies cannot depend on. */
const ownedPatches = Layer.effect(
  CompanyPage.OwnedPatches,
  Effect.map(
    Patches.Patches,
    (patches) => (viewer: { readonly companyId: string; readonly userId: string }) =>
      Effect.gen(function* () {
        const canOpen = yield* Patches.Openability;
        const rows = yield* patches.read({
          ...viewer,
          state: "live",
          canOpen: (patch) => canOpen(patch, viewer.userId)
        });
        const counts = new Map<string, number>();
        for (const { owner } of rows) counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1);
        return counts;
      }).pipe(Effect.catchTags({ PatchUnavailable: Effect.die, WrongState: Effect.die }))
  )
);

/** People's guests are Patches' grants, which Companies cannot depend on. */
const companyGuests = Layer.effect(
  CompanyPage.Guests,
  Effect.map(GuestGrants.GuestGrants, (grants) => ({
    list: grants.companyGuests,
    removeAll: grants.revokeAll
  }))
);

/**
 * What teams reach, for the Teams page: Patches and Integrations know it and Companies cannot
 * read them. Each viewer sees the patches they may open or manage; admins see every connection,
 * and who declares each, and members those they can build with.
 */
const teamReach = Layer.effect(
  TeamsPage.Reach,
  Effect.gen(function* () {
    const patches = yield* Patches.Patches;
    const teams = yield* Teams.Teams;
    const store = yield* ConnectionStore.ConnectionStore;
    const visibility = yield* PatchVisibility.PatchVisibility;
    const sql = yield* SqlClient.SqlClient;
    return Effect.fn("Hosting.teamReach")(
      function* (viewer: Teams.Viewer) {
        const listed = yield* patches
          .list({
            companyId: viewer.companyId,
            userId: viewer.actorId,
            state: "all",
            managed: true,
            canOpen: () => true
          })
          .pipe(Effect.catchTags({ PatchUnavailable: Effect.die, WrongState: Effect.die }));
        const [person] = yield* teams.people(viewer.companyId, [viewer.actorId]);
        const admin = person?.active === true && person.role === "admin";
        const shown = listed.flatMap((row) =>
          row.audience.kind === "teams"
            ? [
                {
                  id: row.patch.id,
                  title: row.patch.title,
                  ownerId: row.patch.ownerUserId,
                  state: row.patch.state,
                  teamIds: row.audience.teams.map((team) => team.id),
                  href: `/patches/${encodeURIComponent(row.patch.name)}`,
                  audienceHref: row.access.canManage
                    ? `/patches/${encodeURIComponent(row.patch.name)}?share=${encodeURIComponent(row.patch.name)}`
                    : null
                }
              ]
            : []
        );
        const seen = new Set(shown.map((patch) => patch.id));
        const hidden = new Map(
          [...(yield* Audiences.patchesByTeam(viewer.companyId))].map(([teamId, ids]) => [
            teamId,
            ids.filter((id) => !seen.has(id)).length
          ])
        );
        // Who declares each connection, by live patch name, is the store's rule; admins only.
        const usage = admin
          ? yield* store.usage(viewer.companyId).pipe(
              Effect.provideService(PatchVisibility.PatchVisibility, visibility),
              // Its storage failing leaves the page nothing true to say.
              Effect.orDie
            )
          : new Map<string, ConnectionStore.Usage>();
        const live = new Map(
          listed
            .filter((row) => row.patch.state === "live")
            .map((row) => [row.patch.name, row.patch])
        );
        const connections = (yield* SqlConnectionStore.teamConnections(viewer.companyId))
          .filter(
            (connection) =>
              admin ||
              Teams.admits({ kind: "teams", teamIds: connection.teamIds }, person?.teamIds ?? [])
          )
          .map((connection) => ({
            id: connection.id,
            label: `${connection.integration}/${connection.handle}`,
            teamIds: connection.teamIds,
            href: connectionPath(connection.id),
            audienceHref: admin ? connectionPath(connection.id, "audience") : null,
            usedBy: (usage.get(connection.id)?.usedBy ?? []).flatMap((name) => {
              const patch = live.get(name);
              return patch === undefined
                ? []
                : [
                    {
                      title: patch.title,
                      href: `/patches/${encodeURIComponent(patch.name)}`,
                      ownerId: patch.ownerUserId
                    }
                  ];
            })
          }));
        return { patches: shown, connections, hidden };
      },
      Effect.provideService(SqlClient.SqlClient, sql)
    );
  })
);

/** The services over a migrated database, with stdout events and optional PostHog delivery. */
const services = Layer.mergeAll(
  Artifact.layer,
  Consents.layer.pipe(Layer.provideMerge(ClientDocuments.layer)),
  Content.layer,
  DeletionSweep.layer,
  DeviceLogins.layer,
  Feedback.layer,
  OrphanSweep.layer,
  Layer.unwrap(
    Effect.gen(function* () {
      const tables = yield* TableOperations.make;
      const files = yield* Files.make;
      const members = yield* Members.make;
      const postgres = yield* PostgresOperations.makeHandlers;
      const posthog = yield* PostHogOperations.makeHandlers;
      const pidgeon = yield* PidgeonOperations.makeHandlers;
      const attio = yield* AttioOperations.makeHandlers;
      const staging = yield* Files.makeStaging;
      const imap = yield* ImapOperations.makeHandlers.pipe(
        Effect.provideService(FileStaging.FileStaging, staging)
      );
      const handlers = {
        me,
        ...tables,
        ...files,
        ...members,
        ...postgres,
        ...posthog,
        ...pidgeon,
        ...attio,
        ...imap
      };
      // Runtime tells the streams of each admitted call, which keeps its viewer's documents active.
      const runtime = RuntimeProduction.layer(handlers).pipe(
        Layer.provideMerge(
          RuntimeStream.layer.pipe(
            Layer.provide(Subscriptions.layer),
            Layer.provide([SubscriptionReads.layer, StreamLimits.layer])
          )
        ),
        Layer.provide(StreamAdmission.layer)
      );
      // The invocation that runs a page's calls also runs agents' calls at Patchy MCP's door,
      // which finds it, when the host runs patch code at all, beside Runtime.
      if (yield* FleetInvocation.enabled)
        return runtime.pipe(
          Layer.provideMerge(
            FleetInvocation.layer(handlers).pipe(Layer.provide(Content.serverBundlesLayer))
          )
        );
      return (yield* DevelopmentInvocation.enabled)
        ? runtime.pipe(
            Layer.provideMerge(
              DevelopmentInvocation.layer(handlers).pipe(Layer.provide(Content.serverBundlesLayer))
            )
          )
        : runtime;
    })
  ).pipe(
    // The member directory brings in the guests Patches' grants name, as Runtime's doors do.
    Layer.provideMerge(MemberDirectory.layer),
    Layer.provide([LoadedVersions.layer, PostgresExecution.layer, grantedGuests])
  )
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      WideEventsPostHog.layer,
      Limits.layer,
      OperatingLimits.layer,
      contentStore,
      MachineTokens.layer,
      AgentConnections.layer,
      ChangeKeys.layer,
      // Sharing checks who may manage the patch, and who the email is, as every patch act does.
      GuestGrants.layer.pipe(Layer.provideMerge(Layer.mergeAll(Patches.layer, Users.layer))),
      Companies.layer,
      Looks.layer,
      identity
    ).pipe(
      // One PostHog, Pidgeon, Attio and IMAP source each, so connection administration and
      // patches share each project's, address's, workspace's and mailbox's slots, and one pool of
      // IMAP sessions that published patches and the dev door share.
      Layer.provideMerge(
        SqlConnectionStore.layer.pipe(
          Layer.provide([CredentialKeys.layer, PostgresSource.layer, Teams.layer]),
          Layer.provideMerge(PostHogSource.layer),
          Layer.provideMerge(PidgeonSource.layer),
          Layer.provideMerge(AttioSource.layer),
          Layer.provideMerge(ImapSessions.layer.pipe(Layer.provideMerge(ImapSource.layer)))
        )
      ),
      Layer.provideMerge(Tables.layer),
      Layer.provideMerge(Analytics.layer),
      Layer.provideMerge(Inventory.layer),
      Layer.provideMerge(PgCompanyDatabases.layer)
    )
  ),
  Layer.provideMerge(RuntimeLog.layer),
  Layer.provideMerge(InvocationLog.layer),
  Layer.provideMerge(resourceChanges),
  Layer.provideMerge(WakesPostgres.layer),
  Layer.provideMerge(ConnectionVisibility.layer),
  // Patches, guest grants, connections and the portal each read teams through this one.
  Layer.provideMerge(Teams.layer),
  Layer.provide(migrated)
);

/**
 * Each sweep runs once on the way up and then on its own interval in its own
 * scoped fiber: deletion, orphans and change keys past their 24 hours hourly,
 * agent connections' retry copies every 15 seconds, so none outlives its minute
 * by more. A slow or defective
 * pass must not stop another. Contain pass failures inside each repeat so the
 * next tick retries, but never swallow shutdown.
 */
export const sweeper = Layer.effectDiscard(
  Effect.gen(function* () {
    const deletion = yield* DeletionSweep.DeletionSweep;
    const orphan = yield* OrphanSweep.OrphanSweep;
    const connections = yield* AgentConnections.AgentConnections;
    const changeKeys = yield* ChangeKeys.ChangeKeys;
    const sweeps: ReadonlyArray<
      readonly [name: string, sweep: Effect.Effect<void, SqlError>, every: Duration.Input]
    > = [
      ["deletion", Effect.asVoid(deletion.sweep), "1 hour"],
      ["orphan", Effect.asVoid(orphan.sweep), "1 hour"],
      ["agent connection retries", connections.sweepRetries, "15 seconds"],
      ["change keys", changeKeys.sweep, "1 hour"]
    ];
    for (const [name, sweep, every] of sweeps) {
      yield* sweep.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logError("Background sweep pass failed.").pipe(
                Effect.annotateLogs({ sweep: name })
              )
        ),
        Effect.repeat(Schedule.spaced(every)),
        Effect.forkScoped
      );
    }
  })
);

/** `/api/*`: the groups' handlers, bearer middleware on protected endpoints, and catch-all. */
const api = Layer.mergeAll(HttpApiBuilder.layer(PatchyApi), ApiGuard.notFound).pipe(
  Layer.provide([
    AuthApi.layer,
    ViewerApi.layer,
    PatchesApi.layer,
    ConnectionsApi.layer,
    DevReads.layer,
    LookApi.layer,
    FeedbackApi.layer,
    SdkApi.layer,
    RuntimeApi.layer,
    RuntimeStreamApi.layer
  ]),
  Layer.provide(Authorization.layer)
);

/**
 * What every request passes through, outermost first: the request events'
 * edge, so an event names the method the client sent; the trusted-proxy walk,
 * so everything after it keys on the client's address rather than the proxy's;
 * the serving headers, so a refusal is covered as well as a page; the API
 * guard; then the moved pages' rewrite, which hands an old POST to the
 * router under its new URL. One global middleware rather than five, so
 * the order is written down instead of left to how layers build.
 */
const middleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const events = yield* RequestEvents.edge;
    const trustedProxies = yield* TrustedProxies.make;
    const guard = yield* ApiGuard.make;
    return (app) => events(trustedProxies(servingHeaders(guard(Moved.rewrite(app)))));
  }),
  { global: true }
);

/** Root and fallback have one owner; no capability's registration order chooses /. */
const landing = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/", PortalPages.errors(RequireSession.withViewer(PortalPages.index)));
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
    FrontDoor.layer.pipe(Layer.provide(SetupPickup.layer)),
    Pages.layer,
    PortalPages.layer,
    Fonts.layer,
    landing,
    Moved.routes,
    AuthPages.layer,
    DemoLink.routes(Pages.notFound),
    BetaLinkPages.routes(Pages.notFound),
    OAuthMetadata.layer,
    OAuthEndpoints.layer,
    Door.layer,
    Layer.unwrap(
      // The persona picker and the `/~ui` gallery exist only where personas sign people in.
      Effect.map(DevPersonas.enabled, (personas) =>
        personas ? Layer.mergeAll(DevPersonas.routes, Gallery.layer) : Layer.empty
      )
    ),
    ConnectionPages.layer
  ).pipe(Layer.provide(RequestEvents.layer)),
  middleware
);

/**
 * The server: serving the app, sweeping, and closing both with the scope. Its runtime and guest
 * grants are the ones a test drives besides the socket.
 */
export const layer = Layer.mergeAll(
  HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provide([ownedPatches, companyGuests, teamReach, PortalPages.navigation])
  ),
  sweeper,
  Layer.effectContext(
    Effect.context<Runtime.Runtime | RuntimeStream.RuntimeStream | GuestGrants.GuestGrants>()
  )
).pipe(Layer.provide(services));
