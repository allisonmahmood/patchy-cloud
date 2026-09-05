import { assert, it } from "@effect/vitest";
import { CookieJar } from "tough-cookie";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { Companies, InviteMail, Users } from "@patchy/companies";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AuthPages from "./AuthPages.js";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Session from "./Session.js";
import { clerkEnv, signedInCookies, signHandshake, signSession } from "./testing.js";

const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const services = Layer.mergeAll(
  Session.layer,
  Companies.layer,
  Users.layer,
  InviteMail.layerRecording
).pipe(
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provide(Analytics.layerNoop),
  Layer.provide(Limits.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
);
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
const post = (cookie: string, body: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { cookie, origin: base },
  body: new URLSearchParams(body)
});
const account = Effect.fn(function* (label: string) {
  const created = yield* (yield* Companies.Companies).create({
    handle: `device-${label}`,
    name: `Company <${label}>`,
    clerkUserId: `user_device_${label}`,
    email: `device-${label}@example.com`,
    userName: 'Alex "Owner"'
  });
  return {
    ...created,
    cookie: signedInCookies(
      signSession({
        sub: created.user.clerkUserId,
        email: created.user.email,
        name: created.user.name
      })
    )
  };
});
const pathFor = (code: string) => `/login/device?code=${encodeURIComponent(code)}`;

it.layer(services)("device login pages in memory with keypair sessions", (it) => {
  it.effect(
    "shows the code first, names the identity, and confirms without minting a plaintext key",
    () =>
      Effect.gen(function* () {
        const owner = yield* account("confirm");
        const logins = yield* DeviceLogins.DeviceLogins;
        const tokens = yield* MachineTokens.MachineTokens;
        const login = yield* logins.start({ machineNameHint: 'Laptop "<hint>"' });
        const page = yield* send(pathFor(login.userCode), { headers: { cookie: owner.cookie } });
        assert.strictEqual(page.status, 200);
        assert.strictEqual(page.headers.get("cache-control"), "private, no-store");
        assert.include(page.headers.get("content-security-policy")!, "form-action 'self'");
        const html = yield* Effect.promise(() => page.text());
        assert.include(html, "Is this the code on your terminal?");
        assert.include(html, `<h1 class="device-code">${login.userCode}</h1>`);
        assert.include(html, "Company &lt;confirm&gt;");
        assert.include(html, "Alex &quot;Owner&quot;");
        assert.include(html, owner.user.email);
        assert.include(html, 'value="Laptop &quot;&lt;hint&gt;&quot;"');
        assert.include(html, "If you didn't run it, deny: nothing happens.");
        assert.include(html, "90 days, or 30 days unused");
        assert.include(html, "clerk.headless.browser.js");
        const confirmed = yield* send(
          "/login/device",
          post(owner.cookie, {
            action: "confirm",
            code: login.userCode,
            machineName: "Publishing laptop"
          })
        );
        assert.strictEqual(confirmed.status, 303);
        const receiptUrl = confirmed.headers.get("location")!;
        const receipt = yield* send(receiptUrl, { headers: { cookie: owner.cookie } });
        assert.strictEqual(receipt.status, 200);
        const confirmedHtml = yield* Effect.promise(() => receipt.text());
        assert.include(confirmedHtml, "Confirmed.");
        assert.include(
          confirmedHtml,
          "Your terminal finishes logging in on its own within a few seconds. You can close this tab."
        );
        assert.deepStrictEqual(yield* tokens.list(owner.user.id), []);
        const complete = yield* logins.poll(login.deviceCode);
        assert.isTrue(complete.ok && complete.status === "complete");
        if (!complete.ok || complete.status !== "complete") return;
        assert.notInclude(confirmedHtml, complete.token);
        assert.strictEqual(complete.machine.name, "Publishing laptop");
        const reloaded = yield* send(receiptUrl, { headers: { cookie: owner.cookie } });
        assert.strictEqual(reloaded.status, 200);
        assert.strictEqual(yield* Effect.promise(() => reloaded.text()), confirmedHtml);
        assert.strictEqual(
          (yield* send(pathFor(login.userCode), { headers: { cookie: owner.cookie } })).status,
          404
        );
      })
  );

  it.effect("inherits the old key name and explains when it stops working", () =>
    Effect.gen(function* () {
      const owner = yield* account("replace");
      const tokens = yield* MachineTokens.MachineTokens;
      const old = yield* tokens.mint({ userId: owner.user.id, name: 'Old "<laptop>"' });
      yield* tokens.revoke(old.id);
      const login = yield* (yield* DeviceLogins.DeviceLogins).start({
        machineNameHint: "hostname",
        previousMachineTokenId: old.id
      });
      const page = yield* send(pathFor(login.userCode), { headers: { cookie: owner.cookie } });
      const html = yield* Effect.promise(() => page.text());
      assert.include(html, 'value="Old &quot;&lt;laptop&gt;&quot;"');
      assert.include(html, "Replaces the key named");
      assert.include(html, "which stops working once your terminal finishes logging in");
      assert.notInclude(html, 'value="hostname"');
    })
  );

  it.effect("denies without requiring a name and renders the dead-code answer", () =>
    Effect.gen(function* () {
      const owner = yield* account("deny");
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "Laptop" });
      const response = yield* send(
        "/login/device",
        post(owner.cookie, { action: "deny", code: login.userCode })
      );
      assert.strictEqual(response.status, 303);
      const receiptUrl = response.headers.get("location")!;
      const receipt = yield* send(receiptUrl, { headers: { cookie: owner.cookie } });
      assert.strictEqual(receipt.status, 200);
      const html = yield* Effect.promise(() => receipt.text());
      assert.include(html, "Nothing was logged in.");
      assert.include(html, `The code ${login.userCode} is dead and no key was made.`);
      assert.include(html, "there is nothing else to do.");
      assert.deepStrictEqual(yield* (yield* MachineTokens.MachineTokens).list(owner.user.id), []);
      const result = yield* logins.poll(login.deviceCode);
      assert.isFalse(result.ok);
      if (!result.ok) assert.strictEqual(result.code, "denied");
      const reloaded = yield* send(receiptUrl, { headers: { cookie: owner.cookie } });
      assert.strictEqual(reloaded.status, 200);
      assert.strictEqual(yield* Effect.promise(() => reloaded.text()), html);
    })
  );

  it.effect(
    "renders expired, answered and unknown codes at their distinct statuses on GET and POST",
    () =>
      Effect.gen(function* () {
        const owner = yield* account("reverse");
        const logins = yield* DeviceLogins.DeviceLogins;
        const expired = [
          yield* logins.start({ machineNameHint: "Expired GET" }),
          yield* logins.start({ machineNameHint: "Expired POST" })
        ];
        yield* TestClock.adjust("10 minutes");
        yield* TestClock.adjust(1);
        for (const [index, login] of expired.entries()) {
          const response = yield* send(
            index === 0 ? pathFor(login.userCode) : "/login/device",
            index === 0
              ? { headers: { cookie: owner.cookie } }
              : post(owner.cookie, {
                  action: "confirm",
                  code: login.userCode,
                  machineName: "Late"
                })
          );
          assert.strictEqual(response.status, 410);
          const html = yield* Effect.promise(() => response.text());
          assert.include(html, "This code has expired.");
          assert.include(html, "A login code lasts ten minutes.");
          assert.include(html, "again on the machine and open the new link it prints.");
        }
        const answered = yield* logins.start({ machineNameHint: "Answered" });
        yield* logins.confirm({
          userCode: answered.userCode,
          userId: owner.user.id,
          machineName: "Answered"
        });
        for (const [code, status, copy] of [
          [answered.userCode, 410, "This code was already used."],
          ["UNKNOWN", 404, "Nothing is waiting for this code."]
        ] as const) {
          for (const action of ["get", "confirm", "deny"]) {
            const response = yield* send(
              action === "get" ? pathFor(code) : "/login/device",
              action === "get"
                ? { headers: { cookie: owner.cookie } }
                : post(owner.cookie, { action, code, machineName: "Another" })
            );
            assert.strictEqual(response.status, status);
            const html = yield* Effect.promise(() => response.text());
            assert.include(html, copy);
            if (status === 404) assert.include(html, "Check the link you opened, or run");
          }
        }
      })
  );

  it.effect(
    "preserves invalid machine names, refuses them at 422, and leaves confirmation pending",
    () =>
      Effect.gen(function* () {
        const owner = yield* account("names");
        const logins = yield* DeviceLogins.DeviceLogins;
        const login = yield* logins.start({ machineNameHint: "Hint" });
        for (const machineName of ["", "   ", "x".repeat(65)]) {
          const response = yield* send(
            "/login/device",
            post(owner.cookie, {
              action: "confirm",
              code: login.userCode,
              machineName
            })
          );
          assert.strictEqual(response.status, 422);
          const html = yield* Effect.promise(() => response.text());
          assert.include(html, "Give the machine a name, up to 64 characters.");
          assert.include(html, `value="${machineName}"`);
          assert.include(html, 'aria-invalid="true"');
          assert.include(html, login.userCode);
        }
        assert.deepStrictEqual(yield* logins.poll(login.deviceCode), {
          ok: true,
          status: "pending"
        });
        const accepted = yield* send(
          "/login/device",
          post(owner.cookie, {
            action: "confirm",
            code: login.userCode,
            machineName: "x".repeat(64)
          })
        );
        assert.strictEqual(accepted.status, 303);
      })
  );

  it.effect("offers only the terminal-link explanation at the bare URL behind the same door", () =>
    Effect.gen(function* () {
      const owner = yield* account("bare");
      assert.strictEqual((yield* send("/login/device")).status, 401);
      const response = yield* send("/login/device", { headers: { cookie: owner.cookie } });
      assert.strictEqual(response.status, 200);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, "Open the link your terminal printed.");
      assert.include(
        html,
        "prints a link that carries its own code, so there is nothing to type here."
      );
      assert.include(
        html,
        "If someone sent you here to type a code, don't: that is the trick the link is designed to avoid."
      );
      assert.notInclude(html, "<input");
      assert.notInclude(html, "<form");
    })
  );

  it.effect(
    "turns signed-out and expired-session POSTs into GETs and preserves the notice through the portal and handshake",
    () =>
      Effect.gen(function* () {
        const owner = yield* account("refresh");
        const logins = yield* DeviceLogins.DeviceLogins;
        for (const sessionCookie of [
          "",
          signedInCookies(signSession({ iat: 1, nbf: 1, exp: 2 }))
        ]) {
          const login = yield* logins.start({ machineNameHint: "Original hint" });
          const response = yield* send(
            "/login/device?code=WRONG-CODE",
            post(sessionCookie, {
              action: "confirm",
              code: login.userCode,
              machineName: "Never replay me"
            })
          );
          assert.strictEqual(response.status, 303);
          const location = response.headers.get("location")!;
          const target = new URL(location, base);
          assert.strictEqual(target.pathname, "/login/device");
          assert.strictEqual(target.searchParams.get("code"), login.userCode);
          assert.strictEqual(target.searchParams.get("refreshed"), "1");
          const door = yield* send(location);
          assert.strictEqual(door.status, 401);
          const portal = new URL(door.headers.get("x-patchy-sign-in-url")!);
          const returning = new URL(portal.searchParams.get("redirect_url")!);
          assert.strictEqual(returning.search, target.search);
          const directives = owner.cookie.split("; ").map((value) => `${value}; Path=/`);
          returning.searchParams.set("__clerk_handshake", signHandshake(directives));
          const handshake = yield* send(`${returning.pathname}${returning.search}`, {
            headers: { accept: "text/html" }
          });
          assert.strictEqual(handshake.status, 307);
          const jar = new CookieJar();
          for (const directive of handshake.headers.getSetCookie())
            jar.setCookieSync(directive, base);
          const back = new URL(handshake.headers.get("location")!);
          const page = yield* send(`${back.pathname}${back.search}`, {
            headers: { cookie: jar.getCookieStringSync(base) }
          });
          assert.strictEqual(page.status, 200);
          const html = yield* Effect.promise(() => page.text());
          assert.include(
            html,
            "Your sign-in was refreshed before that went through. Check the code and press Confirm again."
          );
          assert.include(html, 'value="Original hint"');
          assert.notInclude(html, "Never replay me");
          assert.deepStrictEqual(yield* logins.poll(login.deviceCode), {
            ok: true,
            status: "pending"
          });
        }
      })
  );

  it.effect("carries a deferred confirmation through create-or-join without replaying it", () =>
    Effect.gen(function* () {
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "Enrollment laptop" });
      const cookie = signedInCookies(
        signSession({ sub: "user_device_enroll", email: "device-enroll@example.com" })
      );
      const deferred = yield* send(
        "/login/device",
        post(cookie, { action: "confirm", code: login.userCode, machineName: "Must not replay" })
      );
      assert.strictEqual(deferred.status, 303);
      const join = deferred.headers.get("location")!;
      assert.strictEqual(new URL(join, base).pathname, "/join");
      const enrolled = yield* send(
        join,
        post(cookie, { action: "create", name: "Device Enrollment", handle: "device-enrollment" })
      );
      assert.strictEqual(enrolled.status, 303);
      const target = enrolled.headers.get("location")!;
      const page = yield* send(target, { headers: { cookie } });
      const html = yield* Effect.promise(() => page.text());
      assert.include(html, login.userCode);
      assert.include(html, "Check the code and press Confirm again.");
      assert.include(html, 'value="Enrollment laptop"');
      assert.deepStrictEqual(yield* logins.poll(login.deviceCode), { ok: true, status: "pending" });
    })
  );

  it.effect(
    "shares the per-user lookup bound with blind POST guesses and resumes after the window",
    () =>
      Effect.gen(function* () {
        const owner = yield* account("limited");
        let response = yield* send(
          "/login/device",
          post(owner.cookie, { code: "UNKNOWN", action: "deny" })
        );
        for (let attempts = 1; attempts < 20 && response.status !== 429; attempts++)
          response = yield* send(
            "/login/device",
            post(owner.cookie, { code: "UNKNOWN", action: "confirm", machineName: "Guess" })
          );
        assert.strictEqual(response.status, 429);
        assert.isAbove(Number(response.headers.get("retry-after")), 0);
        assert.include(yield* Effect.promise(() => response.text()), "Too many code lookups.");
        assert.strictEqual(
          (yield* send(pathFor("UNKNOWN"), { headers: { cookie: owner.cookie } })).status,
          429
        );
        const other = yield* account("not-limited");
        assert.strictEqual(
          (yield* send(pathFor("UNKNOWN"), { headers: { cookie: other.cookie } })).status,
          404
        );
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(
          (yield* send(pathFor("UNKNOWN"), { headers: { cookie: owner.cookie } })).status,
          404
        );
      })
  );

  it.effect(
    "lists only owned live tokens and revokes one or all without exposing credentials",
    () =>
      Effect.gen(function* () {
        const owner = yield* account("machines");
        const other = yield* account("foreign");
        const tokens = yield* MachineTokens.MachineTokens;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* tokens.mint({ userId: owner.user.id, name: 'Live "<laptop>"' });
        const second = yield* tokens.mint({ userId: owner.user.id, name: "Second machine" });
        const foreign = yield* tokens.mint({ userId: other.user.id, name: "Foreign secret name" });
        const revoked = yield* tokens.mint({ userId: owner.user.id, name: "Revoked machine" });
        yield* tokens.revoke(revoked.id);
        const expired = yield* tokens.mint({ userId: owner.user.id, name: "Expired machine" });
        const idle = yield* tokens.mint({ userId: owner.user.id, name: "Idle machine" });
        yield* sql`UPDATE machine_tokens SET expires_at = '1960-01-01' WHERE id = ${expired.id}`;
        yield* sql`UPDATE machine_tokens SET last_used_at = '1960-01-01' WHERE id = ${idle.id}`;
        const page = yield* send("/machines", { headers: { cookie: owner.cookie } });
        assert.strictEqual(page.status, 200);
        const html = yield* Effect.promise(() => page.text());
        assert.include(html, "Your machines");
        assert.include(html, "Live &quot;&lt;laptop&gt;&quot;");
        assert.include(html, "Created");
        assert.include(html, "Last used");
        assert.include(html, "Expires");
        assert.include(html, `datetime="${first.expiresAt}"`);
        assert.include(html, `action="/machines/${first.id}/revoke"`);
        assert.include(html, 'action="/machines/revoke-all"');
        assert.include(html, 'action="/logout"');
        for (const absent of [
          first.token,
          second.token,
          foreign.token,
          "Foreign secret name",
          "Revoked machine",
          "Expired machine",
          "Idle machine"
        ])
          assert.notInclude(html, absent);
        const refused = yield* send(`/machines/${foreign.id}/revoke`, post(owner.cookie));
        const missing = yield* send("/machines/tok_missing/revoke", post(owner.cookie));
        assert.strictEqual(refused.status, 404);
        assert.strictEqual(missing.status, 404);
        assert.strictEqual(
          yield* Effect.promise(() => refused.text()),
          yield* Effect.promise(() => missing.text())
        );
        const one = yield* send(`/machines/${first.id}/revoke`, post(owner.cookie));
        assert.strictEqual(one.status, 303);
        assert.strictEqual(one.headers.get("location"), "/machines");
        assert.strictEqual(yield* tokens.authenticate(first.token), null);
        assert.strictEqual((yield* tokens.authenticate(second.token))?.machine.id, second.id);
        const repeated = yield* send(`/machines/${first.id}/revoke`, post(owner.cookie));
        assert.strictEqual(repeated.status, 303);
        const all = yield* send("/machines/revoke-all", post(owner.cookie));
        assert.strictEqual(all.status, 303);
        assert.strictEqual(yield* tokens.authenticate(second.token), null);
        assert.strictEqual((yield* tokens.authenticate(foreign.token))?.machine.id, foreign.id);
        const empty = yield* send("/machines", { headers: { cookie: owner.cookie } });
        const emptyHtml = yield* Effect.promise(() => empty.text());
        assert.include(emptyHtml, "No machines are logged in.");
        assert.include(emptyHtml, 'action="/logout"');
        assert.notInclude(emptyHtml, 'action="/machines/revoke-all"');
      })
  );

  it.effect("shows the deactivated page rather than confirming or exposing machines", () =>
    Effect.gen(function* () {
      const owner = yield* account("deactivated");
      const companies = yield* Companies.Companies;
      const invite = yield* companies.createInvite({
        companyId: owner.company.id,
        email: "device-deactivated-member@example.com",
        invitedBy: owner.user.id
      });
      const user = yield* companies.consumeInvite({
        inviteId: invite.id,
        clerkUserId: "user_device_deactivated_member",
        email: "device-deactivated-member@example.com",
        name: "Departed"
      });
      yield* (yield* Users.Users).deactivate({ companyId: owner.company.id, userId: user.id });
      const cookie = signedInCookies(
        signSession({ sub: user.clerkUserId, email: user.email, name: user.name })
      );
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "Still pending" });
      for (const route of ["/machines", pathFor(login.userCode)]) {
        const response = yield* send(route, { headers: { cookie } });
        assert.strictEqual(response.status, 403);
        assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
        const html = yield* Effect.promise(() => response.text());
        assert.include(html, "Ask an admin to reactivate it.");
        assert.include(html, 'action="/logout"');
      }
      const confirmation = yield* send(
        "/login/device",
        post(cookie, { code: login.userCode, action: "confirm", machineName: "Refused" })
      );
      assert.strictEqual(confirmation.status, 403);
      assert.deepStrictEqual(yield* logins.poll(login.deviceCode), { ok: true, status: "pending" });
    })
  );

  it.effect(
    "requires session membership on the new pages and same-origin provenance on every action",
    () =>
      Effect.gen(function* () {
        const owner = yield* account("provenance");
        const logins = yield* DeviceLogins.DeviceLogins;
        const tokens = yield* MachineTokens.MachineTokens;
        const login = yield* logins.start({ machineNameHint: "Protected" });
        const token = yield* tokens.mint({ userId: owner.user.id, name: "Protected" });
        for (const route of ["/machines", pathFor(login.userCode)]) {
          const signedOut = yield* send(route, {
            headers: { authorization: `Bearer ${token.token}` }
          });
          assert.strictEqual(signedOut.status, 401);
        }
        for (const route of [
          "/login/device",
          `/machines/${token.id}/revoke`,
          "/machines/revoke-all"
        ]) {
          for (const origin of [undefined, "https://foreign.invalid"]) {
            const headers: Record<string, string> = { cookie: owner.cookie };
            if (origin !== undefined) {
              headers.origin = origin;
              headers["sec-fetch-site"] = "same-origin";
            }
            const response = yield* send(route, {
              method: "POST",
              headers,
              body: new URLSearchParams({
                action: "confirm",
                code: login.userCode,
                machineName: "Must not confirm"
              })
            });
            assert.strictEqual(response.status, 403);
            assert.strictEqual(response.headers.get("location"), null);
          }
        }
        assert.deepStrictEqual(yield* logins.poll(login.deviceCode), {
          ok: true,
          status: "pending"
        });
        assert.strictEqual((yield* tokens.authenticate(token.token))?.machine.id, token.id);
        const unenrolled = signedInCookies(signSession({ sub: "user_device_no_company" }));
        for (const route of ["/machines", pathFor(login.userCode)]) {
          const enrollment = yield* send(route, { headers: { cookie: unenrolled } });
          assert.strictEqual(enrollment.status, 303);
          assert.strictEqual(
            new URL(enrollment.headers.get("location")!, base).searchParams.get("return"),
            route
          );
        }
      })
  );
});
