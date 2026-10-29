import { assert, it } from "@effect/vitest";
import { CookieJar } from "tough-cookie";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Analytics } from "@patchy/analytics";
import { Companies, InviteMail, Users } from "@patchy/companies";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AgentConnections from "./AgentConnections.js";
import * as AuthPages from "./AuthPages.js";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Session from "./Session.js";
import * as SetupLinks from "./SetupLinks.js";
import { clerkEnv, signedInCookies, signHandshake, signSession } from "./testing.js";
import { NodeCryptography } from "@patchy/core";

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
  Layer.provideMerge(AgentConnections.layer),
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provide(Limits.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  Layer.provide(NodeCryptography.layer)
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
// What a rendered confirmation form would submit besides the person's own choices.
const hiddenFields = (html: string): Record<string, string> =>
  Object.fromEntries(
    Array.from(
      html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g),
      ([, name, value]) => [name, value]
    )
  );

it.layer(services)("device login pages in memory with keypair sessions", (it) => {
  it.effect(
    "confirms from the Final step panel only while the person's own line binds the login",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const owner = yield* account("inline-owner");
        const other = yield* account("inline-other");
        const logins = yield* DeviceLogins.DeviceLogins;
        const line = yield* SetupLinks.current(owner.user.id);
        const login = yield* logins.start({ machineNameHint: "laptop", setupLink: line.value });
        const answer = (who: typeof owner, fields: Record<string, string>) =>
          send(
            "/login/device",
            post(who.cookie, { userId: who.user.id, code: login.userCode, ...fields })
          );
        // Another account's form, or another line, confirms nothing and goes back Home.
        const foreign = yield* answer(other, {
          action: "confirm",
          machineName: "Laptop",
          setup: line.value
        });
        assert.strictEqual(foreign.status, 303);
        assert.strictEqual(foreign.headers.get("location"), "/");
        const elsewhere = yield* answer(owner, {
          action: "confirm",
          machineName: "Laptop",
          setup: (yield* SetupLinks.current(other.user.id)).value
        });
        assert.strictEqual(elsewhere.status, 303);
        assert.strictEqual(
          (yield* logins.lookup(login.userCode, owner.user.id)).userCode,
          login.userCode
        );
        // The owner's own form confirms, then the terminal collects its key.
        const confirmed = yield* answer(owner, {
          action: "confirm",
          machineName: "Laptop",
          setup: line.value
        });
        assert.strictEqual(confirmed.status, 303);
        assert.strictEqual(confirmed.headers.get("location"), "/");
        assert.strictEqual((yield* logins.poll(login.deviceCode)).status, "complete");
      })
  );

  it.effect("refuses a stale panel form once its line is contested", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const owner = yield* account("inline-contested");
      const logins = yield* DeviceLogins.DeviceLogins;
      const line = yield* SetupLinks.current(owner.user.id);
      const login = yield* logins.start({ machineNameHint: "laptop", setupLink: line.value });
      yield* logins.start({ machineNameHint: "elsewhere", setupLink: line.value });
      const stale = yield* send(
        "/login/device",
        post(owner.cookie, {
          userId: owner.user.id,
          code: login.userCode,
          action: "confirm",
          machineName: "Laptop",
          setup: line.value
        })
      );
      assert.strictEqual(stale.status, 303);
      // Still pending: the printed link can confirm it, the panel can't.
      assert.strictEqual(
        (yield* logins.lookup(login.userCode, owner.user.id)).userCode,
        login.userCode
      );
    })
  );

  it.effect("answers Not me by where the login actually is", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const owner = yield* account("inline-not-me");
      const logins = yield* DeviceLogins.DeviceLogins;
      const notMe = (line: string, code: string) =>
        logins.denyInline({ userCode: code, userId: owner.user.id, setupLink: line });

      // Pending: denied, and the terminal hears so.
      const pendingLine = yield* SetupLinks.current(owner.user.id);
      const pending = yield* logins.start({ machineNameHint: "a", setupLink: pendingLine.value });
      assert.strictEqual(yield* notMe(pendingLine.value, pending.userCode), "denied");
      const denied = yield* Effect.flip(logins.poll(pending.deviceCode));
      assert.strictEqual(denied._tag, "DeviceLoginDenied");

      // Confirmed but not collected: cancelled, so no key is ever made.
      yield* SetupLinks.retire(owner.user.id);
      const confirmedLine = yield* SetupLinks.current(owner.user.id);
      const confirmed = yield* logins.start({
        machineNameHint: "b",
        setupLink: confirmedLine.value
      });
      yield* logins.confirm({
        userCode: confirmed.userCode,
        userId: owner.user.id,
        machineName: "B"
      });
      assert.strictEqual(yield* notMe(confirmedLine.value, confirmed.userCode), "cancelled");
      const gone = yield* Effect.flip(logins.poll(confirmed.deviceCode));
      assert.strictEqual(gone._tag, "DeviceLoginUnknown");
      assert.deepStrictEqual(yield* (yield* MachineTokens.MachineTokens).list(owner.user.id), []);

      // Already minted: says so, for the person to remove on Your agents.
      yield* SetupLinks.retire(owner.user.id);
      const mintedLine = yield* SetupLinks.current(owner.user.id);
      const minted = yield* logins.start({ machineNameHint: "c", setupLink: mintedLine.value });
      yield* logins.confirm({ userCode: minted.userCode, userId: owner.user.id, machineName: "C" });
      yield* logins.poll(minted.deviceCode);
      assert.strictEqual(yield* notMe(mintedLine.value, minted.userCode), "connected");
      const page = yield* send(
        "/login/device",
        post(owner.cookie, {
          userId: owner.user.id,
          code: minted.userCode,
          action: "deny",
          setup: mintedLine.value
        })
      );
      assert.strictEqual(page.status, 409);
      assert.include(
        yield* Effect.promise(() => page.text()),
        "That computer is already connected."
      );
    })
  );

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
        assert.match(html, new RegExp(`<h1\\b[^>]*>${login.userCode}</h1>`));
        assert.include(html, "Company &lt;confirm&gt;");
        assert.include(html, "Alex &quot;Owner&quot;");
        assert.include(html, owner.user.email);
        assert.include(html, 'value="Laptop &quot;&lt;hint&gt;&quot;"');
        assert.include(html, "clerk.headless.browser.js");
        const confirmed = yield* send(
          "/login/device",
          post(owner.cookie, {
            userId: owner.user.id,
            action: "confirm",
            code: login.userCode,
            machineName: "Publishing laptop"
          })
        );
        assert.strictEqual(confirmed.status, 200);
        assert.strictEqual(confirmed.headers.get("cache-control"), "private, no-store");
        assert.strictEqual(confirmed.headers.get("location"), null);
        const confirmedHtml = yield* Effect.promise(() => confirmed.text());
        assert.include(confirmedHtml, "Confirmed.");
        // The person returns to the portal, where the guide picks up at their first patch.
        assert.include(confirmedHtml, "Your agent finishes setting up on its own.");
        assert.match(confirmedHtml, /<a href="\/">Back to [^<]+<\/a>/);
        assert.deepStrictEqual(yield* tokens.list(owner.user.id), []);
        const complete = yield* logins.poll(login.deviceCode);
        assert.strictEqual(complete.status, "complete");
        if (complete.status !== "complete") return;
        assert.notInclude(confirmedHtml, complete.token);
        assert.strictEqual(complete.machine.name, "Publishing laptop");
        assert.strictEqual(
          (yield* send(pathFor(login.userCode), { headers: { cookie: owner.cookie } })).status,
          404
        );
      })
  );

  it.effect(
    "refuses an answer from a page rendered for another account and asks the current one",
    () =>
      Effect.gen(function* () {
        const alice = yield* account("switch-alice");
        const bob = yield* account("switch-bob");
        const logins = yield* DeviceLogins.DeviceLogins;
        const tokens = yield* MachineTokens.MachineTokens;
        const login = yield* logins.start({ machineNameHint: "Shared laptop" });
        const page = yield* send(pathFor(login.userCode), { headers: { cookie: alice.cookie } });
        const stale = hiddenFields(yield* Effect.promise(() => page.text()));
        let fresh = "";
        for (const action of ["confirm", "deny"]) {
          const response = yield* send(
            "/login/device",
            post(bob.cookie, { ...stale, action, machineName: "Named for Alice" })
          );
          assert.strictEqual(response.status, 409);
          assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
          fresh = yield* Effect.promise(() => response.text());
          assert.include(fresh, 'role="alert">The signed-in account changed');
          assert.include(fresh, "Company &lt;switch-bob&gt;");
          assert.include(fresh, bob.user.email);
          assert.notInclude(fresh, alice.user.email);
          assert.notInclude(fresh, "Named for Alice");
          assert.include(fresh, 'value="Shared laptop"');
        }
        assert.deepStrictEqual(yield* logins.poll(login.deviceCode), { status: "pending" });
        assert.deepStrictEqual(yield* tokens.list(alice.user.id), []);
        assert.deepStrictEqual(yield* tokens.list(bob.user.id), []);
        const confirmed = yield* send(
          "/login/device",
          post(bob.cookie, { ...hiddenFields(fresh), action: "confirm", machineName: "Bob's" })
        );
        assert.strictEqual(confirmed.status, 200);
        yield* TestClock.adjust("5 seconds");
        const complete = yield* logins.poll(login.deviceCode);
        assert.strictEqual(complete.status, "complete");
        if (complete.status !== "complete") return;
        assert.strictEqual(complete.user.email, bob.user.email);
        assert.strictEqual(complete.company.handle, bob.company.handle);
        assert.strictEqual(complete.machine.name, "Bob's");
      })
  );

  it.effect("refuses a form that does not name the account it was rendered for", () =>
    Effect.gen(function* () {
      const owner = yield* account("unnamed");
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "Laptop" });
      for (const action of ["confirm", "deny"]) {
        const response = yield* send(
          "/login/device",
          post(owner.cookie, { action, code: login.userCode, machineName: "Laptop" })
        );
        assert.strictEqual(response.status, 400);
        assert.include(yield* Effect.promise(() => response.text()), "Invalid form");
      }
      assert.deepStrictEqual(yield* logins.poll(login.deviceCode), { status: "pending" });
    })
  );

  it.effect("inherits the old key name and says which key it replaces", () =>
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
      assert.notInclude(html, 'value="hostname"');
    })
  );

  it.effect("keeps a long name hint to 64 characters, so Deny still fits the form", () =>
    Effect.gen(function* () {
      const owner = yield* account("long-hint");
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "&".repeat(1_400) });
      const page = yield* send(pathFor(login.userCode), { headers: { cookie: owner.cookie } });
      const html = yield* Effect.promise(() => page.text());
      assert.include(html, `name="machineName" value="${"&amp;".repeat(64)}"`);
      // What the browser posts for Deny with that prefill is answered, not refused for size.
      const denied = yield* send(
        "/login/device",
        post(owner.cookie, {
          userId: owner.user.id,
          action: "deny",
          code: login.userCode,
          machineName: "&".repeat(64)
        })
      );
      assert.strictEqual(denied.status, 200);
      assert.strictEqual(
        (yield* logins.poll(login.deviceCode).pipe(Effect.flip))._tag,
        "DeviceLoginDenied"
      );
    })
  );

  it.effect("denies without requiring a name and renders the dead-code answer", () =>
    Effect.gen(function* () {
      const owner = yield* account("deny");
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "Laptop" });
      const response = yield* send(
        "/login/device",
        post(owner.cookie, { userId: owner.user.id, action: "deny", code: login.userCode })
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
      assert.strictEqual(response.headers.get("location"), null);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, "Nothing was logged in.");
      const actual = yield* send(pathFor(login.userCode), { headers: { cookie: owner.cookie } });
      assert.strictEqual(actual.status, 410);
      assert.include(yield* Effect.promise(() => actual.text()), "This code was already used.");
      assert.deepStrictEqual(yield* (yield* MachineTokens.MachineTokens).list(owner.user.id), []);
      const result = yield* logins.poll(login.deviceCode).pipe(Effect.flip);
      assert.strictEqual(result._tag, "DeviceLoginDenied");
      const afterPoll = yield* send(pathFor(login.userCode), { headers: { cookie: owner.cookie } });
      assert.strictEqual(afterPoll.status, 404);
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
                  userId: owner.user.id,
                  action: "confirm",
                  code: login.userCode,
                  machineName: "Late"
                })
          );
          assert.strictEqual(response.status, 410);
          assert.include(yield* Effect.promise(() => response.text()), "This code has expired.");
        }
        const answered = yield* logins.start({ machineNameHint: "Answered" });
        yield* logins.confirm({
          userCode: answered.userCode,
          userId: owner.user.id,
          machineName: "Answered"
        });
        const confirmed = yield* send(pathFor(answered.userCode), {
          headers: { cookie: owner.cookie }
        });
        assert.strictEqual(confirmed.status, 410);
        for (const action of ["get", "confirm", "deny"]) {
          const response = yield* send(
            action === "get" ? pathFor("UNKNOWN") : "/login/device",
            action === "get"
              ? { headers: { cookie: owner.cookie } }
              : post(owner.cookie, {
                  userId: owner.user.id,
                  action,
                  code: "UNKNOWN",
                  machineName: "Another"
                })
          );
          assert.strictEqual(response.status, 404);
          if (action === "get") {
            assert.include(
              yield* Effect.promise(() => response.text()),
              "Nothing is waiting for this code."
            );
          }
        }
        for (const action of ["confirm", "deny"]) {
          const response = yield* send(
            "/login/device",
            post(owner.cookie, {
              userId: owner.user.id,
              action,
              code: answered.userCode,
              machineName: "Another"
            })
          );
          assert.strictEqual(response.status, 410);
          assert.include(
            yield* Effect.promise(() => response.text()),
            "This code was already used."
          );
        }
      })
  );

  it.effect("counts invalid form submissions once in the shared per-user lookup allowance", () =>
    Effect.gen(function* () {
      const owner = yield* account("invalid-limit");
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "Waiting" });
      for (let attempt = 0; attempt < 5; attempt++) {
        const page = yield* send(pathFor(login.userCode), { headers: { cookie: owner.cookie } });
        assert.strictEqual(page.status, 200);
        const invalid = yield* send(
          "/login/device",
          post(owner.cookie, {
            userId: owner.user.id,
            action: "confirm",
            code: login.userCode,
            machineName: ""
          })
        );
        assert.strictEqual(invalid.status, 422);
      }
      const limited = yield* send(
        "/login/device",
        post(owner.cookie, {
          userId: owner.user.id,
          action: "confirm",
          code: login.userCode,
          machineName: "Valid"
        })
      );
      assert.strictEqual(limited.status, 429);
      yield* TestClock.adjust("1 minute");
      const accepted = yield* send(
        "/login/device",
        post(owner.cookie, {
          userId: owner.user.id,
          action: "confirm",
          code: login.userCode,
          machineName: "Valid"
        })
      );
      assert.strictEqual(accepted.status, 200);
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
              userId: owner.user.id,
              action: "confirm",
              code: login.userCode,
              machineName
            })
          );
          assert.strictEqual(response.status, 422);
          const html = yield* Effect.promise(() => response.text());
          assert.include(html, `value="${machineName}"`);
          assert.include(html, 'aria-invalid="true"');
          assert.include(html, login.userCode);
        }
        assert.deepStrictEqual(yield* logins.poll(login.deviceCode), {
          status: "pending"
        });
        const accepted = yield* send(
          "/login/device",
          post(owner.cookie, {
            userId: owner.user.id,
            action: "confirm",
            code: login.userCode,
            machineName: "x".repeat(64)
          })
        );
        assert.strictEqual(accepted.status, 200);
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
              userId: owner.user.id,
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
          assert.include(html, "Check the code and press Confirm again.");
          assert.include(html, 'value="Original hint"');
          assert.notInclude(html, "Never replay me");
          assert.deepStrictEqual(yield* logins.poll(login.deviceCode), {
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
        post(cookie, {
          userId: "user_rendered_before_enrollment",
          action: "confirm",
          code: login.userCode,
          machineName: "Must not replay"
        })
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
      assert.deepStrictEqual(yield* logins.poll(login.deviceCode), { status: "pending" });
    })
  );

  it.effect(
    "shares the per-user lookup bound with blind POST guesses and resumes after the window",
    () =>
      Effect.gen(function* () {
        const owner = yield* account("limited");
        let response = yield* send(
          "/login/device",
          post(owner.cookie, { userId: owner.user.id, code: "UNKNOWN", action: "deny" })
        );
        for (let attempts = 1; attempts < 20 && response.status !== 429; attempts++)
          response = yield* send(
            "/login/device",
            post(owner.cookie, {
              userId: owner.user.id,
              code: "UNKNOWN",
              action: "confirm",
              machineName: "Guess"
            })
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
        post(cookie, {
          userId: user.id,
          code: login.userCode,
          action: "confirm",
          machineName: "Refused"
        })
      );
      assert.strictEqual(confirmation.status, 403);
      assert.deepStrictEqual(yield* logins.poll(login.deviceCode), { status: "pending" });
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
        const connections = yield* AgentConnections.AgentConnections;
        const agent = yield* connections.create({
          userId: owner.user.id,
          clientId: "https://claude.ai/oauth/claude-code-client-metadata",
          clientName: "Protected"
        });
        for (const route of ["/machines", pathFor(login.userCode)]) {
          const signedOut = yield* send(route, {
            headers: { authorization: `Bearer ${token.token}` }
          });
          assert.strictEqual(signedOut.status, 401);
        }
        for (const route of [
          "/login/device",
          `/machines/${token.id}/revoke`,
          `/machines/agents/${agent.connection.id}/disconnect`,
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
          status: "pending"
        });
        assert.strictEqual((yield* tokens.authenticate(token.token))?.machine.id, token.id);
        assert.isNotNull(yield* connections.authenticate(agent.tokens.accessToken));
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
