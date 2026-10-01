// @effect-diagnostics nodeBuiltinImport:off -- the persona cookie's HMAC and constant-time compare are Node crypto.
import { createHmac, timingSafeEqual } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Users } from "@patchy/companies";
import { escapeAttribute, escapeHtml, randomToken, sha256 } from "@patchy/core";
import * as Session from "./Session.js";
import { pageResponse, returnPath, withCookies } from "./page.js";

/**
 * Dev personas: anyone signs in as any email, no Clerk. The dev runner's
 * environments (`pnpm dev up`) turn this on by setting
 * `PATCHY_DEV_PERSONAS_SECRET`. It refuses to start with `NODE_ENV=production`
 * or on a non-loopback public origin, so a stray secret cannot open a real
 * instance. `/dev/sign-in?as=<email>&return=<path>` signs in; `/dev/sign-in`
 * lists the active people to pick from.
 */

export class DevPersonasRefused extends Schema.TaggedError<DevPersonasRefused>()(
  "DevPersonasRefused",
  { reason: Schema.Literals(["production", "public_origin"]), origin: Schema.String }
) {
  override get message() {
    return this.reason === "production"
      ? "Dev personas never run with NODE_ENV=production."
      : `Dev personas run only on a loopback origin, not ${this.origin}.`;
  }
}

/** The runner sets the secret; its presence alone selects personas over Clerk. */
export const enabled = Config.option(Config.Redacted("PATCHY_DEV_PERSONAS_SECRET")).pipe(
  Config.map(Option.isSome)
);

export const config = Config.all({
  secret: Config.Redacted("PATCHY_DEV_PERSONAS_SECRET"),
  publicUrl: Session.publicUrlConfig,
  environment: Config.String("NODE_ENV").pipe(Config.withDefault("development"))
});

export const COOKIE = "patchy_dev_person";
const LIFETIME_SECONDS = 30 * 24 * 60 * 60;

const isLoopback = (url: URL) =>
  url.hostname === "localhost" ||
  url.hostname.endsWith(".localhost") ||
  url.hostname === "127.0.0.1" ||
  url.hostname === "[::1]";

const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Session.SessionClaims));

/** Settings checked once, plus the cookie codec both the Session and the route use. */
const persona = Effect.gen(function* () {
  const { secret, publicUrl, environment } = yield* config;
  if (environment === "production")
    return yield* new DevPersonasRefused({ reason: "production", origin: publicUrl.origin });
  if (!isLoopback(publicUrl))
    return yield* new DevPersonasRefused({ reason: "public_origin", origin: publicUrl.origin });
  const mac = (payload: string) =>
    createHmac("sha256", Redacted.value(secret)).update(payload).digest();
  const attributes = `Path=/; HttpOnly; SameSite=Lax${publicUrl.protocol === "https:" ? "; Secure" : ""}`;
  return {
    publicUrl,
    seal: (claims: typeof Session.SessionClaims.Type) => {
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${COOKIE}=${payload}.${mac(payload).toString("base64url")}; ${attributes}; Max-Age=${LIFETIME_SECONDS}`;
    },
    open: (value: string) => {
      const [payload = "", signature = ""] = value.split(".");
      const given = Buffer.from(signature, "base64url");
      const expected = mac(payload);
      if (given.length !== expected.length || !timingSafeEqual(given, expected))
        return Option.none();
      return decodeClaims(Buffer.from(payload, "base64url").toString());
    },
    cleared: `${COOKIE}=; ${attributes}; Max-Age=0`
  };
});

export const make = Effect.gen(function* () {
  const { publicUrl, open, cleared } = yield* persona;
  const signedOut = (reason: string, cookies: ReadonlyArray<string> = []) =>
    ({ status: "signed-out", reason, handshakeFailed: false, cookies }) as const;
  const authenticate = Effect.fn("DevPersonas.authenticate")(function* (request: Request) {
    const value = Cookies.parseHeader(request.headers.get("cookie") ?? "")[COOKIE];
    if (value === undefined) return signedOut("dev-persona-missing");
    const claims = open(value);
    if (Option.isNone(claims)) return signedOut("dev-persona-invalid", [cleared]);
    if (claims.value.exp * 1_000 <= (yield* Clock.currentTimeMillis))
      return signedOut("dev-persona-expired", [cleared]);
    return { status: "signed-in", claims: claims.value, cookies: [] } as const;
  });
  return Session.Session.of({
    publicBaseUrl: publicUrl.origin,
    clerk: undefined,
    signInUrl: (path) => new URL(`/dev/sign-in?return=${encodeURIComponent(path)}`, publicUrl).href,
    authenticate,
    // Deactivation is enforced through the users table, as it is for Clerk sessions.
    isActive: () => Effect.succeed(true),
    revoke: () => Effect.void,
    signOutCookies: () => [cleared]
  });
});

export const layer = Layer.effect(Session.Session, make);

const Person = Schema.Struct({
  email: Schema.String,
  name: Schema.String,
  role: Schema.String,
  company: Schema.String
});

const picker = (people: ReadonlyArray<typeof Person.Type>, target: string, notice?: string) => {
  const link = (email: string) =>
    `/dev/sign-in?as=${encodeURIComponent(email)}&return=${encodeURIComponent(target)}`;
  const groups = new Map<string, Array<typeof Person.Type>>();
  for (const person of people)
    groups.set(person.company, [...(groups.get(person.company) ?? []), person]);
  const lists = [...groups]
    .map(
      ([company, members]) =>
        `<h2>${escapeHtml(company)}</h2><ul class="list">${members
          .map(
            (person) =>
              `<li class="list-row"><a class="list-link" href="${escapeAttribute(link(person.email))}"><strong>${escapeHtml(person.name || person.email)}</strong><br>${escapeHtml(person.email)} · ${escapeHtml(person.role)}</a></li>`
          )
          .join("")}</ul>`
    )
    .join("");
  return pageResponse({
    title: "Sign in as someone",
    status: notice === undefined ? 200 : 400,
    body: `<p>This is a local environment. Pick a person, or sign in as any email to accept an invitation.</p>${notice === undefined ? "" : `<p class="field-error">${escapeHtml(notice)}</p>`}${lists}<form method="get" action="/dev/sign-in"><label class="field-label" for="as">Email</label><input class="field" id="as" name="as" type="email" required autocomplete="off"><input type="hidden" name="return" value="${escapeAttribute(target)}"><div class="actions"><button class="btn btn-primary" type="submit">Sign in</button></div></form>`
  });
};

/** `GET /dev/sign-in`: the picker, or with `as`, a cookie for that email and a redirect back. */
const signIn = Effect.fn("DevPersonas.signIn")(function* (
  publicUrl: URL,
  seal: (claims: typeof Session.SessionClaims.Type) => string
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, publicUrl);
  const target = returnPath(url.searchParams.get("return"), publicUrl.origin) ?? "/";
  const as = url.searchParams.get("as")?.trim().toLowerCase();
  const sql = yield* SqlClient.SqlClient;
  const people = Effect.flatMap(
    sql`SELECT u.email, u.name, u.role, c.name AS company FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE u.deactivated_at IS NULL ORDER BY c.name, u.role, u.name`,
    Schema.decodeUnknownEffect(Schema.Array(Person))
  );
  if (as === undefined || as === "") return picker(yield* people, target);
  if (!/^[^@\s]+@[^@\s]+$/.test(as))
    return picker(yield* people, target, `${as} is not an email address.`);
  const user = yield* (yield* Users.Users).findByEmail(as);
  if (user?.deactivatedAt)
    return picker(yield* people, target, `${as} is deactivated; reactivate them from /company.`);
  const now = yield* Clock.currentTimeMillis;
  // A new email gets a stable stand-in Clerk id, so accepting an invitation creates its user.
  const claims = {
    sub: user?.clerkUserId ?? `dev_${sha256(as).slice(0, 24)}`,
    email: user?.email ?? as,
    name: user?.name ?? "",
    sid: `dev_${randomToken(12)}`,
    exp: Math.floor(now / 1_000) + LIFETIME_SECONDS
  };
  return withCookies(
    HttpServerResponse.redirect(target, {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    }),
    [seal(claims)]
  );
});

/** The sign-in page; registered only alongside `layer`. Settings are checked once, on the way up. */
export const routes = Layer.unwrap(
  Effect.map(persona, ({ publicUrl, seal }) =>
    HttpRouter.use((router) => router.add("GET", "/dev/sign-in", signIn(publicUrl, seal)))
  )
);
