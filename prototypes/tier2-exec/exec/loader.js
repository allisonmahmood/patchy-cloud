// PROTOTYPE for #311: the loader Worker. Runs inside workerd; the supervisor
// proxies /bind and /invoke here. Each (company, patch, version) becomes a
// dynamically loaded Worker cached by name. The guest gets an invocation id and
// a `callbacks` loopback stub in ctx.props; the capability lives only in the
// `invocations` map on this side of the isolate boundary.
import { WorkerEntrypoint } from "cloudflare:workers";

const invocations = new Map(); // invocationId -> { capability, hostUrl, name }
const loaded = new Map(); // name -> { loadedAt, loadMs }
const outboundAttempts = []; // what guests tried to reach through global fetch

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function getWorker(env, ctx, name, bundle, compatibilityDate) {
  return env.loader.get(name, () => {
    if (!bundle) throw new Error("bundle_required");
    return {
      compatibilityDate: compatibilityDate ?? "2025-09-01",
      mainModule: "server.js",
      modules: { "server.js": bundle },
      env: {},
      // Everything the guest sends through global fetch()/connect() lands on
      // the Outbound loopback below, which refuses and records it.
      globalOutbound: ctx.exports.Outbound({ props: { name } })
    };
  });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return json({ ok: true, loaded: [...loaded.keys()] });
    if (url.pathname === "/outbound-attempts") return json(outboundAttempts);
    const body = await req.json();
    const { name, bundle, compatibilityDate } = body;
    // The loader's code callback runs lazily, so check up front: after a
    // restart this process has forgotten every bundle and the host must resend.
    if (!loaded.has(name) && !bundle) return json({ ok: false, error: "bundle_required" }, 409);

    if (url.pathname === "/bind") {
      // The wake path's bind step: load the Worker and force the isolate up.
      const t0 = Date.now();
      let worker;
      try {
        worker = getWorker(env, ctx, name, bundle, compatibilityDate);
        const res = await worker.getEntrypoint(undefined, { props: {} }).fetch("http://guest/", {
          method: "POST",
          body: JSON.stringify({ handler: "__ping" })
        });
        await res.json();
      } catch (e) {
        return json(
          { ok: false, error: String(e?.message ?? e) },
          e?.message === "bundle_required" ? 409 : 500
        );
      }
      const loadMs = Date.now() - t0;
      loaded.set(name, { loadedAt: t0, loadMs });
      return json({ ok: true, name, loadMs });
    }

    if (url.pathname === "/invoke") {
      const { invocationId, capability, hostUrl, handler, args, viewer, limits, generation } = body;
      let worker;
      try {
        worker = getWorker(env, ctx, name, bundle, compatibilityDate);
      } catch (e) {
        return json({ ok: false, error: String(e?.message ?? e) }, 409);
      }
      const firstLoad = !loaded.has(name);
      invocations.set(invocationId, { capability, hostUrl, name, generation });
      const t0 = Date.now();
      try {
        const ep = worker.getEntrypoint(undefined, {
          props: { invocationId, callbacks: ctx.exports.Callbacks({ props: { invocationId } }) },
          ...(limits ? { limits } : {})
        });
        const res = await ep.fetch("http://guest/", {
          method: "POST",
          body: JSON.stringify({ handler, args, viewer })
        });
        const out = await res.json();
        if (firstLoad) loaded.set(name, { loadedAt: t0, loadMs: Date.now() - t0 });
        return json({ ...out, guestMs: Date.now() - t0, firstLoad });
      } catch (e) {
        return json(
          {
            ok: false,
            error: `loader: ${String(e?.message ?? e)}`,
            guestMs: Date.now() - t0,
            firstLoad
          },
          500
        );
      } finally {
        invocations.delete(invocationId);
      }
    }
    return json({ error: "not_found" }, 404);
  }
};

// The capability broker: forwards a guest's table operation to the host with
// the per-invocation token the guest never holds.
export class Callbacks extends WorkerEntrypoint {
  async call(op, args) {
    const inv = invocations.get(this.ctx.props.invocationId);
    if (!inv) throw new Error("callback refused: invocation ended");
    const res = await fetch(`${inv.hostUrl}/callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${inv.capability}`,
        "x-exec-generation": String(inv.generation ?? 0)
      },
      body: JSON.stringify({ op, args })
    });
    const out = await res.json();
    if (!res.ok) throw new Error(`callback refused: ${out.error ?? res.status}`);
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
