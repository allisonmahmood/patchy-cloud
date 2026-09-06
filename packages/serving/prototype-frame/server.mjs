// PROTOTYPE — throwaway server for wayfinder #175. One host, three patches,
// in-memory fixtures, a session cookie, and an API that logs what it sees.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const PORT = Number(process.env.PORT ?? 4175);
const ORIGIN = `http://localhost:${PORT}`;
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, name));

// ---- fixtures ---------------------------------------------------------------

const users = { ada: { company: "acme" }, bob: { company: "globex" } };

const patches = {
  "acme/inventory": { scope: "company", html: "patches/inventory.html", csp: "strict" },
  "acme/deck": { scope: "public", html: "patches/deck.html", csp: "strict" },
  "acme/probe": { scope: "company", html: "patches/probe.html", csp: "loose" }
};

const tables = {
  "acme/inventory": {
    items: [
      { id: 1, name: "Anvil", qty: 4 },
      { id: 2, name: "Bellows", qty: 12 },
      { id: 3, name: "Crucible", qty: 1 }
    ]
  },
  "acme/deck": { slides: [{ id: 1, title: "Q3 numbers" }] },
  "acme/probe": { items: [{ id: 1, name: "probe" }] }
};

// A 1x1 PNG so the image test has real bytes, and a CSV for the download test.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const files = {
  "acme/inventory": {
    "logo.png": { type: "image/png", bytes: PNG },
    "report.csv": { type: "text/csv", bytes: Buffer.from("id,name,qty\n1,Anvil,4\n") }
  },
  "acme/deck": { "logo.png": { type: "image/png", bytes: PNG } },
  "acme/probe": {}
};

// ---- what the API saw -------------------------------------------------------

const log = [];
const record = (req, url, outcome) =>
  log.push({
    method: req.method,
    path: url.pathname,
    origin: req.headers.origin ?? "(missing)",
    cookie: req.headers.cookie ? "present" : "absent",
    secFetchSite: req.headers["sec-fetch-site"] ?? "(missing)",
    secFetchDest: req.headers["sec-fetch-dest"] ?? "(missing)",
    outcome
  });

// ---- sdk, compiled once -------------------------------------------------------

const sdkJs = transformSync(read("sdk.ts").toString(), { loader: "ts", format: "iife", globalName: "PatchySDK" }).code;

// ---- helpers -----------------------------------------------------------------

const html = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers
  });
  res.end(body);
};
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const sessionOf = (req) => {
  const m = /(?:^|;\s*)session=([a-z]+)/.exec(req.headers.cookie ?? "");
  return m && users[m[1]] ? m[1] : null;
};

/** The door: who may open this patch, and why not. */
const admission = (patch, company, user) => {
  if (patch.scope === "public") return { ok: true };
  if (!user) return { ok: false, status: 401, reason: "sign in" };
  if (users[user].company !== company) return { ok: false, status: 403, reason: "not your company" };
  return { ok: true };
};

/** Data access: whoever can open a company patch reads and writes all of it; anonymous readers get nothing. */
const dataAccess = (patch, company, user) => {
  if (!user) return { ok: false, status: 401, error: "anonymous readers get nothing" };
  if (users[user].company !== company) return { ok: false, status: 403, error: "not a member of " + company };
  return { ok: true };
};

const escapeHtml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// ---- pages ---------------------------------------------------------------------

const renderIndex = (user) => `<!doctype html><meta charset="utf-8"><title>frame prototype</title>
<body style="font:16px system-ui;max-width:40rem;margin:3rem auto">
<h1>PROTOTYPE — frame + broker</h1>
<p>You are <b>${user ?? "signed out"}</b>${user ? ` (${users[user].company})` : ""}.
 <a href="/login?as=ada">be ada (acme)</a> · <a href="/login?as=bob">be bob (globex)</a> · <a href="/logout">sign out</a></p>
<ul>
<li><a href="/acme/inventory">acme/inventory</a> (company patch) · <a href="/acme/inventory/items/2">deep link to item 2</a></li>
<li><a href="/acme/deck">acme/deck</a> (public patch)</li>
<li><a href="/acme/probe">acme/probe</a> (company patch, loose CSP so the frame can try to reach the API itself)</li>
<li><a href="/acme/inventory/~content">the content URL opened directly</a></li>
<li><a href="/_log">what the API saw</a></li>
</ul></body>`;

const renderDoor = (status, reason) => `<!doctype html><meta charset="utf-8"><title>door</title>
<body style="font:16px system-ui;max-width:40rem;margin:3rem auto"><h1 data-door="${status}">${status}: ${reason}</h1>
<p><a href="/login?as=ada">sign in as ada</a> · <a href="/">home</a></p></body>`;

// Decided on #175: the frame gets allow-modals so patch code prints its own
// document; downloads stay shell-owned (allow-downloads is a click-through variant only).
const SANDBOX = "allow-scripts allow-modals";
const SANDBOX_EXTRAS = new Set(["allow-downloads"]);

const renderShell = ({ company, name, patch, user, route, extras, long }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${company}/${name}</title>
${user ? `<script>/* session scripts would go here on a company shell */window.__session = ${JSON.stringify({ user })};</script>` : "<!-- public shell: no session scripts -->"}
<style>
html,body{height:100%;margin:0;background:#fff}
body{display:flex;flex-direction:column}
.bar{font:13px system-ui;padding:6px 10px;border-bottom:1px solid #ddd;display:flex;gap:1rem;align-items:center}
.patch-frame{flex:1;width:100%;border:0}
</style></head>
<body>
<div class="bar"><b>Patchy shell</b> <span>${company}/${name}</span> <span>viewer: ${user ?? "anonymous"}</span>
<span id="broker-log" data-testid="broker-log"></span></div>
<iframe class="patch-frame" id="patch" title="${company}/${name}"
  sandbox="${SANDBOX}${extras.map((t) => " " + t).join("")}" referrerpolicy="no-referrer"
  src="/${company}/${name}/~content?${new URLSearchParams({ ...(long ? { long: "1" } : {}), sandbox: extras.join(" ") })}"></iframe>
<script>
window.__patchy = ${JSON.stringify({ company, name, base: `/${company}/${name}`, route, origin: ORIGIN })};
</script>
<script src="/~shell.js"></script>
</body></html>`;

// The content's own CSP sandbox intersects with the iframe attribute: the more
// restrictive wins, so any token the shell grants must be listed here as well.
const contentCsp = (mode, extras) =>
  mode === "loose"
    ? `sandbox ${SANDBOX}${extras.map((t) => " " + t).join("")}`
    : [
        `sandbox ${SANDBOX}${extras.map((t) => " " + t).join("")}`,
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src blob: data:",
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'"
      ].join("; ");

const renderContent = ({ company, name, patch, long }) => {
  const body = read(patch.html).toString() + (long ? Array.from({ length: 150 }, (_, i) => `<p>filler paragraph ${i + 1} so the document runs past one screen</p>`).join("") : "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${company}/${name} content</title>
<script>window.__patchyContent = ${JSON.stringify({ shellOrigin: ORIGIN, patch: `${company}/${name}` })};</script>
<script>${sdkJs}</script>
</head><body>${body}</body></html>`;
};

// ---- server ---------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const user = sessionOf(req);

  if (url.pathname === "/") return html(res, 200, renderIndex(user));
  if (url.pathname === "/login") {
    const as = url.searchParams.get("as");
    if (!users[as]) return html(res, 400, "no such user");
    res.writeHead(303, { "set-cookie": `session=${as}; Path=/; HttpOnly; SameSite=Lax`, location: "/" });
    return res.end();
  }
  if (url.pathname === "/logout") {
    res.writeHead(303, { "set-cookie": "session=; Path=/; Max-Age=0", location: "/" });
    return res.end();
  }
  if (url.pathname === "/~shell.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    return res.end(read("shell.js"));
  }
  if (url.pathname === "/_log") {
    if (req.method === "DELETE") log.length = 0;
    return json(res, 200, log);
  }

  // /api/<company>/<patch>/tables/<t>/rows | /api/<company>/<patch>/files/<name>
  const api = /^\/api\/([a-z]+)\/([a-z]+)\/(tables|files)\/([\w.-]+)(?:\/rows)?$/.exec(url.pathname);
  if (api) {
    const [, company, name, kind, key] = api;
    const id = `${company}/${name}`;
    const patch = patches[id];
    if (!patch) return json(res, 404, { ok: false, error: "no such patch" });

    if (req.method === "POST") {
      // Session-authenticated mutations require the exact shell Origin; missing and null are refused before anything runs.
      if (req.headers.origin !== ORIGIN) {
        record(req, url, "403 origin");
        return json(res, 403, { ok: false, error: `origin refused: ${req.headers.origin ?? "(missing)"}` });
      }
    }
    const access = dataAccess(patch, company, user);
    if (!access.ok) {
      record(req, url, `${access.status} ${access.error}`);
      return json(res, access.status, { ok: false, error: access.error });
    }
    if (kind === "tables") {
      const rows = tables[id]?.[key];
      if (!rows) return json(res, 404, { ok: false, error: "no such table" });
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const row = { id: rows.length + 1, ...JSON.parse(body || "{}") };
        rows.push(row);
        record(req, url, "200 inserted");
        return json(res, 200, { ok: true, row });
      }
      record(req, url, "200 rows");
      return json(res, 200, { ok: true, rows });
    }
    const file = files[id]?.[key];
    if (!file) return json(res, 404, { ok: false, error: "no such file" });
    record(req, url, "200 bytes");
    res.writeHead(200, { "content-type": file.type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    return res.end(file.bytes);
  }

  // /<company>/<patch>/~content | /<company>/<patch>[/route]
  const page = /^\/([a-z]+)\/([a-z]+)(\/.*)?$/.exec(url.pathname);
  if (page) {
    const [, company, name, rest = ""] = page;
    const id = `${company}/${name}`;
    const patch = patches[id];
    if (!patch) return html(res, 404, renderDoor(404, "no such patch"));
    const door = admission(patch, company, user);
    if (!door.ok) return html(res, door.status, renderDoor(door.status, door.reason));
    const extras = (url.searchParams.get("sandbox") ?? "").split(/\s+/).filter((t) => SANDBOX_EXTRAS.has(t));
    if (rest === "/~content") {
      record(req, url, "200 content");
      return html(res, 200, renderContent({ company, name, patch, long: url.searchParams.has("long") }), {
        "content-security-policy": contentCsp(patch.csp, extras)
      });
    }
    return html(res, 200, renderShell({ company, name, patch, user, route: rest || "/", extras, long: url.searchParams.has("long") }), {
      "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; img-src 'self' blob:"
    });
  }

  html(res, 404, renderDoor(404, "nothing here"));
});

server.listen(PORT, () => console.log(`PROTOTYPE frame+broker on ${ORIGIN}`));
