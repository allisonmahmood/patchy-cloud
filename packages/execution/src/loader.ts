// PROTOTYPE for #314: the loader Worker and workerd config, embedded as strings so the engine
// ships inside one bundle (the CLI's dev runtime and the hosting server both spawn it). The
// shape is the execution spike's (#311): one dynamically loaded Worker per bundle name on the
// real `workerLoader` binding, `globalOutbound` bound to a refusing loopback, and callbacks
// over a `ctx.exports` stub that carries the invocation id only. The capability never enters
// the guest isolate.

/** Written next to `config.capnp`; the config embeds it by file name. */
export const LOADER_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";

const invocations = new Map(); // invocationId -> { capability, hostUrl }
const loaded = new Map(); // name -> { loadedAt, loadMs }
const outboundAttempts = [];

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function getWorker(env, ctx, name, bundle) {
  return env.loader.get(name, () => {
    if (!bundle) throw new Error("bundle_required");
    return {
      compatibilityDate: "2025-09-01",
      mainModule: "server.js",
      modules: { "server.js": bundle },
      env: {},
      globalOutbound: ctx.exports.Outbound({ props: { name } })
    };
  });
}

async function guest(worker, props, body) {
  const ep = worker.getEntrypoint(undefined, { props });
  const res = await ep.fetch("http://guest/", { method: "POST", body: JSON.stringify(body) });
  return res.json();
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return json({ ok: true, loaded: [...loaded.keys()] });
    if (url.pathname === "/outbound-attempts") return json(outboundAttempts);
    const body = await req.json();
    const { name, bundle } = body;
    if (!loaded.has(name) && !bundle) return json({ ok: false, error: "bundle_required" }, 409);
    if (url.pathname === "/bind" || url.pathname === "/inspect") {
      const t0 = Date.now();
      let worker;
      try {
        worker = getWorker(env, ctx, name, bundle);
        const out = await guest(worker, { invocationId: null, callbacks: null }, {
          handler: url.pathname === "/bind" ? "__ping" : "__describe"
        });
        const loadMs = Date.now() - t0;
        loaded.set(name, { loadedAt: t0, loadMs });
        return json({ ...out, loadMs });
      } catch (e) {
        return json(
          { ok: false, error: "failed", message: String(e?.message ?? e) },
          e?.message === "bundle_required" ? 409 : 500
        );
      }
    }
    if (url.pathname === "/invoke") {
      const { invocationId, capability, hostUrl, handler, args, viewer } = body;
      let worker;
      try {
        worker = getWorker(env, ctx, name, bundle);
      } catch (e) {
        return json({ ok: false, error: "failed", message: String(e?.message ?? e) }, 409);
      }
      const firstLoad = !loaded.has(name);
      invocations.set(invocationId, { capability, hostUrl });
      const t0 = Date.now();
      try {
        const out = await guest(
          worker,
          { invocationId, callbacks: ctx.exports.Callbacks({ props: { invocationId } }) },
          { handler, args, viewer }
        );
        if (firstLoad) loaded.set(name, { loadedAt: t0, loadMs: Date.now() - t0 });
        return json({ ...out, guestMs: Date.now() - t0, firstLoad });
      } catch (e) {
        return json(
          { ok: false, error: "failed", message: "loader: " + String(e?.message ?? e), guestMs: Date.now() - t0 },
          500
        );
      } finally {
        invocations.delete(invocationId);
      }
    }
    return json({ ok: false, error: "not_found" }, 404);
  }
};

// The capability broker: forwards a guest's operation to the host with the per-invocation
// capability the guest never holds. A refusal comes back as a thrown error carrying the code.
export class Callbacks extends WorkerEntrypoint {
  async call(op, args) {
    const inv = invocations.get(this.ctx.props.invocationId);
    if (!inv) throw Object.assign(new Error("callback refused: invocation ended"), { patchyRefusal: { code: "capability_refused" } });
    const res = await fetch(inv.hostUrl + "/callback", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + inv.capability },
      body: JSON.stringify({ op, args })
    });
    const out = await res.json();
    if (!res.ok || out.ok !== true) {
      throw Object.assign(new Error("callback refused: " + (out.code ?? res.status)), {
        patchyRefusal: { code: out.code ?? "capability_refused", details: out.details, message: out.message }
      });
    }
    return out.result;
  }
}

// Global outbound for every dynamic Worker: refuse and remember.
export class Outbound extends WorkerEntrypoint {
  async fetch(req) {
    outboundAttempts.push({ name: this.ctx.props.name, url: req.url, at: Date.now() });
    return json({ refused: true, url: req.url, by: "loader Outbound loopback" }, 403);
  }
}
`;

/**
 * The loader's own outbound is restricted to loopback addresses: the host's callback listener
 * is the only thing it may reach. Dynamic Workers get the refusing `Outbound` above instead.
 */
export const CONFIG_CAPNP = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "loader",
      worker = (
        modules = [ (name = "loader.js", esModule = embed "loader.js") ],
        compatibilityDate = "2025-09-01",
        compatibilityFlags = ["nodejs_compat", "enable_ctx_exports", "experimental"],
        bindings = [ (name = "loader", workerLoader = ()) ],
        globalOutbound = "loopback",
      )
    ),
    ( name = "loopback", network = ( allow = ["local"] ) ),
  ],
  sockets = [ ( name = "http", address = "127.0.0.1:0", http = (), service = "loader" ) ],
);
`;
