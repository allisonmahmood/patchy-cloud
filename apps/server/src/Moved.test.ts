/**
 * The moved pages over the whole server: every old GET answers 308 to its new URL with the query
 * as sent, every old POST is served by its new route with that route's checks, and the pages
 * the old fragments name keep their ids.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { MachineTokens } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import * as Moved from "./Moved.js";
import { send, server } from "./test/server.js";

const origin = "https://patchy.example";
const layer = Layer.mergeAll(Companies.layer, MachineTokens.layer).pipe(
  Layer.provideMerge(server({ PATCHY_PUBLIC_BASE_URL: origin })),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })),
  Layer.provideMerge(NodeCryptography.layer)
);

const admin = signedInCookies(
  signSession({ sub: DEV_SEED.clerkUserId, email: DEV_SEED.email, azp: origin })
);

/** A template with its parameters filled: ids no one holds, and an integration Patchy offers. */
const fill = (template: string) =>
  template.replace(/:(\w+)/g, (_, name: string) =>
    name === "integration" ? "postgres" : "usr_moved_nobody"
  );

const get = (path: string, cookie?: string) =>
  send(
    HttpClientRequest.get(path).pipe(
      HttpClientRequest.setHeaders(cookie === undefined ? {} : { cookie })
    )
  );
const post = (path: string, cookie: string, form: Record<string, string> = {}, from = origin) =>
  send(
    HttpClientRequest.post(path).pipe(
      HttpClientRequest.setHeaders({ cookie, origin: from }),
      HttpClientRequest.bodyUrlParams(form)
    )
  );
/** What a person sees of a response: its status, where it sends them and the page. */
const seen = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.map(response.text, (body) => ({
    status: response.status,
    location: response.headers.location,
    body
  }));

/** A member of the dev company, signed in. */
const member = Effect.fn("MovedTest.member")(function* (key: string) {
  const companies = yield* Companies.Companies;
  const email = `${key}@patchy.local`;
  const invite = yield* companies.createInvite({
    companyId: DEV_SEED.companyId,
    email,
    invitedBy: DEV_SEED.userId,
    role: "member"
  });
  const user = yield* companies.consumeInvite({
    inviteId: invite.id,
    clerkUserId: `user_${key}`,
    email,
    name: "Morgan"
  });
  return {
    user,
    cookie: signedInCookies(signSession({ sub: user.clerkUserId, email, azp: origin }))
  };
});

it.layer(layer)("moved pages", (it) => {
  it.effect("answers every old GET with 308 to its new URL, keeping the query as sent", () =>
    Effect.gen(function* () {
      const gets = Moved.moves.filter((move) => move.methods.includes("GET"));
      assert.isAbove(gets.length, 10);
      const fallback = yield* get("/no/such/page/here", admin).pipe(Effect.flatMap(seen));
      assert.strictEqual(fallback.status, 404);
      for (const move of gets) {
        const query = "?show=a%20b&q=x+y&empty";
        for (const cookie of [undefined, admin]) {
          const answer = yield* get(`${fill(move.from)}${query}`, cookie);
          assert.strictEqual(answer.status, 308, move.from);
          // A browser keeps the old URL's fragment when the new one names none.
          assert.strictEqual(answer.headers.location, `${fill(move.to)}${query}`, move.from);
        }
        // The new URL is a route of its own, not the fallback for an unknown address.
        const landed = yield* get(fill(move.to), admin).pipe(Effect.flatMap(seen));
        assert.notDeepEqual(landed, fallback, move.to);
      }
      const head = yield* send(HttpClientRequest.head("/company?show=guests"));
      assert.strictEqual(head.status, 308);
      assert.strictEqual(head.headers.location, "/settings/people?show=guests");
    })
  );

  it.effect(
    "finds an old address as the router found it: any case, trailing slash or encoding",
    () =>
      Effect.gen(function* () {
        for (const [path, location] of [
          ["/company/", "/settings/people"],
          ["/COMPANY?show=guests", "/settings/people?show=guests"],
          ["/%63ompany?show=guests", "/settings/people?show=guests"],
          ["//machines//revoke-all", "/agents/disconnect-all"],
          ["/Company/Connections/conn_1/Rotate", "/settings/integrations/conn_1/rotate"]
        ] as const) {
          const answer = yield* get(path);
          assert.strictEqual(answer.status, 308, path);
          assert.strictEqual(answer.headers.location, location, path);
        }
        const someone = yield* member("moved-spellings");
        for (const [path, to] of [
          ["/company/agent-access/", "/settings/agent-access"],
          ["/COMPANY/invites", "/settings/people/invites"],
          ["/company/users/usr_moved_nobody/ROLE", "/settings/people/users/usr_moved_nobody/role"]
        ] as const) {
          const answer = yield* post(path, someone.cookie).pipe(Effect.flatMap(seen));
          assert.strictEqual(answer.status, 403, path);
          assert.deepStrictEqual(
            answer,
            yield* post(to, someone.cookie).pipe(Effect.flatMap(seen)),
            path
          );
        }
      })
  );

  it.effect("sends an old link to an app's steps to Connect an app, under `app`", () =>
    Effect.gen(function* () {
      for (const [from, to] of [
        ["/machines?agent=codex", "/agents/connect?app=codex"],
        ["/machines?x=1&agent=claude-code&y=2", "/agents/connect?x=1&app=claude-code&y=2"],
        ["/machines?agent=", "/agents/connect?app="],
        ["/machines?agent", "/agents/connect?app"],
        // The old page read the first `agent` however it was spelled, and nothing else.
        ["/machines?%61gent=codex", "/agents/connect?app=codex"],
        ["/machines?app=claude&agent=codex&agent=chatgpt", "/agents/connect?app=codex&app=chatgpt"],
        ["/MACHINES/?agent=codex", "/agents/connect?app=codex"],
        ["/machines?agents=1", "/agents?agents=1"],
        ["/machines", "/agents"]
      ] as const) {
        const answer = yield* get(from);
        assert.strictEqual(answer.status, 308, from);
        assert.strictEqual(answer.headers.location, to, from);
      }
      const page = yield* get("/agents/connect?app=codex", admin).pipe(Effect.flatMap(seen));
      assert.strictEqual(page.status, 200);
      assert.include(page.body, 'id="connect-an-agent"');
      // The ids old `/machines#add-a-computer` and `#connect-an-agent` links name.
      const agents = yield* get("/agents", admin).pipe(Effect.flatMap(seen));
      assert.include(agents.body, 'id="add-a-computer" href="/agents/computer"');
      assert.include(agents.body, 'id="connect-an-agent"');
      const computer = yield* get("/agents/computer", admin).pipe(Effect.flatMap(seen));
      assert.include(computer.body, 'id="add-a-computer"');
    })
  );

  it.effect("leaves every other URL under the old addresses as it was", () =>
    Effect.gen(function* () {
      for (const [method, path] of [
        ["GET", "/machines/revoke"],
        ["GET", "/machines/tok_1/revoke"],
        ["GET", "/company/invites"],
        ["GET", "/company/users/usr_1/role"],
        ["GET", "/company/connections/conn_1/test"],
        ["GET", "/company/elsewhere"],
        ["POST", "/machines"],
        ["POST", "/company"],
        ["POST", "/company/connections/conn_1"],
        ["POST", "/settings"]
      ] as const) {
        assert.isUndefined(Moved.target(method, path), `${method} ${path}`);
        const answer = yield* send(
          (method === "GET" ? HttpClientRequest.get(path) : HttpClientRequest.post(path)).pipe(
            HttpClientRequest.setHeaders({ cookie: admin, origin })
          )
        );
        assert.strictEqual(answer.status, 404, `${method} ${path}`);
      }
    })
  );

  it.effect("serves every old POST by its new route, with every check that route makes", () =>
    Effect.gen(function* () {
      const posts = Moved.moves.filter((move) => move.methods.includes("POST"));
      assert.isAbove(posts.length, 10);
      const someone = yield* member("moved-refusals");
      const fallback = yield* post("/no/such/page/here", someone.cookie).pipe(Effect.flatMap(seen));
      assert.strictEqual(fallback.status, 404);
      for (const move of posts) {
        const [from, to] = [fill(move.from), fill(move.to)];
        // Another site's form is refused before anything else.
        const foreign = yield* post(from, admin, {}, "https://elsewhere.example");
        assert.strictEqual(foreign.status, 403, from);
        assert.deepStrictEqual(
          yield* seen(foreign),
          yield* post(to, admin, {}, "https://elsewhere.example").pipe(Effect.flatMap(seen)),
          from
        );
        // A member asking for someone else's thing, or for what only an admin may do, is
        // answered as at the new address.
        const answer = yield* post(from, someone.cookie).pipe(Effect.flatMap(seen));
        assert.notDeepEqual(answer, fallback, from);
        assert.deepStrictEqual(
          answer,
          yield* post(to, someone.cookie).pipe(Effect.flatMap(seen)),
          from
        );
      }
    })
  );

  it.effect("changes what the new route changes through an old form", () =>
    Effect.gen(function* () {
      const someone = yield* member("moved-changes");
      const tokens = yield* MachineTokens.MachineTokens;
      const machine = yield* tokens.mint({ userId: someone.user.id, name: "Old tab" });
      const revoked = yield* post(`/machines/${machine.id}/revoke`, someone.cookie);
      assert.strictEqual(revoked.status, 303);
      assert.strictEqual(revoked.headers.location, "/agents");
      assert.isNull(yield* tokens.authenticate(machine.token));

      const companies = yield* Companies.Companies;
      const before = yield* companies.agentAccess(DEV_SEED.companyId);
      const state = before.on ? "off" : "on";
      const turned = yield* post("/company/agent-access", admin, { state });
      assert.strictEqual(turned.status, 303);
      assert.strictEqual(turned.headers.location, "/settings/agent-access");
      assert.strictEqual((yield* companies.agentAccess(DEV_SEED.companyId)).on, !before.on);
      // A member's old form is refused as at the new address, and changes nothing.
      const refused = yield* post("/company/agent-access", someone.cookie, { state: "off" });
      assert.strictEqual(refused.status, 403);
      assert.strictEqual((yield* companies.agentAccess(DEV_SEED.companyId)).on, !before.on);
    })
  );
});
