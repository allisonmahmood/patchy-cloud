/** OFFLINE: the actual pinned Slack module calls a loopback provider double. No real Slack calls. */
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { Session } from "@patchy/auth";
import { clerkEnv, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { RuntimeLog } from "@patchy/runtime";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as Testing from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as CommunityConnections from "./CommunityConnections.js";
import * as CommunityPages from "./CommunityPages.js";
import * as Pieces from "./Pieces.js";

const tokens = ["xoxb-MockCompanyA000001", "xoxb-MockCompanyB000002"];
const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const requests: { path: string; token: string }[] = [];
let rejectProvider = false;

class Provider extends Context.Service<Provider, { readonly preload: string }>()(
  "prototype/slack/test/Provider"
) {}
const provider = Layer.effect(
  Provider,
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = await mkdtemp(join(tmpdir(), "patchy-slack-double-"));
      const server = createServer(async (req, res) => {
        req.resume(); // The mock inspects authorization and endpoint, not the SDK's form body.
        const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const path = req.url!.split("?")[0]!;
        requests.push({ path, token });
        const customer = tokens.indexOf(token);
        const body =
          customer < 0 || rejectProvider
            ? { ok: false, error: token }
            : path === "/api/auth.test"
              ? { ok: true, team_id: `T${customer}` }
              : path === "/api/conversations.list"
                ? {
                    ok: true,
                    channels: [
                      { id: `C${customer}`, name: `mock-company-${customer}`, is_private: false }
                    ],
                    response_metadata: { next_cursor: "" }
                  }
                : { ok: false, error: "unexpected_mock_endpoint" };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      }).listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing mock address");
      const mockBase = `http://127.0.0.1:${address.port}`;
      const preload = join(dir, "transport.cjs");
      await writeFile(
        preload,
        `
    const http = require('node:http');
    const https = require('node:https');
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input);
      if (url.origin !== 'https://slack.com') throw new Error('Offline test refused external request');
      return fetch(new URL(url.pathname + url.search, ${JSON.stringify(mockBase)}), init);
    };
    https.request = (options, callback) => {
      if (options.hostname !== 'slack.com') throw new Error('Offline test refused external request');
      return http.request({...options, protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1', port: ${address.port}, agent: undefined}, callback);
    };
  `
      );
      return { preload, server, dir };
    }),
    ({ server, dir }) =>
      Effect.promise(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      })
  )
);

const pieceLayer = Layer.effect(
  Pieces.Pieces,
  Effect.gen(function* () {
    return yield* Pieces.makeWithTestPreload((yield* Provider).preload);
  })
).pipe(Layer.provide(provider));
const services = Layer.mergeAll(
  CommunityConnections.layer,
  Session.layer,
  Companies.layer,
  Users.layer,
  HttpServer.layerServices,
  WideEvents.layerNoop
).pipe(
  Layer.provideMerge(pieceLayer),
  Layer.provideMerge(RuntimeLog.layer),
  Layer.provideMerge(
    CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 73).toString("base64")}`))
  ),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
);
const send = Effect.fn(function* (
  user: Users.User | null,
  path = CommunityPages.path,
  fields?: Record<string, string>,
  origin = base
) {
  const app = yield* HttpRouter.toHttpEffect(CommunityPages.layer);
  return HttpServerResponse.toWeb(
    yield* app.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(new URL(path, base), {
            method: fields ? "POST" : "GET",
            headers: {
              ...(user
                ? {
                    cookie: signedInCookies(
                      signSession({ sub: user.clerkUserId, email: user.email, name: user.name })
                    )
                  }
                : {}),
              origin
            },
            ...(fields ? { body: new URLSearchParams(fields) } : {})
          })
        )
      )
    )
  );
});

it.layer(services)("Slack inside Patchy (mock provider)", (it) => {
  it.effect(
    "selects each company's encrypted token, refuses foreign ids and members, removes tokens on disconnect",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const sql = yield* SqlClient.SqlClient;
        const logs = yield* RuntimeLog.RuntimeLog;
        const owners = [];
        for (const name of ["slack-a", "slack-b"])
          owners.push(
            yield* companies.create({
              handle: name,
              name,
              clerkUserId: `user_${name}`,
              email: `${name}@test.local`,
              userName: name
            })
          );
        const ids: string[] = [];
        for (const [i, owner] of owners.entries()) {
          assert.strictEqual(
            (yield* send(owner.user, CommunityPages.path, {
              handle: "workspace",
              token: tokens[i]!
            })).status,
            303
          );
          const rows = yield* sql<{
            id: string;
            credentials: string;
          }>`SELECT id, credentials FROM connections WHERE company_id = ${owner.company.id}`;
          assert.lengthOf(rows, 1);
          assert.notInclude(rows[0]!.credentials, tokens[i]!);
          ids.push(rows[0]!.id);
          const response = yield* send(owner.user, `${CommunityPages.path}/${ids[i]}/run`, {});
          assert.strictEqual(response.status, 200);
          const text = yield* Effect.promise(() => response.text());
          assert.include(text, `mock-company-${i}`);
          for (const token of tokens) assert.notInclude(text, token);
          const history = yield* logs.recent({
            companyId: owner.company.id,
            connectionId: ids[i]!
          });
          assert.strictEqual(history[0]!.outcome, "success");
          assert.notInclude(JSON.stringify(history), tokens[i]!);
        }
        assert.deepStrictEqual(
          requests.filter((r) => r.path === "/api/conversations.list").map((r) => r.token),
          tokens
        );
        const before = requests.length;
        for (const action of ["run", "disconnect", "delete", "connect"]) {
          const response = yield* send(
            owners[1]!.user,
            `${CommunityPages.path}/${ids[0]}/${action}`,
            { handle: "workspace", token: tokens[1]! }
          );
          assert.strictEqual(response.status, 404);
        }
        assert.strictEqual(requests.length, before);
        assert.strictEqual(
          (yield* send(
            owners[0]!.user,
            CommunityPages.path,
            { handle: "another", token: tokens[0]! },
            "https://other.example"
          )).status,
          403
        );
        assert.strictEqual(requests.length, before);
        const invite = yield* companies.createInvite({
          companyId: owners[0]!.company.id,
          invitedBy: owners[0]!.user.id,
          email: "member@test.local",
          role: "member"
        });
        const member = yield* companies.consumeInvite({
          inviteId: invite.id,
          clerkUserId: "user_slack_member",
          email: "member@test.local",
          name: "Member"
        });
        assert.strictEqual(
          (yield* send(member, `${CommunityPages.path}/${ids[0]}/run`, {})).status,
          403
        );
        assert.strictEqual((yield* send(null)).status, 401);
        rejectProvider = true;
        const failure = yield* send(owners[0]!.user, `${CommunityPages.path}/${ids[0]}/run`, {});
        assert.strictEqual(failure.status, 502);
        assert.notInclude(yield* Effect.promise(() => failure.text()), tokens[0]!);
        rejectProvider = false;
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${CommunityPages.path}/${ids[0]}/disconnect`, {})).status,
          303
        );
        const removed = yield* sql<{
          credentials: string;
        }>`SELECT credentials FROM connections WHERE id = ${ids[0]}`;
        assert.strictEqual(removed[0]!.credentials, "");
        const calls = requests.length;
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${CommunityPages.path}/${ids[0]}/run`, {})).status,
          404
        );
        assert.strictEqual(requests.length, calls);
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${CommunityPages.path}/${ids[0]}/connect`, {
            handle: "workspace",
            token: tokens[0]!
          })).status,
          303
        );
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${CommunityPages.path}/${ids[0]}/run`, {})).status,
          200
        );
      })
  );
});
