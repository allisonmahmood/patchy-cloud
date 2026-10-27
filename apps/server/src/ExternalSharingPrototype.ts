/**
 * Local-only experiment for #924. Installed only on loopback in development/test.
 * Grant persistence and policy belong to PatchGrants, using the normal migration record.
 * Real sessions, patch bytes, runtime operations and server-side grants.
 * No company membership, machine token or direct resource credential is created.
 */
import * as ByteSize from "effect/ByteSize";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import {
  DevPersonas,
  RequireSession,
  Session,
  pageResponse,
  sessionScripts,
  signOutForm,
  withCookies
} from "@patchy/auth";
import { Companies, Users } from "@patchy/companies";
import { escapeAttribute, escapeHtml, newInternalId } from "@patchy/core";
import { Content, PatchGrants, Patches } from "@patchy/patches";
import { PatchAccess } from "@patchy/runtime";
import { handlerKinds, WIRE_VERSION } from "@patchy/api";
import { homeStyles, PortalPages, renderSharedHome } from "@patchy/portal";
import { Pages } from "@patchy/serving";
import {
  contentSecurityPolicy,
  PATCH_PERMISSIONS_POLICY,
  shellContentSecurityPolicy,
  renderPatchWrapper,
  renderShellNotice
} from "@patchy/serving/shell";

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
  const probe = () => fetch('/~shared/access/' + url.searchParams.get('patch') + '/' + url.searchParams.get('version'), { cache: 'no-store', redirect: 'manual' });
  const check = async () => {
    try {
      let reply = await probe();
      // A stale cookie can start Clerk's handshake; keep that hop outside fetch.
      // Refresh through the existing session client, then recheck the grant itself.
      if (reply.status === 401 || reply.type === 'opaqueredirect') {
        if (await window.patchySession?.refresh() === 'refreshed') reply = await probe();
      }
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

const recipientId = (subject: string) => `recipient:${subject}`;

/** Only Runtime receives this identity. First-party company and builder doors still
 * resolve real membership, and a grant never inserts or changes a users row.
 */
export const runtimeAccess = Layer.unwrap(
  Effect.gen(function* () {
    if (!(yield* enabled)) return Layer.empty;
    const grants = yield* PatchGrants.PatchGrants;
    const users = yield* Users.Users;
    return Layer.succeed(
      PatchAccess.recipient,
      Effect.fn("ExternalSharingPrototype.runtimeAccess")(function* (claims, target) {
        const grant = yield* grants.admit(claims.sub, target.patchId, target.versionId);
        if (grant === null || grant.tier === 0) return null;
        const member = yield* users.findByClerkId(claims.sub);
        if (member?.companyId === grant.companyId) return null;
        return {
          user: {
            id: recipientId(claims.sub),
            name: claims.name || claims.email,
            email: claims.email
          },
          company: { id: grant.companyId, handle: grant.handle, name: grant.company },
          admin: false
        };
      })
    );
  })
);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const session = yield* Session.Session;
  const users = yield* Users.Users;
  const companies = yield* Companies.Companies;
  const grants = yield* PatchGrants.PatchGrants;
  const patches = yield* Patches.Patches;
  const content = yield* Content.Content;
  const recipient = Effect.fn("ExternalSharingPrototype.recipient")(function* (claims: Claims) {
    const facts = yield* session.account(claims);
    return { sub: claims.sub, verifiedEmails: facts.verifiedEmails };
  });
  const forRecipient = (claims: Claims) => Effect.flatMap(recipient(claims), grants.inbox);
  const canOpen = (claims: Claims, patchId: string, versionId?: string) =>
    Effect.map(grants.admit(claims.sub, patchId, versionId), (grant) => grant !== null);
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
    const facts = yield* session.account(claims);
    const shares = yield* grants.inbox({ sub: claims.sub, verifiedEmails: facts.verifiedEmails });
    const companyInvites =
      user === null && facts.verifiedEmails.includes(claims.email.toLowerCase())
        ? yield* companies.findInvitesByEmail(claims.email)
        : [];
    const enrollment =
      user === null &&
      (yield* users.findByClerkId(claims.sub)) === null &&
      (companyInvites.length > 0 || facts.canCreateCompany)
        ? `<p><a href="/join">${companyInvites.length > 0 ? "Join your company" : "Create company"}</a></p>`
        : "";
    const company = user === null ? null : yield* companies.findById(user.companyId);
    if (user !== null && company === null)
      return yield* Effect.die(new Error("User company is missing"));
    let management = "";
    if (user !== null) {
      const inventory =
        yield* sql`SELECT p.id, p.name FROM patches p JOIN patch_versions v ON v.id = p.current_version_id
        WHERE p.company_id = ${user.companyId} AND p.retired_at IS NULL AND p.deleted_at IS NULL AND p.disabled_at IS NULL
        AND p.scope = 'company' AND (p.owner_user_id = ${user.id} OR ${user.role === "admin"}) ORDER BY p.name`;
      const owned = yield* grants.managed(claims);
      management = `<section class="section"><h2 class="section-heading">Share a patch</h2><p class="supporting-text">Recipients can use this live patch and its declared data and connections, including writes. Share only tools and data intended for them.</p>${inventory.length === 0 ? "<p>No company-only patches to share yet.</p>" : `<form class="confirmation-form" method="post" action="/~shared/grant"><label class="field-label" for="patchId">Patch</label><select class="field" name="patchId" id="patchId">${inventory.map((p) => `<option value="${escapeAttribute(p.id)}">${escapeHtml(p.name)}</option>`).join("")}</select><label class="field-label" for="email">Recipient’s email</label><input class="field" name="email" id="email" type="email" required><div class="actions"><button class="btn btn-primary" type="submit">Invite to this patch</button></div></form>`}</section>${owned.length === 0 ? "" : `<section class="section"><h2 class="section-heading">External access you manage</h2><div class="list">${owned.map((share) => `<div class="list-row"><div class="shared-heading"><div><strong>${escapeHtml(share.name)}</strong><p>${escapeHtml(share.email)} · ${share.revoked ? "Revoked" : share.subject === null ? "Invited" : "Accepted"}</p></div>${share.revoked ? "" : `<form method="post" action="/~shared/revoke/${escapeAttribute(share.id)}"><button class="btn btn-danger" type="submit">${share.subject === null ? "Cancel invitation" : "Revoke access"}</button></form>`}</div>${share.revoked ? "" : `<p class="supporting-text shared-link">Invitation: <a href="/~shared/invite/${escapeAttribute(share.id)}">${escapeHtml(session.publicBaseUrl)}/~shared/invite/${escapeHtml(share.id)}</a></p>`}</div>`).join("")}</div></section>`}`;
    }
    return pageResponse(
      {
        title: user === null ? "Home" : "Shared with you",
        heading: "",
        body: `${renderSharedHome(shares, query, user === null ? "/" : "/shared")}<p class="supporting-text home-foot">Signed in as ${escapeHtml(claims.email)}. ${user === null ? "Your account can open shared patches. Creating and publishing patches requires company access." : 'Your company membership is unchanged. <a href="/">Your company home</a>'}</p>${enrollment}${management}`,
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
    // A company deactivates its own membership, not another company’s grant.
    const activeUser = user?.deactivatedAt ? null : user;
    const guest = activeUser === null;
    if (request.method === "GET" && path === "/" && guest) return yield* inbox(claims, null);
    if (request.method === "GET" && path === "/shared") return yield* inbox(claims, activeUser);
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
      const invitations = yield* forRecipient(claims);
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
        `<p>${escapeHtml(share.company)} shared this page with ${escapeHtml(share.email)}.</p><p>You can use this live patch without joining the company.</p><form method="post" action="/~shared/accept/${escapeAttribute(share.id)}"><button class="btn btn-primary" type="submit">Accept invitation</button></form>${signOutForm(true, path)}`
      );
    }
    const accept = path.match(/^\/~shared\/accept\/([^/]+)$/);
    if (request.method === "POST" && accept) {
      const accepted = yield* grants.accept(yield* recipient(claims), accept[1]!);
      return accepted !== null
        ? redirect(`/${accepted.handle}/${accepted.name}`)
        : page(
            "Invitation unavailable",
            '<p>This invitation has ended or belongs to another person.</p><p><a href="/shared">Shared with you</a></p>',
            403
          );
    }
    if (request.method === "POST" && path === "/~shared/grant") {
      const form = yield* request.urlParamsBody.pipe(
        Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(8))
      );
      const input = yield* decodeForm(Object.fromEntries(form));
      yield* grants.invite(claims, {
        ...input,
        ...(session.clerk
          ? {
              destination: (id: string) => {
                const portal = new URL(session.signInUrl(`/~shared/invite/${id}`));
                portal.pathname = "/sign-up";
                return portal.href;
              }
            }
          : {})
      });
      return redirect("/shared");
    }
    const revoke = path.match(/^\/~shared\/revoke\/([^/]+)$/);
    if (request.method === "POST" && revoke)
      return (yield* grants.revoke(claims, revoke[1]!)) ? redirect("/shared") : refused();

    if (sharedPath) return Pages.notFound;
    if (guest && path.toLowerCase() === "/join") return null;
    if (guest && /^\/(join|company|patches|guide|machines|login\/device|oauth)(\/|$)/i.test(path))
      return refused();
    if (request.method !== "GET") return null;
    const address = path.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)(\/.*)?$/);
    const route = Pages.addressRouteOf(address?.[3] ?? "");
    const internal = path.match(/^\/~content\/([^/]+)\/([^/]+)$/);
    if (!address && !internal) return null;
    const resolved = address ? yield* patches.resolveName(address[1]!, address[2]!) : Option.none();
    const patchId = internal?.[1] ?? (Option.isSome(resolved) ? resolved.value.patchId : undefined);
    if (patchId === undefined) return null;
    const found = yield* patches.find(patchId, undefined, internal?.[2]);
    if (Option.isNone(found)) return null;
    const { patch, version } = found.value;
    if (patch.scope === "public" || user?.companyId === patch.companyId) return null;
    if (
      (address && route.versionNumber !== undefined) ||
      !(yield* canOpen(claims, patch.id, version.id))
    )
      return Pages.notFound;
    if (version.tier >= 1 && version.wireVersion !== WIRE_VERSION)
      return HttpServerResponse.text(renderShellNotice("needs_rebuild", request.url), {
        status: 409,
        contentType: "text/html",
        headers: {
          "cache-control": "private, no-store",
          "content-security-policy": shellContentSecurityPolicy(0)
        }
      });
    const html = yield* content.read(version);
    const response = internal
      ? HttpServerResponse.text(html, {
          contentType: "text/html",
          headers: {
            "content-security-policy": contentSecurityPolicy(version.tier),
            "permissions-policy": PATCH_PERMISSIONS_POLICY
          }
        })
      : HttpServerResponse.text(
          renderPatchWrapper({
            patch,
            version,
            html,
            scope: "company",
            viewerId: recipientId(claims.sub),
            handlerKinds: handlerKinds(version.manifest.handlers),
            ...(version.tier >= 1
              ? {
                  nonce: newInternalId("boot"),
                  base: `/${patch.companyHandle}/${patch.name}`,
                  route: route.route
                }
              : {}),
            head: `${sessionScripts(session)}<script defer src="/~shared/session.js?patch=${escapeAttribute(patch.id)}&amp;version=${escapeAttribute(version.id)}"></script>`
          }),
          {
            contentType: "text/html",
            headers: {
              "content-security-policy": session.clerk
                ? shellContentSecurityPolicy(version.tier, session.clerk.frontendApiHost).replace(
                    "connect-src ",
                    "connect-src 'self' "
                  )
                : version.tier === 0
                  ? `${shellContentSecurityPolicy(0)}; script-src 'self'; connect-src 'self'`
                  : shellContentSecurityPolicy(version.tier)
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
          CannotSharePatch: (error) =>
            Effect.succeed(
              page("Cannot share this patch", `<p>${escapeHtml(error.message)}</p>`, 403)
            ),
          InvitationDeliveryFailed: () =>
            Effect.succeed(
              page(
                "Invitation saved",
                '<p>The invitation is saved, but its email could not be sent. Try inviting this address again to retry delivery.</p><p><a href="/shared">External access</a></p>',
                502
              )
            ),
          InvitationCompensationFailed: (error) =>
            Effect.succeed(
              page(
                "Invitation changed",
                `<p>${escapeHtml(error.message)}</p><p><a href="/shared">External access</a></p>`,
                502
              )
            ),
          GrantRevocationMailFailed: (error) =>
            Effect.succeed(
              page(
                "Access revoked",
                `<p>${escapeHtml(error.message)}</p><p><a href="/shared">External access</a></p>`,
                502
              )
            ),
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
