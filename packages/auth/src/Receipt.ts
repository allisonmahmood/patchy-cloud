import * as Schema from "effect/Schema";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import { withCookies } from "./page.js";

/**
 * A receipt is one line naming what a form just did ("Revoked Studio Mac mini"), shown once on
 * the page its redirect lands on. The POST that made the change sets it as a short-lived
 * HttpOnly cookie bound to the person; `RequireSession.withViewer` takes it on their next page
 * and clears it. Nothing in a URL can make a page claim a change, and over HTTPS the `__Host-`
 * prefix keeps other subdomains from planting one.
 */

const MAX_AGE_SECONDS = 60;
/** Generous for one sentence; a longer one is cut rather than refused, since the change is done. */
const MAX_TEXT = 300;

const Stored = Schema.fromJsonString(Schema.Struct({ u: Schema.String, t: Schema.String }));
const encode = Schema.encodeSync(Stored);
const decode = Schema.decodeUnknownOption(Stored);

const cookieName = (publicBaseUrl: string) =>
  new URL(publicBaseUrl).protocol === "https:" ? "__Host-patchy_receipt" : "patchy_receipt";

const attributes = (publicBaseUrl: string, maxAge: number) =>
  `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(publicBaseUrl).protocol === "https:" ? "; Secure" : ""}`;

/** `response` with a receipt for `userId`'s next page. */
export const set = (
  response: HttpServerResponse.HttpServerResponse,
  input: { readonly userId: string; readonly text: string; readonly publicBaseUrl: string }
): HttpServerResponse.HttpServerResponse =>
  withCookies(response, [
    `${cookieName(input.publicBaseUrl)}=${Buffer.from(encode({ u: input.userId, t: input.text.slice(0, MAX_TEXT) })).toString("base64url")}; ${attributes(input.publicBaseUrl, MAX_AGE_SECONDS)}`
  ]);

/**
 * The receipt waiting in a request's `cookies` for `userId`, and the cookie that clears it. A receipt left
 * for someone else, such as before an account switch, is cleared without being shown.
 */
export const take = (
  cookies: Readonly<Record<string, string>>,
  input: { readonly userId: string; readonly publicBaseUrl: string }
): { readonly text: string | undefined; readonly clear: ReadonlyArray<string> } => {
  const name = cookieName(input.publicBaseUrl);
  const raw = cookies[name];
  if (raw === undefined) return { text: undefined, clear: [] };
  const stored = decode(Buffer.from(raw, "base64url").toString("utf8"));
  return {
    text: stored._tag === "Some" && stored.value.u === input.userId ? stored.value.t : undefined,
    clear: [`${name}=; ${attributes(input.publicBaseUrl, 0)}`]
  };
};
