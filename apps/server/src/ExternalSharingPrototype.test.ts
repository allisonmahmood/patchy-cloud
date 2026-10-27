import { assert, it } from "@effect/vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { CURRENT_RELEASE, MANIFEST_VERSION, PublishCreated, WIRE_VERSION } from "@patchy/api";
import { MachineTokens } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import {
  FRONTEND_API_HOST,
  accountProfiles,
  clerkAccount,
  layerClerkAccounts,
  signedInCookies,
  signHandshake,
  signSession
} from "@patchy/auth/testing";
import { Companies, InviteMail } from "@patchy/companies";
import { html, publish, send, server as makeServer } from "./test/server.js";

const server: typeof makeServer = (...args) =>
  makeServer(...args).pipe(Layer.provide(layerClerkAccounts));

const origin = "http://localhost:3000";
const decodeCreated = Schema.decodeUnknownEffect(PublishCreated);
const login = Effect.fn("RecipientHomeTest.login")(function* (email: string) {
  const response = yield* send(
    HttpClientRequest.get(`/dev/sign-in?as=${encodeURIComponent(email)}&return=%2F`)
  );
  assert.strictEqual(response.status, 303);
  return Cookies.toCookieHeader(response.cookies);
});

const get = (path: string, cookie: string) =>
  send(HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader("cookie", cookie)));
const post = (path: string, cookie: string, fields: Record<string, string> = {}) =>
  send(
    HttpClientRequest.post(path).pipe(
      HttpClientRequest.setHeaders({ cookie, origin }),
      HttpClientRequest.bodyText(
        new URLSearchParams(fields).toString(),
        "application/x-www-form-urlencoded"
      )
    )
  );
const page = Effect.fn("RecipientHomeTest.publish")(function* (
  name: string,
  token = DEV_SEED.token as string
) {
  const response = yield* publish(token, { html: html(name), name });
  assert.strictEqual(response.status, 201);
  return yield* response.json.pipe(Effect.flatMap(decodeCreated));
});
const invite = Effect.fn("RecipientHomeTest.invite")(function* (
  patchId: string,
  email: string,
  cookie: string
) {
  assert.strictEqual((yield* post("/~shared/grant", cookie, { patchId, email })).status, 303);
  const sql = yield* SqlClient.SqlClient;
  const [row] =
    yield* sql`SELECT id FROM patch_grants WHERE patch_id = ${patchId} AND email = ${email}`;
  return String(row!.id);
});

it.layer(
  server({
    NODE_ENV: "test",
    PATCHY_PUBLIC_BASE_URL: origin,
    PATCHY_DEV_PERSONAS_SECRET: "recipient-home-test-secret"
  }).pipe(Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })))
)("signed-in recipient Home", (it) => {
  it.effect("new grants are read-only and only their managers can change permission", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const owner = yield* login(DEV_SEED.email);
      const recipient = yield* login("permissions@example.com");
      const stranger = yield* login("unrelated-permissions@example.com");
      const shared = yield* page("permission-brief");
      const id = yield* invite(shared.patchId, "permissions@example.com", owner);
      const access = () => sql`SELECT access FROM patch_grants WHERE id = ${id}`;
      assert.deepStrictEqual(yield* access(), [{ access: "read" }]);
      // Resending mail cannot silently increase an existing recipient's access.
      assert.strictEqual(
        (yield* post("/~shared/grant", owner, {
          patchId: shared.patchId,
          email: "permissions@example.com",
          access: "write"
        })).status,
        303
      );
      assert.deepStrictEqual(yield* access(), [{ access: "read" }]);
      assert.strictEqual((yield* post(`/~shared/accept/${id}`, recipient)).status, 303);
      for (const cookie of [recipient, stranger])
        assert.strictEqual(
          (yield* post(`/~shared/permission/${id}`, cookie, { access: "write" })).status,
          403
        );
      assert.deepStrictEqual(yield* access(), [{ access: "read" }]);
      assert.strictEqual(
        (yield* post(`/~shared/permission/${id}`, owner, { access: "admin" })).status,
        422
      );
      for (const value of ["write", "read"] as const) {
        assert.strictEqual(
          (yield* post(`/~shared/permission/${id}`, owner, { access: value })).status,
          303
        );
        assert.deepStrictEqual(yield* access(), [{ access: value }]);
      }
      assert.strictEqual((yield* post(`/~shared/revoke/${id}`, owner)).status, 303);
      assert.strictEqual(
        (yield* post(`/~shared/permission/${id}`, owner, { access: "write" })).status,
        403
      );
    })
  );

  it.effect("a company deactivation does not cancel another company's patch grant", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.make;
      const other = yield* companies.create({
        handle: "independent-recipient",
        name: "Recipient Company",
        clerkUserId: "independent-recipient",
        email: "independent@example.com",
        userName: "Recipient"
      });
      const owner = yield* login(DEV_SEED.email);
      const recipient = yield* login(other.user.email);
      const published = yield* publish(DEV_SEED.token, {
        name: "independent-grant",
        html: html("Independent grant"),
        manifest: {
          manifestVersion: MANIFEST_VERSION,
          release: CURRENT_RELEASE,
          tier: 1,
          tables: {},
          files: {},
          uses: {}
        }
      });
      assert.strictEqual(published.status, 201);
      const shared = yield* published.json.pipe(Effect.flatMap(decodeCreated));
      const privatePatch = yield* page("independent-private");
      const id = yield* invite(shared.patchId, other.user.email, owner);
      assert.strictEqual((yield* post(`/~shared/accept/${id}`, recipient)).status, 303);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${other.user.id}`;
      assert.strictEqual((yield* get(new URL(shared.address).pathname, recipient)).status, 200);
      assert.strictEqual(
        (yield* get(new URL(privatePatch.address).pathname, recipient)).status,
        404
      );
      assert.strictEqual((yield* get("/company", recipient)).status, 403);
      const principal = { userId: `recipient:${other.user.clerkUserId}` };
      const runtime = (patch: typeof shared) =>
        send(
          HttpClientRequest.post("/api/runtime/call").pipe(
            HttpClientRequest.setHeaders({
              cookie: recipient,
              origin,
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": JSON.stringify(principal)
            }),
            HttpClientRequest.bodyJsonUnsafe({
              patchId: patch.patchId,
              versionId: patch.versionId,
              principal,
              wire: WIRE_VERSION,
              op: "me",
              args: {}
            })
          )
        );
      assert.strictEqual((yield* runtime(shared)).status, 200);
      assert.strictEqual((yield* runtime(privatePatch)).status, 403);
      assert.strictEqual((yield* post(`/~shared/revoke/${id}`, owner)).status, 303);
      assert.strictEqual((yield* runtime(shared)).status, 403);
    })
  );

  it.effect("needs no company or invitations and cannot self-enroll before visiting Home", () =>
    Effect.gen(function* () {
      const cookie = yield* login("empty@example.com");
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT id FROM companies`;
      const door = yield* send(HttpClientRequest.get("/login"));
      assert.strictEqual(door.status, 200);
      const signIn = yield* door.text;
      assert.include(signIn, "Sign in to open patches shared with your account.");
      assert.include(signIn, "return=%2F");
      assert.notInclude(signIn, "return=%2Fmachines");
      // Try the enrollment door before any inbox visit or identity scratch row exists.
      for (const path of ["/join", "/j%6fin", "/JOIN", "//join//", "/join;test=1"]) {
        assert.strictEqual((yield* get(path, cookie)).status, 403, path);
        assert.strictEqual(
          (yield* post(path, cookie, { action: "create", name: "No", handle: "not-allowed" }))
            .status,
          403,
          path
        );
      }
      for (const path of ["/", "/?company=1", "/shared"]) {
        const response = yield* get(path, cookie);
        assert.strictEqual(response.status, 200);
        const body = yield* response.text;
        assert.include(body, 'class="app"');
        assert.include(body, "Nothing has been shared with you yet");
        assert.include(body, "empty@example.com");
        for (const href of ["/company", "/patches", "/machines", "/guide", "/join"])
          assert.notInclude(body, `href="${href}"`);
        assert.notInclude(body, "Connect your agent");
      }
      for (const path of [
        "/company",
        "/patches",
        "/guide",
        "/machines",
        "/login/device",
        "/oauth/authorize"
      ])
        assert.strictEqual((yield* get(path, cookie)).status, 403, path);
      assert.strictEqual((yield* post("/api/publish", cookie)).status, 401);
      assert.strictEqual((yield* get("/api/me", cookie)).status, 401);
      assert.deepStrictEqual(yield* sql`SELECT id FROM companies`, before);
      assert.deepStrictEqual(
        yield* sql`SELECT id FROM users WHERE email = 'empty@example.com'`,
        []
      );
    })
  );

  it.effect(
    "opens grants from two companies, searches only them and stays restricted after revocation",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const companies = yield* Companies.make;
        const second = yield* companies.create({
          handle: "other-company",
          name: "Other Company",
          clerkUserId: "other-owner",
          email: "owner@other.example",
          userName: "Other Owner"
        });
        const tokens = yield* MachineTokens.make;
        const machine = yield* tokens.mint({ userId: second.user.id, name: "Test machine" });
        const firstPatch = yield* page("shared-brief");
        const secondPatch = yield* page("other-notes", machine.token);
        const privatePatch = yield* page("private-forecast");
        const owner = yield* login(DEV_SEED.email);
        const otherOwner = yield* login(second.user.email);
        const recipient = yield* login("recipient@example.com");
        const a = yield* invite(firstPatch.patchId, "recipient@example.com", owner);
        const b = yield* invite(secondPatch.patchId, "recipient@example.com", otherOwner);
        for (const path of ["/", "/shared"]) {
          const signedOut = yield* send(HttpClientRequest.get(path));
          assert.strictEqual(signedOut.status, 401);
          const body = yield* signedOut.text;
          assert.include(body, "Sign in");
          assert.notInclude(body, "recipient@example.com");
          assert.notInclude(body, "shared-brief");
          assert.notInclude(body, "other-notes");
        }
        const pending = yield* (yield* get("/", recipient)).text;
        assert.include(pending, `action="/~shared/accept/${a}"`);
        assert.include(pending, `action="/~shared/accept/${b}"`);
        assert.notInclude(pending, 'href="/patchy-dev/shared-brief"');
        assert.strictEqual(
          (yield* get(new URL(firstPatch.address).pathname, recipient)).status,
          404
        );
        for (const id of [a, b]) {
          const response = yield* post(`/~shared/accept/${id}`, recipient);
          assert.strictEqual(response.status, 303);
          assert.strictEqual(
            response.headers.location,
            new URL((id === a ? firstPatch : secondPatch).address).pathname
          );
        }
        const home = yield* (yield* get("/", recipient)).text;
        assert.include(home, "Patchy Dev");
        assert.include(home, "Other Company");
        assert.include(home, "shared-brief");
        assert.include(home, "other-notes");
        assert.notInclude(home, "private-forecast");
        const search = yield* (yield* get("/?q=other", recipient)).text;
        assert.include(search, "other-notes");
        assert.notInclude(search, 'href="/patchy-dev/shared-brief"');
        const miss = yield* (yield* get("/?q=private-forecast", recipient)).text;
        assert.include(miss, "No shared patches match");
        assert.notInclude(miss, "Build us a Patchy tool");
        for (const shared of [firstPatch, secondPatch]) {
          const opened = yield* get(new URL(shared.address).pathname, recipient);
          assert.strictEqual(opened.status, 200);
          assert.include(opened.headers["content-security-policy"]!, "script-src 'self'");
          assert.include(opened.headers["content-security-policy"]!, "connect-src 'self'");
        }
        assert.strictEqual(
          (yield* get(new URL(privatePatch.address).pathname, recipient)).status,
          404
        );
        assert.strictEqual(
          (yield* post("/~shared/grant", recipient, {
            patchId: firstPatch.patchId,
            email: "forward@example.com"
          })).status,
          403
        );
        assert.strictEqual((yield* post(`/~shared/revoke/${a}`, owner)).status, 303);
        assert.strictEqual(
          (yield* get(new URL(firstPatch.address).pathname, recipient)).status,
          404
        );
        assert.strictEqual(
          (yield* get(new URL(secondPatch.address).pathname, recipient)).status,
          200
        );
        assert.strictEqual((yield* post(`/~shared/revoke/${b}`, otherOwner)).status, 303);
        assert.include(
          yield* (yield* get("/", recipient)).text,
          "Nothing has been shared with you yet"
        );
        assert.strictEqual(
          (yield* post("/join", recipient, { action: "create", name: "No", handle: "no-company" }))
            .status,
          403
        );
        assert.deepStrictEqual(
          yield* sql`SELECT id FROM users WHERE email = 'recipient@example.com'`,
          []
        );
      })
  );

  it.effect(
    "keeps an existing member's company Home and publishing access when they receive an external share",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.make;
        const other = yield* companies.create({
          handle: "member-source",
          name: "Member Source",
          clerkUserId: "member-source-owner",
          email: "member-source@example.com",
          userName: "Source Owner"
        });
        const tokens = yield* MachineTokens.make;
        const machine = yield* tokens.mint({ userId: other.user.id, name: "Source" });
        const shared = yield* page("member-brief", machine.token);
        const owner = yield* login(other.user.email);
        const member = yield* login(DEV_SEED.email);
        const id = yield* invite(shared.patchId, DEV_SEED.email, owner);
        const home = yield* get("/", member);
        assert.strictEqual(home.status, 200);
        const body = yield* home.text;
        assert.include(body, 'href="/company"');
        assert.include(body, 'href="/shared"');
        assert.notInclude(body, 'href="/member-source/member-brief"');
        const accepted = yield* post(`/~shared/accept/${id}`, member);
        assert.strictEqual(accepted.headers.location, new URL(shared.address).pathname);
        assert.strictEqual((yield* get(new URL(shared.address).pathname, member)).status, 200);
        assert.strictEqual((yield* get("/company", member)).status, 200);
        yield* page("member-can-still-publish");
        const sql = yield* SqlClient.SqlClient;
        const [user] =
          yield* sql`SELECT company_id AS "companyId" FROM users WHERE id = ${DEV_SEED.userId}`;
        assert.strictEqual(user!.companyId, DEV_SEED.companyId);
      })
  );
});

it.layer(
  server({
    NODE_ENV: "test",
    PATCHY_PUBLIC_BASE_URL: origin,
    PATCHY_DEV_EXTERNAL_SHARING: "true"
  }).pipe(Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })))
)("Clerk recipient admission", (it) => {
  it.effect("only a verified email can claim a patch; accepted access follows the account", () =>
    Effect.gen(function* () {
      const shared = yield* page("verified-email-grant");
      const privatePatch = yield* page("verified-email-private");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO patch_grants (id,patch_id,email,created_by) VALUES ('verified_email',${shared.patchId},'invited@example.com',${DEV_SEED.userId})`;
      const sub = "verified_recipient";
      const cookie = signedInCookies(
        signSession({ sub, email: "invited@example.com", azp: origin })
      );
      const profile = clerkAccount(sub, "invited@example.com", {
        public_metadata: { patchySignup: "patch-recipient" }
      });
      accountProfiles.set(sub, {
        ...profile,
        email_addresses: [
          {
            id: "email_test",
            email_address: "invited@example.com",
            verification: { status: "unverified" },
            linked_to: []
          }
        ]
      });
      assert.strictEqual((yield* post("/~shared/accept/verified_email", cookie)).status, 403);
      assert.strictEqual((yield* get(new URL(shared.address).pathname, cookie)).status, 404);
      const [pending] = yield* sql`SELECT subject FROM patch_grants WHERE id='verified_email'`;
      assert.isNull(pending!.subject);
      // Failure to obtain fresh proof never spends the invitation.
      accountProfiles.delete(sub);
      assert.strictEqual((yield* post("/~shared/accept/verified_email", cookie)).status, 502);
      const [stillPending] = yield* sql`SELECT subject FROM patch_grants WHERE id='verified_email'`;
      assert.isNull(stillPending!.subject);
      // A verified secondary address works even when the session's primary email differs.
      accountProfiles.set(sub, profile);
      const otherPrimary = signedInCookies(
        signSession({ sub, email: "primary@example.com", azp: origin })
      );
      assert.strictEqual((yield* post("/~shared/accept/verified_email", otherPrimary)).status, 303);
      accountProfiles.set(
        sub,
        clerkAccount(sub, "primary@example.com", {
          public_metadata: { patchySignup: "patch-recipient" }
        })
      );
      assert.strictEqual((yield* get(new URL(shared.address).pathname, otherPrimary)).status, 200);
      assert.strictEqual(
        (yield* get(new URL(privatePatch.address).pathname, otherPrimary)).status,
        404
      );
      const otherAccount = signedInCookies(
        signSession({ sub: "different_recipient", email: "invited@example.com", azp: origin })
      );
      assert.strictEqual((yield* post("/~shared/accept/verified_email", otherAccount)).status, 403);
      assert.strictEqual((yield* post("/api/publish", otherPrimary)).status, 401);
      assert.strictEqual(
        (yield* post("/join", otherPrimary, {
          action: "create",
          name: "No",
          handle: "not-allowed"
        })).status,
        403
      );
      assert.isUndefined((yield* sql`SELECT id FROM users WHERE clerk_user_id=${sub}`)[0]);
    })
  );

  it.effect("finishes the Clerk handshake and preserves the returned session cookies", () =>
    Effect.gen(function* () {
      const token = signSession({
        sub: "user_external_handshake",
        email: "handshake@example.com",
        azp: origin
      });
      const directives = signedInCookies(token)
        .split("; ")
        .map((cookie) => `${cookie}; Path=/; SameSite=Lax`);
      const reply = yield* send(
        HttpClientRequest.get(
          `/?__clerk_handshake=${encodeURIComponent(signHandshake(directives))}`
        )
      );
      assert.strictEqual(reply.status, 307);
      assert.strictEqual(reply.headers["cache-control"], "private, no-store");
      const cookie = Cookies.toCookieHeader(reply.cookies);
      assert.include(cookie, "__session=");
      const home = yield* get(new URL(reply.headers.location!, origin).pathname, cookie);
      assert.strictEqual(home.status, 200);
      assert.include(yield* home.text, "handshake@example.com");
    })
  );

  it.effect("keeps public pages session-free with a cold expired Clerk cookie", () =>
    Effect.gen(function* () {
      const response = yield* publish(DEV_SEED.token, { html: html("Public"), scope: "public" });
      const created = yield* response.json.pipe(Effect.flatMap(decodeCreated));
      const cookie = signedInCookies(signSession({ azp: origin, iat: 1, nbf: 1, exp: 2 }));
      for (const path of [
        new URL(created.address).pathname,
        `${new URL(created.address).pathname}/~v/1`
      ]) {
        const reply = yield* send(
          HttpClientRequest.get(path).pipe(
            HttpClientRequest.setHeaders({ cookie, accept: "text/html" })
          )
        );
        assert.strictEqual(reply.status, 200);
        assert.strictEqual(reply.headers["cache-control"], "public, max-age=60");
        assert.isUndefined(reply.headers.location);
        assert.deepStrictEqual(Cookies.toSetCookieHeaders(reply.cookies), []);
      }
    })
  );

  it.effect(
    "admits a Clerk identity to only its grant and refreshes its session outside the static page",
    () =>
      Effect.gen(function* () {
        const shared = yield* page("clerk-shared");
        const unrelated = yield* page("clerk-private");
        accountProfiles.set(
          "user_external_clerk",
          clerkAccount("user_external_clerk", "clerk-recipient@example.com", {
            public_metadata: { patchySignup: "patch-recipient" }
          })
        );
        const cookie = signedInCookies(
          signSession({
            sub: "user_external_clerk",
            email: "clerk-recipient@example.com",
            azp: origin
          })
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO patch_grants (id,patch_id,email,created_by) VALUES ('share_clerk_test',${shared.patchId},'clerk-recipient@example.com',${DEV_SEED.userId})`;
        const accepted = yield* post("/~shared/accept/share_clerk_test", cookie);
        assert.strictEqual(accepted.status, 303);
        const reply = yield* get(new URL(shared.address).pathname, cookie);
        assert.strictEqual(reply.status, 200);
        const body = yield* reply.text;
        assert.include(body, "clerk.headless.browser.js");
        assert.include(body, 'src="/auth/session.js"');
        assert.include(body, 'src="/~shared/session.js?');
        assert.include(reply.headers["content-security-policy"]!, FRONTEND_API_HOST);
        assert.include(reply.headers["content-security-policy"]!, "connect-src 'self'");
        assert.strictEqual((yield* get(new URL(unrelated.address).pathname, cookie)).status, 404);
        assert.strictEqual(
          (yield* post("/join", cookie, { action: "create", name: "No", handle: "not-permitted" }))
            .status,
          403
        );
        assert.strictEqual((yield* post("/api/publish", cookie)).status, 401);
        assert.deepStrictEqual(
          yield* sql`SELECT id FROM users WHERE clerk_user_id='user_external_clerk'`,
          []
        );
      })
  );
});

// A scoped HTTP boundary exercises Clerk's real SDK, with no external mail or account changes.
class MailHost extends Context.Service<
  MailHost,
  {
    readonly events: Array<{ method: string; path: string; body: Record<string, unknown> }>;
    failRevoke: boolean;
    holdCreate: boolean;
    readonly started: ReturnType<typeof Promise.withResolvers<void>>;
    readonly pending: Array<() => void>;
  }
>()("ExternalSharingPrototypeTest/MailHost") {}

const mailHost = Layer.effectContext(
  Effect.gen(function* () {
    const state = MailHost.of({
      events: [],
      failRevoke: false,
      holdCreate: false,
      started: Promise.withResolvers<void>(),
      pending: []
    });
    const host = createServer((req, res) => {
      let text = "";
      req.on("data", (chunk) => {
        text += String(chunk);
      });
      req.on("end", () => {
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        state.events.push({ method: req.method!, path: req.url!, body });
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/revoke") && state.failRevoke) {
          res
            .writeHead(400)
            .end(
              JSON.stringify({ errors: [{ code: "offline_failure", message: "Cannot cancel" }] })
            );
          return;
        }
        const reply = () =>
          res.end(
            JSON.stringify({
              id: "inv_offline",
              object: "invitation",
              email_address: body.email_address ?? "mail@example.com",
              status: req.url?.endsWith("/revoke") ? "revoked" : "pending",
              public_metadata: {},
              created_at: 1,
              updated_at: 1
            })
          );
        if (state.holdCreate && req.url === "/v1/invitations") {
          state.pending.push(reply);
          state.started.resolve();
        } else reply();
      });
    });
    const port = yield* Effect.acquireRelease(
      Effect.callback<number>((resume) => {
        host.listen(0, "127.0.0.1", () =>
          resume(Effect.succeed((host.address() as AddressInfo).port))
        );
      }),
      () =>
        Effect.callback<void>((resume) => {
          host.closeAllConnections();
          host.close(() => resume(Effect.void));
        })
    );
    return Context.make(MailHost, state).pipe(
      Context.add(InviteMail.backendApiUrl, `http://127.0.0.1:${port}`)
    );
  })
);

it.layer(
  server({
    NODE_ENV: "test",
    PATCHY_PUBLIC_BASE_URL: origin,
    PATCHY_DEV_EXTERNAL_SHARING: "true"
  }).pipe(
    Layer.provideMerge(mailHost),
    Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
  )
)("Clerk patch invitation mail", (it) => {
  const owner = () =>
    signedInCookies(signSession({ sub: DEV_SEED.clerkUserId, email: DEV_SEED.email, azp: origin }));
  it.effect(
    "delivers the hosted signup return, retries failed cancellation and denies the revoked grant",
    () =>
      Effect.gen(function* () {
        const shared = yield* page("mailed-patch");
        const state = yield* MailHost;
        const id = yield* invite(shared.patchId, "mail@example.com", owner());
        const sent = state.events.at(-1)!;
        assert.strictEqual(sent.path, "/v1/invitations");
        assert.strictEqual(sent.body.email_address, "mail@example.com");
        assert.deepStrictEqual(sent.body.public_metadata, { patchySignup: "patch-recipient" });
        const destination = new URL(String(sent.body.redirect_url));
        assert.strictEqual(destination.hostname, "accounts.patchy.invalid");
        assert.strictEqual(destination.pathname, "/sign-up");
        assert.strictEqual(
          destination.searchParams.get("redirect_url"),
          `${origin}/~shared/invite/${id}`
        );
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql`SELECT clerk_invitation_id FROM patch_grants WHERE id = ${id}`;
        assert.strictEqual(row!.clerk_invitation_id, "inv_offline");
        state.failRevoke = true;
        assert.strictEqual((yield* post(`/~shared/revoke/${id}`, owner())).status, 502);
        const recipient = signedInCookies(
          signSession({ sub: "mail_guest", email: "mail@example.com", azp: origin })
        );
        assert.strictEqual((yield* post(`/~shared/accept/${id}`, recipient)).status, 403);
        assert.strictEqual((yield* get(new URL(shared.address).pathname, recipient)).status, 404);
        state.failRevoke = false;
        assert.strictEqual((yield* post(`/~shared/revoke/${id}`, owner())).status, 303);
        assert.strictEqual(state.events.at(-1)!.path, "/v1/invitations/inv_offline/revoke");
      })
  );

  it.effect("cancels an email whose grant was revoked while Clerk was creating it", () =>
    Effect.gen(function* () {
      const shared = yield* page("in-flight-mail");
      const state = yield* MailHost;
      state.holdCreate = true;
      const sending = yield* post("/~shared/grant", owner(), {
        patchId: shared.patchId,
        email: "race@example.com"
      }).pipe(Effect.forkChild);
      yield* Effect.promise(() => state.started.promise);
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql`SELECT id FROM patch_grants WHERE patch_id = ${shared.patchId}`;
      assert.strictEqual((yield* post(`/~shared/revoke/${String(row!.id)}`, owner())).status, 303);
      state.pending.shift()!();
      assert.strictEqual((yield* Fiber.join(sending)).status, 303);
      assert.strictEqual(state.events.at(-1)!.path, "/v1/invitations/inv_offline/revoke");
      assert.deepStrictEqual(
        yield* sql`SELECT revoked, clerk_invitation_id FROM patch_grants WHERE id = ${String(row!.id)}`,
        [{ revoked: true, clerk_invitation_id: null }]
      );
      state.holdCreate = false;
    })
  );
});

it.layer(server({ NODE_ENV: "test", PATCHY_DEV_EXTERNAL_SHARING: "true" }))(
  "sharing stays local",
  (it) => {
    it.effect("migrates grants but leaves sharing disabled on a public origin", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql`SELECT to_regclass('patch_grants')::text AS name`;
        assert.strictEqual(row!.name, "patch_grants");
        assert.strictEqual((yield* get("/shared", signedInCookies())).status, 404);
      })
    );
  }
);
