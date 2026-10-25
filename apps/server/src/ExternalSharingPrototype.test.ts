import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { PublishCreated } from "@patchy/api";
import { MachineTokens } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { Companies } from "@patchy/companies";
import { html, publish, send, server } from "./test/server.js";

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
    yield* sql`SELECT id FROM prototype_external_shares WHERE patch_id = ${patchId} AND email = ${email}`;
  return String(row!.id);
});

it.layer(
  server({
    NODE_ENV: "test",
    PATCHY_PUBLIC_BASE_URL: origin,
    PATCHY_DEV_PERSONAS_SECRET: "recipient-home-test-secret"
  }).pipe(Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })))
)("signed-in recipient Home", (it) => {
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
        assert.include(body, 'class="app-card"');
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
          assert.strictEqual(response.headers.location, "/");
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
        for (const shared of [firstPatch, secondPatch])
          assert.strictEqual((yield* get(new URL(shared.address).pathname, recipient)).status, 200);
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
        assert.strictEqual(accepted.headers.location, "/shared");
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
