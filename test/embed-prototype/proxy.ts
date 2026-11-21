/** #1232 only: a loopback ingress experiment, never imported by the product server. */
import { createServer, type Server } from "node:http";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { Session } from "@patchy/auth";
import { escapeAttribute, htmlPage } from "../../packages/core/src/html.js";
import type { liveClient } from "../../packages/auth/live/fixtures.js";
import type { Published } from "../browser-tier1/instance.js";

export async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback listener.");
  return address.port;
}

export async function closeServer(server: Server) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

const digest = async (value: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "hex"
  );

type Embedded = {
  sid: string;
  sub: string;
  patch: Published;
  host: string;
  expiresAt: number;
  cookie: string;
  cookieUntil: number;
  ended?: string;
  streams: Set<AbortController>;
};
type Pending = {
  patch: Published;
  host: string;
  challenge: string;
  expiresAt: number;
  session?: Embedded;
  refused?: boolean;
};

export async function startProxy() {
  let upstream = "";
  let auth: Session.Session["Service"];
  let clerk: Effect.Success<typeof liveClient>;
  const patches = new Map<string, Published>();
  const approved = new Set<string>();
  const pending = new Map<string, Pending>();
  const sessions = new Map<string, Embedded>();
  let lifetimeMs = 300_000;
  const audit = { credentialInUrl: false, embeddedCookies: 0, runtimeCalls: 0 };
  const bundled = await build({
    entryPoints: [new URL("client.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife"
  });
  const broker = await build({
    entryPoints: [new URL("../../packages/serving/src/broker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    conditions: ["development"],
    plugins: [
      {
        name: "prototype-content-post",
        setup(builder) {
          builder.onLoad({ filter: /\/serving\/src\/broker\.ts$/ }, async ({ path }) => {
            const source = await readFile(path, "utf8");
            const needle = "frame.src = contentSrc;";
            if (!source.includes(needle))
              throw new Error("Revisit the prototype's content adapter.");
            const notice =
              "location.replace(\n      `/~shell/notice/${code}?return=${encodeURIComponent(location.pathname + location.search + location.hash)}`\n    );";
            if (!source.includes(notice))
              throw new Error("Revisit the prototype's notice adapter.");
            return {
              contents: source
                .replace(needle, "window.prototypeContent(frame, contentSrc);")
                .replace(notice, "window.prototypeStop(code);"),
              loader: "ts"
            };
          });
          builder.onResolve({ filter: /^node:/ }, ({ path }) => ({
            path,
            external: true,
            sideEffects: false
          }));
        }
      }
    ]
  });
  const end = (session: Embedded, reason: string) => {
    session.ended = reason;
    session.cookie = "";
    for (const controller of session.streams) controller.abort();
  };
  const forward = (path: string, init?: RequestInit) =>
    fetch(new URL(path, upstream), {
      ...init,
      redirect: "manual",
      signal: init?.signal ?? AbortSignal.timeout(15_000)
    });
  const failure = (reason: string, status = 403) =>
    Response.json(
      {
        ok: false,
        source: "patchy",
        code: "access_denied",
        error: reason
      },
      { status }
    );
  const check = async (session: Embedded) => {
    if (session.ended) return false;
    if (Date.now() >= session.expiresAt) end(session, "Embedded session expired");
    else if (!approved.has(session.host)) end(session, "Host approval removed");
    else if (!(await Effect.runPromise(auth.isActive(session))))
      end(session, "Patchy session ended");
    if (session.ended) return false;
    if (Date.now() >= session.cookieUntil) {
      // A fresh JWT for the SAME live Clerk session; it never leaves this loopback proxy.
      const token = await clerk.sessions.getToken(session.sid);
      session.cookie = `__session=${token.jwt}; __client_uat=${Math.floor(Date.now() / 1000)}; __clerk_db_jwt=prototype`;
      session.cookieUntil = Date.now() + 40_000;
    }
    // Use the real serving door, including membership, guest grants and lifecycle checks.
    const access = await forward(new URL(session.patch.address).pathname, {
      headers: { cookie: session.cookie, "accept-encoding": "identity" }
    });
    const body = await access.text();
    if (!access.ok || !body.includes('id="patch"')) end(session, "Patch access ended");
    return session.ended === undefined;
  };
  const framePolicy = (response: Response, ancestors: string, shell = false) => {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("set-cookie");
    headers.set("cache-control", "private, no-store");
    const policy =
      headers.get("content-security-policy") ?? "default-src 'none'; frame-ancestors 'none'";
    headers.set(
      "content-security-policy",
      policy
        .replace(/frame-ancestors[^;]*/, `frame-ancestors ${ancestors}`)
        .replace("form-action 'none'", shell ? "form-action 'self'" : "form-action 'none'")
    );
    return headers;
  };
  const page = (body: string) =>
    new Response(htmlPage({ title: "Embed prototype", body }), {
      headers: {
        "content-type": "text/html",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
      }
    });
  let origin = "";
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (url.searchParams.has("token") || url.searchParams.has("verifier"))
      audit.credentialInUrl = true;
    if (path === "/~prototype/client.js" || path === "/~prototype/broker.js")
      return new Response((path.endsWith("client.js") ? bundled : broker).outputFiles[0]!.text, {
        headers: { "content-type": "text/javascript", "cache-control": "no-store" }
      });
    if (path === "/~prototype/cookie-probe")
      return Response.json({
        cookie: request.headers.get("cookie")?.includes("prototype_probe=1") ?? false
      });
    if (path === "/~prototype/embed") {
      const patch = patches.get(url.searchParams.get("patch") ?? "");
      const host = url.searchParams.get("host") ?? "";
      if (!patch || !approved.has(host)) return failure("Host not approved");
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><title>Embedded patch</title>
        <style>html,body{height:100%;margin:0}header{height:48px;display:flex;align-items:center;gap:16px;padding:0 16px}iframe{display:block;width:100%;height:calc(100% - 48px);border:0}</style>
        <script defer src="/~prototype/client.js"></script></head><body><header>
        <button id="sign-in">Sign in to Patchy</button><span id="status">Sign in to use this patch.</span>
        <a href="${escapeAttribute(patch.address)}" target="_blank" rel="noopener">Open in Patchy</a>
        </header></body></html>`,
        {
          headers: {
            "content-type": "text/html",
            "cache-control": "no-store",
            "referrer-policy": "same-origin",
            "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors ${host}`
          }
        }
      );
    }
    // Every protocol write originates on Patchy's origin; the host gets no CORS access.
    if (
      path.startsWith("/~prototype/") &&
      request.method === "POST" &&
      request.headers.get("origin") !== origin
    )
      return failure("Use the Patchy frame");
    if (path === "/~prototype/begin" && request.method === "POST") {
      const body = (await request.json()) as { patch: string; host: string; challenge: string };
      const patch = patches.get(body.patch);
      if (!patch || !approved.has(body.host) || !/^[0-9a-f]{64}$/.test(body.challenge))
        return failure("Invalid handoff");
      for (const [id, attempt] of pending) if (attempt.expiresAt <= Date.now()) pending.delete(id);
      if (pending.size >= 100) return failure("Too many attempts", 429);
      const id = crypto.randomUUID();
      pending.set(id, {
        patch,
        host: body.host,
        challenge: body.challenge,
        expiresAt: Date.now() + 180_000
      });
      return Response.json({ id });
    }
    if (path === "/~prototype/claim" && request.method === "POST") {
      const { id, verifier } = (await request.json()) as { id: string; verifier: string };
      const attempt = pending.get(id);
      if (
        !attempt ||
        attempt.expiresAt <= Date.now() ||
        typeof verifier !== "string" ||
        verifier.length > 100 ||
        (await digest(verifier)) !== attempt.challenge
      )
        return failure("Invalid handoff");
      if (attempt.refused) return failure("No patch access");
      if (!attempt.session) return new Response(null, { status: 202 });
      const token = crypto.randomUUID() + crypto.randomUUID();
      sessions.set(await digest(token), attempt.session);
      pending.delete(id);
      return Response.json({ token });
    }
    if (path === "/~prototype/authorize") {
      const id = url.searchParams.get("id") ?? "";
      const attempt = pending.get(id);
      if (!attempt || attempt.expiresAt <= Date.now() || !approved.has(attempt.host))
        return failure("Handoff ended");
      const result = await Effect.runPromise(auth.authenticate(request));
      if (result.status === "handshake") return result.response;
      if (result.status === "signed-out")
        return Response.redirect(auth.signInUrl(`${path}?id=${id}`), 303);
      if (request.method !== "POST")
        return page(`<main class="auth-card"><h1>Continue in the embedded patch?</h1>
        <p>${escapeAttribute(attempt.host)}</p><form method="post"><button class="btn btn-primary">Continue in embed</button></form></main>`);
      const session: Embedded = {
        sid: result.claims.sid,
        sub: result.claims.sub,
        patch: attempt.patch,
        host: attempt.host,
        expiresAt: Date.now() + lifetimeMs,
        cookie: "",
        cookieUntil: 0,
        streams: new Set()
      };
      if (!(await check(session))) {
        attempt.refused = true;
        return page('<main class="auth-card"><h1>This patch is unavailable to you</h1></main>');
      }
      attempt.session = session;
      const response = page(
        '<main class="auth-card"><h1>Return to your host app</h1><p>The original frame is ready.</p></main>'
      );
      response.headers.append(
        "set-cookie",
        "prototype_probe=1; HttpOnly; Secure; SameSite=None; Path=/"
      );
      return response;
    }
    if (path === "/~prototype/sessions") {
      const result = await Effect.runPromise(auth.authenticate(request));
      if (result.status === "handshake") return result.response;
      if (result.status !== "signed-in") return Response.redirect(auth.signInUrl(path), 303);
      const own = [...sessions.entries()].filter(
        ([, session]) => session.sub === result.claims.sub
      );
      if (request.method === "POST") {
        const id = new URLSearchParams(await request.text()).get("id");
        const selected = own.find(([key]) => key === id);
        if (!selected) return failure("Session unavailable");
        end(selected[1], "Embedded session revoked");
      }
      return page(
        `<main class="auth-card"><h1>Your embedded sessions</h1>${own
          .map(
            ([id, session]) =>
              `<section><p>${escapeAttribute(session.host)} · ${escapeAttribute(session.patch.name)} · ${session.ended ?? "Active"}</p>
                ${session.ended ? "" : `<form method="post"><input type="hidden" name="id" value="${id}"><button class="btn">End session</button></form>`}</section>`
          )
          .join("")}</main>`
      );
    }
    let token = request.headers.get("x-prototype-session");
    const contentPost = path.startsWith("/~content/") && request.method === "POST";
    if (contentPost) token = new URLSearchParams(await request.text()).get("token");
    if (token) {
      const session = sessions.get(await digest(token));
      if (!session || !(await check(session)))
        return failure(session?.ended ?? "Session unavailable");
      if (request.headers.get("cookie")) audit.embeddedCookies++;
      if (path === "/~prototype/end") {
        end(session, "Embedded session ended");
        return Response.json({ ok: true });
      }
      if (path === "/~prototype/status") return Response.json({ expiresAt: session.expiresAt });
      if (path === "/~prototype/shell") {
        const response = await forward(new URL(session.patch.address).pathname, {
          headers: { cookie: session.cookie }
        });
        return new Response(await response.text(), {
          headers: framePolicy(response, session.host, true)
        });
      }
      let body: string | undefined;
      if (contentPost) {
        if (!path.startsWith(`/~content/${session.patch.patchId}/`)) return failure("Wrong patch");
      } else if (path.startsWith("/api/runtime/")) {
        body = request.method === "GET" ? undefined : await request.text();
        const patchId =
          path === "/api/runtime/call" || path === "/api/runtime/subscriptions"
            ? (JSON.parse(body ?? "{}") as { patchId?: string }).patchId
            : path === "/api/runtime/stream"
              ? url.searchParams.get("patchId")
              : path.split("/")[4];
        if (patchId !== session.patch.patchId) return failure("Wrong patch");
        audit.runtimeCalls++;
      } else return failure("Embedded sessions reach only their own patch");
      const headers = new Headers(request.headers);
      headers.delete("x-prototype-session");
      headers.delete("content-length");
      headers.set("cookie", session.cookie);
      headers.set("origin", origin);
      const controller = new AbortController();
      if (path.endsWith("/stream")) session.streams.add(controller);
      const response = await forward(`${path}${url.search}`, {
        method: contentPost ? "GET" : request.method,
        headers,
        body,
        signal: controller.signal
      });
      // Polling the status endpoint rechecks all admission and terminates these streaming reads.
      const outgoing = new Response(response.body, {
        status: response.status,
        headers: framePolicy(response, `'self' ${session.host}`)
      });
      if (!path.endsWith("/stream")) session.streams.delete(controller);
      return outgoing;
    }
    if (path.startsWith("/~prototype/")) return failure("Session required", 401);
    // Ordinary Patchy pages keep their original auth and framing policy. Only a public patch's
    // current address/content is made frameable, as identified by its public cache policy.
    const headers = new Headers(request.headers);
    headers.delete("host");
    const response = await forward(`${path}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
    });
    if (response.headers.get("cache-control")?.startsWith("public, max-age=60"))
      return new Response(response.body, {
        status: response.status,
        headers: framePolicy(response, "*")
      });
    return response;
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        chunks.push(Buffer.from(chunk));
        if (chunks.reduce((size, value) => size + value.length, 0) > 1_048_576) {
          outgoing.writeHead(413).end();
          return;
        }
      }
      const request = new Request(new URL(incoming.url ?? "/", origin), {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {})
      });
      const response = await handle(request);
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      outgoing.writeHead(response.status, {
        ...Object.fromEntries(headers),
        "set-cookie": response.headers.getSetCookie(),
        "x-content-type-options": "nosniff"
      });
      if (response.body) {
        const reader = response.body.getReader();
        outgoing.on("close", () => {
          void reader.cancel().catch(() => {});
        });
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          outgoing.write(value);
        }
      }
      outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(503, { "content-type": "text/plain" });
      outgoing.end("Prototype service unavailable");
    }
  });
  origin = `http://127.0.0.1:${await listen(server)}`;
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      for (const session of sessions.values()) {
        if (session.ended) continue;
        try {
          await check(session);
        } catch {
          end(session, "Admission check unavailable");
        }
      }
    } finally {
      checking = false;
    }
  }, 1000);
  return {
    origin,
    audit,
    approved,
    sessions,
    setLifetime(ms: number) {
      lifetimeMs = ms;
    },
    configure(input: {
      upstream: string;
      auth: typeof auth;
      clerk: typeof clerk;
      patches: Published[];
    }) {
      upstream = input.upstream;
      auth = input.auth;
      clerk = input.clerk;
      for (const patch of input.patches) patches.set(patch.patchId, patch);
    },
    revokeAll() {
      for (const session of sessions.values()) end(session, "Embedded session revoked");
    },
    async close() {
      clearInterval(timer);
      for (const session of sessions.values()) end(session, "Prototype stopped");
      await closeServer(server);
    }
  };
}
