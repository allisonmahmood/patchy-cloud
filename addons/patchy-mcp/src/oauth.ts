import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, urlencoded, type Request, type Response } from "express";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { CloudApiError, cloudRequest, type PatchyRequest } from "./api.js";
import { openOAuthState } from "./oauth-state.js";

const scope = "patchy:tools";
const writeScope = "patchy:write";
const scopes = [scope, writeScope];
const random = () => randomBytes(32).toString("base64url");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const text = z.string().min(1);
const identitySchema = z.object({
  user: z.object({ id: text }),
  company: z.object({ id: text }),
  machine: z.object({ id: text }),
});
type Identity = z.infer<typeof identitySchema>;
type Client = {
  id: string;
  name: string;
  redirects: string[];
  method: string;
  secretHash?: string;
};
type Grant = {
  clientId: string;
  cloudToken: string;
  identity: Identity;
  instanceUrl: string;
  expiresAt: number;
  credentialExpiresAt: number;
  scopes: string[];
  refreshHash: string;
  spentRefreshHashes: string[];
};
type Access = { grantId: string; expiresAt: number };
type Login = {
  client: Client;
  redirect: string;
  state?: string;
  challenge: string;
  csrf: string;
  cookie: string;
  expiresAt: number;
  busy: boolean;
  device?: {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    interval: number;
  };
  nextPoll: number;
  scopes: string[];
  direct?: boolean;
};
type Code = Omit<Grant, "refreshHash" | "spentRefreshHashes"> & {
  redirect: string;
  challenge: string;
};
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const bad = (code: string, message: string): never => {
  throw new OAuthError(code, message);
};
const invalidToken = () =>
  new OAuthError(
    OAuthErrorCode.InvalidToken,
    "Reconnect to Patchy and sign in again.",
  );

/** Local OAuth bridge. Cloud remains the identity and revocation authority. */
export function createOAuth(
  origin: string,
  instanceUrl: string,
  stateDir?: string,
) {
  const resource = new URL("/mcp", origin);
  const clients = new Map<string, Client>();
  const logins = new Map<string, Login>();
  const codes = new Map<string, Code>();
  const grants = new Map<string, Grant>();
  const accesses = new Map<string, Access>();
  const storage = openOAuthState(stateDir);
  try {
    const saved = storage.read();
    if (saved !== undefined) {
      const clientSchema = z.object({
        id: text,
        name: text,
        redirects: z.array(text),
        method: z.enum(["none", "client_secret_post", "client_secret_basic"]),
        secretHash: text.optional(),
      });
      const grantSchema = z.object({
        clientId: text,
        cloudToken: text,
        identity: identitySchema,
        instanceUrl: text,
        expiresAt: z.number(),
        credentialExpiresAt: z.number(),
        scopes: z.array(z.enum([scope, writeScope])).min(1),
        refreshHash: text,
        spentRefreshHashes: z.array(text),
      });
      const state = z
        .object({
          format: z.literal(1),
          origin: z.literal(origin),
          instanceUrl: z.literal(instanceUrl),
          clients: z.array(z.tuple([text, clientSchema])),
          grants: z.array(z.tuple([text, grantSchema])),
          accesses: z.array(
            z.tuple([text, z.object({ grantId: text, expiresAt: z.number() })]),
          ),
        })
        .parse(saved);
      for (const [key, value] of state.clients) clients.set(key, value);
      for (const [key, value] of state.grants) grants.set(key, value);
      for (const [key, value] of state.accesses) accesses.set(key, value);
    }
  } catch {
    storage.close();
    throw new Error(
      "Cannot load OAuth state: invalid format, origin or Cloud URL. Use the original listener URL and state directory; do not overwrite it.",
    );
  }
  function persist() {
    storage.save({
      format: 1,
      origin,
      instanceUrl,
      clients: [...clients],
      grants: [...grants],
      accesses: [...accesses],
    });
  }
  function scopeList(value: unknown, fallback: string[] = [scope]): string[] {
    if (value === undefined) return [...fallback];
    const list = [...new Set(parameter(value).split(" "))];
    if (!list.includes(scope) || list.some((s) => !scopes.includes(s)))
      return bad(
        "invalid_scope",
        "Use patchy:tools for reads, optionally with patchy:write.",
      );
    return list;
  }
  function accessGrant(token: string) {
    storage.check();
    const access = accesses.get(hash(token));
    const grant = access && grants.get(access.grantId);
    if (
      !access ||
      access.expiresAt <= Date.now() ||
      !grant ||
      grant.expiresAt <= Date.now() ||
      grant.credentialExpiresAt <= Date.now() ||
      grant.instanceUrl !== instanceUrl
    )
      throw invalidToken();
    return { access, grant };
  }
  async function identityFor(grant: Grant) {
    let identity: Identity;
    try {
      identity = identitySchema.parse(
        await cloudRequest(instanceUrl, grant.cloudToken, "/api/me"),
      );
    } catch (error) {
      if (
        error instanceof CloudApiError &&
        (error.status === undefined ||
          error.status >= 500 ||
          error.status === 429)
      )
        throw new OAuthError(
          "temporarily_unavailable",
          "Patchy is temporarily unavailable. Retry when the local Cloud is running.",
        );
      throw invalidToken();
    }
    if (
      identity.user.id !== grant.identity.user.id ||
      identity.company.id !== grant.identity.company.id ||
      identity.machine.id !== grant.identity.machine.id
    )
      throw invalidToken();
    return identity;
  }
  function dropGrant(id: string) {
    grants.delete(id);
    for (const [key, access] of accesses)
      if (access.grantId === id) accesses.delete(key);
  }
  function issue(grantId: string, grant: Grant) {
    const token = random(),
      refresh = random();
    const expiresAt = Math.min(Date.now() + 3_600_000, grant.expiresAt);
    grant.refreshHash = hash(refresh);
    accesses.set(hash(token), { grantId, expiresAt });
    persist();
    return {
      access_token: token,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
      scope: grant.scopes.join(" "),
    };
  }
  const router = Router();
  const metadata = {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: scopes,
    authorization_response_iss_parameter_supported: true,
  };
  router.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      // Keep same-origin form POSTs' Origin intact for the SDK's loopback guard.
      // Cross-origin destinations still receive no referrer.
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    storage.check();
    for (const store of [logins, codes])
      for (const [key, value] of store)
        if (value.expiresAt <= Date.now()) store.delete(key);
    // Retain expired access hashes for revocation until the finite family expires.
    for (const [id, grant] of grants)
      if (grant.expiresAt <= Date.now()) {
        dropGrant(id);
        persist();
      }
    next();
  });
  router.use(urlencoded({ extended: false, limit: "16kb" }));

  function capacity(store: Map<string, unknown>) {
    if (store.size >= 1000)
      bad(
        "temporarily_unavailable",
        "Too many active authorizations. Try later.",
      );
  }
  function parameter(value: unknown): string {
    if (typeof value !== "string" || value.length > 8192)
      return bad("invalid_request", "Missing or repeated OAuth parameter.");
    return value;
  }
  function target(value: unknown) {
    // RFC 8707 permits repeated resource indicators. Accept only this one
    // audience, even when a client repeats it via discovery and configuration.
    const values = Array.isArray(value) ? value : [value];
    if (!values.length || values.some((v) => parameter(v) !== resource.href))
      bad("invalid_target", "The resource must be this MCP endpoint.");
  }
  function clientAuth(req: Request): Client {
    let id = req.body?.client_id,
      secret = req.body?.client_secret,
      method = secret ? "client_secret_post" : "none";
    if (req.headers.authorization) {
      if (!req.headers.authorization.startsWith("Basic "))
        return bad("invalid_client", "Unsupported client authentication.");
      const decoded = Buffer.from(
        req.headers.authorization.slice(6),
        "base64",
      ).toString();
      const colon = decoded.indexOf(":");
      if (colon < 0 || secret !== undefined)
        return bad("invalid_client", "Invalid client authentication.");
      let basicId: string;
      try {
        basicId = decodeURIComponent(decoded.slice(0, colon));
        secret = decodeURIComponent(decoded.slice(colon + 1));
      } catch {
        return bad("invalid_client", "Invalid client authentication.");
      }
      if (id !== undefined && id !== basicId)
        return bad("invalid_client", "Invalid client authentication.");
      id = basicId;
      method = "client_secret_basic";
    }
    const client = typeof id === "string" ? clients.get(id) : undefined;
    if (
      !client ||
      client.method !== method ||
      (client.secretHash &&
        (typeof secret !== "string" || !equal(hash(secret), client.secretHash)))
    )
      return bad("invalid_client", "Invalid client authentication.");
    return client;
  }
  function redirect(
    res: Response,
    login: Pick<Login, "redirect" | "state">,
    params: Record<string, string>,
  ) {
    const url = new URL(login.redirect);
    for (const [key, value] of Object.entries({
      ...params,
      iss: origin,
      ...(login.state === undefined ? {} : { state: login.state }),
    }))
      url.searchParams.set(key, value);
    res.redirect(302, url.href);
  }
  function page(
    res: Response,
    body: string,
    refresh?: string,
    callback?: string,
  ) {
    res.set(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self' ${new URL(instanceUrl).origin} ${callback ? new URL(callback).origin : ""}; frame-ancestors 'none'; base-uri 'none'`,
    );
    res
      .type("html")
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect to Patchy</title><script src="/oauth/browser.js" defer></script>${refresh ? `<meta http-equiv="refresh" content="5;url=${escape(refresh)}">` : ""}<style>body{font:18px system-ui;max-width:42rem;margin:10vh auto;padding:1rem;line-height:1.6}button{font:inherit;padding:.5rem 1rem}code{overflow-wrap:anywhere}</style><main><h1>Connect to Patchy</h1>${body}</main></html>`,
      );
  }
  function loginRequest(req: Request, csrf = false) {
    const id = parameter(req.params.id),
      login = logins.get(id);
    const cookie = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`patchy_${id}=`))
      ?.slice(`patchy_${id}=`.length);
    if (
      !login ||
      !cookie ||
      !equal(cookie, login.cookie) ||
      (csrf && !equal(parameter(req.body?.csrf), login.csrf))
    )
      return bad(
        "access_denied",
        "This browser sign-in expired or is invalid. Start again from your MCP client.",
      );
    return { id, login, path: `/oauth/login/${id}` };
  }
  const consent = (login: Login, path: string) =>
    `<p><strong>${escape(login.client.name)}</strong> wants to connect to Patchy.</p><p>Instance: <code>${escape(instanceUrl)}</code>. Sign in as yourself and approve a dedicated connection.</p><form data-connect data-poll="${path}?wait=1" method="post" action="${path}/start" rel="noopener"><input type="hidden" name="csrf" value="${login.csrf}"><fieldset><legend>Connection permission</legend><label><input type="radio" name="permission" value="read-only" checked> Read only — view Pages and run queries</label>${login.scopes.includes(writeScope) ? '<br><label><input type="radio" name="permission" value="read-write"> Read and write — also add, update and delete through declared Tool mutations</label>' : ""}</fieldset><p>Patchy still applies your existing access rules. Changing permission requires a new connection.</p><button>Sign in to Patchy</button></form><form method="post" action="${path}/cancel"><input type="hidden" name="csrf" value="${login.csrf}"><button>Cancel</button></form>`;

  // The user gesture opens Cloud directly; the original tab completes OAuth.
  // Without JavaScript, retain the link-based device flow as a fallback.
  router.get("/browser.js", (_req, res) => {
    res.type("application/javascript").send(`
const form = document.querySelector('form[data-connect]');
if (form) form.addEventListener('submit', () => {
  form.target = '_blank';
  const direct = document.createElement('input');
  direct.type = 'hidden'; direct.name = 'browserFlow'; direct.value = 'direct';
  form.append(direct);
  setTimeout(() => window.location.replace(form.dataset.poll), 0);
});
`);
  });

  router.post("/register", (req, res) => {
    capacity(clients);
    const parsed = z
      .object({
        redirect_uris: z.array(z.string().url()).min(1).max(10),
        client_name: z.string().min(1).max(120).default("MCP client"),
        token_endpoint_auth_method: z
          .enum(["none", "client_secret_post", "client_secret_basic"])
          .default("client_secret_basic"),
        // Both code and rotating refresh grants are supported.
        grant_types: z
          .array(z.enum(["authorization_code", "refresh_token"]))
          .max(2)
          .refine((grants) => grants.includes("authorization_code"))
          .optional(),
        response_types: z.array(z.literal("code")).max(1).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return bad(
        "invalid_client_metadata",
        "Register authorization_code, code, and valid redirect_uris.",
      );
    const data = parsed.data;
    for (const raw of data.redirect_uris) {
      const url = new URL(raw);
      if (
        url.username ||
        url.password ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        )
      )
        return bad(
          "invalid_redirect_uri",
          "Redirects require HTTPS or loopback HTTP, without credentials or fragments.",
        );
    }
    const id = random(),
      secret =
        data.token_endpoint_auth_method === "none" ? undefined : random();
    clients.set(id, {
      id,
      name: data.client_name,
      redirects: data.redirect_uris,
      method: data.token_endpoint_auth_method,
      secretHash: secret && hash(secret),
    });
    persist();
    res.status(201).json({
      ...data,
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });
  router.get("/authorize", (req, res) => {
    const client = clients.get(parameter(req.query.client_id));
    const uri = parameter(req.query.redirect_uri);
    // Never redirect until the client and its exact redirect have been validated.
    if (!client || !client.redirects.includes(uri))
      return bad("invalid_request", "Unknown client or redirect URI.");
    const callback = {
      redirect: uri,
      state:
        req.query.state === undefined ? undefined : parameter(req.query.state),
    };
    try {
      if (req.query.response_type !== "code")
        return bad("unsupported_response_type", "Only code is supported.");
      target(req.query.resource);
      const requestedScopes = scopeList(req.query.scope);
      const challenge = parameter(req.query.code_challenge);
      if (
        req.query.code_challenge_method !== "S256" ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      )
        return bad("invalid_request", "PKCE S256 is required.");
      capacity(logins);
      const id = random(),
        path = `/oauth/login/${id}`;
      const login: Login = {
        client,
        scopes: requestedScopes,
        redirect: uri,
        state: callback.state,
        challenge,
        csrf: random(),
        cookie: random(),
        expiresAt: Date.now() + 600_000,
        nextPoll: 0,
        busy: false,
      };
      logins.set(id, login);
      res.cookie(`patchy_${id}`, login.cookie, {
        httpOnly: true,
        secure: origin.startsWith("https:"),
        sameSite: "lax",
        path,
        maxAge: 600_000,
      });
      page(res, consent(login, path), undefined, login.redirect);
    } catch (error) {
      if (error instanceof OAuthError)
        return redirect(res, callback, {
          error: error.code,
          error_description: error.message,
        });
      throw error;
    }
  });
  router.post("/login/:id/start", async (req, res) => {
    const { login, path } = loginRequest(req, true);
    if (login.busy || login.device) return res.redirect(303, path);
    const permission = req.body?.permission ?? "read-only";
    if (
      !["read-only", "read-write"].includes(permission) ||
      (permission === "read-write" && !login.scopes.includes(writeScope))
    )
      return bad(
        "invalid_scope",
        "Read and write was not requested by this client.",
      );
    login.scopes = permission === "read-write" ? [scope, writeScope] : [scope];
    login.direct = req.body?.browserFlow === "direct";
    login.busy = true;
    try {
      const response = await fetch(`${instanceUrl}/api/login/device`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          machineNameHint: `MCP: ${login.client.name}`.slice(0, 64),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const device = z
        .object({
          deviceCode: text,
          userCode: text,
          verificationUrl: z.string().url(),
          interval: z.number().positive(),
          expiresAt: z.string().datetime(),
        })
        .parse(await response.json());
      if (
        !response.ok ||
        new URL(device.verificationUrl).origin !== new URL(instanceUrl).origin
      )
        throw new Error();
      login.device = device;
      login.expiresAt = Math.min(login.expiresAt, Date.parse(device.expiresAt));
      login.nextPoll = Date.now() + device.interval * 1000;
      res.redirect(303, login.direct ? device.verificationUrl : path);
    } catch {
      bad(
        "temporarily_unavailable",
        "Patchy sign-in is unavailable. Start again from your MCP client.",
      );
    } finally {
      login.busy = false;
    }
  });
  router.post("/login/:id/cancel", (req, res) => {
    const { id, login } = loginRequest(req, true);
    logins.delete(id);
    redirect(res, login, { error: "access_denied" });
  });
  router.get("/login/:id", async (req, res) => {
    const { id, login, path } = loginRequest(req);
    const device = login.device;
    if (!device) {
      if (req.query.wait === "1" || login.busy)
        return page(
          res,
          "<p>Opening Patchy sign-in… Keep this tab open; it will connect automatically after you approve.</p>",
          `${path}?wait=1`,
          login.redirect,
        );
      return page(res, consent(login, path), undefined, login.redirect);
    }
    if (!login.busy && Date.now() >= login.nextPoll) {
      login.busy = true;
      login.nextPoll = Date.now() + device.interval * 1000;
      try {
        const response = await fetch(`${instanceUrl}/api/login/device/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: device.deviceCode }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 410) {
          logins.delete(id);
          return redirect(res, login, { error: "access_denied" });
        }
        if (!response.ok) throw new Error();
        const result = z
          .discriminatedUnion("status", [
            z.object({ status: z.enum(["pending", "slow_down"]) }),
            z.object({
              status: z.literal("complete"),
              token: text,
              expiresAt: z.string().datetime(),
            }),
          ])
          .parse(await response.json());
        if (result.status === "slow_down") login.nextPoll += 5000;
        if (result.status === "complete") {
          const identity = identitySchema.parse(
            await cloudRequest(instanceUrl, result.token, "/api/me"),
          );
          if (Date.parse(result.expiresAt) <= Date.now()) throw new Error();
          capacity(codes);
          const code = random();
          codes.set(hash(code), {
            clientId: login.client.id,
            scopes: login.scopes,
            cloudToken: result.token,
            identity,
            instanceUrl,
            credentialExpiresAt: Date.parse(result.expiresAt),
            redirect: login.redirect,
            challenge: login.challenge,
            expiresAt: Math.min(
              Date.now() + 60_000,
              Date.parse(result.expiresAt),
            ),
          });
          logins.delete(id);
          res.clearCookie(`patchy_${id}`, { path });
          return redirect(res, login, { code });
        }
      } catch {
        logins.delete(id);
        return redirect(res, login, { error: "temporarily_unavailable" });
      } finally {
        login.busy = false;
      }
    }
    page(
      res,
      `${login.direct ? `<p>Finish signing in and approve this connection in the Patchy tab that opened.</p><p>Keep this tab open. Your client will connect automatically—no code to copy.</p><p><a href="${escape(device.verificationUrl)}" target="_blank" rel="noopener noreferrer">Reopen Patchy sign-in</a></p>` : `<p>Open Patchy to sign in and confirm code <strong>${escape(device.userCode)}</strong>.</p><p><a href="${escape(device.verificationUrl)}" target="_blank" rel="noopener noreferrer">Sign in to ${escape(instanceUrl)}</a></p><p>This page checks for approval every five seconds. Return here after confirming.</p>`}<form method="post" action="${path}/cancel"><input type="hidden" name="csrf" value="${login.csrf}"><button>Cancel</button></form>`,
      path,
      login.redirect,
    );
  });
  router.post("/token", async (req, res) => {
    const client = clientAuth(req);
    target(req.body.resource);
    if (req.body?.grant_type === "refresh_token") {
      const refreshHash = hash(parameter(req.body.refresh_token));
      const found = [...grants].find(
        ([, g]) =>
          g.clientId === client.id &&
          (g.refreshHash === refreshHash ||
            g.spentRefreshHashes.includes(refreshHash)),
      );
      if (!found)
        return bad(
          "invalid_grant",
          "Invalid or expired refresh token. Reconnect and sign in.",
        );
      const [id, grant] = found;
      if (
        grant.refreshHash !== refreshHash ||
        grant.expiresAt <= Date.now() ||
        grant.credentialExpiresAt <= Date.now()
      ) {
        dropGrant(id);
        persist();
        return bad(
          "invalid_grant",
          "Refresh token expired or reused. This connection was revoked; sign in again.",
        );
      }
      const requested = scopeList(req.body.scope, grant.scopes);
      if (requested.some((s) => !grant.scopes.includes(s)))
        return bad(
          "invalid_scope",
          "Refresh cannot increase connection permission.",
        );
      // Consume synchronously before identity I/O. A concurrent replay revokes the family.
      grant.spentRefreshHashes.push(refreshHash);
      grant.refreshHash = "consumed";
      persist();
      try {
        await identityFor(grant);
      } catch (error) {
        if (
          error instanceof OAuthError &&
          error.code === "temporarily_unavailable" &&
          grants.get(id) === grant
        ) {
          // No tokens were issued: preserve this refresh token through a Cloud outage.
          grant.spentRefreshHashes.pop();
          grant.refreshHash = refreshHash;
          persist();
          throw error;
        }
        dropGrant(id);
        persist();
        return bad(
          "invalid_grant",
          "Patchy login expired, was revoked or changed identity. Sign in again.",
        );
      }
      if (grants.get(id) !== grant)
        return bad("invalid_grant", "Connection was revoked.");
      grant.scopes = requested;
      res.json(issue(id, grant));
      return;
    }
    if (req.body?.grant_type !== "authorization_code")
      return bad(
        "unsupported_grant_type",
        "Use authorization_code or refresh_token.",
      );
    const key = hash(parameter(req.body.code)),
      code = codes.get(key);
    if (
      !code ||
      code.clientId !== client.id ||
      code.instanceUrl !== instanceUrl ||
      code.redirect !== req.body.redirect_uri
    )
      return bad("invalid_grant", "Invalid or expired authorization code.");
    const verifier = parameter(req.body.code_verifier);
    if (
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      !equal(
        createHash("sha256").update(verifier).digest("base64url"),
        code.challenge,
      )
    )
      return bad("invalid_grant", "Invalid PKCE verifier.");
    codes.delete(key);
    capacity(grants);
    const id = random();
    const grant: Grant = {
      ...code,
      expiresAt: Math.min(
        Date.now() + 30 * 86_400_000,
        code.credentialExpiresAt,
      ),
      refreshHash: "",
      spentRefreshHashes: [],
    };
    if (grant.expiresAt <= Date.now())
      return bad("invalid_grant", "Patchy login expired. Sign in again.");
    grants.set(id, grant);
    res.json(issue(id, grant));
  });
  router.post("/revoke", async (req, res) => {
    const client = clientAuth(req);
    const key = hash(parameter(req.body.token));
    const access = accesses.get(key);
    const found = access
      ? ([access.grantId, grants.get(access.grantId)] as const)
      : [...grants].find(
          ([, g]) =>
            g.refreshHash === key || g.spentRefreshHashes.includes(key),
        );
    if (found && found[1]?.clientId === client.id) {
      const [id, grant] = found;
      dropGrant(id);
      persist();
      await cloudRequest(
        instanceUrl,
        grant.cloudToken,
        "/api/logout",
        {},
      ).catch(() => undefined);
    }
    res.status(200).end();
  });
  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token): Promise<AuthInfo> {
      const { grant, access } = accessGrant(token);
      const identity = await identityFor(grant);
      // Re-check after I/O in case the family was revoked concurrently.
      accessGrant(token);
      return {
        token,
        clientId: grant.clientId,
        scopes: grant.scopes,
        expiresAt: Math.floor(access.expiresAt / 1000),
        resource,
        extra: {
          userId: identity.user.id,
          companyId: identity.company.id,
          instanceUrl,
        },
      };
    },
  };
  function requestFor(auth?: AuthInfo, mutation = false): PatchyRequest {
    if (!auth) throw invalidToken();
    accessGrant(auth.token);
    // Re-check each call; a read-only connection must never POST a mutation.
    return (path, payload) => {
      const { grant } = accessGrant(auth.token);
      if (
        (mutation || (payload !== undefined && !path.endsWith("/query"))) &&
        !grant.scopes.includes(writeScope)
      )
        throw new CloudApiError(
          "This connection is read only. Reconnect and approve Read and write before changing data.",
          "insufficient_scope",
          403,
        );
      return cloudRequest(grant.instanceUrl, grant.cloudToken, path, payload);
    };
  }
  return {
    router,
    metadata,
    verifier,
    resource,
    scope,
    scopes,
    requestFor,
    close: storage.close,
  };
}
