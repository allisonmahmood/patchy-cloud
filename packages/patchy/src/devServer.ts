// PROTOTYPE for #314: the local runtime serves a tier 2 repo on the engine with two viewers.
//
// Two loopback listeners in one daemon, one per identity: the seeded owner at
// `/dev/<patch>` and a fixture colleague at `/dev-as-colleague/<patch>`. Each listener gets its
// own `RuntimeDev` layer bound to its identity, so the principal is chosen by the host's wiring
// per mount; no browser-supplied field, header or argument selects it. The engine, PGlite and
// the loaded version are shared. A `server/` change rebuilds the server bundle, derives its
// handlers in a throwaway workerd, binds the new digest and swaps the loaded version; calls
// admitted earlier keep the version they were admitted with.
// @effect-diagnostics nodeBuiltinImport:off -- This CLI-owned local server owns its Node sockets and process identity.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { RuntimeGroup, type Identity } from "@patchy/api";
import { Engine, workerdBinary } from "@patchy/execution";
import { RuntimeDev, RuntimeApi } from "@patchy/runtime/dev";
import { Limits } from "@patchy/limits";
import {
  brokerScript,
  renderPatchWrapper,
  contentSecurityPolicy,
  shellContentSecurityPolicy,
  PATCH_PERMISSIONS_POLICY,
  PATCH_ROBOTS_TAG,
  NO_REFERRER_POLICY
} from "@patchy/serving/shell";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { LocalError } from "./CliError.js";
import * as DevResources from "./devResources.js";
import type { Prepared } from "./devPreparation.js";
import { atomicJson, birth, io, readRecord, type Daemon } from "./devState.js";
import { watch, watchServer } from "./devWatch.js";

const api = HttpApi.make("patchy").add(RuntimeGroup);
const headers = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": PATCH_ROBOTS_TAG,
  "referrer-policy": NO_REFERRER_POLICY,
  "permissions-policy": PATCH_PERMISSIONS_POLICY
};
const absent = HttpServerResponse.text("Not found", { status: 404, headers });
// External trusted script, never inserted into the sandbox. A reload retains pathname/query/hash.
const reloadScript = `(() => {
  const revision = new URL(document.currentScript.src).searchParams.get("v");
  async function check() {
    try {
      const response = await fetch("/~dev/build", { cache: "no-store" });
      if (response.ok && (await response.text()) !== revision) { location.reload(); return; }
    } catch {}
    setTimeout(check, 1000);
  }
  setTimeout(check, 1000);
})();`;

/** The second dev identity: a member of the same company, never the owner. */
const colleagueOf = (identity: Identity): NonNullable<Identity> => ({
  ...identity,
  user: { id: "usr_colleague", name: "Colleague (dev fixture)", email: "colleague@patchy.local" },
  role: "member"
});

export const serve = Effect.fn("Dev.serve")(function* (
  prepared: Prepared,
  stateDir: string,
  record: Daemon
) {
  const tier2 = prepared.manifest.tier === 2;
  const engineLayer = Layer.unwrap(
    Effect.map(
      workerdBinary(path.join(record.root, "package.json")).pipe(
        Effect.mapError((cause) => new LocalError({ message: cause.message, cause }))
      ),
      (binary) => Engine.layer({ binary })
    )
  );
  const engineContext = tier2
    ? yield* Layer.build(engineLayer).pipe(
        Effect.catchTags({
          EngineUnavailable: (cause) =>
            Effect.fail(new LocalError({ message: "Could not start the execution engine.", cause }))
        })
      )
    : undefined;
  const resources = yield* DevResources.prepare(prepared, record.root, stateDir).pipe(
    Effect.provide(Layer.succeedContext(engineContext ?? Context.empty()))
  );
  const nextBuild = yield* watch(record.root, stateDir);
  let html = yield* nextBuild(prepared.manifest);
  let revision = 1;
  // The first server bundle is bound before the daemon reports healthy.
  const nextServerBuild = tier2 ? yield* watchServer(record.root, stateDir) : undefined;
  const bindServer = Effect.fn("Dev.bindServer")(function* (bundle: string) {
    if (engineContext === undefined || resources.setServer === undefined) return;
    const started = yield* Clock.currentTimeMillis;
    const engine = yield* Engine.Engine.pipe(Effect.provideContext(engineContext));
    const handlers = yield* engine.inspect(bundle).pipe(
      Effect.mapError(
        (cause) =>
          new LocalError({
            message:
              cause._tag === "InspectionFailed"
                ? `Server bundle refused: ${cause.reason}`
                : cause.message,
            cause
          })
      )
    );
    const bound = yield* resources
      .setServer(bundle, handlers)
      .pipe(Effect.mapError((cause) => new LocalError({ message: cause.message, cause })));
    yield* Console.log(
      `Server build bound as ${bound.digest.slice(0, 19)} (${Object.keys(handlers).join(", ")}) in ${(yield* Clock.currentTimeMillis) - started} ms (bind ${bound.bindMs} ms).`
    );
  });
  if (nextServerBuild !== undefined) yield* bindServer(yield* nextServerBuild);

  const shellPolicy = shellContentSecurityPolicy(prepared.manifest.tier);
  const version = resources.version();
  const content = `/~content/${version.patchId}/${version.versionId}` as const;

  /** One listener: its routes, guard and runtime bound to one identity. */
  const mount = (base: `/${string}`, origin: string, identity: Identity) => {
    // Tier 0 keeps its production policy, permitting only the trusted reload script and poll.
    const localShellPolicy =
      prepared.manifest.tier >= 1
        ? shellPolicy
        : `${shellPolicy}; script-src ${origin}/~dev/reload.js; connect-src ${origin}/~dev/build`;
    const pages = HttpRouter.use((router) =>
      Effect.gen(function* () {
        yield* router.add(
          "GET",
          "/healthz",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return request.headers["x-patchy-dev"] === record.nonce
              ? HttpServerResponse.jsonUnsafe(
                  { nonce: record.nonce, root: record.root, instance: record.instance },
                  { headers }
                )
              : absent;
          })
        );
        yield* router.add(
          "GET",
          "/~dev/build",
          Effect.sync(() => HttpServerResponse.text(String(revision), { headers }))
        );
        yield* router.add(
          "GET",
          "/~dev/reload.js",
          HttpServerResponse.text(reloadScript, {
            contentType: "text/javascript; charset=utf-8",
            headers
          })
        );
        yield* router.add(
          "GET",
          "/~shell/broker.js",
          HttpServerResponse.text(brokerScript, {
            contentType: "text/javascript; charset=utf-8",
            headers
          })
        );
        yield* router.add(
          "GET",
          content,
          Effect.sync(() =>
            HttpServerResponse.text(html, {
              contentType: "text/html; charset=utf-8",
              headers: {
                ...headers,
                "content-security-policy": contentSecurityPolicy(prepared.manifest.tier)
              }
            })
          )
        );
        const shell = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, origin);
          const route = url.pathname.slice(base.length) || "/";
          if (route.split("/").some((segment) => segment.startsWith("~"))) return absent;
          return HttpServerResponse.text(
            renderPatchWrapper({
              patch: { id: version.patchId, title: prepared.manifest.name ?? "Local patch" },
              version: {
                id: version.versionId,
                versionNumber: 1,
                tier: prepared.manifest.tier,
                wireVersion: version.wireVersion
              },
              html,
              nonce: randomBytes(24).toString("hex"),
              route,
              base,
              head: `<script defer src="/~dev/reload.js?v=${revision}"></script>`
            }),
            {
              contentType: "text/html; charset=utf-8",
              headers: { ...headers, "content-security-policy": localShellPolicy }
            }
          );
        });
        yield* router.add("GET", `${base}/*`, shell);
      })
    );
    const guard = HttpRouter.middleware(
      (requestEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          // Loopback binding alone does not prevent DNS rebinding into the authenticated local runtime.
          if (request.headers.host !== new URL(origin).host) return absent;
          return yield* requestEffect;
        }),
      { global: true }
    );
    const runtime = RuntimeDev.layer(resources.handlers, {
      origin,
      identity: {
        user: identity.user,
        company: identity.company,
        admin: identity.role === "admin"
      }
    }).pipe(Layer.provide([Limits.layer, Layer.succeedContext(resources.context)]));
    return HttpRouter.serve(
      Layer.mergeAll(HttpApiBuilder.layer(api).pipe(Layer.provide(RuntimeApi.layer)), pages, guard),
      { disableLogger: true, disableListenLog: true }
    ).pipe(Layer.provide(runtime));
  };

  // The owner listens on the server this daemon was given; the colleague on a second one.
  const ownerOrigin = yield* HttpServer.addressFormattedWith(Effect.succeed);
  const ownerBase = `/dev/${version.patchId}` as const;
  yield* Layer.build(mount(ownerBase, ownerOrigin, prepared.identity));
  let colleagueUrl: string | undefined;
  if (tier2) {
    const colleagueServer = yield* Layer.build(
      NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
    );
    const colleagueOrigin = yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(
      Effect.provideContext(colleagueServer)
    );
    const colleagueBase = `/dev-as-colleague/${version.patchId}` as const;
    yield* Layer.build(
      mount(colleagueBase, colleagueOrigin, colleagueOf(prepared.identity)).pipe(
        Layer.provide(Layer.succeedContext(colleagueServer))
      )
    );
    colleagueUrl = `${colleagueOrigin}${colleagueBase}`;
  }
  const ready = {
    ...record,
    pid: process.pid,
    birth: yield* io("Could not identify the dev daemon.", async () => {
      const value = await birth(process.pid);
      if (!value) throw new Error("Process identity unavailable");
      return value;
    }),
    url: `${ownerOrigin}${ownerBase}`,
    ...(colleagueUrl === undefined ? {} : { colleagueUrl })
  };
  yield* io("Could not record the healthy dev daemon.", () =>
    atomicJson(stateDir, "daemon.json", ready)
  );
  yield* Console.log(`Ready: ${ready.url}`);
  if (colleagueUrl !== undefined) yield* Console.log(`Colleague: ${colleagueUrl}`);
  yield* Effect.addFinalizer(() =>
    io("Could not clear the stopped dev daemon.", async () => {
      const current = await readRecord(stateDir);
      if (current?.nonce === record.nonce)
        await atomicJson(stateDir, "daemon.json", { ...ready, url: undefined });
    }).pipe(Effect.orDie)
  );
  const clientLoop = Effect.forever(
    nextBuild(prepared.manifest).pipe(
      Effect.tap((bundle) =>
        Effect.sync(() => {
          html = bundle;
          revision++;
        })
      ),
      Effect.tap(() => Console.log(`Build ${revision} ready; reloading local shells.`)),
      Effect.catch((error) => Console.error(error.message))
    )
  );
  if (nextServerBuild === undefined) return yield* clientLoop;
  const serverLoop = Effect.forever(
    nextServerBuild.pipe(
      Effect.flatMap(bindServer),
      Effect.catch((error) => Console.error(error.message))
    )
  );
  return yield* Effect.all([clientLoop, serverLoop], { concurrency: "unbounded" });
});

export const layer = NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 });
