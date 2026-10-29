import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { Authorization as AuthorizationTag, PatchyApi } from "@patchy/api";
import { Analytics } from "@patchy/analytics";
import { Limits } from "@patchy/limits";
import { Companies, CompanyPage, InviteMail, Users } from "@patchy/companies";
import * as Testing from "@patchy/sql/testing";
import * as AgentConnections from "./AgentConnections.js";
import * as AuthApi from "./AuthApi.js";
import * as AuthPages from "./AuthPages.js";
import * as Authorization from "./Authorization.js";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Session from "./Session.js";
import { clerkEnv, signedInCookies, signSession } from "./testing.js";
import { NodeCryptography } from "@patchy/core";

const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const origin = new URL(base).origin;
const cookie = (user: Users.User) =>
  signedInCookies(signSession({ sub: user.clerkUserId, email: user.email, name: user.name }));
const post = (user: Users.User, body: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { cookie: cookie(user), origin },
  body: new URLSearchParams(body)
});
const send = Effect.fn(function* (path: string, options: RequestInit = {}) {
  const app = yield* HttpRouter.toHttpEffect(AuthPages.layer);
  const response = yield* app.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(new URL(path, base), options))
    )
  );
  return HttpServerResponse.toWeb(response);
});
const me = Effect.fn(function* (token: string) {
  const client = yield* HttpApiTest.groups(PatchyApi, ["auth"]).pipe(
    Effect.provide(
      HttpApiMiddleware.layerClient(AuthorizationTag, ({ next, request }) =>
        next(HttpClientRequest.bearerToken(request, token))
      )
    )
  );
  return yield* client.me({ responseMode: "response-only" });
});
const createCompany = Effect.fn(function* (handle: string, name = handle) {
  return yield* (yield* Companies.Companies).create({
    handle,
    name,
    clerkUserId: `user_${handle}_admin`,
    email: `${handle}-admin@example.com`,
    userName: `${handle} Admin`
  });
});
const addUser = Effect.fn(function* (
  owner: { readonly company: Companies.Company; readonly user: Users.User },
  label: string,
  role: Users.Role = "member",
  name = label
) {
  const companies = yield* Companies.Companies;
  const email = `${owner.company.handle}-${label}@example.com`;
  const invite = yield* companies.createInvite({
    companyId: owner.company.id,
    invitedBy: owner.user.id,
    email,
    role
  });
  return yield* companies.consumeInvite({
    inviteId: invite.id,
    clerkUserId: `user_${owner.company.handle}_${label}`,
    email,
    name
  });
});
/** A management form; the page's search is a GET and changes nothing. */
const companyAction = /<form\b[^>]*method="post"[^>]*action="\/company(?:\/|")/;
const redirected = (response: Response) => {
  assert.strictEqual(response.status, 303);
  assert.strictEqual(response.headers.get("location"), "/company");
};
const redirectedTo = (response: Response) => {
  assert.strictEqual(response.status, 303);
  assert.strictEqual(response.headers.get("location"), "/company/agent-access");
};
/** Follows a form's redirect as a browser would and returns the receipt the page shows, if any. */
const landed = Effect.fn(function* (user: Users.User, response: Response) {
  assert.strictEqual(response.status, 303);
  const receipt = response.headers
    .getSetCookie()
    .find((line) => line.includes("patchy_receipt="))
    ?.split(";")[0];
  const page = yield* send(response.headers.get("location")!, {
    headers: { cookie: [cookie(user), ...(receipt ? [receipt] : [])].join("; ") }
  });
  assert.strictEqual(page.status, 200);
  const html = yield* Effect.promise(() => page.text());
  return html.match(/<p class="note note-ok app-receipt" role="status">([^<]*)<\/p>/)?.[1];
});
/** The page's own content, after the sidebar, which names the company and its places. */
const main = (html: string) => html.slice(html.indexOf("<main"));
const deliveryFailed = Effect.fn(function* (response: Response) {
  assert.strictEqual(response.status, 502);
  assert.strictEqual(response.headers.get("location"), null);
  const html = yield* Effect.promise(() => response.text());
  assert.include(html, 'role="alert"');
  assert.match(html, /(?:email|mail|delivery|Clerk)/i);
  assert.match(html, /(?:could not|did not|fail|unavailable)/i);
});

const events: Analytics.AnalyticsEvent[] = [];
/** A company's business events, without the company they all share. */
const reported = (companyId: string) =>
  events.flatMap(({ companyId: company, ...event }) => (company === companyId ? [event] : []));

const services = Layer.mergeAll(
  AuthApi.layer,
  HttpServer.layerServices,
  Session.layer,
  Companies.layer,
  Users.layer,
  InviteMail.layerRecording
).pipe(
  Layer.provideMerge(Authorization.layer),
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(AgentConnections.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Limits.layer,
      Layer.succeed(
        Analytics.Analytics,
        Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
      )
    )
  ),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  Layer.provideMerge(NodeCryptography.layer)
);

it.layer(services)("company page and actions", (it) => {
  it.effect(
    "lists only this company's users and pending invites, with escaped data and admin-only controls",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const users = yield* Users.Users;
        const owner = yield* createCompany(
          "company-list",
          'Research <script>alert("company")</script>'
        );
        const member = yield* addUser(
          owner,
          "member",
          "member",
          '<img src=x onerror=alert("name")>'
        );
        const inactive = yield* addUser(owner, "inactive");
        yield* users.deactivate({ companyId: owner.company.id, userId: inactive.id });
        const pending = yield* companies.createInvite({
          companyId: owner.company.id,
          invitedBy: owner.user.id,
          email: "pending&copy@example.com",
          role: "admin"
        });
        const revoked = yield* companies.createInvite({
          companyId: owner.company.id,
          invitedBy: owner.user.id,
          email: "revoked-list@example.com"
        });
        yield* companies.revokeInvite({ companyId: owner.company.id, inviteId: revoked.id });
        const foreign = yield* createCompany("company-hidden");
        for (const viewer of [owner.user, member]) {
          const response = yield* send("/company", { headers: { cookie: cookie(viewer) } });
          assert.strictEqual(response.status, 200);
          assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
          assert.include(response.headers.get("content-security-policy")!, "form-action 'self'");
          const html = yield* Effect.promise(() => response.text());
          assert.match(html, /<form\b[^>]*method="post"[^>]*action="\/logout"/);
          assert.include(html, "Research &lt;script&gt;alert(&quot;company&quot;)&lt;/script&gt;");
          assert.include(html, "&lt;img src=x onerror=alert(&quot;name&quot;)&gt;");
          assert.include(html, "pending&amp;copy@example.com");
          assert.notInclude(html, owner.company.name);
          assert.notInclude(html, member.name);
          assert.include(html, owner.user.email);
          assert.include(html, member.email);
          assert.include(html, inactive.email);
          assert.match(html, /deactivated/i);
          assert.match(html, /admin/i);
          assert.match(html, /member/i);
          assert.notInclude(html, revoked.email);
          assert.notInclude(html, foreign.user.email);
          assert.notInclude(html, foreign.company.name);
          if (viewer.role === "admin") {
            for (const action of [
              "/company/invites",
              `/company/invites/${pending.id}/revoke`,
              `/company/invites/${pending.id}/resend`,
              `/company/users/${member.id}/role`
            ])
              assert.include(html, `action="${action}"`);
            for (const path of [
              `/company/users/${member.id}/deactivate`,
              `/company/users/${inactive.id}/reactivate`
            ]) {
              assert.include(html, `href="${path}"`);
              assert.notInclude(html, `action="${path}"`);
            }
            assert.notInclude(html, `href="/company/users/${owner.user.id}/deactivate"`);
          } else {
            assert.notMatch(html, companyAction);
            assert.notMatch(
              html,
              /<a\b[^>]*href="\/company\/users\/[^"]+\/(?:deactivate|reactivate)"/
            );
          }
        }
      })
  );

  it.effect("marks expired invitations while keeping their resend and revoke controls", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const owner = yield* createCompany("company-expired");
      const invite = yield* companies.createInvite({
        companyId: owner.company.id,
        invitedBy: owner.user.id,
        email: "expired-page@example.com"
      });
      const before = yield* send("/company", { headers: { cookie: cookie(owner.user) } });
      assert.notInclude(yield* Effect.promise(() => before.text()), "Expired");
      yield* TestClock.adjust("30 days");
      const response = yield* send("/company", { headers: { cookie: cookie(owner.user) } });
      assert.strictEqual(response.status, 200);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, invite.email);
      assert.include(html, '<span class="pill">Expired</span>');
      assert.include(html, `action="/company/invites/${invite.id}/resend"`);
      assert.include(html, `action="/company/invites/${invite.id}/revoke"`);
    })
  );

  it.effect("offers a route back to company management when the form body cannot be read", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-unreadable-form");
      const request = new Request(
        new URL("/company/invites", base),
        post(owner.user, {
          email: "unreadable@example.com",
          role: "member"
        })
      );
      yield* Effect.promise(() => request.text());
      const app = yield* HttpRouter.toHttpEffect(AuthPages.layer);
      const response = HttpServerResponse.toWeb(
        yield* app.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request)
          )
        )
      );
      assert.strictEqual(response.status, 400);
      const html = yield* Effect.promise(() => response.text());
      const recovery = html.match(/<a href="([^"]+)"/)?.[1];
      assert.strictEqual(recovery, "/company");
      const page = yield* send(recovery!, { headers: { cookie: cookie(owner.user) } });
      assert.strictEqual(page.status, 200);
      assert.include(yield* Effect.promise(() => page.text()), 'action="/company/invites"');
      assert.deepStrictEqual(yield* (yield* Companies.Companies).listInvites(owner.company.id), []);
    })
  );

  it.effect(
    "gives signed-out readers a door and sends an unenrolled session through join with its return",
    () =>
      Effect.gen(function* () {
        const signedOut = yield* send("/company");
        assert.strictEqual(signedOut.status, 401);
        assert.strictEqual(signedOut.headers.get("location"), null);
        assert.strictEqual(signedOut.headers.get("www-authenticate"), null);
        assert.strictEqual(signedOut.headers.get("cache-control"), "private, no-store");
        assert.include(yield* Effect.promise(() => signedOut.text()), "Sign in");
        const sessionCookie = signedInCookies(
          signSession({
            sub: "user_company_unenrolled",
            email: "company-unenrolled@example.com",
            name: "New Reader"
          })
        );
        const unenrolled = yield* send("/company", { headers: { cookie: sessionCookie } });
        assert.strictEqual(unenrolled.status, 303);
        const target = new URL(unenrolled.headers.get("location")!, base);
        assert.strictEqual(target.pathname, "/join");
        assert.strictEqual(target.searchParams.get("return"), "/company");
        assert.strictEqual(
          yield* (yield* Users.Users).findByClerkId("user_company_unenrolled"),
          null
        );
      })
  );

  it.effect("creates, resends and revokes one local invitation through the mail capability", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-mail");
      const companies = yield* Companies.Companies;
      const recording = yield* InviteMail.Recording;
      const start = (yield* recording.events).length;
      redirected(
        yield* send(
          "/company/invites",
          post(owner.user, {
            email: "COLLEAGUE@example.com",
            role: "admin"
          })
        )
      );
      const [invite] = yield* companies.listInvites(owner.company.id);
      assert.isDefined(invite);
      assert.isNotNull(invite.clerkInvitationId);
      assert.strictEqual(invite!.email, "colleague@example.com");
      assert.strictEqual(invite!.role, "admin");
      assert.deepStrictEqual((yield* recording.events).slice(start), [
        {
          operation: "create",
          email: invite!.email,
          id: invite!.clerkInvitationId
        }
      ]);
      redirected(yield* send(`/company/invites/${invite!.id}/resend`, post(owner.user)));
      const [resent] = yield* companies.listInvites(owner.company.id);
      assert.strictEqual(resent!.id, invite!.id);
      assert.isNotNull(resent!.clerkInvitationId);
      assert.notStrictEqual(resent!.clerkInvitationId, invite!.clerkInvitationId);
      assert.deepStrictEqual(
        (yield* recording.events).slice(start).filter((event) => event.operation === "create"),
        [
          { operation: "create", email: invite!.email, id: invite!.clerkInvitationId },
          { operation: "create", email: invite!.email, id: resent!.clerkInvitationId }
        ]
      );
      redirected(yield* send(`/company/invites/${invite!.id}/revoke`, post(owner.user)));
      assert.deepStrictEqual(yield* companies.listInvites(owner.company.id), []);
      assert.deepInclude((yield* recording.events).slice(start), {
        operation: "revoke",
        id: resent!.clerkInvitationId
      });
      const page = yield* send("/company", { headers: { cookie: cookie(owner.user) } });
      assert.notInclude(yield* Effect.promise(() => page.text()), invite!.email);
      assert.strictEqual(
        (yield* send(`/company/invites/${invite!.id}/resend`, post(owner.user))).status,
        404
      );
      const join = yield* send("/join", {
        method: "POST",
        headers: {
          origin,
          cookie: signedInCookies(
            signSession({ sub: "user_revoked_company_invite", email: invite!.email })
          )
        },
        body: new URLSearchParams({ action: "join", inviteId: invite!.id })
      });
      assert.strictEqual(join.status, 409);
      const principalId = owner.user.id;
      assert.deepStrictEqual(reported(owner.company.id), [
        {
          name: "invite.sent",
          principalId,
          properties: { inviteId: invite!.id, role: "admin", emailed: true }
        },
        { name: "invite.resent", principalId, properties: { inviteId: invite!.id, emailed: true } },
        { name: "invite.revoked", principalId, properties: { inviteId: invite!.id } }
      ]);
    })
  );

  // Delivery commits even when the browser disconnects; its event must follow it.
  it.effect("reports an invitation that commits after its request was interrupted", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-mail-interrupted");
      const delivering = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const slowMail = Layer.succeed(
        InviteMail.InviteMail,
        InviteMail.InviteMail.of({
          create: () =>
            Deferred.succeed(delivering, undefined).pipe(
              Effect.andThen(Deferred.await(delivered)),
              Effect.as("clerk_inv_slow")
            ),
          revoke: () => Effect.void
        })
      );
      const request = yield* send(
        "/company/invites",
        post(owner.user, { email: "interrupted@example.com", role: "member" })
      ).pipe(Effect.provide(slowMail), Effect.forkChild);
      yield* Deferred.await(delivering);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(request));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(delivered, undefined);
      yield* Fiber.join(interrupting);
      const [invite] = yield* (yield* Companies.Companies).listInvites(owner.company.id);
      assert.strictEqual(invite?.clerkInvitationId, "clerk_inv_slow");
      assert.deepStrictEqual(reported(owner.company.id), [
        {
          name: "invite.sent",
          principalId: owner.user.id,
          properties: { inviteId: invite!.id, role: "member", emailed: true }
        }
      ]);
    })
  );

  // Invitations owns which addresses are refused; the page answers each refusal alike.
  it.effect("refuses existing users and duplicate live invites with a 409 alert and no mail", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-invite-rules");
      const recording = yield* InviteMail.Recording;
      const email = "shared-invite@example.com";
      redirected(yield* send("/company/invites", post(owner.user, { email, role: "member" })));
      const delivered = yield* recording.events;
      for (const refusedEmail of [email.toUpperCase(), owner.user.email]) {
        const response = yield* send(
          "/company/invites",
          post(owner.user, { email: refusedEmail, role: "member" })
        );
        assert.strictEqual(response.status, 409);
        assert.include(yield* Effect.promise(() => response.text()), 'role="alert"');
      }
      assert.deepStrictEqual(yield* recording.events, delivered);
      assert.deepStrictEqual(
        reported(owner.company.id).map((event) => event.name),
        ["invite.sent"]
      );
    })
  );

  it.effect("sends one invitation per address in a pasted list and names the ones it skipped", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-batch");
      const member = yield* addUser(owner, "member");
      const companies = yield* Companies.Companies;
      const recording = yield* InviteMail.Recording;
      yield* companies.createInvite({
        companyId: owner.company.id,
        invitedBy: owner.user.id,
        email: "waiting@example.com"
      });
      const start = (yield* recording.events).length;
      const response = yield* send(
        "/company/invites",
        post(owner.user, {
          email: `first@example.com, FIRST@example.com\nsecond@example.com;${member.email}  waiting@example.com`,
          role: "admin"
        })
      );
      assert.strictEqual(response.status, 409);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, 'role="alert"');
      assert.include(html, "Invited first@example.com and second@example.com.");
      assert.include(html, `${member.email} is already in`);
      assert.include(html, "waiting@example.com already has an invite.");
      // The form stays open with the chosen role, and keeps nothing that was sent or can't be.
      assert.include(html, '<details class="company-invite" open>');
      assert.include(html, '<option value="admin" selected>Admin</option>');
      assert.match(html, /<textarea\b[^>]*id="invite-email"[^>]*><\/textarea>/);
      const invites = yield* companies.listInvites(owner.company.id);
      assert.deepStrictEqual(
        invites
          .map(({ email, role }) => ({ email, role }))
          .sort((a, b) => a.email.localeCompare(b.email)),
        [
          { email: "first@example.com", role: "admin" },
          { email: "second@example.com", role: "admin" },
          { email: "waiting@example.com", role: "member" }
        ]
      );
      assert.deepStrictEqual(
        (yield* recording.events)
          .slice(start)
          .flatMap((event) => (event.operation === "create" ? [event.email] : []))
          .sort(),
        ["first@example.com", "second@example.com"]
      );
      assert.deepStrictEqual(
        reported(owner.company.id).map((event) => event.name),
        ["invite.sent", "invite.sent"]
      );
      redirected(
        yield* send(
          "/company/invites",
          post(owner.user, { email: "third@example.com fourth@example.com", role: "member" })
        )
      );
    })
  );

  it.effect("keeps going past an address it cannot save and leaves that one in the box", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-batch-fault");
      const companies = yield* Companies.Companies;
      const offline = new SqlError({
        reason: new ConnectionError({ cause: new Error("database offline") })
      });
      const response = yield* send(
        "/company/invites",
        post(owner.user, {
          email: "before@example.com broken@example.com after@example.com",
          role: "member"
        })
      ).pipe(
        Effect.provideService(
          Companies.Companies,
          Companies.Companies.of({
            ...companies,
            createInvite: (input) =>
              input.email === "broken@example.com"
                ? Effect.fail(offline)
                : companies.createInvite(input)
          })
        )
      );
      assert.strictEqual(response.status, 503);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, "Invited before@example.com and after@example.com.");
      assert.include(html, "Could not save the invite for broken@example.com.");
      assert.include(html, ">broken@example.com</textarea>");
      assert.deepStrictEqual(
        (yield* companies.listInvites(owner.company.id)).map(({ email }) => email).sort(),
        ["after@example.com", "before@example.com"]
      );
      assert.deepStrictEqual(
        reported(owner.company.id).map((event) => event.name),
        ["invite.sent", "invite.sent"]
      );
    })
  );

  it.effect(
    "refuses a bad, empty or oversized list before sending any, keeping what was typed",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("company-batch-refused");
        const recording = yield* InviteMail.Recording;
        const before = yield* recording.events;
        const tooMany = Array.from({ length: 51 }, (_, index) => `person-${index}@example.com`);
        for (const [email, problem] of [
          ["ok@example.com <b>bad</b>", "&lt;b&gt;bad&lt;/b&gt; is not an email address"],
          [" \n ", "Enter at least one email address."],
          [tooMany.join("\n"), "That is 51 addresses. Send up to 50 at a time."]
        ] as const) {
          const response = yield* send(
            "/company/invites",
            post(owner.user, { email, role: "admin" })
          );
          assert.strictEqual(response.status, 422);
          const html = yield* Effect.promise(() => response.text());
          assert.match(html, /class="note note-refused field-callout"[^>]*role="alert"/);
          assert.include(html, problem);
          assert.include(html, 'aria-invalid="true" autofocus');
          assert.include(html, '<option value="admin" selected>');
          if (email.startsWith("ok@"))
            assert.include(html, ">ok@example.com &lt;b&gt;bad&lt;/b&gt;</textarea>");
        }
        assert.deepStrictEqual(
          yield* (yield* Companies.Companies).listInvites(owner.company.id),
          []
        );
        assert.deepStrictEqual(yield* recording.events, before);
        assert.deepStrictEqual(reported(owner.company.id), []);
      })
  );

  it.effect("narrows the list to a tab and a search, and keeps both in its links", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-filter");
      const member = yield* addUser(owner, "zed", "member", "Zed Quill");
      const gone = yield* addUser(owner, "gone");
      yield* (yield* Users.Users).deactivate({ companyId: owner.company.id, userId: gone.id });
      const invited = "invited-filter@example.com";
      yield* (yield* Companies.Companies).createInvite({
        companyId: owner.company.id,
        invitedBy: owner.user.id,
        email: invited
      });
      const page = Effect.fn(function* (path: string) {
        const response = yield* send(path, { headers: { cookie: cookie(owner.user) } });
        assert.strictEqual(response.status, 200, path);
        return yield* Effect.promise(() => response.text());
      });
      const everyone = [invited, owner.user.email, gone.email, member.email];
      // The page's own list; the sidebar's account menu carries the viewer's email on every page.
      const shown = (html: string) =>
        everyone.filter((email) => html.slice(html.indexOf("<main")).includes(email)).sort();
      assert.deepStrictEqual(shown(yield* page("/company")), [...everyone].sort());
      assert.deepStrictEqual(shown(yield* page("/company?show=nonsense")), [...everyone].sort());
      assert.deepStrictEqual(shown(yield* page("/company?show=admins")), [owner.user.email]);
      assert.deepStrictEqual(shown(yield* page("/company?show=invited")), [invited]);
      assert.deepStrictEqual(shown(yield* page("/company?show=deactivated")), [gone.email]);
      const searched = yield* page("/company?q=+QUILL+");
      assert.deepStrictEqual(shown(searched), [member.email]);
      assert.include(searched, "1 match for “QUILL”");
      assert.include(searched, 'href="/company?show=admins&amp;q=QUILL"');
      assert.include(searched, 'name="q" value="QUILL"');
      assert.include(yield* page("/company?show=admins&q=nobody"), "No one matches “nobody”.");
    })
  );

  it.effect("adds a Patches column when the server supplies owned patch counts", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-owned");
      const member = yield* addUser(owner, "builder");
      const page = (response: Response) => Effect.promise(() => response.text());
      const request = { headers: { cookie: cookie(owner.user) } };
      assert.notInclude(yield* page(yield* send("/company", request)), ">Patches</th>");
      const asked: Array<{ readonly companyId: string; readonly userId: string }> = [];
      const html = yield* page(
        yield* send("/company", request).pipe(
          Effect.provideService(CompanyPage.OwnedPatches, (viewer) => {
            asked.push(viewer);
            return Effect.succeed(new Map([[member.id, 3]]));
          })
        )
      );
      assert.deepStrictEqual(asked, [{ companyId: owner.company.id, userId: owner.user.id }]);
      assert.include(html, '<th scope="col">Patches</th>');
      assert.match(html, new RegExp(`${member.email}[\\s\\S]*?<td>Member</td><td>3</td>`));
      assert.match(html, new RegExp(`${owner.user.email}[\\s\\S]*?<td>Admin</td><td>0</td>`));
    })
  );

  it.effect(
    "rejects malformed email and unknown roles without changing users or sending mail",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("company-invalid-form");
        const member = yield* addUser(owner, "member");
        const recording = yield* InviteMail.Recording;
        const before = yield* recording.events;
        for (const body of [
          { email: "not-an-email", role: "member" },
          { email: "invalid-role@example.com", role: "owner" }
        ]) {
          const response = yield* send("/company/invites", post(owner.user, body));
          assert.strictEqual(response.status, 422);
          assert.include(yield* Effect.promise(() => response.text()), 'role="alert"');
        }
        const role = yield* send(
          `/company/users/${member.id}/role`,
          post(owner.user, { role: "owner" })
        );
        assert.strictEqual(role.status, 422);
        assert.include(yield* Effect.promise(() => role.text()), 'role="alert"');
        assert.strictEqual(
          (yield* (yield* Users.Users).findByClerkId(member.clerkUserId))?.role,
          "member"
        );
        assert.deepStrictEqual(
          yield* (yield* Companies.Companies).listInvites(owner.company.id),
          []
        );
        assert.deepStrictEqual(yield* recording.events, before);
        assert.deepStrictEqual(reported(owner.company.id), []);
      })
  );

  it.effect(
    "refuses every company action from a member without changing rows or delivering mail",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("company-member-actions");
        const member = yield* addUser(owner, "member");
        const users = yield* Users.Users;
        const companies = yield* Companies.Companies;
        const recording = yield* InviteMail.Recording;
        const invite = yield* companies.createInvite({
          companyId: owner.company.id,
          invitedBy: owner.user.id,
          email: "member-action-invite@example.com"
        });
        const beforeUsers = yield* users.list(owner.company.id);
        const beforeInvites = yield* companies.listInvites(owner.company.id);
        const beforeMail = yield* recording.events;
        const actions: ReadonlyArray<readonly [string, Record<string, string>]> = [
          ["/company/invites", { email: "member-forbidden@example.com", role: "admin" }],
          [`/company/invites/${invite.id}/revoke`, {}],
          [`/company/invites/${invite.id}/resend`, {}],
          [`/company/users/${member.id}/role`, { role: "admin" }],
          ["/company/agent-access", { state: "on" }]
        ];
        for (const [path, body] of actions) {
          const response = yield* send(path, post(member, body));
          assert.strictEqual(response.status, 403, path);
          assert.strictEqual(response.headers.get("location"), null);
        }
        assert.deepStrictEqual(yield* users.list(owner.company.id), beforeUsers);
        assert.deepStrictEqual(yield* companies.listInvites(owner.company.id), beforeInvites);
        assert.deepStrictEqual(yield* companies.agentAccess(owner.company.id), {
          on: false,
          latest: null
        });
        assert.deepStrictEqual(yield* recording.events, beforeMail);
        assert.deepStrictEqual(reported(owner.company.id), []);
      })
  );

  it.effect(
    "shows agent access on its own page, where only an admin turns it on and off, stamped with who and when",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("company-agent-access", "Brightline Studio");
        const second = yield* addUser(owner, "second", "admin", "Priya Shah");
        const member = yield* addUser(owner, "member");
        const page = Effect.fn(function* (viewer: Users.User) {
          const response = yield* send("/company/agent-access", {
            headers: { cookie: cookie(viewer) }
          });
          assert.strictEqual(response.status, 200);
          const html = yield* Effect.promise(() => response.text());
          assert.include(
            html,
            '<a class="app-place" href="/company/agent-access" aria-current="page">'
          );
          return main(html);
        });
        const turn = (viewer: Users.User, state: string) =>
          send("/company/agent-access", post(viewer, { state }));
        const button = (state: "on" | "off") =>
          `<form class="actions" method="post" action="/company/agent-access"><input type="hidden" name="state" value="${state}"><button class="btn${state === "on" ? " btn-primary" : ""}" type="submit">Turn ${state} agent access</button></form>`;

        // The starting Off has no latest change; an admin gets Turn on, a member the admins.
        const off = yield* page(owner.user);
        assert.include(off, '<h1 class="page-heading">Agent access</h1>');
        assert.include(off, '<span class="pill">Off</span>');
        assert.notInclude(off, "Turned");
        assert.include(
          off,
          "Agents can’t use any patch; connections stay and work again when it’s on."
        );
        assert.include(off, button("on"));
        const offForMember = yield* page(member);
        assert.notInclude(offForMember, "<form");
        assert.notInclude(offForMember, "Turned");
        assert.include(
          offForMember,
          "At Brightline Studio that’s company-agent-access Admin and Priya Shah."
        );
        // People no longer carries the switch.
        const people = yield* send("/company", { headers: { cookie: cookie(owner.user) } });
        assert.notInclude(
          yield* Effect.promise(() => people.text()),
          'action="/company/agent-access"'
        );

        yield* TestClock.setTime(Date.parse("2026-10-12T09:00:00Z"));
        const turnedOn = yield* turn(owner.user, "on");
        redirectedTo(turnedOn);
        assert.strictEqual(yield* landed(owner.user, turnedOn), "Agent access is on");
        const on = yield* page(owner.user);
        assert.include(on, '<span class="pill pill-done">On</span>');
        const stamp =
          'Turned on by company-agent-access Admin on <time datetime="2026-10-12T09:00:00.000Z">12 Oct 2026</time>';
        assert.include(on, stamp);
        assert.include(
          on,
          "Anyone at Brightline Studio can connect their own agent to use patches’ agent tools as themselves."
        );
        // Before Turn off, what it does: every agent refused, no connection ended.
        assert.include(
          on,
          `<p class="supporting-text">Turning it off refuses every agent at Brightline Studio until it’s back on. Nobody’s connection ends.</p>${button("off")}`
        );
        const onForMember = yield* page(member);
        assert.include(onForMember, '<span class="pill pill-done">On</span>');
        assert.include(onForMember, stamp);
        assert.include(onForMember, '<a class="btn" href="/machines">Connect your agent</a>');
        assert.notInclude(onForMember, "<form");

        // A stale Turn on from another admin's tab changes nothing and reports nothing.
        redirectedTo(yield* turn(second, "on"));
        assert.include(yield* page(owner.user), stamp);

        yield* TestClock.adjust("1 day");
        const turnedOff = yield* turn(second, "off");
        assert.strictEqual(yield* landed(second, turnedOff), "Agent access is off");
        const offAgain = yield* page(member);
        assert.include(offAgain, '<span class="pill">Off</span>');
        assert.include(
          offAgain,
          'Turned off by Priya Shah on <time datetime="2026-10-13T09:00:00.000Z">13 Oct 2026</time>'
        );
        assert.deepStrictEqual(reported(owner.company.id), [
          { name: "agent_access.changed", principalId: owner.user.id, properties: { on: true } },
          { name: "agent_access.changed", principalId: second.id, properties: { on: false } }
        ]);

        const malformed = yield* turn(owner.user, "maybe");
        assert.strictEqual(malformed.status, 422);
        const malformedHtml = yield* Effect.promise(() => malformed.text());
        assert.include(malformedHtml, 'role="alert"');
        assert.include(malformedHtml, '<h1 class="page-heading">Agent access</h1>');
        assert.isFalse((yield* (yield* Companies.Companies).agentAccess(owner.company.id)).on);
        assert.lengthOf(reported(owner.company.id), 2);
      })
  );

  it.effect(
    "keeps agent access to its own company's admins: members read it, others never reach it",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const owner = yield* createCompany("company-access-scope", "Scope Studio");
        const member = yield* addUser(owner, "member");
        const gone = yield* addUser(owner, "gone");
        const foreign = yield* createCompany("company-access-foreign", "Foreign Co");
        yield* companies.setAgentAccess({
          companyId: owner.company.id,
          on: true,
          by: owner.user.id
        });
        const before = yield* companies.agentAccess(owner.company.id);
        const read = Effect.fn(function* (viewer: Users.User) {
          const response = yield* send("/company/agent-access", {
            headers: { cookie: cookie(viewer) }
          });
          return { status: response.status, html: yield* Effect.promise(() => response.text()) };
        });

        // A member reads the state and its admins, with no way to change it, and a forged
        // POST is refused on the same page.
        const asMember = yield* read(member);
        assert.strictEqual(asMember.status, 200);
        assert.include(asMember.html, '<span class="pill pill-done">On</span>');
        assert.notMatch(asMember.html, companyAction);
        const forged = yield* send("/company/agent-access", post(member, { state: "off" }));
        assert.strictEqual(forged.status, 403);
        assert.strictEqual(forged.headers.get("location"), null);
        const forgedHtml = yield* Effect.promise(() => forged.text());
        assert.include(forgedHtml, "Only an admin can turn agent access on or off.");
        assert.notMatch(forgedHtml, companyAction);

        // Another company's admin sees and turns only their own company's switch.
        const elsewhere = yield* read(foreign.user);
        assert.strictEqual(elsewhere.status, 200);
        assert.include(elsewhere.html, '<span class="pill">Off</span>');
        assert.notInclude(elsewhere.html, owner.company.name);
        assert.notInclude(elsewhere.html, owner.user.name);
        redirectedTo(yield* send("/company/agent-access", post(foreign.user, { state: "on" })));
        redirectedTo(yield* send("/company/agent-access", post(foreign.user, { state: "off" })));
        assert.isFalse((yield* companies.agentAccess(foreign.company.id)).on);

        // Signed out gets the door; deactivated gets the deactivated page, reading or writing.
        const signedOut = yield* send("/company/agent-access");
        assert.strictEqual(signedOut.status, 401);
        assert.notInclude(yield* Effect.promise(() => signedOut.text()), "Turned on by");
        const signedOutPost = yield* send("/company/agent-access", {
          method: "POST",
          headers: { origin },
          body: new URLSearchParams({ state: "off" })
        });
        assert.strictEqual(signedOutPost.status, 401);
        yield* (yield* Users.Users).deactivate({ companyId: owner.company.id, userId: gone.id });
        const deactivated = yield* read(gone);
        assert.strictEqual(deactivated.status, 403);
        assert.match(deactivated.html, /deactivated/i);
        assert.notInclude(deactivated.html, "Turned on by");
        assert.strictEqual(
          (yield* send("/company/agent-access", post(gone, { state: "off" }))).status,
          403
        );

        assert.deepStrictEqual(yield* companies.agentAccess(owner.company.id), before);
        assert.deepStrictEqual(reported(owner.company.id), []);
        assert.deepStrictEqual(
          reported(foreign.company.id).map((event) => event.properties),
          [{ on: true }, { on: false }]
        );
      })
  );

  it.effect("names what each form did in a receipt on the page it lands on", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-receipts");
      const member = yield* addUser(owner, "member", "member", "Dana Reyes");
      const companies = yield* Companies.Companies;
      const invite = (email: string) =>
        send("/company/invites", post(owner.user, { email, role: "member" }));
      assert.strictEqual(
        yield* landed(owner.user, yield* invite("Solo@Example.com")),
        "Invited solo@example.com"
      );
      assert.strictEqual(
        yield* landed(owner.user, yield* invite("one@example.com two@example.com")),
        "Invited 2 people"
      );
      const solo = (yield* companies.listInvites(owner.company.id)).find(
        (entry) => entry.email === "solo@example.com"
      )!;
      assert.strictEqual(
        yield* landed(
          owner.user,
          yield* send(`/company/invites/${solo.id}/resend`, post(owner.user))
        ),
        "Sent a new invite to solo@example.com"
      );
      assert.strictEqual(
        yield* landed(
          owner.user,
          yield* send(`/company/invites/${solo.id}/revoke`, post(owner.user))
        ),
        "Revoked the invite to solo@example.com"
      );
      const role = (value: string) =>
        send(`/company/users/${member.id}/role`, post(owner.user, { role: value }));
      assert.strictEqual(
        yield* landed(owner.user, yield* role("admin")),
        "Dana Reyes is now an admin"
      );
      assert.strictEqual(
        yield* landed(owner.user, yield* role("member")),
        "Dana Reyes is now a member"
      );
      // The receipt is shown once; a refusal leaves none and keeps its own notice.
      const again = yield* send("/company", { headers: { cookie: cookie(owner.user) } });
      assert.notInclude(main(yield* Effect.promise(() => again.text())), "app-receipt");
      const refused = yield* invite("one@example.com");
      assert.strictEqual(refused.status, 409);
      assert.isUndefined(
        refused.headers.getSetCookie().find((line) => line.includes("patchy_receipt="))
      );
    })
  );

  it.effect("folds the invite form into the toolbar, open from ?invite=1 or after a refusal", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-invite-form");
      const member = yield* addUser(owner, "member");
      const html = Effect.fn(function* (response: Response) {
        return main(yield* Effect.promise(() => response.text()));
      });
      const read = (viewer: Users.User, path: string) =>
        send(path, { headers: { cookie: cookie(viewer) } }).pipe(Effect.flatMap(html));
      const closed = yield* read(owner.user, "/company");
      assert.include(closed, '<h1 class="page-heading">People</h1>');
      assert.include(closed, "2 people · 1 admin");
      assert.include(
        closed,
        '<details class="company-invite"><summary class="btn btn-primary">Invite people</summary>'
      );
      assert.include(closed, '<label class="field-label" for="invite-email">Emails</label>');
      assert.include(closed, '<label class="field-label" for="invite-role">Role</label>');
      assert.include(closed, "Up to 50 at once. Invites expire after 30 days.");
      // Everyone listed has joined, so the column holds their dates.
      assert.include(closed, '<th scope="col">Joined</th>');
      assert.include(
        yield* read(owner.user, "/company?invite=1"),
        '<details class="company-invite" open>'
      );
      const refused = yield* html(
        yield* send("/company/invites", post(owner.user, { email: "nope", role: "member" }))
      );
      assert.include(refused, '<details class="company-invite" open>');
      assert.include(refused, 'aria-invalid="true" autofocus');
      const asMember = yield* read(member, "/company?invite=1");
      assert.notInclude(asMember, "<details");
      assert.notInclude(asMember, "Invite people");

      // An invite row says when it went out and when it lapses; the column is a status again.
      yield* TestClock.setTime(Date.parse("2026-10-12T09:00:00Z"));
      redirected(
        yield* send(
          "/company/invites",
          post(owner.user, { email: "waiting-row@example.com", role: "member" })
        )
      );
      yield* TestClock.adjust("2 days");
      const listed = yield* read(owner.user, "/company");
      assert.include(
        listed,
        'Invited <time datetime="2026-10-12T09:00:00.000Z">2 days ago</time> · expires <time datetime="2026-11-11T09:00:00.000Z">11 Nov 2026</time>'
      );
      assert.include(listed, '<th scope="col">Status</th>');
      assert.include(
        yield* read(owner.user, "/company?show=admins"),
        '<th scope="col">Joined</th>'
      );
    })
  );

  it.effect("checks Origin on all company actions even with an administrator's valid session", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-origin");
      const member = yield* addUser(owner, "member");
      const users = yield* Users.Users;
      const companies = yield* Companies.Companies;
      const recording = yield* InviteMail.Recording;
      const invite = yield* companies.createInvite({
        companyId: owner.company.id,
        invitedBy: owner.user.id,
        email: "origin-invite@example.com"
      });
      const beforeUsers = yield* users.list(owner.company.id);
      const beforeInvites = yield* companies.listInvites(owner.company.id);
      const beforeMail = yield* recording.events;
      const actions: ReadonlyArray<readonly [string, Record<string, string>]> = [
        ["/company/invites", { email: "origin-forbidden@example.com", role: "member" }],
        [`/company/invites/${invite.id}/revoke`, {}],
        [`/company/invites/${invite.id}/resend`, {}],
        [`/company/users/${member.id}/role`, { role: "admin" }],
        ["/company/agent-access", { state: "on" }]
      ];
      const refusedHeaders: ReadonlyArray<Record<string, string>> = [
        { origin: "https://foreign.invalid", "sec-fetch-site": "same-origin" },
        { "sec-fetch-site": "cross-site" }
      ];
      for (const [path, body] of actions) {
        for (const headers of refusedHeaders) {
          const response = yield* send(path, {
            method: "POST",
            headers: { cookie: cookie(owner.user), ...headers },
            body: new URLSearchParams(body)
          });
          assert.strictEqual(response.status, 403, path);
        }
      }
      assert.deepStrictEqual(yield* users.list(owner.company.id), beforeUsers);
      assert.deepStrictEqual(yield* companies.listInvites(owner.company.id), beforeInvites);
      assert.isFalse((yield* companies.agentAccess(owner.company.id)).on);
      assert.deepStrictEqual(yield* recording.events, beforeMail);
      assert.deepStrictEqual(reported(owner.company.id), []);
    })
  );

  it.effect("cannot act on another company's users or invitations by crafting their ids", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-scope");
      const foreign = yield* createCompany("company-scope-foreign");
      const member = yield* addUser(foreign, "member");
      const users = yield* Users.Users;
      const companies = yield* Companies.Companies;
      const recording = yield* InviteMail.Recording;
      const invite = yield* companies.createInvite({
        companyId: foreign.company.id,
        invitedBy: foreign.user.id,
        email: "foreign-action-invite@example.com"
      });
      const beforeUsers = yield* users.list(foreign.company.id);
      const beforeInvites = yield* companies.listInvites(foreign.company.id);
      const beforeMail = yield* recording.events;
      const actions: ReadonlyArray<readonly [string, Record<string, string>]> = [
        [`/company/invites/${invite.id}/revoke`, {}],
        [`/company/invites/${invite.id}/resend`, {}],
        [`/company/users/${member.id}/role`, { role: "admin" }]
      ];
      for (const [path, body] of actions) {
        const response = yield* send(
          path,
          post(owner.user, {
            ...body,
            companyId: foreign.company.id
          })
        );
        assert.strictEqual(response.status, 404, path);
        assert.notInclude(yield* Effect.promise(() => response.text()), foreign.user.email);
      }
      assert.deepStrictEqual(yield* users.list(foreign.company.id), beforeUsers);
      assert.deepStrictEqual(yield* companies.listInvites(foreign.company.id), beforeInvites);
      assert.deepStrictEqual(yield* recording.events, beforeMail);
      assert.deepStrictEqual(reported(owner.company.id), []);
      assert.deepStrictEqual(reported(foreign.company.id), []);
    })
  );

  it.effect("re-renders the last-admin reason when demotion would leave no active admin", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-last-admin");
      const response = yield* send(
        `/company/users/${owner.user.id}/role`,
        post(owner.user, { role: "member" })
      );
      assert.strictEqual(response.status, 409);
      assert.strictEqual(response.headers.get("location"), null);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, 'role="alert"');
      assert.match(html, /last (?:active )?admin/i);
      const user = yield* (yield* Users.Users).findByClerkId(owner.user.clerkUserId);
      assert.strictEqual(user?.role, "admin");
      assert.isNull(user?.deactivatedAt);
      assert.deepStrictEqual(reported(owner.company.id), []);
    })
  );

  it.effect("leaves an active admin when two admins concurrently demote each other over HTTP", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-admin-race");
      const other = yield* addUser(owner, "other-admin", "admin");
      const responses = yield* Effect.all(
        [
          send(`/company/users/${other.id}/role`, post(owner.user, { role: "member" })),
          send(`/company/users/${owner.user.id}/role`, post(other, { role: "member" }))
        ],
        { concurrency: "unbounded" }
      );
      assert.strictEqual(responses.filter((response) => response.status === 303).length, 1);
      const refused = responses.find((response) => response.status !== 303)!;
      // The loser may reach the viewer check before or after the winning demotion commits.
      assert.oneOf(refused.status, [403, 409]);
      const users = yield* (yield* Users.Users).list(owner.company.id);
      assert.strictEqual(
        users.filter((user) => user.role === "admin" && user.deactivatedAt === null).length,
        1
      );
      assert.strictEqual(users.filter((user) => user.role === "member").length, 1);
      assert.deepStrictEqual(
        reported(owner.company.id).map((event) => event.properties),
        [{ userId: users.find((user) => user.role === "member")!.id, role: "member" }]
      );
    })
  );

  it.effect(
    "reflects role and lifecycle changes in browser and bearer access while mail is unavailable",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("company-lifecycle");
        const member = yield* addUser(owner, "member");
        const users = yield* Users.Users;
        const input = { companyId: owner.company.id, userId: member.id };
        const tokens = yield* MachineTokens.MachineTokens;
        const laptop = yield* tokens.mint({ userId: member.id, name: "Laptop" });
        const initial = yield* me(laptop.token);
        assert.strictEqual(initial.status, 200);
        assert.deepInclude(yield* initial.json, { role: "member" });

        redirected(
          yield* send(`/company/users/${member.id}/role`, post(owner.user, { role: "admin" }))
        );
        const promoted = yield* me(laptop.token);
        assert.strictEqual(promoted.status, 200);
        assert.deepInclude(yield* promoted.json, { role: "admin" });
        const adminPage = yield* send("/company", { headers: { cookie: cookie(member) } });
        assert.include(yield* Effect.promise(() => adminPage.text()), 'action="/company/invites"');
        redirected(
          yield* send(`/company/users/${member.id}/role`, post(owner.user, { role: "member" }))
        );
        assert.deepInclude(yield* (yield* me(laptop.token)).json, { role: "member" });
        // A stale form asking for the role the user already has changes nothing.
        redirected(
          yield* send(`/company/users/${member.id}/role`, post(owner.user, { role: "member" }))
        );
        assert.deepStrictEqual(reported(owner.company.id), [
          {
            name: "user.role_changed",
            principalId: owner.user.id,
            properties: { userId: member.id, role: "admin" }
          },
          {
            name: "user.role_changed",
            principalId: owner.user.id,
            properties: { userId: member.id, role: "member" }
          }
        ]);

        yield* users.deactivate(input);
        const denied = yield* send("/company", { headers: { cookie: cookie(member) } });
        assert.strictEqual(denied.status, 403);
        assert.strictEqual(denied.headers.get("cache-control"), "private, no-store");
        const deniedHtml = yield* Effect.promise(() => denied.text());
        assert.match(deniedHtml, /deactivated/i);
        assert.include(deniedHtml, owner.company.name);
        assert.include(deniedHtml, 'action="/logout"');
        assert.notMatch(deniedHtml, companyAction);
        const manage = yield* send("/company", { headers: { cookie: cookie(owner.user) } });
        assert.include(
          yield* Effect.promise(() => manage.text()),
          `href="/company/users/${member.id}/reactivate"`
        );
        assert.strictEqual(
          (yield* send(
            "/company/invites",
            post(member, {
              email: "deactivated-forbidden@example.com",
              role: "member"
            })
          )).status,
          403
        );

        yield* users.reactivate(input);
        const restored = yield* send("/company", { headers: { cookie: cookie(member) } });
        assert.strictEqual(restored.status, 200);
        const restoredHtml = yield* Effect.promise(() => restored.text());
        assert.include(restoredHtml, member.email);
        assert.notMatch(restoredHtml, companyAction);
        const fresh = yield* tokens.mint({ userId: member.id, name: "Reauthenticated laptop" });
        const identity = yield* me(fresh.token);
        assert.strictEqual(identity.status, 200);
        assert.deepInclude(yield* identity.json, {
          user: { id: member.id, email: member.email, name: member.name },
          company: {
            id: owner.company.id,
            handle: owner.company.handle,
            name: owner.company.name
          },
          role: "member",
          machine: { id: fresh.id, name: fresh.name }
        });
      }).pipe(Effect.provide(InviteMail.layerFailing))
  );

  // Invitations owns what each failed delivery leaves behind; the page reports it and keeps it.
  it.effect(
    "answers a failed invite delivery with a 502 alert and keeps the invitation state",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        for (const action of ["create", "resend", "revoke"] as const) {
          const owner = yield* createCompany(`company-mail-${action}-failure`);
          const form = { email: `${action}-failure@example.com`, role: "member" };
          if (action !== "create") {
            redirected(yield* send("/company/invites", post(owner.user, form)));
          }
          const before = yield* companies.listInvites(owner.company.id);
          const response = yield* send(
            action === "create"
              ? "/company/invites"
              : `/company/invites/${before[0]!.id}/${action}`,
            post(owner.user, action === "create" ? form : {})
          ).pipe(Effect.provide(InviteMail.layerFailing));
          yield* deliveryFailed(response);
          const after = yield* companies.listInvites(owner.company.id);
          const principalId = owner.user.id;
          const last = reported(owner.company.id).at(-1);
          if (action === "create") {
            // Saved without a delivered link, so the invitee can still join.
            assert.deepStrictEqual(
              after.map((invite) => [invite.email, invite.clerkInvitationId]),
              [[form.email, null]]
            );
            assert.deepStrictEqual(last, {
              name: "invite.sent",
              principalId,
              properties: { inviteId: after[0]!.id, role: "member", emailed: false }
            });
          } else if (action === "resend") {
            // The earlier delivery stays because it could not be revoked.
            assert.deepStrictEqual(after, before);
            assert.deepStrictEqual(last, {
              name: "invite.resent",
              principalId,
              properties: { inviteId: before[0]!.id, emailed: false }
            });
          } else {
            // Revoked here even though the emailed link could not be.
            assert.deepStrictEqual(after, []);
            assert.deepStrictEqual(last, {
              name: "invite.revoked",
              principalId,
              properties: { inviteId: before[0]!.id }
            });
          }
        }
      })
  );
});
