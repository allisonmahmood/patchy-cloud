import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { DEV_SEED } from "@patchy/auth/seed";
import { send, server } from "./test/server.js";
import { root } from "./TeamsPrototype.js";

const base = "http://teams.localhost:3000";
const get = (path: string, cookie: string) =>
  send(HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader("cookie", cookie)));
const post = (cookie: string, fields: Record<string, string>, origin = base) =>
  send(
    HttpClientRequest.post(root).pipe(
      HttpClientRequest.setHeaders({ cookie, origin }),
      HttpClientRequest.bodyUrlParams(fields)
    )
  );
const signIn = Effect.fn(function* (email: string) {
  const response = yield* send(
    HttpClientRequest.get(`/dev/sign-in?as=${encodeURIComponent(email)}`)
  );
  assert.strictEqual(response.status, 303);
  return Cookies.toCookieHeader(response.cookies);
});

it.layer(
  server({
    PATCHY_PUBLIC_BASE_URL: base,
    PATCHY_DEV_PERSONAS_SECRET: "teams-prototype-test",
    NODE_ENV: "test"
  }).pipe(Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })))
)("local team audience", (it) => {
  it.effect(
    "publishes atomically, denies outsiders and rechecks membership for readers and owners",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES ('teams-ben', 'teams-ben', ${DEV_SEED.companyId}, 'ben@teams.example', 'Ben', 'member'),
          ('teams-cleo', 'teams-cleo', ${DEV_SEED.companyId}, 'cleo@teams.example', 'Cleo', 'admin')`;
        const owner = yield* signIn(DEV_SEED.email);
        const teammate = yield* signIn("ben@teams.example");
        const outsider = yield* signIn("cleo@teams.example");
        const fields = {
          action: "publish",
          name: "review-room",
          title: "Review room",
          text: "Private review"
        };
        const open = `${root}/patches/review-room`;

        assert.strictEqual(
          (yield* post(teammate, { action: "create", name: "Design" })).status,
          403
        );
        assert.strictEqual(
          (yield* post(owner, { action: "create", name: "Design" }, "https://elsewhere.example"))
            .status,
          403
        );
        assert.strictEqual((yield* post(owner, { action: "create", name: "Design" })).status, 200);
        assert.strictEqual((yield* post(owner, { ...fields, audience: "team" })).status, 403);
        assert.strictEqual((yield* get(open, owner)).status, 404);
        for (const user of [DEV_SEED.userId, "teams-ben"])
          assert.strictEqual((yield* post(owner, { action: "add", user })).status, 200);

        assert.strictEqual((yield* post(owner, fields)).status, 400);
        assert.strictEqual((yield* get(open, teammate)).status, 404);
        const created = yield* post(owner, { ...fields, audience: "team" });
        assert.strictEqual(created.status, 201);
        const receipt = yield* created.text;
        assert.include(receipt, "Who can open: Design");
        assert.include(receipt, "Version 1");
        assert.include(receipt, "Ben");
        assert.strictEqual((yield* get(open, teammate)).status, 200);
        assert.include(yield* (yield* get(`${root}/patches`, teammate)).text, "Review room");
        assert.notInclude(yield* (yield* get(`${root}/patches`, outsider)).text, "Review room");
        const denied = yield* get(open, outsider);
        assert.strictEqual(denied.status, 404);
        assert.strictEqual(denied.headers["cache-control"], "private, no-store");
        assert.notInclude(yield* denied.text, "Private review");
        assert.strictEqual((yield* post(teammate, fields)).status, 403);
        assert.strictEqual((yield* post(outsider, fields)).status, 404);

        assert.strictEqual(
          (yield* post(owner, { action: "remove", user: "teams-ben" })).status,
          200
        );
        assert.strictEqual((yield* get(open, teammate)).status, 404);
        assert.notInclude(yield* (yield* get(`${root}/patches`, teammate)).text, "Review room");
        assert.strictEqual((yield* post(owner, { action: "add", user: "teams-ben" })).status, 200);
        assert.strictEqual((yield* get(open, teammate)).status, 200);

        const updated = yield* post(owner, { ...fields, text: "Second review" });
        assert.strictEqual(updated.status, 200);
        const updateReceipt = yield* updated.text;
        assert.include(updateReceipt, "Version 2");
        assert.include(updateReceipt, "Who can open: Design");
        assert.strictEqual((yield* post(owner, { ...fields, audience: "company" })).status, 400);
        assert.strictEqual((yield* get(open, outsider)).status, 404);

        assert.strictEqual(
          (yield* post(owner, { action: "remove", user: DEV_SEED.userId })).status,
          200
        );
        assert.strictEqual((yield* get(open, owner)).status, 404);
        assert.strictEqual((yield* post(owner, fields)).status, 404);
        assert.strictEqual(
          (yield* post(outsider, { action: "add", user: DEV_SEED.userId })).status,
          200
        );
        assert.strictEqual((yield* post(owner, fields)).status, 200);
        assert.include(yield* (yield* get(open, teammate)).text, "Version 3");

        assert.strictEqual(
          (yield* post(owner, { ...fields, name: "company-room", audience: "company" })).status,
          201
        );
        assert.strictEqual((yield* get(`${root}/patches/company-room`, outsider)).status, 200);
        const choice = yield* (yield* get(`${root}/publish`, owner)).text;
        assert.notMatch(choice, /type="radio"[^>]*checked/);
      })
  );
});

it.layer(server())("outside local personas", (it) => {
  it.effect("does not mount the prototype on a regular server", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* send(HttpClientRequest.get(root))).status, 404);
      assert.strictEqual((yield* post("", { action: "create", name: "Design" })).status, 404);
    })
  );
});
