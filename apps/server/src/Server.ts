/**
 * The server as one layer: the capability services over a migrated
 * database, the `/api/*` contract with both groups' handlers behind the
 * bearer middleware, the pages, the middleware every request passes through,
 * and the expiry sweep forked in the same scope. Wiring only — every rule
 * lives in the package that owns it.
 *
 * Needs a `SqlClient` and an `HttpServer` from whoever launches it: `start.ts`
 * brings Postgres from `DATABASE_URL` and a Node server on `PORT`; a test
 * brings a fresh database and `NodeHttpServer.layerTest`.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Analytics } from "@patchy/analytics";
import { PatchyApi } from "@patchy/api";
import { AuthApi, Authorization, migrations as authMigrations, Tokens } from "@patchy/auth";
import { AzureContentStore, BlobContainer, FilesystemContentStore } from "@patchy/content-store";
import { Limits } from "@patchy/limits";
import {
  Content,
  ExpirySweep,
  migrations as patchesMigrations,
  Patches,
  PatchesApi
} from "@patchy/patches";
import { Pages, servingHeaders, TrustedProxies } from "@patchy/serving";
import { migrate } from "@patchy/sql";
import * as ApiGuard from "./ApiGuard.js";

/** The port the server listens on. */
export const port = Config.int("PORT").pipe(Config.withDefault(3000));

/**
 * Where a patch's bytes go is wiring, not a setting: Azure Blob when its
 * container is configured, the local filesystem otherwise. An incomplete
 * Azure configuration fails startup here rather than the first upload.
 */
const contentStore = Layer.unwrap(
  Effect.map(Config.option(BlobContainer.container), (container) =>
    Option.isSome(container) ? AzureContentStore.layer : FilesystemContentStore.layer
  )
);

/** Every capability's migrations as one record, applied before anything reads the database. */
const migrated = Layer.effectDiscard(migrate({ ...authMigrations, ...patchesMigrations }));

/**
 * The services, over the migrated database. Analytics reports nothing unless
 * a key is configured; the tokens layer seeds the bootstrap token from
 * `PATCHY_BOOTSTRAP_API_TOKEN`.
 */
const services = Layer.mergeAll(Content.layer, ExpirySweep.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(Analytics.layer, Limits.layer, contentStore, Tokens.layer, Patches.layer)
  ),
  Layer.provide(migrated)
);

/**
 * The expiry sweep, once on the way up — a restart is exactly when a backlog
 * is most likely — and then hourly. Nothing depends on the exact period: a
 * patch's clock decides when it expires, and this only decides how long the
 * dead row lingers afterwards. Forked in the server's scope, so shutdown
 * interrupts it.
 */
const sweeper = Layer.effectDiscard(
  Effect.flatMap(ExpirySweep.ExpirySweep, (sweep) => sweep.sweep).pipe(
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped
  )
);

/** `/api/*`: both groups' handlers behind the bearer middleware, and the guard's catch-all. */
const api = Layer.mergeAll(HttpApiBuilder.layer(PatchyApi), ApiGuard.notFound).pipe(
  Layer.provide([AuthApi.layer, PatchesApi.layer]),
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
const app = Layer.mergeAll(api, Pages.layer, middleware);

/** The server: serving the app, sweeping, and closing both with the scope. */
export const layer = Layer.mergeAll(
  HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }),
  sweeper
).pipe(Layer.provide(services));
