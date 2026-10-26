/**
 * Local-only experiment for #924. Installed only on loopback in development/test.
 * Scratch tables deliberately stay outside the production migration record.
 * Real sessions, patch bytes and server-side grants; static patches only.
 * No company user, machine token or resource authority is created for a recipient.
 */
import * as ByteSize from "effect/ByteSize";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  DevPersonas,
  RequireSession,
  Session,
  pageResponse,
  sessionScripts,
  signOutForm,
  withCookies
} from "@patchy/auth";
import { Companies, InviteMail, Users } from "@patchy/companies";
import { escapeAttribute, escapeHtml, newInternalId } from "@patchy/core";
import { Content, Patches } from "@patchy/patches";
import { homeStyles, PortalPages, renderSharedHome } from "@patchy/portal";
import { Pages } from "@patchy/serving";
import {
  contentSecurityPolicy,
  PATCH_CONTENT_SECURITY_POLICY,
  PATCH_PERMISSIONS_POLICY,
  shellContentSecurityPolicy,
  renderPatchWrapper
} from "@patchy/serving/shell";

const Share = Schema.Struct({
  id: Schema.String,
  patchId: Schema.String,
  email: Schema.String,
  subject: Schema.NullOr(Schema.String),
  revoked: Schema.Boolean,
  name: Schema.String,
  title: Schema.String,
  company: Schema.String,
  handle: Schema.String
});
const decodeShares = Schema.decodeUnknownEffect(Schema.Array(Share));
const decodeForm = Schema.decodeUnknownEffect(
  Schema.Struct({
    patchId: Schema.NonEmptyString,
    email: Schema.String.check(
      Schema.isPattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/),
      Schema.isMaxLength(254)
    )
  })
);
type Claims = RequireSession.SignedIn["Service"];

export const enabled = Effect.gen(function* () {
  const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
  const session = yield* Session.Session;
  if (
    (environment !== "development" && environment !== "test") ||
    !Session.isLoopback(new URL(session.publicBaseUrl))
  )
    return false;
  if (yield* DevPersonas.enabled) return true;
  if (!session.clerk?.publishableKey.startsWith("pk_test_")) return false;
  return yield* Config.Boolean("PATCHY_DEV_EXTERNAL_SHARING").pipe(Config.withDefault(false));
});

function requestPath(target: string, pathname: string): string | null {
  try {
    // Match the router's decoding, query delimiters and slash normalization.
    // Keep origin-form //paths as paths rather than interpreting a new host.
    const raw = target.startsWith("/") ? target : pathname;
    const decoded = decodeURI(raw.split(/[?;#]/, 1)[0]!).replace(/\/+/g, "/");
    return decoded.length > 1 ? decoded.replace(/\/+$/, "") : decoded;
  } catch {
    return null;
  }
}

const script = `(() => {
  const url = new URL(document.currentScript.src);
  const check = async () => {
    try {
      const reply = await fetch('/~shared/access/' + url.searchParams.get('patch') + '/' + url.searchParams.get('version'), { cache: 'no-store' });
      if (reply.ok) return;
    } catch {}
    document.querySelector('#patch')?.remove();
    location.replace('/~shared/ended');
  };
  setInterval(check, 2000);
  addEventListener('focus', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  void check();
})();`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const session = yield* Session.Session;
  const users = yield* Users.Users;
  const companies = yield* Companies.Companies;
  const mail = yield* InviteMail.InviteMail;
  const patches = yield* Patches.Patches;
  const content = yield* Content.Content;
  // Only this branch's loopback development/test instance reaches these scratch tables.
  yield* sql`CREATE TABLE IF NOT EXISTS prototype_external_shares (
    id TEXT PRIMARY KEY,
    patch_id TEXT NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    subject TEXT,
    revoked BOOLEAN NOT NULL DEFAULT false,
    created_by TEXT NOT NULL REFERENCES users(id),
    UNIQUE(patch_id, email)
  )`;
  yield* sql`ALTER TABLE prototype_external_shares ADD COLUMN IF NOT EXISTS clerk_invitation_id TEXT`;

  const rows = Effect.fn("ExternalSharingPrototype.rows")(function* (
    query: Effect.Effect<ReadonlyArray<unknown>, SqlError>
  ) {
    // The SQL client decodes through the same schema for every list.
    return yield* query.pipe(
      Effect.flatMap(decodeShares),
      Effect.catchTags({ SchemaError: Effect.die })
    );
  });
  const columns = sql`s.id, p.id AS "patchId", s.email, s.subject, s.revoked,
    p.name, p.title, c.name AS company, c.handle`;
  const joins = sql`FROM prototype_external_shares s JOIN patches p ON p.id = s.patch_id
    JOIN companies c ON c.id = p.company_id JOIN patch_versions v ON v.id = p.current_version_id`;
  const available = sql`p.retired_at IS NULL AND p.deleted_at IS NULL AND p.disabled_at IS NULL AND v.tier = 0`;
  const forRecipient = (claims: Claims) =>
    rows(sql`
    SELECT ${columns} ${joins} WHERE NOT s.revoked AND ${available}
    AND (s.subject = ${claims.sub} OR (s.subject IS NULL AND s.email = ${claims.email.toLowerCase()}))
    ORDER BY c.name, p.name`);
  const canOpen = Effect.fn("ExternalSharingPrototype.canOpen")(function* (
    claims: Claims,
    patchId: string,
    versionId?: string
  ) {
    const found = yield* sql`SELECT s.id ${joins} WHERE s.patch_id = ${patchId}
      AND s.subject = ${claims.sub} AND NOT s.revoked AND ${available}
      ${versionId === undefined ? sql`` : sql`AND v.id = ${versionId}`}`;
    return found.length > 0;
  });
  const redirect = (path: string) =>
    HttpServerResponse.redirect(path, {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    });
  const page = (title: string, body: string, status = 200) =>
    pageResponse(
      {
        title,
        status,
        body,
        styles:
          ".shared-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; } .shared-link { overflow-wrap:anywhere; }"
      },
      session
    );
  const refused = () =>
    page(
      "This account opens shared patches",
      `<p>Only company members can build patches or open company administration.</p><div class="actions"><a class="btn btn-primary" href="/shared">Shared with you</a></div>${signOutForm()}`,
      403
    );
  const inbox = Effect.fn("ExternalSharingPrototype.inbox")(function* (
    claims: Claims,
    user: Users.User | null
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = (new URL(request.url, session.publicBaseUrl).searchParams.get("q") ?? "")
      .trim()
      .slice(0, 256);
    const shares = yield* forRecipient(claims);
    const company = user === null ? null : yield* companies.findById(user.companyId);
    if (user !== null && company === null)
      return yield* Effect.die(new Error("User company is missing"));
    let management = "";
    if (user !== null) {
      const inventory =
        yield* sql`SELECT p.id, p.name FROM patches p JOIN patch_versions v ON v.id = p.current_version_id
        WHERE p.company_id = ${user.companyId} AND p.retired_at IS NULL AND p.deleted_at IS NULL AND p.disabled_at IS NULL
        AND p.scope = 'company' AND v.tier = 0 AND (p.owner_user_id = ${user.id} OR ${user.role === "admin"}) ORDER BY p.name`;
      const owned =
        yield* rows(sql`SELECT ${columns} ${joins} WHERE p.company_id = ${user.companyId}
        AND (p.owner_user_id = ${user.id} OR ${user.role === "admin"}) ORDER BY p.name, s.email`);
      management = `<section class="section"><h2 class="section-heading">Share a patch</h2><p class="supporting-text">Recipients can read the entire static page. Share only information intended for them.</p>${inventory.length === 0 ? "<p>No company-only static patches to share yet.</p>" : `<form class="confirmation-form" method="post" action="/~shared/grant"><label class="field-label" for="patchId">Patch</label><select class="field" name="patchId" id="patchId">${inventory.map((p) => `<option value="${escapeAttribute(p.id)}">${escapeHtml(p.name)}</option>`).join("")}</select><label class="field-label" for="email">Recipient’s email</label><input class="field" name="email" id="email" type="email" required><div class="actions"><button class="btn btn-primary" type="submit">Invite to this patch</button></div></form>`}</section>${owned.length === 0 ? "" : `<section class="section"><h2 class="section-heading">External access you manage</h2><div class="list">${owned.map((share) => `<div class="list-row"><div class="shared-heading"><div><strong>${escapeHtml(share.name)}</strong><p>${escapeHtml(share.email)} · ${share.revoked ? "Revoked" : share.subject === null ? "Invited" : "Accepted"}</p></div>${share.revoked ? "" : `<form method="post" action="/~shared/revoke/${escapeAttribute(share.id)}"><button class="btn btn-danger" type="submit">${share.subject === null ? "Cancel invitation" : "Revoke access"}</button></form>`}</div>${share.revoked ? "" : `<p class="supporting-text shared-link">Invitation: <a href="/~shared/invite/${escapeAttribute(share.id)}">${escapeHtml(session.publicBaseUrl)}/~shared/invite/${escapeHtml(share.id)}</a></p>`}</div>`).join("")}</div></section>`}`;
    }
    return pageResponse(
      {
        title: user === null ? "Home" : "Shared with you",
        heading: "",
        body: `${renderSharedHome(shares, query, user === null ? "/" : "/shared")}<p class="supporting-text home-foot">Signed in as ${escapeHtml(claims.email)}. ${user === null ? "Your account can open shared patches. Creating and publishing patches requires company access." : 'Your company membership is unchanged. <a href="/">Your company home</a>'}</p>${management}`,
        styles:
          homeStyles +
          ".shared-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; } .shared-link { overflow-wrap:anywhere; }",
        app: {
          viewer:
            user === null || company === null
              ? { user: { name: claims.name || claims.email }, company: null }
              : { user, company, whatsNewSeen: user.whatsNewSeen },
          section: "home"
        }
      },
      session
    );
  });

  const forAccount = Effect.fn("ExternalSharingPrototype.forAccount")(function* (
    claims: Claims,
    path: string
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const sharedPath = path === "/shared" || path.startsWith("/~shared/");
    const user = yield* users.findByClerkId(claims.sub);
    if (user?.deactivatedAt) return sharedPath ? refused() : null;
    const invitations = yield* forRecipient(claims);
    const guest = user === null;
    if (request.method === "GET" && path === "/" && guest) return yield* inbox(claims, null);
    if (request.method === "GET" && path === "/shared") return yield* inbox(claims, user);
    if (request.method === "GET" && path === "/~shared/ended")
      return page(
        "This patch is no longer available",
        '<p>Your access ended, your account changed, or the page is no longer shared. The open patch has been closed.</p><div class="actions"><a class="btn btn-primary" href="/shared">Shared with you</a></div>',
        403
      );
    const check = path.match(/^\/~shared\/access\/([^/]+)\/([^/]+)$/);
    if (request.method === "GET" && check) {
      const allowed = yield* canOpen(claims, check[1]!, check[2]!);
      return HttpServerResponse.jsonUnsafe(
        { allowed },
        { status: allowed ? 200 : 403, headers: { "cache-control": "private, no-store" } }
      );
    }
    const invitation = path.match(/^\/~shared\/invite\/([^/]+)$/);
    if (request.method === "GET" && invitation) {
      const share = invitations.find((entry) => entry.id === invitation[1]);
      if (share === undefined)
        return page(
          "Invitation unavailable",
          `<p>This invitation has ended or belongs to another email address.</p>${signOutForm(true, path)}<p><a href="/shared">Shared with you</a></p>`,
          403
        );
      if (share.subject !== null) return redirect(`/${share.handle}/${share.name}`);
      return page(
        `Open ${share.name}`,
        `<p>${escapeHtml(share.company)} shared this page with ${escapeHtml(claims.email)}.</p><p>You can read this page without joining the company.</p><form method="post" action="/~shared/accept/${escapeAttribute(share.id)}"><button class="btn btn-primary" type="submit">Accept invitation</button></form>${signOutForm(true, path)}`
      );
    }
    const accept = path.match(/^\/~shared\/accept\/([^/]+)$/);
    if (request.method === "POST" && accept) {
      // Claim exactly once by signed-in email; afterwards only the stable subject counts.
      const accepted = yield* sql`UPDATE prototype_external_shares s SET subject = ${claims.sub}
        FROM patches p, patch_versions v, companies c WHERE s.id = ${accept[1]!} AND p.id = s.patch_id AND c.id = p.company_id
        AND v.id = p.current_version_id AND ${available} AND NOT s.revoked
        AND ((s.subject IS NULL AND s.email = ${claims.email.toLowerCase()}) OR s.subject = ${claims.sub}) RETURNING s.id, p.name, c.handle`;
      return accepted.length > 0
        ? redirect(`/${String(accepted[0]!.handle)}/${String(accepted[0]!.name)}`)
        : page(
            "Invitation unavailable",
            '<p>This invitation has ended or belongs to another person.</p><p><a href="/shared">Shared with you</a></p>',
            403
          );
    }
    if (request.method === "POST" && path === "/~shared/grant") {
      if (user === null) return refused();
      const form = yield* request.urlParamsBody.pipe(
        Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(8))
      );
      const input = yield* decodeForm(Object.fromEntries(form));
      const selected =
        yield* sql`SELECT p.id FROM patches p JOIN patch_versions v ON v.id = p.current_version_id
        WHERE p.id = ${input.patchId} AND p.company_id = ${user.companyId} AND ${available}
        AND p.scope = 'company' AND (p.owner_user_id = ${user.id} OR ${user.role === "admin"})`;
      if (selected.length === 0)
        return page(
          "Cannot share this patch",
          "<p>Only the owner or a company admin can share a live, company-only static patch.</p>",
          403
        );
      const [grant] =
        yield* sql`INSERT INTO prototype_external_shares (id, patch_id, email, created_by)
        VALUES (${newInternalId("share")}, ${input.patchId}, ${input.email.toLowerCase()}, ${user.id})
        ON CONFLICT (patch_id, email) DO UPDATE SET
          id = CASE WHEN prototype_external_shares.revoked THEN excluded.id ELSE prototype_external_shares.id END,
          subject = CASE WHEN prototype_external_shares.revoked THEN NULL ELSE prototype_external_shares.subject END,
          clerk_invitation_id = CASE WHEN prototype_external_shares.revoked THEN NULL ELSE prototype_external_shares.clerk_invitation_id END,
          created_by = CASE WHEN prototype_external_shares.revoked THEN excluded.created_by ELSE prototype_external_shares.created_by END,
          revoked = false
        RETURNING id, subject, clerk_invitation_id AS "mailId"`;
      if (session.clerk && grant!.subject === null && grant!.mailId === null) {
        const portal = new URL(session.signInUrl(`/~shared/invite/${String(grant!.id)}`));
        portal.pathname = "/sign-up";
        const sent = yield* mail.create(input.email.toLowerCase(), portal.href).pipe(Effect.result);
        if (sent._tag === "Failure")
          return page(
            "Invitation saved",
            '<p>The invitation is saved, but its email could not be sent. Try inviting this address again to retry delivery.</p><p><a href="/shared">External access</a></p>',
            502
          );
        // Revocation may finish while Clerk sends the email. Attach only to the same
        // active grant; cancel an in-flight or duplicate invitation that lost the race.
        const attached =
          yield* sql`UPDATE prototype_external_shares SET clerk_invitation_id = ${sent.success}
          WHERE id = ${String(grant!.id)} AND NOT revoked AND clerk_invitation_id IS NULL RETURNING id`;
        if (attached.length === 0) {
          const kept = yield* sql`SELECT id FROM prototype_external_shares
            WHERE id = ${String(grant!.id)} AND NOT revoked AND clerk_invitation_id = ${sent.success}`;
          if (kept.length === 0) {
            const cancelled = yield* mail
              .revoke(sent.success)
              .pipe(Effect.catchTags({ InvitationNotPending: () => Effect.void }), Effect.result);
            if (cancelled._tag === "Failure")
              return page(
                "Invitation changed",
                '<p>The patch invitation changed while email was being sent. Its account invitation could not be cancelled; it grants no patch or company access.</p><p><a href="/shared">External access</a></p>',
                502
              );
          }
        }
      }
      return redirect("/shared");
    }
    const revoke = path.match(/^\/~shared\/revoke\/([^/]+)$/);
    if (request.method === "POST" && revoke) {
      if (user === null) return refused();
      const changed =
        yield* sql`UPDATE prototype_external_shares s SET revoked = true FROM patches p
        WHERE s.id = ${revoke[1]!} AND p.id = s.patch_id AND p.company_id = ${user.companyId}
        AND (p.owner_user_id = ${user.id} OR ${user.role === "admin"}) RETURNING s.id, s.clerk_invitation_id AS "mailId"`;
      if (changed[0]?.mailId) {
        const cancelled = yield* mail
          .revoke(String(changed[0].mailId))
          .pipe(Effect.catchTags({ InvitationNotPending: () => Effect.void }), Effect.result);
        if (cancelled._tag === "Failure")
          return page(
            "Access revoked",
            '<p>Patch access has ended, but the account invitation email could not be cancelled. It grants no patch or company access.</p><p><a href="/shared">External access</a></p>',
            502
          );
      }
      return changed.length ? redirect("/shared") : refused();
    }
    if (sharedPath) return Pages.notFound;
    if (guest && /^\/(join|company|patches|guide|machines|login\/device|oauth)(\/|$)/i.test(path))
      return refused();
    if (request.method !== "GET") return null;
    const address = path.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)(\/.*)?$/);
    const internal = path.match(/^\/~content\/([^/]+)\/([^/]+)$/);
    if (!address && !internal) return null;
    const resolved = address ? yield* patches.resolveName(address[1]!, address[2]!) : Option.none();
    const patchId = internal?.[1] ?? (Option.isSome(resolved) ? resolved.value.patchId : undefined);
    if (patchId === undefined) return null;
    const found = yield* patches.find(patchId);
    if (Option.isNone(found)) return null;
    const { patch, version } = found.value;
    if (patch.scope === "public" || user?.companyId === patch.companyId) return null;
    if (
      (internal && internal[2] !== version.id) ||
      (address?.[3] && address[3] !== "/") ||
      version.tier !== 0 ||
      !(yield* canOpen(claims, patch.id, version.id))
    )
      return Pages.notFound;
    const html = yield* content.read(version);
    const response = internal
      ? HttpServerResponse.text(html, {
          contentType: "text/html",
          headers: {
            "content-security-policy": contentSecurityPolicy(0),
            "permissions-policy": PATCH_PERMISSIONS_POLICY
          }
        })
      : HttpServerResponse.text(
          renderPatchWrapper({
            patch,
            version,
            html,
            scope: "company",
            head: `${sessionScripts(session)}<script defer src="/~shared/session.js?patch=${escapeAttribute(patch.id)}&amp;version=${escapeAttribute(version.id)}"></script>`
          }),
          {
            contentType: "text/html",
            headers: {
              "content-security-policy": session.clerk
                ? shellContentSecurityPolicy(0, session.clerk.frontendApiHost).replace(
                    "connect-src ",
                    "connect-src 'self' "
                  )
                : `${PATCH_CONTENT_SECURITY_POLICY}; script-src 'self'; connect-src 'self'`
            }
          }
        );
    return HttpServerResponse.setHeaders(response, {
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex"
    });
  });

  const handle = Effect.fn("ExternalSharingPrototype.handle")(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, session.publicBaseUrl);
    const path = requestPath(request.url, url.pathname);
    if (path === null) return page("Request refused", "<p>This address is malformed.</p>", 400);
    const sharedPath = path === "/shared" || path.startsWith("/~shared/");
    if (request.method === "GET" && path === "/login" && !url.searchParams.has("return"))
      return RequireSession.door(session, "/", false, 200, "shared");
    if (path === "/~shared/session.js" && request.method === "GET")
      return HttpServerResponse.text(script, {
        contentType: "text/javascript",
        headers: { "cache-control": "no-store" }
      });
    // Leave the public wire, runtime and session infrastructure to their existing doors.
    if (
      !sharedPath &&
      (path.startsWith("/api/") ||
        path.startsWith("/.well-known/") ||
        path.startsWith("/healthz") ||
        path.startsWith("/auth/") ||
        path.startsWith("/dev/") ||
        path === "/logout" ||
        path === "/login" ||
        path === "/mcp")
    )
      return null;
    if (request.method === "POST" && sharedPath && request.headers.origin !== session.publicBaseUrl)
      return page("Request refused", "<p>Submit this form from this Patchy instance.</p>", 403);
    const signedIn = yield* session.authenticate(
      new Request(url, { method: request.method, headers: request.headers })
    );
    if (signedIn.status === "handshake") {
      // Serving decides whether an initial handshake is needed: public pages
      // stay readable even with an expired session cookie.
      if (!signedIn.completed && !sharedPath && path !== "/") return null;
      return withCookies(
        HttpServerResponse.empty({
          status: signedIn.response.status,
          headers: {
            location: signedIn.response.headers.get("location") ?? "/",
            "cache-control": "private, no-store"
          }
        }),
        signedIn.response.headers.getSetCookie()
      );
    }
    if (signedIn.status === "signed-out") {
      if (!sharedPath && path !== "/") return null;
      return withCookies(
        RequireSession.door(
          session,
          `${path}${url.search}`,
          signedIn.handshakeFailed,
          401,
          "shared"
        ),
        signedIn.cookies
      );
    }
    return yield* forAccount(signedIn.claims, path).pipe(
      Effect.map((response) => (response === null ? null : withCookies(response, signedIn.cookies)))
    );
  });

  return <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const result = yield* handle().pipe(
        Effect.catchTags({
          SchemaError: () =>
            Effect.succeed(
              page(
                "Check the invitation",
                "<p>Choose a patch and enter a valid email address.</p>",
                422
              )
            ),
          SqlError: () =>
            Effect.succeed(page("Sharing is unavailable", "<p>Please try again.</p>", 503)),
          SessionError: () =>
            Effect.succeed(page("Sign-in is unavailable", "<p>Please try again.</p>", 502)),
          InvalidObjectKey: Effect.die,
          StoreUnavailable: Effect.die
        })
      );
      return result ?? (yield* app.pipe(Effect.provideService(PortalPages.SharedInbox, true)));
    });
});
