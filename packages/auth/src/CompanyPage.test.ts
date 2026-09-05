import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import { Authorization as AuthorizationTag, PatchyApi } from "@patchy/api";
import { Companies, InviteMail, Users } from "@patchy/companies";
import * as Testing from "@patchy/sql/testing";
import * as AuthApi from "./AuthApi.js";
import * as AuthPages from "./AuthPages.js";
import * as Authorization from "./Authorization.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Session from "./Session.js";
import { clerkEnv, signedInCookies, signSession } from "./testing.js";

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
const redirected = (response: Response) => {
  assert.strictEqual(response.status, 303);
  assert.strictEqual(response.headers.get("location"), "/company");
};
const deliveryFailed = Effect.fn(function* (response: Response) {
  assert.strictEqual(response.status, 502);
  assert.strictEqual(response.headers.get("location"), null);
  const html = yield* Effect.promise(() => response.text());
  assert.include(html, 'role="alert"');
  assert.match(html, /(?:email|mail|delivery|Clerk)/i);
  assert.match(html, /(?:could not|did not|fail|unavailable)/i);
  return html;
});

const services = Layer.mergeAll(
  AuthApi.layer,
  HttpServer.layerServices,
  Session.layer,
  Companies.layer,
  Users.layer,
  InviteMail.layerRecording
).pipe(
  Layer.provideMerge(Authorization.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
);

it.layer(services)("company page and actions", (it) => {
  it.effect(
    "lists only this company's users and pending invites, with escaped data and admin-only forms",
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
              `/company/users/${member.id}/role`,
              `/company/users/${member.id}/deactivate`,
              `/company/users/${inactive.id}/reactivate`
            ])
              assert.include(html, `action="${action}"`);
            assert.notInclude(html, `action="/company/users/${owner.user.id}/deactivate"`);
          } else {
            assert.notMatch(html, /<form\b[^>]*action="\/company(?:\/|")/);
          }
        }
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
      assert.strictEqual(invite!.email, "colleague@example.com");
      assert.strictEqual(invite!.role, "admin");
      assert.deepStrictEqual((yield* recording.events).slice(start), [
        {
          operation: "create",
          email: invite!.email,
          id: invite!.clerkInvitationId
        }
      ]);
      assert.isString(invite!.clerkInvitationId);
      redirected(yield* send(`/company/invites/${invite!.id}/resend`, post(owner.user)));
      const [resent] = yield* companies.listInvites(owner.company.id);
      assert.strictEqual(resent!.id, invite!.id);
      assert.isString(resent!.clerkInvitationId);
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
    })
  );

  it.effect(
    "refuses existing users and duplicate live invites without mailing, but allows another company's invite",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("company-invite-rules");
        const foreign = yield* createCompany("company-invite-other");
        const recording = yield* InviteMail.Recording;
        const companies = yield* Companies.Companies;
        const email = "shared-invite@example.com";
        redirected(yield* send("/company/invites", post(owner.user, { email, role: "member" })));
        const delivered = yield* recording.events;
        for (const refusedEmail of [
          email.toUpperCase(),
          owner.user.email,
          foreign.user.email.toUpperCase()
        ]) {
          const response = yield* send(
            "/company/invites",
            post(owner.user, { email: refusedEmail, role: "member" })
          );
          assert.strictEqual(response.status, 409);
          assert.include(yield* Effect.promise(() => response.text()), 'role="alert"');
        }
        assert.deepStrictEqual(yield* recording.events, delivered);
        redirected(yield* send("/company/invites", post(foreign.user, { email, role: "admin" })));
        assert.deepStrictEqual(
          (yield* companies.findInvitesByEmail(email)).map((invite) => invite.companyId).sort(),
          [owner.company.id, foreign.company.id].sort()
        );
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
      })
  );

  it.effect(
    "refuses every company action from a member without changing rows or delivering mail",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("company-member-actions");
        const member = yield* addUser(owner, "member");
        const inactive = yield* addUser(owner, "inactive");
        const users = yield* Users.Users;
        const companies = yield* Companies.Companies;
        const recording = yield* InviteMail.Recording;
        yield* users.deactivate({ companyId: owner.company.id, userId: inactive.id });
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
          [`/company/users/${member.id}/deactivate`, {}],
          [`/company/users/${inactive.id}/reactivate`, {}]
        ];
        for (const [path, body] of actions) {
          const response = yield* send(path, post(member, body));
          assert.strictEqual(response.status, 403, path);
          assert.strictEqual(response.headers.get("location"), null);
        }
        assert.deepStrictEqual(yield* users.list(owner.company.id), beforeUsers);
        assert.deepStrictEqual(yield* companies.listInvites(owner.company.id), beforeInvites);
        assert.deepStrictEqual(yield* recording.events, beforeMail);
      })
  );

  it.effect("checks Origin on all six actions even with an administrator's valid session", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-origin");
      const member = yield* addUser(owner, "member");
      const inactive = yield* addUser(owner, "inactive");
      const users = yield* Users.Users;
      const companies = yield* Companies.Companies;
      const recording = yield* InviteMail.Recording;
      yield* users.deactivate({ companyId: owner.company.id, userId: inactive.id });
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
        [`/company/users/${member.id}/deactivate`, {}],
        [`/company/users/${inactive.id}/reactivate`, {}]
      ];
      for (const [path, body] of actions) {
        for (const headers of [
          { origin: "https://foreign.invalid", "sec-fetch-site": "same-origin" },
          { "sec-fetch-site": "same-origin" }
        ]) {
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
      assert.deepStrictEqual(yield* recording.events, beforeMail);
    })
  );

  it.effect("cannot act on another company's users or invitations by crafting their ids", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-scope");
      const foreign = yield* createCompany("company-scope-foreign");
      const member = yield* addUser(foreign, "member");
      const inactive = yield* addUser(foreign, "inactive");
      const users = yield* Users.Users;
      const companies = yield* Companies.Companies;
      const recording = yield* InviteMail.Recording;
      yield* users.deactivate({ companyId: foreign.company.id, userId: inactive.id });
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
        [`/company/users/${member.id}/role`, { role: "admin" }],
        [`/company/users/${member.id}/deactivate`, {}],
        [`/company/users/${inactive.id}/reactivate`, {}]
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
    })
  );

  it.effect("re-renders the last-admin reason for demotion and a crafted self-deactivation", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-last-admin");
      for (const [action, body] of [
        ["role", { role: "member" }],
        ["deactivate", {}]
      ] as const) {
        const response = yield* send(
          `/company/users/${owner.user.id}/${action}`,
          post(owner.user, body)
        );
        assert.strictEqual(response.status, 409);
        assert.strictEqual(response.headers.get("location"), null);
        const html = yield* Effect.promise(() => response.text());
        assert.include(html, 'role="alert"');
        assert.match(html, /last (?:active )?admin/i);
        assert.notInclude(html, `action="/company/users/${owner.user.id}/deactivate"`);
      }
      const user = yield* (yield* Users.Users).findByClerkId(owner.user.clerkUserId);
      assert.strictEqual(user?.role, "admin");
      assert.isNull(user?.deactivatedAt);
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
    })
  );

  for (const [mode, mail] of [
    ["recording", InviteMail.layerRecording],
    ["failing", InviteMail.layerFailing]
  ] as const) {
    it.effect(
      `changes roles and deactivates/reactivates browser and bearer access with ${mode} mail`,
      () =>
        Effect.gen(function* () {
          const owner = yield* createCompany(`company-lifecycle-${mode}`);
          const member = yield* addUser(owner, "member");
          const tokens = yield* MachineTokens.MachineTokens;
          const laptop = yield* tokens.mint({ userId: member.id, name: "Laptop" });
          const desktop = yield* tokens.mint({ userId: member.id, name: "Desktop" });
          const adminMachine = yield* tokens.mint({ userId: owner.user.id, name: "Admin laptop" });
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
          assert.include(
            yield* Effect.promise(() => adminPage.text()),
            'action="/company/invites"'
          );
          redirected(
            yield* send(`/company/users/${member.id}/role`, post(owner.user, { role: "member" }))
          );
          assert.deepInclude(yield* (yield* me(laptop.token)).json, { role: "member" });

          redirected(yield* send(`/company/users/${member.id}/deactivate`, post(owner.user)));
          for (const token of [laptop.token, desktop.token]) {
            assert.strictEqual((yield* me(token)).status, 401);
          }
          assert.strictEqual((yield* me(adminMachine.token)).status, 200);
          const denied = yield* send("/company", { headers: { cookie: cookie(member) } });
          assert.strictEqual(denied.status, 403);
          assert.strictEqual(denied.headers.get("cache-control"), "private, no-store");
          const deniedHtml = yield* Effect.promise(() => denied.text());
          assert.match(deniedHtml, /deactivated/i);
          assert.include(deniedHtml, owner.company.name);
          assert.include(deniedHtml, 'action="/logout"');
          assert.notMatch(deniedHtml, /<form\b[^>]*action="\/company(?:\/|")/);
          const manage = yield* send("/company", { headers: { cookie: cookie(owner.user) } });
          assert.include(
            yield* Effect.promise(() => manage.text()),
            `action="/company/users/${member.id}/reactivate"`
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

          redirected(yield* send(`/company/users/${member.id}/reactivate`, post(owner.user)));
          const restored = yield* send("/company", { headers: { cookie: cookie(member) } });
          assert.strictEqual(restored.status, 200);
          const restoredHtml = yield* Effect.promise(() => restored.text());
          assert.include(restoredHtml, member.email);
          assert.notMatch(restoredHtml, /<form\b[^>]*action="\/company(?:\/|")/);
          for (const token of [laptop.token, desktop.token]) {
            assert.strictEqual((yield* me(token)).status, 401);
          }
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
        }).pipe(Effect.provide(mail))
    );
  }

  it.effect("keeps an undelivered invite usable for join after create fails", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-mail-create-failure");
      const email = "undelivered@example.com";
      const response = yield* send(
        "/company/invites",
        post(owner.user, { email, role: "admin" })
      ).pipe(Effect.provide(InviteMail.layerFailing));
      assert.include(yield* deliveryFailed(response), email);
      const [invite] = yield* (yield* Companies.Companies).listInvites(owner.company.id);
      assert.isDefined(invite);
      assert.isNull(invite!.clerkInvitationId);
      const sessionCookie = signedInCookies(
        signSession({ sub: "user_undelivered", email, name: "Invited" })
      );
      const joinPage = yield* send("/join", { headers: { cookie: sessionCookie } });
      assert.include(yield* Effect.promise(() => joinPage.text()), owner.company.name);
      redirected(
        yield* send("/join", {
          method: "POST",
          headers: { cookie: sessionCookie, origin },
          body: new URLSearchParams({ action: "join", inviteId: invite!.id })
        })
      );
      const joined = yield* (yield* Users.Users).findByClerkId("user_undelivered");
      assert.strictEqual(joined?.companyId, owner.company.id);
      assert.strictEqual(joined?.role, "admin");
    })
  );

  it.effect(
    "preserves the previous delivery when resend cannot revoke it, then permits a successful resend",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("company-mail-resend-failure");
        const companies = yield* Companies.Companies;
        redirected(
          yield* send(
            "/company/invites",
            post(owner.user, {
              email: "resend-failure@example.com",
              role: "member"
            })
          )
        );
        const [invite] = yield* companies.listInvites(owner.company.id);
        const response = yield* send(
          `/company/invites/${invite!.id}/resend`,
          post(owner.user)
        ).pipe(Effect.provide(InviteMail.layerFailing));
        assert.include(yield* deliveryFailed(response), invite!.email);
        const pending = yield* companies.listInvites(owner.company.id);
        assert.deepStrictEqual(
          pending.map((item) => item.id),
          [invite!.id]
        );
        assert.strictEqual(pending[0]!.clerkInvitationId, invite!.clerkInvitationId);
        redirected(yield* send(`/company/invites/${invite!.id}/resend`, post(owner.user)));
        const [resent] = yield* companies.listInvites(owner.company.id);
        assert.strictEqual(resent!.id, invite!.id);
        assert.isString(resent!.clerkInvitationId);
        assert.notStrictEqual(resent!.clerkInvitationId, invite!.clerkInvitationId);
      })
  );

  it.effect("revokes the local invitation even if Clerk cannot revoke its emailed link", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("company-mail-revoke-failure");
      const companies = yield* Companies.Companies;
      redirected(
        yield* send(
          "/company/invites",
          post(owner.user, {
            email: "revoke-failure@example.com",
            role: "member"
          })
        )
      );
      const [invite] = yield* companies.listInvites(owner.company.id);
      const response = yield* send(`/company/invites/${invite!.id}/revoke`, post(owner.user)).pipe(
        Effect.provide(InviteMail.layerFailing)
      );
      yield* deliveryFailed(response);
      assert.deepStrictEqual(yield* companies.listInvites(owner.company.id), []);
      assert.deepStrictEqual(yield* companies.findInvitesByEmail(invite!.email), []);
      const joined = yield* send("/join", {
        method: "POST",
        headers: {
          origin,
          cookie: signedInCookies(
            signSession({ sub: "user_revoke_failure_invite", email: invite!.email })
          )
        },
        body: new URLSearchParams({ action: "join", inviteId: invite!.id })
      });
      assert.strictEqual(joined.status, 409);
      assert.strictEqual(
        yield* (yield* Users.Users).findByClerkId("user_revoke_failure_invite"),
        null
      );
    })
  );
});
