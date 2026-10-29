import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/http/Cookies";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { Users } from "@patchy/companies";
import { Cryptography, escapeAttribute, escapeHtml } from "@patchy/core";
import * as Session from "./Session.js";
import { pageResponse, returnPath, withCookies } from "./page.js";

/**
 * Dev personas: anyone signs in as any email, no Clerk. The dev runner's
 * environments (`pnpm dev up`) turn this on by setting
 * `PATCHY_DEV_PERSONAS_SECRET`. It refuses to start unless `NODE_ENV` is
 * development or test and the public origin is loopback, and the server then
 * listens on loopback only, so neither a stray secret nor a LAN neighbour can
 * sign in. `/dev/sign-in?as=<email>&return=<path>` signs in, unless the
 * browser says another site sent it there; `/dev/sign-in` lists the active
 * people to pick from.
 */

export class DevPersonasOutsideDevelopment extends Schema.TaggedError<DevPersonasOutsideDevelopment>()(
  "DevPersonasOutsideDevelopment",
  { environment: Schema.String }
) {
  override get message() {
    return `Dev personas run only with NODE_ENV=development or test, not ${this.environment}.`;
  }
}

export class DevPersonasOnPublicOrigin extends Schema.TaggedError<DevPersonasOnPublicOrigin>()(
  "DevPersonasOnPublicOrigin",
  { origin: Schema.String }
) {
  override get message() {
    return `Dev personas run only on a loopback origin, not ${this.origin}.`;
  }
}

/** The runner sets the secret; its presence alone selects personas over Clerk. */
export const enabled = Config.option(Config.Redacted("PATCHY_DEV_PERSONAS_SECRET")).pipe(
  Config.map(Option.isSome)
);

/** No default for NODE_ENV: personas need an explicit development or test process. */
export const config = Config.all({
  secret: Config.Redacted("PATCHY_DEV_PERSONAS_SECRET"),
  publicUrl: Session.publicUrlConfig,
  environment: Config.String("NODE_ENV")
});

export const COOKIE = "patchy_dev_person";
const LIFETIME_SECONDS = 30 * 24 * 60 * 60;

const Claims = Schema.fromJsonString(Session.SessionClaims);
const decodeClaims = Schema.decodeUnknownOption(Claims);
const encodeClaims = Schema.encodeSync(Claims);

/** Settings checked once, plus the cookie codec both the Session and the route use. */
const persona = Effect.gen(function* () {
  const { secret, publicUrl, environment } = yield* config;
  if (environment !== "development" && environment !== "test")
    return yield* new DevPersonasOutsideDevelopment({ environment });
  if (!Session.isLoopback(publicUrl))
    return yield* new DevPersonasOnPublicOrigin({ origin: publicUrl.origin });
  const cryptography = yield* Cryptography.Cryptography;
  const mac = (payload: string) => cryptography.hmacSha256(Redacted.value(secret), payload);
  const attributes = `Path=/; HttpOnly; SameSite=Lax${publicUrl.protocol === "https:" ? "; Secure" : ""}`;
  return {
    publicUrl,
    seal: Effect.fnUntraced(function* (claims: typeof Session.SessionClaims.Type) {
      const payload = Buffer.from(encodeClaims(claims)).toString("base64url");
      const signature = Buffer.from(yield* mac(payload)).toString("base64url");
      return `${COOKIE}=${payload}.${signature}; ${attributes}; Max-Age=${LIFETIME_SECONDS}`;
    }),
    open: Effect.fnUntraced(function* (value: string) {
      const [payload = "", signature = ""] = value.split(".");
      if (!(yield* cryptography.equal(Buffer.from(signature, "base64url"), yield* mac(payload))))
        return Option.none();
      return decodeClaims(Buffer.from(payload, "base64url").toString());
    }),
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
    const claims = yield* open(value);
    if (Option.isNone(claims)) return signedOut("dev-persona-invalid", [cleared]);
    if (claims.value.exp * 1_000 <= (yield* Clock.currentTimeMillis))
      return signedOut("dev-persona-expired", [cleared]);
    return { status: "signed-in", claims: claims.value, cookies: [] } as const;
  });
  return Session.Session.of({
    publicBaseUrl: publicUrl.origin,
    clerk: undefined,
    signInUrl: (path) => new URL(`/dev/sign-in?return=${encodeURIComponent(path)}`, publicUrl).href,
    waitlistUrl: undefined,
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
  seal: (claims: typeof Session.SessionClaims.Type) => Effect.Effect<string>
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const cryptography = yield* Cryptography.Cryptography;
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
  // Another site may not change who you are, mid-consent included. The dev tools that switch
  // persona open this URL directly, so their browsers send `none` or no header at all.
  const from = request.headers["sec-fetch-site"];
  if (from === "cross-site" || from === "same-site")
    return pageResponse({
      title: "Sign in from this instance",
      status: 403,
      body: `<p>Another site asked to sign you in as someone else, so nothing changed. To switch, open <a href="${escapeAttribute(`/dev/sign-in?return=${encodeURIComponent(target)}`)}">the people on this instance</a> and pick one.</p>`
    });
  if (!/^[^@\s]+@[^@\s]+$/.test(as))
    return picker(yield* people, target, `${as} is not an email address.`);
  const user = yield* (yield* Users.Users).findByEmail(as);
  if (user?.deactivatedAt)
    return picker(yield* people, target, `${as} is deactivated; reactivate them from /company.`);
  const now = yield* Clock.currentTimeMillis;
  // A new email gets a stable stand-in Clerk id, so accepting an invitation creates its user.
  const claims = {
    sub: user?.clerkUserId ?? `dev_${(yield* cryptography.sha256(as)).slice(0, 24)}`,
    email: user?.email ?? as,
    name: user?.name ?? "",
    sid: `dev_${yield* cryptography.token(12)}`,
    exp: Math.floor(now / 1_000) + LIFETIME_SECONDS
  };
  return withCookies(
    HttpServerResponse.redirect(target, {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    }),
    [yield* seal(claims)]
  );
});

/** The sign-in page; registered only alongside `layer`. Settings are checked once, on the way up. */
export const routes = Layer.unwrap(
  Effect.map(persona, ({ publicUrl, seal }) =>
    HttpRouter.use((router) => router.add("GET", "/dev/sign-in", signIn(publicUrl, seal)))
  )
);
