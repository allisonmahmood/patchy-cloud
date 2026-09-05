/**
 * Browser-authenticated pages: the login door and the create-or-join company page.
 *
 * These pages are served only when Clerk auth is enabled. They require no
 * authentication themselves (they are the sign-in entry points), but
 * they are gated by RequireSession only after the user is signed in.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { Viewer } from "@patchy/auth";
import { escapeHtml } from "./render.js";

/**
 * The login door: a page with one "Sign in with Clerk" link.
 *
 * The `return` query parameter is validated to be a local path (no open redirect).
 * Default return path is `/join` until the company dashboard exists.
 */
export function renderLogin(options: { returnTo: string; clerkSignInUrl: string }): string {
  const returnTo = validateReturnTo(options.returnTo, "/join");
  const signInUrl = buildClerkRedirectUrl(options.clerkSignInUrl, returnTo);

  return htmlPage({
    title: "Sign in — Patchy",
    body: `
      <main class="wrap compact">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</span>
            <span class="kicker">Sign in</span>
          </div>
          <h1>Sign in to Patchy</h1>
          <p class="lede">Use your Clerk account to sign in. If you do not have one, sign up through the link below.</p>
        </header>
        <section class="panel">
          <a class="btn btn-primary" href="${escapeHtml(signInUrl)}">Sign in with Clerk</a>
        </section>
        <p class="muted">No account? <a href="${escapeHtml(signInUrl.replace("sign-in", "sign-up"))}">Create one</a>.</p>
      </main>
    `,
    extraStyles: `
      .panel { display: flex; flex-direction: column; gap: 16px; }
      .btn { display: inline-flex; align-items: center; justify-content: center; padding: 12px 24px; border: 2px solid var(--ink); border-radius: var(--radius); font-weight: 800; text-decoration: none; cursor: pointer; }
      .btn-primary { background: var(--green); color: var(--ink); box-shadow: 3px 3px 0 var(--ink); }
      .btn-primary:hover { background: var(--yellow); }
      .muted { color: var(--muted); font-size: .9rem; }
    `
  });
}

/**
 * The create-or-join company page, served to a signed-in user who has no company yet.
 */
export function renderJoin(options: {
  user: { userId: string; email: Option.Option<string>; name: Option.Option<string> };
  invitations: ReadonlyArray<{ id: string; companyName: string; invitedBy: string }>;
  returnTo: string;
}): string {
  const email = Option.getOrUndefined(options.user.email) ?? "your account";
  const name = Option.getOrUndefined(options.user.name) ?? email;

  let invitationsHtml = "";
  if (options.invitations.length > 0) {
    const inviteItems = options.invitations
      .map(
        (inv) =>
          `<li><strong>${escapeHtml(inv.companyName)}</strong> (invited by ${escapeHtml(inv.invitedBy)}) — <form method="post" action="/join/accept/${escapeHtml(inv.id)}"><button type="submit">Join</button></form></li>`
      )
      .join("");
    invitationsHtml = `
      <section class="panel">
        <h2>Pending invitations</h2>
        <ul>${inviteItems}</ul>
      </section>
    `;
  }

  return htmlPage({
    title: "Create or join a company — Patchy",
    body: `
      <main class="wrap compact">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</span>
            <span class="kicker">Create or join</span>
          </div>
          <h1>Welcome, ${escapeHtml(name)}</h1>
          <p class="lede">You need to be a member of a company to use Patchy Cloud.</p>
        </header>
        ${invitationsHtml}
        <section class="panel">
          <h2>Create a company</h2>
          <p>Start your own company on Patchy Cloud. You will be the admin.</p>
          <form method="post" action="/join/create">
            <input type="hidden" name="return" value="${escapeHtml(options.returnTo)}">
            <div class="field">
              <label for="handle">Company handle</label>
              <input type="text" id="handle" name="handle" placeholder="acme" required pattern="[a-z0-9-]+" minlength="2" maxlength="32">
              <span class="hint">Lowercase letters, numbers and hyphens only.</span>
            </div>
            <div class="field">
              <label for="name">Company name</label>
              <input type="text" id="name" name="name" placeholder="Acme Corp" required minlength="1" maxlength="100">
            </div>
            <button type="submit" class="btn btn-primary">Create company</button>
          </form>
        </section>
        <p class="muted">Already have a company? Ask your admin for an invite link.</p>
      </main>
    `,
    extraStyles: `
      .panel { display: flex; flex-direction: column; gap: 16px; }
      .field { display: flex; flex-direction: column; gap: 6px; }
      .field label { font-weight: 700; }
      .field input { padding: 8px 12px; border: 2px solid var(--ink); border-radius: var(--radius); font-size: 1rem; }
      .hint { font-size: .8rem; color: var(--muted); }
      .btn { display: inline-flex; align-items: center; justify-content: center; padding: 10px 20px; border: 2px solid var(--ink); border-radius: var(--radius); font-weight: 800; text-decoration: none; cursor: pointer; background: var(--green); color: var(--ink); box-shadow: 3px 3px 0 var(--ink); }
      .btn:hover { background: var(--yellow); }
      .muted { color: var(--muted); font-size: .9rem; }
    `
  });
}

/**
 * The deactivated account page: 403, no-store, with a Sign out control.
 */
export function renderDeactivated(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Account deactivated — Patchy</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; }
    h1 { color: #c00; }
    a { color: #1263e6; }
  </style>
</head>
<body>
  <h1>Account deactivated</h1>
  <p>Your Patchy account has been deactivated. Contact the company admin if you believe this is an error.</p>
  <form method="post" action="/sign-out">
    <button type="submit">Sign out</button>
  </form>
</body>
</html>`;
}

/**
 * Validate and normalise a return-to path: only local absolute paths are allowed.
 * Open redirects are prevented by rejecting any URL that has a scheme or host.
 */
function validateReturnTo(value: string, fallback: string): string {
  try {
    const url = new URL(value, "http://localhost");
    // new URL with a base rejects paths that have a scheme (e.g. https://evil.com)
    // Only paths starting with / are allowed
    if (url.pathname.startsWith("/")) {
      return url.pathname + url.search + url.hash;
    }
  } catch {
    // Invalid URL — use fallback
  }
  return fallback;
}

/**
 * Build a Clerk Account Portal sign-in URL with a redirect_url parameter.
 *
 * The `clerkSignInUrl` is the base Account Portal URL from Clerk's frontend API.
 * The `redirect_url` is appended as a query parameter.
 */
function buildClerkRedirectUrl(baseUrl: string, returnTo: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("redirect_url", returnTo);
  return url.toString();
}
