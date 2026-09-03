/**
 * PROTOTYPE for #119 — throwaway, delete with the branch. The login door:
 * route-scoped middleware in front of `/d/*` (and the two door-only routes)
 * that asks `ClerkSession` what the request is, copies Clerk's headers onto
 * the answer, and either redirects for the handshake, shows the door page,
 * refuses an outsider, or lets the patch through with one user-row read.
 * Behind `PROTOTYPE_R2_6` it also answers the third wrong-person state: a
 * signed-in person from another company gets the missing-patch 404.
 * The door's own pages (door, outsider, device confirm, not-configured) and
 * the sign-out route live here too. Every doored request logs one `[door]`
 * line; that log is most of what the prototype is for.
 */
// @effect-diagnostics globalConsole:off -- prototype instrumentation.
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as UrlParams from "effect/unstable/http/UrlParams";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { ClerkSession, DeviceLogins, PrototypeUsers } from "@patchy/auth";
import { PatchesConfig } from "@patchy/patches";
import { escapeAttribute, escapeHtml, htmlPage, renderNotFound } from "./render.js";
import { NO_REFERRER_POLICY, PATCH_ROBOTS_TAG } from "./serving-headers.js";

/** The door's own pages: no script, inline style, forms only to this origin. */
export const DOOR_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'";

const doorHeaders = {
  "content-security-policy": DOOR_CONTENT_SECURITY_POLICY,
  "cache-control": "no-store"
};

/** What the door established, for the handlers behind it. */
export class DoorAuth extends Context.Service<
  DoorAuth,
  {
    readonly verdict: ClerkSession.Verdict;
    readonly user: Option.Option<PrototypeUsers.PrototypeUser>;
  }
>()("@patchy/serving/LoginDoor.prototype/DoorAuth") {}

/** `page`: a signed-out document request sees the door page; `redirect`: it goes straight to the portal. */
const doorMode = Config.string("PROTOTYPE_DOOR_MODE").pipe(
  Config.withDefault("page"),
  Config.map((value): "page" | "redirect" => (value === "redirect" ? "redirect" : "page"))
);

/** `PROTOTYPE_DOOR_SUFFIX_FIX=1`: mirror a refreshed session token across Clerk's cookie families (#119 lane B). */
const suffixFix = Config.string("PROTOTYPE_DOOR_SUFFIX_FIX").pipe(
  Config.withDefault("0"),
  Config.map((value) => value === "1")
);

// --- the company check (#119 lane R2-6 experiment) -----------------------------

/**
 * `PROTOTYPE_R2_6=1`: after the user row, a second read for the patch's
 * company, and a signed-in person from another company gets the same 404 a
 * missing patch gets; `PROTOTYPE_R2_6=fold`: the user row and the patch's
 * company in one read. Off by default: the door then serves any user with a row.
 */
const companyCheck = Config.string("PROTOTYPE_R2_6").pipe(
  Config.withDefault("0"),
  Config.map((value): "off" | "second" | "fold" =>
    value === "1" ? "second" : value === "fold" ? "fold" : "off"
  )
);

/** The patch id a doored path names (`/d/:patchId` or `/d/:patchId/v/:n`), or nothing for the door's own routes. */
const patchIdOf = (path: string) => /^\/d\/([^/]+)(?:\/v\/[^/]+)?$/.exec(path)?.[1];

/** The 404 a patch URL gets from `Pages`, byte for byte, with the door's own caching. */
const patchNotFound = HttpServerResponse.html(renderNotFound()).pipe(
  HttpServerResponse.setStatus(404),
  HttpServerResponse.setHeaders({
    "x-robots-tag": PATCH_ROBOTS_TAG,
    "referrer-policy": NO_REFERRER_POLICY,
    "cache-control": "private, no-store"
  })
);

// --- copying Clerk's headers onto an Effect response --------------------------

/**
 * Clerk's contract: append every header from the state. `Set-Cookie` rides on
 * `response.cookies` (the Node server joins header values with commas), and
 * `Location` is the caller's to turn into a redirect.
 */
const withClerkHeaders = (
  response: HttpServerResponse.HttpServerResponse,
  headers: Headers
): HttpServerResponse.HttpServerResponse => {
  const plain: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name !== "set-cookie" && name !== "location") plain[name] = value;
  });
  const setCookies = headers.getSetCookie();
  const withPlain = HttpServerResponse.setHeaders(response, plain);
  return setCookies.length === 0
    ? withPlain
    : HttpServerResponse.mergeCookies(withPlain, Cookies.fromSetCookie(setCookies));
};

const redirect307 = (location: string, headers: Headers) =>
  withClerkHeaders(
    HttpServerResponse.redirect(location, {
      status: 307,
      headers: { "cache-control": "no-store" }
    }),
    headers
  );

// --- the suffix mismatch (#119 lane B experiment) ------------------------------

/**
 * The handshake establishes the unsuffixed `__client_uat` / `__session` pair,
 * but the SDK's refresh sets only `__session_<suffix>`, and its
 * `usesSuffixedCookies()` stays false while there is no suffixed
 * `__client_uat`, so the refreshed token is never read and every later load
 * refreshes again. When a refresh directive is present, mirror the token into
 * `__session` with the same attributes, so the SDK keeps reading the family
 * the handshake chose. (Mirroring `__client_uat` into its suffixed name
 * instead flips the SDK to the suffixed family wholesale; on a development
 * instance it then wants `__clerk_db_jwt_<suffix>` too and signs the person
 * out on the next load. Measured on #119.)
 */
const mirrorRefreshedSession = (headers: Headers, suffix: string): void => {
  const refreshed = headers.getSetCookie().find((d) => d.startsWith(`__session_${suffix}=`));
  if (refreshed !== undefined) {
    headers.append("set-cookie", refreshed.replace(`__session_${suffix}=`, "__session="));
  }
};

// --- logging -----------------------------------------------------------------

/** A URL as host + path with the query's parameter names only. */
const describeUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    const keys = [...url.searchParams.keys()];
    return `${url.host}${url.pathname}${keys.length === 0 ? "" : `?[${keys.join(",")}]`}`;
  } catch {
    return raw;
  }
};

/** A Set-Cookie directive with its value replaced by `<len N>`, attributes verbatim. */
export const redactSetCookie = (directive: string): string => {
  const [pair, ...attributes] = directive.split(";");
  const equals = (pair ?? "").indexOf("=");
  if (equals === -1) return directive;
  const name = (pair ?? "").slice(0, equals);
  const value = (pair ?? "").slice(equals + 1);
  return [`${name}=<len ${value.length}>`, ...attributes.map((a) => a.trim())].join("; ");
};

const report = (
  request: HttpServerRequest.HttpServerRequest,
  verdict: ClerkSession.Verdict,
  dbMs: number | "-",
  extra = ""
): void => {
  const { outcome } = verdict;
  const reason =
    outcome._tag === "signed-in" || outcome._tag === "not-configured" ? "-" : outcome.reason;
  const claims = outcome._tag === "signed-in" ? outcome.claims : {};
  const azp = typeof claims["azp"] === "string" ? claims["azp"] : "-";
  const expIat =
    typeof claims["exp"] === "number" && typeof claims["iat"] === "number"
      ? String(claims["exp"] - claims["iat"])
      : "-";
  const path = request.originalUrl.split("?")[0] ?? request.originalUrl;
  console.log(
    `[door] ${request.method} ${path} status=${outcome._tag} reason=${reason} ` +
      `authMs=${verdict.authMs} dbMs=${typeof dbMs === "number" ? dbMs.toFixed(1) : dbMs} net=${verdict.netCalls} azp=${azp} exp-iat=${expIat}${extra}`
  );
  if (outcome._tag === "handshake") {
    console.log(`[door]   -> 307 ${describeUrl(outcome.location)}`);
  }
  if (outcome._tag !== "not-configured") {
    const location = outcome.headers.get("location");
    if (location !== null && outcome._tag !== "handshake") {
      console.log(`[door]   -> 307 (state carried location) ${describeUrl(location)}`);
    }
    for (const directive of outcome.headers.getSetCookie()) {
      console.log(`[door]   set-cookie ${redactSetCookie(directive)}`);
    }
  }
};

// --- pages -------------------------------------------------------------------

const signOutForm = (next: string, label = "Sign out") => `
  <form method="post" action="/sign-out" style="margin-top:1.5rem">
    <input type="hidden" name="next" value="${escapeAttribute(next)}">
    <button type="submit" style="font:inherit;font-weight:750;padding:.5em 1em;border:2px solid var(--ink);border-radius:8px;background:var(--white);box-shadow:3px 3px 0 var(--ink);cursor:pointer">${escapeHtml(label)}</button>
  </form>`;

const doorPage = (signInUrl: string, reason: string) =>
  HttpServerResponse.html(
    htmlPage({
      title: "Sign in to view this patch",
      body: `
      <main class="wrap compact">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</span>
            <span class="kicker">Shared inside a company</span>
          </div>
          <h1>Sign in to view this patch.</h1>
          <p class="lede">This patch is shared inside a company. Sign in with your work account and you will be sent straight back here.</p>
          <p><a href="${escapeAttribute(signInUrl)}">Sign in</a></p>
          <p class="foot">prototype: signed-out reason <code>${escapeHtml(reason)}</code></p>
        </header>
      </main>`
    })
  ).pipe(HttpServerResponse.setStatus(401), HttpServerResponse.setHeaders(doorHeaders));

const outsiderPage = (email: string, next: string) =>
  HttpServerResponse.html(
    htmlPage({
      title: "Not in a company",
      body: `
      <main class="wrap compact">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</span>
            <span class="kicker">No company</span>
          </div>
          <h1>You are not in a company.</h1>
          <p class="lede">You are signed in as <code>${escapeHtml(email)}</code>, but that account is not in any company yet. The product's answer to this state is create or join a company, which this prototype does not build.</p>
          ${signOutForm(next)}
        </header>
      </main>`
    })
  ).pipe(HttpServerResponse.setStatus(403), HttpServerResponse.setHeaders(doorHeaders));

const notConfiguredPage = (missing: ReadonlyArray<string>) =>
  HttpServerResponse.html(
    htmlPage({
      title: "Login door not configured",
      body: `
      <main class="wrap compact">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</span>
            <span class="kicker">Door closed</span>
          </div>
          <h1>The login door is not configured.</h1>
          <p class="lede">This instance cannot verify who you are, so it serves nothing. Set <code>${missing.map(escapeHtml).join("</code> and <code>")}</code> in the server's environment.</p>
        </header>
      </main>`
    })
  ).pipe(HttpServerResponse.setStatus(503), HttpServerResponse.setHeaders(doorHeaders));

// --- the confirm page (PROTOTYPE for #131) ------------------------------------

/**
 * Three copy variants of the confirm page on the real route, switchable with
 * `?v=a|b|c` (the prototype skill's UI shape): A leads with the code, B with
 * the machine and the person, C with a checklist. A floating bar at the
 * bottom flips between them; it is links, since the door's CSP allows no
 * script. `/prototype/login/device` renders the same page with sample data
 * and no door in front, for looking without logging in.
 */
export type Variant = "a" | "b" | "c";
const VARIANTS: ReadonlyArray<{ key: Variant; name: string }> = [
  { key: "a", name: "Code first" },
  { key: "b", name: "Machine first" },
  { key: "c", name: "Checklist" }
];
export const variantOf = (raw: unknown): Variant => (raw === "b" || raw === "c" ? raw : "a");

export interface ConfirmData {
  readonly code: string;
  readonly company: string;
  readonly email: string;
  readonly name: string | null;
  /** What the name field starts with: the old token's name on a re-login, else the CLI's hostname. */
  readonly machineName: string;
  /** Set on a re-login: the name the previous key had, which confirm revokes. */
  readonly replaces: string | null;
  readonly expiresInMinutes: number;
  readonly error: string | null;
  /** Set when the person was bounced back here by #122 item 9: their session had gone stale under the form. */
  readonly notice: string | null;
  readonly next: string;
  readonly mock: boolean;
}

const button = (label: string, value: "confirm" | "deny", primary: boolean) =>
  `<button type="submit" name="action" value="${value}" style="font:inherit;font-weight:750;padding:.55em 1.1em;border:2px solid var(--ink);border-radius:8px;background:${primary ? "var(--green)" : "var(--white)"};box-shadow:3px 3px 0 var(--ink);cursor:pointer;margin-right:.6rem">${escapeHtml(label)}</button>`;

const nameField = (data: ConfirmData, label: string) => `
  <label style="display:block;margin:1.2rem 0">
    <span style="display:block;font-weight:750;color:var(--ink);margin-bottom:.3rem">${escapeHtml(label)}</span>
    <input name="machine" value="${escapeAttribute(data.machineName)}" required minlength="1" maxlength="64" autocomplete="off" style="font:inherit;padding:.5em .7em;border:2px solid var(--ink);border-radius:8px;min-width:min(22rem,100%);background:var(--white)">
    ${data.replaces === null ? "" : `<span style="display:block;color:var(--muted);font-size:.92rem;margin-top:.3rem">Replaces the key named <code>${escapeHtml(data.replaces)}</code>, which stops working when you confirm.</span>`}
  </label>`;

const errorLine = (data: ConfirmData) =>
  (data.notice === null
    ? ""
    : `<p style="color:var(--blue-dark);font-weight:750;border:2px solid var(--blue);border-radius:8px;padding:.5em .8em;background:var(--paper-blue)">${escapeHtml(data.notice)}</p>`) +
  (data.error === null
    ? ""
    : `<p style="color:var(--amber-ink);font-weight:750;border:2px solid var(--yellow);border-radius:8px;padding:.5em .8em;background:var(--paper-amber)">${escapeHtml(data.error)}</p>`);

const bigCode = (code: string) =>
  `<p style="font-family:var(--font-mono);font-size:3.4rem;font-weight:900;letter-spacing:.12em;color:var(--ink);margin:.2em 0 .6em">${escapeHtml(code)}</p>`;

const formOpen = (data: ConfirmData, variant: Variant) => `
  <form method="post" action="/login/device">
    <input type="hidden" name="code" value="${escapeAttribute(data.code)}">
    <input type="hidden" name="v" value="${variant}">`;

const person = (data: ConfirmData) =>
  data.name
    ? `${escapeHtml(data.name)} (<code>${escapeHtml(data.email)}</code>)`
    : `<code>${escapeHtml(data.email)}</code>`;

/** A: the code is the headline; the person checks it against the terminal, names the machine, confirms. */
const variantA = (data: ConfirmData) => `
  <main class="wrap compact">
    <header class="doc-head">
      <div class="head-line">
        <span class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</span>
        <span class="kicker">Device login</span>
      </div>
      <p class="lede" style="margin-bottom:0">Is this the code on your terminal?</p>
      ${bigCode(data.code)}
      <p class="lede">A terminal just ran <code>patchy login</code> and wants to publish at <strong>${escapeHtml(data.company)}</strong> as ${person(data)}. If the code matches, name the machine and confirm. If you didn't run it, deny: nothing happens.</p>
      ${errorLine(data)}
      ${formOpen(data, "a")}
        ${nameField(data, "Machine name")}
        ${button("Confirm", "confirm", true)}${button("Deny", "deny", false)}
      </form>
      <p class="foot" style="margin-top:1.5rem">The code expires in ${data.expiresInMinutes} minutes. The key it makes works for 90 days, or 30 days unused, and can be revoked any time on <em>Your machines</em>.</p>
    </header>
  </main>`;

/** B: the machine is the headline; the code is one row of a receipt. */
const variantB = (data: ConfirmData) => `
  <main class="wrap compact">
    <header class="doc-head">
      <div class="head-line">
        <span class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</span>
        <span class="kicker">A machine wants in</span>
      </div>
      <h1>Let <span style="font-family:var(--font-mono)">${escapeHtml(data.machineName || "this machine")}</span> publish as you?</h1>
      <p class="lede">Someone ran <code>patchy login</code> on a machine calling itself <strong>${escapeHtml(data.machineName || "(unnamed)")}</strong>. Confirming hands it a key to publish and manage patches at <strong>${escapeHtml(data.company)}</strong> as ${person(data)}, until you revoke it on <em>Your machines</em>.</p>
      <table style="border-collapse:collapse;margin:1rem 0 1.5rem;font-size:1rem">
        <tr><th style="text-align:left;padding:.3em 1.2em .3em 0;color:var(--muted);font-weight:750">Code on the terminal</th><td style="font-family:var(--font-mono);font-weight:900;font-size:1.3rem;letter-spacing:.08em;color:var(--ink)">${escapeHtml(data.code)}</td></tr>
        <tr><th style="text-align:left;padding:.3em 1.2em .3em 0;color:var(--muted);font-weight:750">Company</th><td>${escapeHtml(data.company)}</td></tr>
        <tr><th style="text-align:left;padding:.3em 1.2em .3em 0;color:var(--muted);font-weight:750">Acting as</th><td>${person(data)}</td></tr>
        <tr><th style="text-align:left;padding:.3em 1.2em .3em 0;color:var(--muted);font-weight:750">Offer expires</th><td>in ${data.expiresInMinutes} minutes</td></tr>
      </table>
      ${errorLine(data)}
      ${formOpen(data, "b")}
        ${nameField(data, "Call this machine")}
        ${button("Confirm, that's my machine", "confirm", true)}${button("Not me", "deny", false)}
      </form>
    </header>
  </main>`;

/** C: three checks the person ticks in their head before the one button. */
const variantC = (data: ConfirmData) => `
  <main class="wrap compact">
    <header class="doc-head">
      <div class="head-line">
        <span class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</span>
        <span class="kicker">Check, then confirm</span>
      </div>
      <h1>Is this you?</h1>
      <p class="lede">You're signed in as ${person(data)} at <strong>${escapeHtml(data.company)}</strong>. Confirm only if all three are true.</p>
      ${errorLine(data)}
      ${formOpen(data, "c")}
        <ol style="padding-left:1.4em;margin:1.2rem 0;font-size:1.08rem;color:var(--ink)">
          <li style="margin-bottom:.8rem">You just ran <code>patchy login</code> yourself.</li>
          <li style="margin-bottom:.8rem">Your terminal shows <span style="font-family:var(--font-mono);font-weight:900;font-size:1.25rem;letter-spacing:.08em">${escapeHtml(data.code)}</span>.</li>
          <li>It's on a machine you'd call
            <input name="machine" value="${escapeAttribute(data.machineName)}" required minlength="1" maxlength="64" autocomplete="off" style="font:inherit;padding:.3em .6em;border:2px solid var(--ink);border-radius:8px;min-width:14rem;background:var(--white)">
            ${data.replaces === null ? "" : `<span style="display:block;color:var(--muted);font-size:.92rem;margin-top:.3rem">Replaces the key named <code>${escapeHtml(data.replaces)}</code>, which stops working when you confirm.</span>`}
          </li>
        </ol>
        ${button("All three: log it in", "confirm", true)}${button("No", "deny", false)}
      </form>
      <p class="foot" style="margin-top:1.5rem">If someone else sent you this link, that's the trick this page exists to catch: press No. The code dies in ${data.expiresInMinutes} minutes either way.</p>
    </header>
  </main>`;

const switcher = (current: Variant, data: ConfirmData) => {
  const index = VARIANTS.findIndex((v) => v.key === current);
  const at = (offset: number) => VARIANTS[(index + offset + VARIANTS.length) % VARIANTS.length]!;
  const href = (v: Variant) =>
    data.mock ? `?v=${v}` : `?code=${encodeURIComponent(data.code)}&v=${v}`;
  return `
  <nav aria-label="prototype variants" style="position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:14px;align-items:center;padding:8px 16px;border:2px solid var(--ink);border-radius:999px;background:var(--ink);color:var(--white);font-weight:850;font-size:.9rem;box-shadow:4px 4px 0 var(--yellow)">
    <a href="${href(at(-1).key)}" style="color:var(--white);text-decoration:none">&larr;</a>
    <span>prototype ${current.toUpperCase()} (${escapeHtml(VARIANTS[index]!.name)})</span>
    <a href="${href(at(1).key)}" style="color:var(--white);text-decoration:none">&rarr;</a>
  </nav>`;
};

export const renderConfirmPage = (data: ConfirmData, variant: Variant) =>
  htmlPage({
    title: "Confirm a machine login",
    body:
      (variant === "b" ? variantB(data) : variant === "c" ? variantC(data) : variantA(data)) +
      switcher(variant, data) +
      signOutForm(data.next).replace(
        'style="margin-top:1.5rem"',
        'style="margin:0 auto 5rem;width:min(760px,calc(100% - 40px))"'
      )
  });

/** The one-message pages around the confirm: done, denied, and the three ways a code is no good. */
const messagePage = (kicker: string, title: string, lede: string, status = 200) =>
  HttpServerResponse.html(
    htmlPage({
      title,
      body: `
      <main class="wrap compact">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</span>
            <span class="kicker">${escapeHtml(kicker)}</span>
          </div>
          <h1>${escapeHtml(title)}</h1>
          <p class="lede">${lede}</p>
        </header>
      </main>`
    })
  ).pipe(HttpServerResponse.setStatus(status), HttpServerResponse.setHeaders(doorHeaders));

const confirmedPage = (machine: string, company: string, email: string) =>
  messagePage(
    "Logged in",
    `${machine} is logged in.`,
    `It can publish and manage patches at <strong>${escapeHtml(company)}</strong> as <code>${escapeHtml(email)}</code> until you revoke it on <em>Your machines</em>. Your terminal already knows; you can close this tab.`
  );

const deniedPage = (code: string) =>
  messagePage(
    "Denied",
    "Nothing was logged in.",
    `The code <code>${escapeHtml(code)}</code> is dead and no key was made. If you didn't run <code>patchy login</code>, there is nothing else to do.`
  );

const expiredPage = messagePage(
  "Code expired",
  "This code has expired.",
  "A login code lasts ten minutes. Run <code>patchy login</code> again on the machine and open the new link it prints.",
  410
);

const answeredPage = messagePage(
  "Already answered",
  "This code was already used.",
  "Each code is answered once. Run <code>patchy login</code> again if the machine still needs a key.",
  410
);

const unknownPage = messagePage(
  "No login waiting",
  "Nothing is waiting for this code.",
  "Check the link you opened, or run <code>patchy login</code> again on the machine and open the new link it prints.",
  404
);

/** `/login/device` with no code: the question of whether this page should exist at all. */
const barePage = messagePage(
  "Device login",
  "Open the link your terminal printed.",
  "<code>patchy login</code> prints a link that carries its own code, so there is nothing to type here. If someone sent you here to type a code, don't: that is the trick the link is designed to avoid."
);

const wrongOrigin = HttpServerResponse.text("Refused: the form did not come from this origin.", {
  status: 403
}).pipe(HttpServerResponse.setHeaders(doorHeaders));

// --- the middleware ----------------------------------------------------------

/**
 * The Clerk cookies the server itself must expire on sign-out, unsuffixed and
 * suffixed. The handshake pair is on the list because nothing else clears it:
 * the SDK only ever reads `__clerk_handshake` (index.js:6470), and the payload
 * inside it is a standing `__session` directive, so a browser that kept the
 * cookie is signed in again on its next document GET (#119 finding M2-3, T8).
 */
const sessionCookieNames = (suffix: string) =>
  [
    "__session",
    "__clerk_db_jwt",
    "__refresh",
    "__clerk_handshake",
    "__clerk_handshake_nonce"
  ].flatMap((name) => [name, `${name}_${suffix}`]);

/**
 * The `sid` claim of a session cookie, unverified: a sign-out POST arrives
 * with an expired token as often as not (a POST is not refresh-eligible), so
 * the verdict is `signed-out` and names no session; the cookie still does.
 * Revoking is a BAPI call under the secret key, so a forged `sid` buys nothing.
 */
const sidFromCookie = (request: HttpServerRequest.HttpServerRequest, suffix: string) => {
  const token = request.cookies[`__session_${suffix}`] ?? request.cookies["__session"];
  const payload = token?.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const sid = (claims as { sid?: unknown }).sid;
    return typeof sid === "string" ? sid : undefined;
  } catch {
    return undefined;
  }
};

export const make = Effect.gen(function* () {
  const clerk = yield* ClerkSession.ClerkSession;
  const users = yield* PrototypeUsers.PrototypeUsers;
  const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
  const mode = yield* doorMode;
  const mirror = yield* suffixFix;
  const check = yield* companyCheck;
  const sql = yield* SqlClient.SqlClient;

  /** R2-6 `second`: the patch's company, one read by primary key. */
  const patchAccountRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ accountId: Schema.String }),
    execute: (patchId) => sql`SELECT account_id AS "accountId" FROM patches WHERE id = ${patchId}`
  });

  /** R2-6 `fold`: the user row and the patch's company in one read. */
  const foldRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ clerkUserId: Schema.String, patchId: Schema.String }),
    Result: Schema.Struct({
      clerkUserId: Schema.String,
      accountId: Schema.String,
      accountName: Schema.String,
      email: Schema.String,
      name: Schema.NullOr(Schema.String),
      patchAccountId: Schema.NullOr(Schema.String)
    }),
    execute: ({ clerkUserId, patchId }) => sql`
      SELECT u.clerk_user_id AS "clerkUserId", u.account_id AS "accountId",
             a.name AS "accountName", u.email, u.name, p.account_id AS "patchAccountId"
      FROM prototype_users u JOIN accounts a ON a.id = u.account_id
      LEFT JOIN patches p ON p.id = ${patchId}
      WHERE u.clerk_user_id = ${clerkUserId}`
  });

  // A route handler does not see the context its layer was built in, so what
  // the handlers behind the door need is provided per request, here.
  const provided = <E, R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    auth: DoorAuth["Service"]
  ) =>
    app.pipe(
      Effect.provideService(DoorAuth, auth),
      Effect.provideService(ClerkSession.ClerkSession, clerk)
    );

  return <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const failing = yield* HttpServerRequest.HttpServerRequest;
      return yield* door(app).pipe(
        // Prototype instrumentation: the server runs with its logger off, so a
        // failing doored request would otherwise be a silent 500.
        Effect.tapCause((cause) =>
          Effect.sync(() =>
            console.log(
              `[door] ${failing.method} ${failing.originalUrl.split("?")[0]} FAILED ${Cause.pretty(cause)}`
            )
          )
        )
      );
    });

  function door<E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) {
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const publicUrl = new URL(request.originalUrl, publicBaseUrl).href;
      const path = request.originalUrl.split("?")[0] ?? request.originalUrl;
      const verdict = yield* clerk.authenticate(request, publicUrl);
      const { outcome } = verdict;

      if (outcome._tag === "not-configured") {
        report(request, verdict, "-");
        return notConfiguredPage(outcome.missing);
      }
      if (mirror) mirrorRefreshedSession(outcome.headers, clerk.cookieSuffix);

      // Sign-out gets through whatever the verdict: it clears cookies either way.
      if (request.method === "POST" && path === "/sign-out") {
        report(request, verdict, "-");
        return yield* provided(app, { verdict, user: Option.none() });
      }

      if (outcome._tag === "handshake") {
        report(request, verdict, "-");
        return redirect307(outcome.location, outcome.headers);
      }

      // A signed-in or signed-out state that still carries a Location: the
      // development instance's extra hop to the clean URL once a handshake
      // resolved. The cookies ride on this response.
      const location = outcome.headers.get("location");
      if (location !== null) {
        report(request, verdict, "-");
        return redirect307(location, outcome.headers);
      }

      // #122 item 9: a POST is neither refresh- nor handshake-eligible, so a
      // Confirm pressed on a stale session arrives signed-out. Send the person
      // back through the door to the GET with the code intact.
      if (outcome._tag === "signed-out" && request.method === "POST" && path === "/login/device") {
        const body = yield* request.urlParamsBody.pipe(Effect.orElseSucceed(() => UrlParams.empty));
        const code = Option.getOrElse(UrlParams.getFirst(body, "code"), () => "");
        report(request, verdict, "-", " item9=303-to-get");
        return withClerkHeaders(
          HttpServerResponse.redirect(`/login/device?code=${encodeURIComponent(code)}&again=1`, {
            status: 303,
            headers: doorHeaders
          }),
          outcome.headers
        );
      }

      if (outcome._tag === "signed-out") {
        report(request, verdict, "-");
        const signIn = clerk.signInUrl(publicUrl);
        return mode === "redirect" && request.method === "GET"
          ? withClerkHeaders(
              HttpServerResponse.redirect(signIn, { status: 302, headers: doorHeaders }),
              outcome.headers
            )
          : withClerkHeaders(doorPage(signIn, outcome.reason), outcome.headers);
      }

      // Signed in: one read, then either the page or the outsider refusal.
      // R2-6: with the company check on, the patch's company rides along
      // (`fold`) or comes from a second read (`second`), and a person from
      // another company gets the missing-patch 404 without reaching `Pages`.
      const patchId = check === "off" ? undefined : patchIdOf(path);
      let found: PrototypeUsers.Found;
      let patchAccountId: string | null | undefined;
      let reads = 1;
      if (check === "fold" && patchId !== undefined) {
        const [duration, row] = yield* Effect.timed(
          foldRow({ clerkUserId: outcome.userId, patchId })
        ).pipe(Effect.orDie);
        found = {
          user: Option.map(
            row,
            (r) =>
              new PrototypeUsers.PrototypeUser({
                clerkUserId: r.clerkUserId,
                accountId: r.accountId,
                accountName: r.accountName,
                email: r.email,
                name: r.name
              })
          ),
          dbMs: Duration.toMillis(duration)
        };
        patchAccountId = Option.isSome(row) ? row.value.patchAccountId : undefined;
      } else {
        found = yield* users.find(outcome.userId).pipe(Effect.orDie);
      }
      let user = found.user;
      if (Option.isNone(user)) {
        const email = outcome.email ?? `${outcome.userId}@no-email-claim.invalid`;
        if (email.includes("+outsider")) {
          report(request, verdict, found.dbMs);
          return withClerkHeaders(outsiderPage(email, publicUrl), outcome.headers);
        }
        user = Option.some(
          yield* users
            .createJustInTime({ clerkUserId: outcome.userId, email, name: outcome.name })
            .pipe(Effect.orDie)
        );
      }
      let extra = "";
      if (patchId !== undefined) {
        let patchMs: number | undefined;
        if (patchAccountId === undefined) {
          const [duration, row] = yield* Effect.timed(patchAccountRow(patchId)).pipe(Effect.orDie);
          reads += 1;
          patchMs = Duration.toMillis(duration);
          patchAccountId = Option.isSome(row) ? row.value.accountId : null;
        }
        const company =
          patchAccountId === null
            ? "missing"
            : patchAccountId === Option.getOrThrow(user).accountId
              ? "ok"
              : "other";
        extra = ` company=${company} reads=${reads}${patchMs === undefined ? "" : ` patchMs=${patchMs.toFixed(1)}`}`;
        if (company !== "ok") {
          report(request, verdict, found.dbMs, extra);
          return withClerkHeaders(patchNotFound, outcome.headers);
        }
      }
      report(request, verdict, found.dbMs, extra);
      const response = yield* provided(app, { verdict, user });
      return withClerkHeaders(
        HttpServerResponse.setHeader(response, "cache-control", "private, no-store"),
        outcome.headers
      );
    });
  }
});

/** The route-scoped middleware; `Layer.provide` it to the layer that registers the doored routes. */
export const layer = HttpRouter.middleware<{ provides: DoorAuth | ClerkSession.ClerkSession }>()(
  make
).layer;

// --- the door's own routes ---------------------------------------------------

const sameOrigin = (request: HttpServerRequest.HttpServerRequest, publicBaseUrl: string) =>
  request.headers["origin"] === new URL(publicBaseUrl).origin;

const minutesLeft = (expiresAt: Date, now: number) =>
  Math.max(1, Math.ceil((expiresAt.getTime() - now) / 60_000));

/** The confirm page for a pending login, with its name prefilled: the old key's name on a re-login, else the CLI's hostname. */
const confirmFor = (
  found: Extract<DeviceLogins.Lookup, { _tag: "pending" }>,
  user: PrototypeUsers.PrototypeUser,
  now: number,
  next: string,
  override: { machineName?: string; error?: string; notice?: string } = {}
): ConfirmData => {
  const inherited =
    found.previousToken !== null && found.previousToken.accountId === user.accountId
      ? found.previousToken
      : null;
  return {
    code: found.userCode,
    company: user.accountName,
    email: user.email,
    name: user.name,
    machineName: override.machineName ?? inherited?.name ?? found.machineNameHint ?? "",
    replaces: inherited?.name ?? null,
    expiresInMinutes: minutesLeft(found.expiresAt, now),
    error: override.error ?? null,
    notice: override.notice ?? null,
    next,
    mock: false
  };
};

const lookupPage = (found: Exclude<DeviceLogins.Lookup, { _tag: "pending" }>) =>
  found._tag === "expired" ? expiredPage : found._tag === "answered" ? answeredPage : unknownPage;

/** GET `/login/device?code=XXXX-XXXX[&v=a|b|c]`: the confirm page, or why this code is no good. */
export const device = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = yield* HttpServerRequest.ParsedSearchParams;
  const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
  const deviceLogins = yield* DeviceLogins.DeviceLogins;
  const { user } = yield* DoorAuth;
  const next = new URL(request.originalUrl, publicBaseUrl).href;
  const raw = params["code"];
  if (typeof raw !== "string" || raw === "") return barePage;
  const code = DeviceLogins.normalizeUserCode(raw);
  if (code === undefined) return unknownPage;
  const found = yield* deviceLogins.lookup(code).pipe(Effect.orDie);
  console.log(`[door]   device lookup code=${code} -> ${found._tag}`);
  if (found._tag !== "pending") return lookupPage(found);
  const now = yield* Clock.currentTimeMillis;
  const data = confirmFor(found, Option.getOrThrow(user), now, next, {
    ...(params["again"] === "1"
      ? {
          notice:
            "Your sign-in was refreshed before that went through. Check the code and press Confirm again."
        }
      : {})
  });
  return HttpServerResponse.html(renderConfirmPage(data, variantOf(params["v"]))).pipe(
    HttpServerResponse.setHeaders(doorHeaders)
  );
});

/** POST `/login/device`: the Origin check, then confirm (mint, name, revoke the old key) or deny. */
export const deviceConfirm = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
  const deviceLogins = yield* DeviceLogins.DeviceLogins;
  if (!sameOrigin(request, publicBaseUrl)) return wrongOrigin;
  const user = Option.getOrThrow((yield* DoorAuth).user);
  const body = yield* request.urlParamsBody.pipe(Effect.orDie);
  const action = Option.getOrElse(UrlParams.getFirst(body, "action"), () => "deny");
  const machine = Option.getOrElse(UrlParams.getFirst(body, "machine"), () => "").trim();
  const variant = variantOf(Option.getOrUndefined(UrlParams.getFirst(body, "v")));
  const code = DeviceLogins.normalizeUserCode(
    Option.getOrElse(UrlParams.getFirst(body, "code"), () => "")
  );
  if (code === undefined) return unknownPage;
  const next = `${publicBaseUrl}/login/device?code=${code}`;

  if (action !== "confirm") {
    const denied = yield* deviceLogins.deny(code).pipe(Effect.orDie);
    console.log(`[door]   device deny code=${code} -> ${denied ? "denied" : "not pending"}`);
    if (!denied) return lookupPage(yield* deviceLogins.lookup(code).pipe(Effect.orDie));
    return deniedPage(code);
  }

  if (machine.length === 0 || machine.length > 64) {
    const found = yield* deviceLogins.lookup(code).pipe(Effect.orDie);
    if (found._tag !== "pending") return lookupPage(found);
    const now = yield* Clock.currentTimeMillis;
    const data = confirmFor(found, user, now, next, {
      machineName: machine.slice(0, 64),
      error: "Give the machine a name, up to 64 characters."
    });
    return HttpServerResponse.html(renderConfirmPage(data, variant)).pipe(
      HttpServerResponse.setStatus(422),
      HttpServerResponse.setHeaders(doorHeaders)
    );
  }

  const minted = yield* deviceLogins
    .confirm({
      userCode: code,
      accountId: user.accountId,
      machineName: machine,
      confirmedBy: user.email
    })
    .pipe(Effect.orDie);
  console.log(
    `[door]   device confirm code=${code} machine=<len ${machine.length}> -> ${Option.isSome(minted) ? `minted ${minted.value.id}` : "not pending"}`
  );
  if (Option.isNone(minted)) return lookupPage(yield* deviceLogins.lookup(code).pipe(Effect.orDie));
  return confirmedPage(minted.value.name, user.accountName, user.email);
});

/** GET `/prototype/login/device?v=`: the confirm page with sample data and no door, for looking. */
export const mock = Effect.gen(function* () {
  const params = yield* HttpServerRequest.ParsedSearchParams;
  const data: ConfirmData = {
    code: "WXYZ-4RT9",
    company: "Patchy Dev",
    email: "allison@example.com",
    name: "Allison Mahmood",
    machineName: "allison-laptop",
    replaces: params["relogin"] === "1" ? "allison-laptop" : null,
    expiresInMinutes: 10,
    error: null,
    notice:
      params["again"] === "1"
        ? "Your sign-in was refreshed before that went through. Check the code and press Confirm again."
        : null,
    next: "/prototype/login/device",
    mock: true
  };
  return HttpServerResponse.html(renderConfirmPage(data, variantOf(params["v"]))).pipe(
    HttpServerResponse.setHeaders(doorHeaders)
  );
});

/**
 * POST `/sign-out`: revoke the session at Clerk if there is one, expire every
 * Clerk cookie on this host, and go back to `next` when it is a same-origin path.
 */
export const signOut = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const clerk = yield* ClerkSession.ClerkSession;
  const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
  if (!sameOrigin(request, publicBaseUrl)) return wrongOrigin;

  const { verdict } = yield* DoorAuth;
  const sessionId =
    verdict.outcome._tag === "signed-in"
      ? verdict.outcome.sessionId
      : sidFromCookie(request, clerk.cookieSuffix);
  if (sessionId !== undefined) {
    yield* clerk.revoke(sessionId).pipe(
      Effect.tap(() => Effect.sync(() => console.log(`[door]   revoked ${sessionId}`))),
      Effect.catch((error) =>
        Effect.sync(() => console.log(`[door]   revoke failed: ${error.message}`))
      )
    );
  }

  // `next` is honoured as a path, or as an absolute URL on this origin
  // reduced to its path; anything else goes home.
  const body = yield* request.urlParamsBody.pipe(Effect.orDie);
  const next = UrlParams.getFirst(body, "next").pipe(
    Option.map((value) => {
      if (value.startsWith("/") && !value.startsWith("//")) return value;
      try {
        const url = new URL(value);
        return url.origin === new URL(publicBaseUrl).origin ? `${url.pathname}${url.search}` : "/";
      } catch {
        return "/";
      }
    }),
    Option.getOrElse(() => "/")
  );

  let response = HttpServerResponse.redirect(next, {
    status: 303,
    headers: { "cache-control": "no-store" }
  });
  for (const name of sessionCookieNames(clerk.cookieSuffix)) {
    response = yield* HttpServerResponse.expireCookie(response, name, { path: "/" }).pipe(
      Effect.orDie
    );
  }
  // FAPI sets `__client_uat` with `Domain=<public host>` (the eTLD+1 in
  // production); a host-only `__client_uat=0` would sit beside it instead of
  // replacing it, so the zero goes out with the same Domain.
  for (const name of ["__client_uat", `__client_uat_${clerk.cookieSuffix}`]) {
    response = yield* HttpServerResponse.setCookie(response, name, "0", {
      path: "/",
      domain: new URL(publicBaseUrl).hostname,
      maxAge: "365 days",
      sameSite: "lax"
    }).pipe(Effect.orDie);
  }
  return response;
});
