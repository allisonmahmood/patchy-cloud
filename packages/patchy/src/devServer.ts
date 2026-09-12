// @effect-diagnostics nodeBuiltinImport:off -- This CLI-owned local server owns its Node socket and process identity.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { RuntimeGroup } from "@patchy/api";
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
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as DevResources from "./devResources.js";
import type { Prepared } from "./devPreparation.js";
import { atomicJson, birth, io, readRecord, type Daemon } from "./devState.js";
import { watch } from "./devWatch.js";

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

export const serve = Effect.fn("Dev.serve")(function* (
  prepared: Prepared,
  stateDir: string,
  record: Daemon
) {
  const resources = yield* DevResources.prepare(prepared, record.root, stateDir);
  const nextBuild = yield* watch(record.root, stateDir);
  let html = yield* nextBuild(prepared.manifest);
  let revision = 1;
  const origin = yield* HttpServer.addressFormattedWith(Effect.succeed);
  const shellPolicy = shellContentSecurityPolicy(prepared.manifest.tier);
  // Tier 0 keeps its production policy, permitting only the trusted reload script and poll.
  const localShellPolicy =
    prepared.manifest.tier >= 1
      ? shellPolicy
      : `${shellPolicy}; script-src ${origin}/~dev/reload.js; connect-src ${origin}/~dev/build`;
  const version = resources.version;
  const base = `/dev/${version.patchId}` as const;
  const content = `/~content/${version.patchId}/${version.versionId}` as const;
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
      user: prepared.identity.user,
      company: prepared.identity.company,
      admin: prepared.identity.role === "admin"
    }
  }).pipe(Layer.provide([Limits.layer, Layer.succeedContext(resources.context)]));
  yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(HttpApiBuilder.layer(api).pipe(Layer.provide(RuntimeApi.layer)), pages, guard),
      { disableLogger: true, disableListenLog: true }
    ).pipe(Layer.provide(runtime))
  );
  const ready = {
    ...record,
    pid: process.pid,
    birth: yield* io("Could not identify the dev daemon.", async () => {
      const value = await birth(process.pid);
      if (!value) throw new Error("Process identity unavailable");
      return value;
    }),
    url: `${origin}${base}`
  };
  yield* io("Could not record the healthy dev daemon.", () =>
    atomicJson(stateDir, "daemon.json", ready)
  );
  yield* Console.log(`Ready: ${ready.url}`);
  yield* Effect.addFinalizer(() =>
    io("Could not clear the stopped dev daemon.", async () => {
      const current = await readRecord(stateDir);
      if (current?.nonce === record.nonce)
        await atomicJson(stateDir, "daemon.json", { ...ready, url: undefined });
    }).pipe(Effect.orDie)
  );
  return yield* Effect.forever(
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
});

export const layer = NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 });
