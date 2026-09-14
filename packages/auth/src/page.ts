import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { escapeAttribute, escapeHtml, htmlPage } from "@patchy/core";

export interface Page {
  readonly title: string;
  readonly body: string;
  readonly status?: number;
  readonly styles?: string;
  readonly heading?: string;
  /**
   * Prototype #241: render in the app shell (header bar over a wide card)
   * instead of the sign-in card. `bare` pages lay out their own body under
   * the header; others get the padded page with the title as its heading.
   */
  readonly app?: { readonly header: string; readonly bare?: boolean };
}

export type AppSection = "patches" | "company" | "connections" | "machines";

/**
 * The header every signed-in first-party page shares (prototype #241):
 * brand, the four sections, the viewer and sign-out. `extra` is for a
 * page's own control beside the viewer, such as the portal's role switch.
 */
export function appHeader(
  viewer: {
    readonly user: { readonly name: string };
    readonly company: { readonly name: string };
  },
  current: AppSection | null,
  extra = ""
): string {
  const link = (href: string, label: string, key: AppSection) =>
    `<a href="${href}"${key === current ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header class="app-bar"><div class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</div><nav class="app-nav" aria-label="Primary">${link("/", "Patches", "patches")}${link("/company", "Company", "company")}${link("/company/connections", "Connections", "connections")}${link("/machines", "Your machines", "machines")}</nav><div class="app-who"><span>${escapeHtml(viewer.user.name)} · ${escapeHtml(viewer.company.name)}</span><form class="auth-signout" method="post" action="/logout"><button type="submit">Sign out</button></form>${extra}</div></header>`;
}

/** The app shell's CSS, on top of the shared tokens; the sign-in card keeps its own rules. */
export const appStyles = `
    body:has(.app-card) { display: flow-root; min-height: 100vh; }
    .app-card { width: min(1180px, calc(100% - 32px)); margin: 32px auto; padding: 0; overflow: hidden; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--white); box-shadow: var(--shadow-hard); }
    .app-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 28px; padding: 14px 26px; border-bottom: 2px solid var(--ink); background: var(--white); }
    .app-bar .brand { font-size: 1rem; margin: 0; }
    .app-nav { display: flex; gap: 4px; flex-wrap: wrap; }
    .app-nav a { padding: 6px 12px; border-radius: 6px; color: var(--ink); text-decoration: none; font-weight: 750; font-size: .95rem; }
    .app-nav a[aria-current="page"] { background: var(--yellow); border: 2px solid var(--ink); box-shadow: 2px 2px 0 var(--ink); }
    .app-who { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; color: var(--muted); font-size: .88rem; font-weight: 650; }
    .app-who .auth-signout { margin: 0; padding: 0; border: 0; display: inline; }
    .app-who .auth-signout button { min-height: 0; }
    .app-page { padding: 30px 34px 40px; max-width: 900px; }
    .app-page h1 { max-width: none; font-size: 2.2rem; margin-bottom: .6rem; overflow-wrap: anywhere; }
    .app-page label { display: block; margin: 18px 0 6px; font-size: .9rem; font-weight: 750; }
    .app-page input:not([type=checkbox]):not([type=radio]), .app-page select, .app-page textarea {
      width: 100%; min-height: 48px; padding: 10px 12px; border: 1.5px solid var(--ink); border-radius: 6px; background: white; color: var(--ink); font: inherit;
    }
    .app-page .auth-signout { display: none; }
`;

export interface SessionShell {
  readonly frontendApiHost: string;
  readonly publishableKey: string;
}

/** Only local absolute paths survive; reject authorities and slash/backslash escapes. */
export function returnPath(value: string | null, publicBaseUrl: string): string | null {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/.test(value)
  )
    return null;
  const base = new URL(publicBaseUrl);
  const url = new URL(value, base);
  // Dot-segment normalization can turn a local path into a new authority reference.
  return url.origin === base.origin && !url.pathname.startsWith("//")
    ? `${url.pathname}${url.search}${url.hash}`
    : null;
}

export const signOutForm = (notYou = false) =>
  `<form class="auth-signout" method="post" action="/logout">${notYou ? "Not you? " : ""}<button type="submit">Sign out</button></form>`;

/** Cookie collections normally key by name, which would lose distinct Domain/Path setters. */
export function withCookies(
  response: HttpServerResponse.HttpServerResponse,
  values: ReadonlyArray<string>
): HttpServerResponse.HttpServerResponse {
  if (values.length === 0) return response;
  const all = [...values, ...Cookies.toSetCookieHeaders(response.cookies)];
  const cookies = Object.fromEntries(
    all.flatMap((value, index) =>
      Object.values(Cookies.fromSetCookie(value).cookies).map((cookie) => [String(index), cookie])
    )
  );
  return HttpServerResponse.replaceCookies(response, Cookies.fromReadonlyRecord(cookies));
}

/** The only scripts in a session shell: Clerk headless and Patchy's external initializer. */
export function sessionScripts(shell: SessionShell): string {
  return `<script defer crossorigin="anonymous" data-clerk-publishable-key="${escapeAttribute(shell.publishableKey)}" src="https://${escapeAttribute(shell.frontendApiHost)}/npm/@clerk/clerk-js@5/dist/clerk.headless.browser.js"></script><script defer src="/auth/session.js"></script>`;
}

export function pageResponse(
  page: Page,
  shell?: SessionShell
): HttpServerResponse.HttpServerResponse {
  const head = shell ? sessionScripts(shell) : undefined;
  const heading = page.heading ?? `<h1>${escapeHtml(page.title)}</h1>`;
  const body = page.app
    ? `<main class="app-card">${page.app.header}${page.app.bare ? page.body : `<div class="app-page">${heading}${page.body}</div>`}</main>`
    : `<main class="auth-card"><div class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</div>${heading}${page.body}</main>`;
  return HttpServerResponse.text(
    htmlPage({
      title: page.title,
      head,
      styles: page.app ? `${appStyles}${page.styles ?? ""}` : page.styles,
      body
    }),
    {
      contentType: "text/html",
      status: page.status ?? 200,
      headers: {
        "cache-control": "private, no-store",
        // no-referrer makes browsers send Origin: null on plain form POSTs.
        "referrer-policy": "same-origin",
        "x-content-type-options": "nosniff",
        "content-security-policy": [
          "default-src 'none'",
          "style-src 'unsafe-inline'",
          "img-src https: data:",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'",
          ...(shell
            ? [
                `script-src 'self' https://${shell.frontendApiHost}`,
                `connect-src https://${shell.frontendApiHost}`
              ]
            : [])
        ].join("; ")
      }
    }
  );
}
