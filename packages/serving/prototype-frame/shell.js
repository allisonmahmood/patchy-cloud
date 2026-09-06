// PROTOTYPE — the shell's broker. Runs on the trusted origin with the viewer's
// session; the frame reaches Patchy only through this. Wayfinder #175.
(() => {
  const { base, route, origin } = window.__patchy;
  const frame = document.getElementById("patch");
  const logEl = document.getElementById("broker-log");
  const refused = [];
  window.__brokerRefused = refused;
  const note = (text) => (logEl.textContent = text);

  const api = (method, path, body) =>
    fetch(`/api${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    });

  const routeOf = (pathname) => (pathname.startsWith(base) ? pathname.slice(base.length) || "/" : "/");

  // Resource names are identifiers, never path fragments: `../../other/tables/x`
  // would otherwise normalise into another patch's URL before the server looks.
  const ident = (value, pattern) => {
    if (typeof value !== "string" || !pattern.test(value)) throw Object.assign(new Error(`bad identifier ${JSON.stringify(value)}`), { code: "bad_request" });
    return value;
  };
  const tableName = (t) => ident(t, /^[a-z][a-z0-9_]{0,62}$/);
  const fileName = (n) => ident(n, /^[\w-]+(\.[\w-]+)*$/);
  const routePath = (p) => {
    ident(p, /^\/(?:[\w.-]+(?:\/[\w.-]+)*)?$/);
    if (p.split("/").some((seg) => seg === "." || seg === "..")) throw Object.assign(new Error(`bad route ${p}`), { code: "bad_request" });
    return p;
  };

  // The operations the shell exposes. Specific SDK operations, never a URL.
  // The server still checks declarations and permissions per call; this list is
  // only what the frame is allowed to ask for.
  const ops = {
    "rows.read": async ({ table }) => {
      const res = await api("GET", `/tables/${tableName(table)}/rows`);
      const body = await res.json();
      if (!body.ok) throw Object.assign(new Error(body.error), { code: res.status });
      return { value: body.rows };
    },
    "rows.insert": async ({ table, row }) => {
      const res = await api("POST", `/tables/${tableName(table)}/rows`, row);
      const body = await res.json();
      if (!body.ok) throw Object.assign(new Error(body.error), { code: res.status });
      return { value: body.row };
    },
    "files.get": async ({ name }) => {
      const res = await api("GET", `/files/${fileName(name)}`);
      if (!res.ok) throw Object.assign(new Error(`file ${name}: ${res.status}`), { code: res.status });
      const bytes = await res.arrayBuffer();
      return { value: { bytes, type: res.headers.get("content-type") }, transfer: [bytes] };
    },
    // The route bridge: the frame owns its routes, the shell owns the address bar.
    "route.set": ({ path }) => {
      history.pushState(null, "", base + routePath(path));
      return { value: null };
    },
    // Shell-owned download: the anchor is created on the trusted origin.
    download: async ({ name }) => {
      const res = await api("GET", `/files/${fileName(name)}`);
      if (!res.ok) throw Object.assign(new Error(`file ${name}: ${res.status}`), { code: res.status });
      const href = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      return { value: null };
    },
    // Shell-owned printing: prints the shell, frame included. The frame is a
    // fixed box, so the shell grows it to the content's height first, else
    // everything past the first screen is clipped.
    print: ({ height }) => {
      const restore = { height: frame.style.height, flex: frame.style.flex };
      if (height) {
        frame.style.flex = "none";
        frame.style.height = `${height}px`;
        window.addEventListener("afterprint", () => Object.assign(frame.style, restore), { once: true });
      }
      window.print();
      return { value: null };
    }
  };

  // The broker lives on a MessageChannel handed to the first document the frame
  // loads, once. Replies go down the port, never to the window, so a document
  // that replaces it by navigating (or a redirect) inherits nothing: no port,
  // no in-flight replies, no second handshake. Reloading the shell is the only
  // way to a new port.
  let port = null;
  let issued = false;
  const send = (message, transfer = []) => port?.postMessage(message, transfer);

  const handle = async (m) => {
    if (!m || m.v !== 1 || typeof m.id !== "string" || typeof m.op !== "string") return;
    if (!Object.hasOwn(ops, m.op)) return send({ v: 1, id: m.id, kind: "error", error: { code: "unknown_op", message: `unknown op ${m.op}` } });
    try {
      const { value, transfer } = await ops[m.op](m.args ?? {});
      send({ v: 1, id: m.id, kind: "result", value }, transfer);
      note(`${m.op} ok`);
    } catch (e) {
      send({ v: 1, id: m.id, kind: "error", error: { code: e.code ?? "failed", message: e.message } });
      note(`${m.op} failed: ${e.message}`);
    }
  };

  frame.addEventListener("load", () => {
    if (issued) {
      // The frame loaded a second document: it navigated itself or was redirected. It gets no broker.
      port?.close();
      port = null;
      window.__brokerRevoked = (window.__brokerRevoked ?? 0) + 1;
      note("frame navigated: broker revoked");
      return;
    }
    issued = true;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (event) => handle(event.data);
    // The one window-level message: the port and the current route, to the mounted frame only.
    frame.contentWindow.postMessage({ v: 1, kind: "bootstrap", route: routeOf(location.pathname) }, "*", [channel.port2]);
  });

  // Anything that still arrives on the window is not the broker's: log it and drop it.
  window.addEventListener("message", (event) => {
    refused.push({ origin: event.origin, source: event.source === frame.contentWindow ? "frame" : "other", data: event.data });
    note(`refused window message from ${event.origin}`);
  });

  window.addEventListener("popstate", () =>
    send({ v: 1, kind: "event", event: "route", data: { path: routeOf(location.pathname) } })
  );
})();
