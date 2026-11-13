// @effect-diagnostics nodeBuiltinImport:off -- This CLI-owned local server owns its Node socket and process identity.
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  RuntimeGroup,
  RuntimeStreamGroup,
  ShortcutsRequest,
  ViewerGroup,
  capBody,
  handlerKinds,
  isBodyTooLarge
} from "@patchy/api";
import type { ReleaseToolchain } from "@patchy/api";
import {
  Binding,
  RuntimeDev,
  RuntimeApi,
  RuntimeStream,
  RuntimeStreamApi,
  StreamAdmission,
  StreamLimits
} from "@patchy/runtime/dev";
import { Cryptography, documentTitle } from "@patchy/core";
import { ContractLimits, Limits } from "@patchy/limits";
import {
  brokerScript,
  renderPatchWrapper,
  withSwitcherRelay,
  CONTENT_SECURITY_POLICY,
  SHELL_SECURITY_POLICY,
  PATCH_PERMISSIONS_POLICY,
  PATCH_ROBOTS_TAG,
  NO_REFERRER_POLICY
} from "@patchy/serving/shell";
import * as Console from "effect/Console";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Redacted from "effect/Redacted";
import * as HttpApi from "effect/http-api/HttpApi";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as DevAgent from "./devAgent.js";
import * as DevResources from "./devResources.js";
import * as DevLog from "./devLog.js";
import { colleague, guest } from "./devMembers.js";
import type { Prepared } from "./devPreparation.js";
import {
  AgentRequest,
  atomicJson,
  birth,
  io,
  readRecord,
  readShortcuts,
  type Daemon
} from "./devState.js";
import { watch } from "./devWatch.js";
import * as DevServerWatch from "./devServerWatch.js";
import { guestAliases } from "./serverBuild.js";

const api = HttpApi.make("patchy").add(RuntimeGroup, RuntimeStreamGroup, ViewerGroup);
const headers = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": PATCH_ROBOTS_TAG,
  "referrer-policy": NO_REFERRER_POLICY,
  "permissions-policy": PATCH_PERMISSIONS_POLICY
};
const absent = HttpServerResponse.text("Not found", { status: 404, headers });
const decodeAgentRequest = Schema.decodeUnknownEffect(AgentRequest);
/** The shortcuts form, as Patchy reads it: the value and a page path to land back on. */
const MAX_SHORTCUTS_BYTES = 4_096;
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
  record: Daemon,
  toolchain: typeof ReleaseToolchain.Type,
  /** The machine token, when a declared integration reads the real connection; memory only. */
  token: Option.Option<Redacted.Redacted>
) {
  const cryptography = yield* Cryptography.Cryptography;
  // Vite sets NODE_ENV while building. Execution uses the daemon's startup environment.
  const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
  const executionConfig = ConfigProvider.orElse(
    ConfigProvider.fromUnknown({ NODE_ENV: environment }),
    yield* ConfigProvider.ConfigProvider
  );
  const events = yield* Layer.build(DevLog.layer(record.logJson ?? false));
  const nextServer =
    prepared.manifest.tier === 2
      ? yield* DevServerWatch.watch(
          record.root,
          toolchain,
          guestAliases(prepared.manifest.uses),
          prepared.manifest.tables
        )
      : undefined;
  const initialServer = nextServer === undefined ? undefined : yield* nextServer;
  const resources = yield* DevResources.prepare(prepared, record.root, stateDir, {
    ...(initialServer === undefined
      ? {}
      : {
          server: {
            bytes: new TextEncoder().encode(initialServer.server),
            handlers: yield* initialServer.inspect
          }
        }),
    observe: (event) => DevLog.invocation(event, record.logJson ?? false),
    simulated: (write) => DevLog.simulated(write, record.logJson ?? false),
    instance: { apiUrl: record.instance, token }
  }).pipe(
    Effect.provideContext(events),
    Effect.provideService(ConfigProvider.ConfigProvider, executionConfig),
    Effect.provide(FetchHttpClient.layer)
  );
  // Each mount's person keeps their own single-key shortcut setting, as each account does.
  const shortcuts = new Map(
    Object.entries(
      yield* io("Could not read the dev people's shortcut settings.", () => readShortcuts(stateDir))
    )
  );
  const saving = yield* Semaphore.make(1);
  // The file first: shells read the map, so a write that fails changes nothing they show.
  const saveShortcuts = (userId: string, on: boolean) =>
    saving.withPermits(1)(
      Effect.suspend(() =>
        io("Could not save the dev person's shortcut setting.", () =>
          atomicJson(stateDir, "shortcuts.json", { ...Object.fromEntries(shortcuts), [userId]: on })
        )
      ).pipe(Effect.tap(() => Effect.sync(() => shortcuts.set(userId, on))))
    );
  const nextBuild = yield* watch(record.root, stateDir, toolchain);
  let html = yield* nextBuild(prepared.manifest);
  // As publish reads it: only from the page's start.
  let title = documentTitle(html);
  let revision = 1;
  // A failed rebuild keeps the last good binding serving, and `patchy dev agent` says so until a
  // newer build installs. Recording the build that was serving keeps the two in step.
  let failedOver: number | undefined;
  const agentDev: DevAgent.Dev = {
    binding: () => ({
      version: resources.version,
      build: resources.build,
      rebuildFailed: failedOver === resources.build
    }),
    patch: {
      name: prepared.manifest.name ?? "This patch",
      description: prepared.manifest.description ?? "",
      owner: prepared.identity.user.name
    }
  };
  if (nextServer !== undefined) {
    yield* Effect.forever(
      nextServer.pipe(
        Effect.flatMap(
          Effect.fn("Dev.installServer")(function* (
            build: Effect.Success<NonNullable<typeof nextServer>>
          ) {
            const [handlers, install] = yield* Effect.all(
              [build.inspect, resources.stage(new TextEncoder().encode(build.server))],
              { concurrency: "unbounded" }
            );
            yield* install(handlers);
          })
        ),
        Effect.tap(() =>
          Console.log(`Server build ${resources.build} ready; waking subscriptions.`)
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            failedOver = resources.build;
          }).pipe(Effect.andThen(Console.error(error)))
        )
      )
    ).pipe(Effect.forkScoped);
  }
  const mount = Effect.fn("Dev.mount")(function* (
    identity: NonNullable<Binding.Binding["Service"]["identity"]>
  ) {
    const origin = yield* HttpServer.addressFormattedWith(Effect.succeed);
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
        // `patchy dev agent`, answering as this mount's person. The nonce keeps pages and other
        // local programs out, as for health. A guest's has none: agents reach their own company's.
        if (identity.guest !== true)
          yield* router.add(
            "POST",
            "/~dev/agent",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.headers["x-patchy-dev"] !== record.nonce) return absent;
              const mount = { person: identity, address: `${origin}${base}` };
              const body = yield* request.json.pipe(
                // `patchy dev agent`'s call, read up to the cap Patchy MCP reads one at.
                capBody(yield* ContractLimits.get("mcp.body.bytes")),
                Effect.flatMap(decodeAgentRequest),
                Effect.result
              );
              // One past the cap is refused unread, as the door refuses it; the rest is malformed.
              if (Result.isFailure(body))
                return isBodyTooLarge(body.failure)
                  ? HttpServerResponse.jsonUnsafe(DevAgent.tooLarge(agentDev, mount), { headers })
                  : HttpServerResponse.text("Bad request", { status: 400, headers });
              const reply = yield* DevAgent.answer(agentDev, mount, body.success).pipe(
                Effect.provideContext(resources.context),
                Effect.provideContext(events)
              );
              return HttpServerResponse.jsonUnsafe(reply, { headers });
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
            // As the cloud serves it, with the relay that claims Patchy's switcher key first.
            HttpServerResponse.text(withSwitcherRelay(html), {
              contentType: "text/html; charset=utf-8",
              headers: {
                ...headers,
                "content-security-policy": CONTENT_SECURITY_POLICY
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
              scope: "local",
              viewerId: identity.user.id,
              // Every local build is this release's, which obeys the setting.
              shortcuts: { on: shortcuts.get(identity.user.id) ?? true, note: false },
              handlerKinds: handlerKinds(resources.version.manifest.handlers),
              patch: {
                id: version.patchId,
                title: title ?? prepared.manifest.name ?? "Local patch"
              },
              version: {
                id: version.versionId,
                versionNumber: 1,
                tier: prepared.manifest.tier,
                wireVersion: version.wireVersion
              },
              nonce: Buffer.from(yield* cryptography.randomBytes(24)).toString("hex"),
              route,
              base,
              head: `<script defer src="/~dev/reload.js?v=${revision}"></script>`
            }),
            {
              contentType: "text/html; charset=utf-8",
              headers: { ...headers, "content-security-policy": SHELL_SECURITY_POLICY }
            }
          );
        });
        yield* router.add("GET", `${base}/*`, shell);
      })
    );
    // `POST /api/me/shortcuts` as Patchy serves it, for this mount's person: the shell's dialog
    // saves through it. Only this origin's pages may change it.
    const viewer = HttpApiBuilder.group(api, "viewer", (handlers) =>
      Effect.succeed(
        handlers.handleRaw("setShortcuts", () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.headers.origin !== origin)
              return HttpServerResponse.text("Request refused", { status: 403, headers });
            const form = yield* HttpServerRequest.schemaBodyUrlParams(ShortcutsRequest).pipe(
              capBody(MAX_SHORTCUTS_BYTES),
              Effect.option
            );
            if (Option.isNone(form))
              return HttpServerResponse.text("Send value=on or value=off.", {
                status: 400,
                headers
              });
            const { value, return: back } = form.value;
            yield* saveShortcuts(identity.user.id, value === "on");
            if (request.headers.accept?.includes("application/json") === true)
              return HttpServerResponse.jsonUnsafe({ value }, { headers });
            return HttpServerResponse.redirect(
              back?.startsWith(`${base}/`) === true ? back : `${base}/`,
              { status: 303, headers }
            );
          }).pipe(
            Effect.catchTags({
              LocalError: (error) =>
                Console.error(error.message).pipe(
                  Effect.as(HttpServerResponse.text("Not saved", { status: 503, headers }))
                )
            })
          )
        )
      )
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
    const streamIdentity = {
      companyId: identity.company.id,
      viewerId: identity.user.id,
      expiresAt: Number.POSITIVE_INFINITY,
      identity
    };
    const runtime = Layer.mergeAll(
      RuntimeDev.layer(resources.handlers, { origin, identity }),
      RuntimeStream.layer.pipe(
        Layer.provide([
          StreamLimits.layerLocal,
          Layer.succeed(StreamAdmission.StreamAdmission, {
            admit: Effect.succeed({
              viewerId: streamIdentity.viewerId,
              expiresAt: streamIdentity.expiresAt,
              viewer: () =>
                Effect.succeed({ ...streamIdentity, recheck: Effect.succeed(streamIdentity) })
            })
          })
        ])
      )
    ).pipe(Layer.provide([Limits.layer, Layer.succeedContext(resources.context)]));
    yield* Layer.build(
      HttpRouter.serve(
        Layer.mergeAll(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide([RuntimeApi.layer, RuntimeStreamApi.layer, viewer])
          ),
          pages,
          guard
        ),
        { disableLogger: true, disableListenLog: true }
      ).pipe(Layer.provide(runtime), Layer.provide(Layer.succeedContext(events)))
    );
    return `${origin}${base}`;
  });
  const url = yield* mount({
    user: prepared.identity.user,
    company: prepared.identity.company,
    admin: prepared.identity.role !== "member"
  });
  const colleagueServer = yield* Layer.build(Layer.fresh(layer));
  const colleagueUrl = yield* mount({
    user: colleague,
    company: prepared.identity.company,
    admin: false
  }).pipe(Effect.provideContext(colleagueServer));
  // The patch's guest: themselves, in the patch's company, never its admin.
  const guestServer = yield* Layer.build(Layer.fresh(layer));
  const guestUrl = yield* mount({
    user: guest,
    company: prepared.identity.company,
    admin: false,
    guest: true
  }).pipe(Effect.provideContext(guestServer));
  const ready = {
    ...record,
    pid: process.pid,
    birth: yield* io("Could not identify the dev daemon.", async () => {
      const value = await birth(process.pid);
      if (!value) throw new Error("Process identity unavailable");
      return value;
    }),
    url,
    colleagueUrl,
    guestUrl
  };
  yield* io("Could not record the healthy dev daemon.", () =>
    atomicJson(stateDir, "daemon.json", ready)
  );
  yield* Console.log(`Ready: ${ready.url}`);
  yield* Console.log(`Colleague: ${colleagueUrl}`);
  yield* Console.log(`Guest: ${guestUrl}`);
  yield* Effect.addFinalizer(() =>
    io("Could not clear the stopped dev daemon.", async () => {
      const current = await readRecord(stateDir);
      if (current?.nonce === record.nonce)
        await atomicJson(stateDir, "daemon.json", {
          ...ready,
          url: undefined,
          colleagueUrl: undefined,
          guestUrl: undefined
        });
    }).pipe(Effect.orDie)
  );
  return yield* Effect.forever(
    nextBuild(prepared.manifest).pipe(
      Effect.tap((bundle) =>
        Effect.sync(() => {
          html = bundle;
          title = documentTitle(bundle);
          revision++;
        })
      ),
      Effect.tap(() => Console.log(`Build ${revision} ready; reloading local shells.`)),
      Effect.catch((error) => Console.error(error.message))
    )
  );
});

export const layer = NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 });
