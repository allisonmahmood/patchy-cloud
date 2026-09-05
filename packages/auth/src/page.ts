import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { escapeAttribute, escapeHtml, htmlPage } from "@patchy/core";

export interface Page {
  readonly title: string;
  readonly body: string;
  readonly status?: number;
  readonly styles?: string;
}

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
  return url.origin === base.origin ? `${url.pathname}${url.search}${url.hash}` : null;
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

export function pageResponse(
  page: Page,
  shell?: SessionShell
): HttpServerResponse.HttpServerResponse {
  const head = shell
    ? `<script defer crossorigin="anonymous" data-clerk-publishable-key="${escapeAttribute(shell.publishableKey)}" src="https://${escapeAttribute(shell.frontendApiHost)}/npm/@clerk/clerk-js@5/dist/clerk.headless.js"></script><script defer src="/auth/session.js"></script>`
    : undefined;
  return HttpServerResponse.text(
    htmlPage({
      title: page.title,
      head,
      styles: page.styles,
      body: `<main class="auth-card"><div class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</div><h1>${escapeHtml(page.title)}</h1>${page.body}</main>`
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
