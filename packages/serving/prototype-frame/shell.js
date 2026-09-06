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

  // The operations the shell exposes. Specific SDK operations, never a URL.
  // The server still checks declarations and permissions per call; this list is
  // only what the frame is allowed to ask for.
  const ops = {
    "rows.read": async ({ table }) => {
      const res = await api("GET", `/tables/${table}/rows`);
      const body = await res.json();
      if (!body.ok) throw Object.assign(new Error(body.error), { code: res.status });
      return { value: body.rows };
    },
    "rows.insert": async ({ table, row }) => {
      const res = await api("POST", `/tables/${table}/rows`, row);
      const body = await res.json();
      if (!body.ok) throw Object.assign(new Error(body.error), { code: res.status });
      return { value: body.row };
    },
    "files.get": async ({ name }) => {
      const res = await api("GET", `/files/${name}`);
      if (!res.ok) throw Object.assign(new Error(`file ${name}: ${res.status}`), { code: res.status });
      const bytes = await res.arrayBuffer();
      return { value: { bytes, type: res.headers.get("content-type") }, transfer: [bytes] };
    },
    // The route bridge: the frame owns its routes, the shell owns the address bar.
    "route.set": ({ path }) => {
      history.pushState(null, "", base + path);
      return { value: null };
    },
    // Shell-owned download: the anchor is created on the trusted origin.
    download: async ({ name }) => {
      const res = await api("GET", `/files/${name}`);
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

  const send = (message, transfer = []) => frame.contentWindow.postMessage(message, "*", transfer);

  window.addEventListener("message", async (event) => {
    // Only the mounted frame may talk to the broker. Anything else — the shell
    // window itself, another frame, a popup — is dropped without a reply.
    if (event.source !== frame.contentWindow) {
      refused.push({ origin: event.origin, data: event.data });
      note(`refused message from ${event.origin}`);
      return;
    }
    const m = event.data;
    if (!m || m.v !== 1 || typeof m.id !== "string" || typeof m.op !== "string") return;
    const op = ops[m.op];
    if (!op) return send({ v: 1, id: m.id, kind: "error", error: { code: "unknown_op", message: `unknown op ${m.op}` } });
    try {
      const { value, transfer } = await op(m.args ?? {});
      send({ v: 1, id: m.id, kind: "result", value }, transfer);
      note(`${m.op} ok`);
    } catch (e) {
      send({ v: 1, id: m.id, kind: "error", error: { code: e.code ?? "failed", message: e.message } });
      note(`${m.op} failed: ${e.message}`);
    }
  });

  // The frame says it is ready; the shell hands it the current route. Back and
  // forward are shell events the frame subscribes to.
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    if (event.data?.kind === "ready") send({ v: 1, kind: "event", event: "route", data: { path: route } });
  });
  window.addEventListener("popstate", () =>
    send({ v: 1, kind: "event", event: "route", data: { path: routeOf(location.pathname) } })
  );
})();
