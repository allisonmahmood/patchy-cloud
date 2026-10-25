import * as Cookies from "effect/http/Cookies";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { type AppShell, escapeAttribute, escapeHtml, htmlPage } from "@patchy/core";

export interface Page {
  readonly title: string;
  readonly body: string;
  readonly status?: number;
  readonly styles?: string;
  readonly heading?: string;
  readonly app?: AppShell;
  /**
   * Where else a form's answer may land, as CSP sources: browsers hold a form's redirects to
   * `form-action`, so a page whose answer redirects to another site names that site here.
   */
  readonly formActions?: ReadonlyArray<string>;
}

/** A page's session scripts come from Clerk when it signs people in; dev personas need none. */
export interface SessionShell {
  readonly clerk: { readonly frontendApiHost: string; readonly publishableKey: string } | undefined;
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

/** Sign out; with `returnTo`, Use another account, which signs in again back at that path. */
export const signOutForm = (notYou = false, returnTo?: string) =>
  `<form class="auth-signout" method="post" action="/logout">${returnTo === undefined ? "" : `<input type="hidden" name="return" value="${escapeAttribute(returnTo)}">`}${notYou ? "Not you? " : ""}<button class="btn btn-quiet" type="submit">${returnTo === undefined ? "Sign out" : "Use another account"}</button></form>`;

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
export function sessionScripts({ clerk }: SessionShell): string {
  if (clerk === undefined) return "";
  return `<script defer crossorigin="anonymous" data-clerk-publishable-key="${escapeAttribute(clerk.publishableKey)}" src="https://${escapeAttribute(clerk.frontendApiHost)}/npm/@clerk/clerk-js@5/dist/clerk.headless.browser.js"></script><script defer src="/auth/session.js"></script>`;
}

/** Marks a page that showed its viewer's receipt, so `withViewer` knows to clear it; never sent. */
export const RECEIPT_SHOWN = "x-patchy-receipt-shown";

export function pageResponse(
  page: Page,
  shell?: SessionShell
): HttpServerResponse.HttpServerResponse {
  const clerk = shell?.clerk;
  const head = shell && clerk ? sessionScripts(shell) : undefined;
  const heading = page.heading ?? `<h1 class="page-heading">${escapeHtml(page.title)}</h1>`;
  return HttpServerResponse.text(
    htmlPage({
      title: page.title,
      head,
      styles: page.styles,
      app: page.app,
      body: page.app
        ? `${heading}${page.body}`
        : `<main class="auth-card"><div class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</div>${heading}${page.body}</main>`
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
          ["form-action 'self'", ...(page.formActions ?? [])].join(" "),
          "frame-ancestors 'none'",
          // App pages run the shell's own What's new script, which posts back here.
          ...(clerk
            ? [
                `script-src 'self' https://${clerk.frontendApiHost}`,
                `connect-src ${page.app ? "'self' " : ""}https://${clerk.frontendApiHost}`,
                // Clerk's session poller runs on a blob worker; without it the 60s
                // session cookie goes stale and the page's next form POST is signed out.
                "worker-src blob:"
              ]
            : page.app
              ? ["script-src 'self'", "connect-src 'self'"]
              : [])
        ].join("; ")
      }
    }
  ).pipe((response) =>
    page.app?.viewer.receipt === undefined
      ? response
      : HttpServerResponse.setHeader(response, RECEIPT_SHOWN, "1")
  );
}
