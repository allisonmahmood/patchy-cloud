/** OFFLINE: pinned Slack/Resend modules call a loopback provider double. No real provider calls. */
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
const resendTokens = ["re_MockCompanyA000001", "re_MockCompanyB000002"];
const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const slackPath = `${CommunityPages.path}/slack`;
const requests: {
  provider: string;
  path: string;
  token: string;
  fields: Record<string, string>;
}[] = [];
let rejectProvider = false;
let echoCredential = false;

class Provider extends Context.Service<Provider, { readonly preload: string }>()(
  "prototype/slack/test/Provider"
) {}
const provider = Layer.effect(
  Provider,
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = await mkdtemp(join(tmpdir(), "patchy-slack-double-"));
      const server = createServer(async (req, res) => {
        let bodyText = "";
        for await (const chunk of req) bodyText += chunk;
        const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const provider = req.url!.startsWith("/resend/") ? "resend" : "slack";
        const path = req.url!.split("?")[0]!.replace(/^\/(?:resend|slack)/, "");
        const fields = Object.fromEntries(new URLSearchParams(bodyText));
        requests.push({ provider, path, token, fields });
        if (provider === "resend") {
          const customer = resendTokens.indexOf(token);
          res.setHeader("content-type", "application/json");
          if (customer < 0 || rejectProvider) {
            res.writeHead(401).end(JSON.stringify({ name: "validation_error", message: token }));
          } else if (path === "/api-keys") res.end(JSON.stringify({ data: [] }));
          else if (path === "/domains")
            res.end(
              JSON.stringify({
                data: [
                  {
                    id: `domain-${customer}`,
                    name: echoCredential ? token : `mock-resend-${customer}.example`,
                    status: "verified",
                    region: "us-east-1"
                  }
                ],
                has_more: false
              })
            );
          else res.writeHead(404).end("{}");
          return;
        }
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
                : path === "/api/conversations.replies" &&
                    fields.channel === `D${customer}` &&
                    fields.ts === "1700000000.000001"
                  ? {
                      ok: true,
                      messages: [{ ts: fields.ts, text: `mock-thread-company-${customer}` }],
                      has_more: false,
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
      const provider = url.origin === 'https://slack.com' ? 'slack' : url.origin === 'https://api.resend.com' ? 'resend' : undefined;
      if (!provider) throw new Error('Offline test refused external request');
      return fetch(new URL('/' + provider + url.pathname + url.search, ${JSON.stringify(mockBase)}), init);
    };
    https.request = (options, callback) => {
      if (options.hostname !== 'slack.com') throw new Error('Offline test refused external request');
      return http.request({...options, path: '/slack' + options.path, protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1', port: ${address.port}, agent: undefined}, callback);
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
  path = slackPath,
  fields?: Record<string, string> | URLSearchParams,
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

it.layer(services)("Community connector catalog (mock providers)", (it) => {
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
            (yield* send(owner.user, slackPath, {
              handle: "workspace",
              "credential.botToken": tokens[i]!
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
          const response = yield* send(owner.user, `${slackPath}/${ids[i]}/run`, {});
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
          const thread = yield* send(
            owner.user,
            `${slackPath}/${ids[i]}/run/slack_get_thread_replies`,
            {
              "input.channel": `D${i}`,
              "input.threadTs": "1700000000.000001"
            }
          );
          assert.strictEqual(thread.status, 200);
          assert.include(yield* Effect.promise(() => thread.text()), `mock-thread-company-${i}`);
        }
        assert.deepStrictEqual(
          requests.filter((r) => r.path === "/api/conversations.list").map((r) => r.token),
          tokens
        );
        assert.deepStrictEqual(
          requests
            .filter((r) => r.path === "/api/conversations.replies")
            .map(({ token, fields }) => ({ token, channel: fields.channel, ts: fields.ts })),
          tokens.map((token, i) => ({ token, channel: `D${i}`, ts: "1700000000.000001" }))
        );
        const before = requests.length;
        const invalidInputs: Array<Record<string, string> | URLSearchParams> = [
          {},
          { "input.channel": "D0", "input.threadTs": " " },
          {
            "input.channel": "D0",
            "input.threadTs": "1700000000.000001",
            "input.botToken": tokens[1]!
          },
          { "input.channel": "D".repeat(4097), "input.threadTs": "1700000000.000001" },
          new URLSearchParams([
            ["input.channel", "D0"],
            ["input.channel", "D1"],
            ["input.threadTs", "1700000000.000001"]
          ])
        ];
        for (const fields of invalidInputs)
          assert.strictEqual(
            (yield* send(
              owners[0]!.user,
              `${slackPath}/${ids[0]}/run/slack_get_thread_replies`,
              fields
            )).status,
            422
          );
        assert.strictEqual(
          (yield* send(owners[1]!.user, `${slackPath}/${ids[0]}/run/slack_get_thread_replies`, {
            "input.channel": "D0",
            "input.threadTs": "1700000000.000001"
          })).status,
          404
        );
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${slackPath}/${ids[0]}/run/slack_list_channels`, {
            "input.types": "im"
          })).status,
          422
        );
        for (const action of ["run", "disconnect", "delete", "connect"]) {
          const response = yield* send(
            owners[1]!.user,
            `${slackPath}/${ids[0]}/${action}`,
            action === "connect"
              ? {
                  handle: "workspace",
                  "credential.botToken": tokens[1]!
                }
              : {}
          );
          assert.strictEqual(response.status, 404);
        }
        assert.strictEqual(requests.length, before);
        assert.strictEqual(
          (yield* send(
            owners[0]!.user,
            slackPath,
            { handle: "another", "credential.botToken": tokens[0]! },
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
        assert.strictEqual((yield* send(member, `${slackPath}/${ids[0]}/run`, {})).status, 403);
        assert.strictEqual((yield* send(null)).status, 401);
        rejectProvider = true;
        const failure = yield* send(owners[0]!.user, `${slackPath}/${ids[0]}/run`, {});
        assert.strictEqual(failure.status, 502);
        assert.notInclude(yield* Effect.promise(() => failure.text()), tokens[0]!);
        rejectProvider = false;
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${slackPath}/${ids[0]}/disconnect`, {})).status,
          303
        );
        const removed = yield* sql<{
          credentials: string;
        }>`SELECT credentials FROM connections WHERE id = ${ids[0]}`;
        assert.strictEqual(removed[0]!.credentials, "");
        const calls = requests.length;
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${slackPath}/${ids[0]}/run`, {})).status,
          404
        );
        assert.strictEqual(requests.length, calls);
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${slackPath}/${ids[0]}/connect`, {
            handle: "workspace",
            "credential.botToken": tokens[0]!
          })).status,
          303
        );
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${slackPath}/${ids[0]}/run`, {})).status,
          200
        );
      })
  );
  it.effect(
    "uses the same generated form and encrypted store for Resend, denies other providers and unadmitted actions",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const sql = yield* SqlClient.SqlClient;
        const logs = yield* RuntimeLog.RuntimeLog;
        const owners = [];
        const target = `${CommunityPages.path}/resend`;
        const ids: string[] = [];
        for (const name of ["resend-a", "resend-b"])
          owners.push(
            yield* companies.create({
              handle: name,
              name,
              clerkUserId: `user_${name}`,
              email: `${name}@test.local`,
              userName: name
            })
          );
        for (const [i, owner] of owners.entries()) {
          const form = yield* send(owner.user, target);
          const formHtml = yield* Effect.promise(() => form.text());
          assert.include(formHtml, 'name="credential.secret_text"');
          assert.include(formHtml, 'type="password"');
          assert.include(formHtml, "Full access");
          assert.strictEqual(
            (yield* send(owner.user, target, {
              handle: "workspace",
              "credential.secret_text": resendTokens[i]!
            })).status,
            303
          );
          const rows = yield* sql<{
            id: string;
            credentials: string;
            keyId: string;
          }>`SELECT id, credentials, key_id AS "keyId" FROM connections WHERE company_id = ${owner.company.id} AND integration = 'activepieces:resend'`;
          assert.lengthOf(rows, 1);
          ids.push(rows[0]!.id);
          assert.notInclude(rows[0]!.credentials, resendTokens[i]!);
          const encrypted = yield* (yield* CredentialKeys.CredentialKeys).decrypt(
            { companyId: owner.company.id, id: rows[0]!.id, integration: "activepieces:resend" },
            rows[0]!
          );
          assert.deepStrictEqual(yield* Pieces.decodeCredentials(Redacted.value(encrypted)), {
            secret_text: resendTokens[i]!
          });
          const result = yield* send(owner.user, `${target}/${ids[i]}/run/list_domains`, {});
          assert.strictEqual(result.status, 200);
          const text = yield* Effect.promise(() => result.text());
          assert.include(text, `mock-resend-${i}.example`);
          for (const token of resendTokens) assert.notInclude(text, token);
          const history = yield* logs.recent({
            companyId: owner.company.id,
            connectionId: ids[i]!
          });
          assert.strictEqual(history[0]!.resource, "list_domains");
          assert.strictEqual(history[0]!.outcome, "success");
          assert.notInclude(JSON.stringify(history), resendTokens[i]!);
        }
        assert.deepStrictEqual(
          requests
            .filter((r) => r.provider === "resend" && r.path === "/domains")
            .map((r) => r.token),
          resendTokens
        );
        const catalogue = yield* send(owners[0]!.user, CommunityPages.path);
        const html = yield* Effect.promise(() => catalogue.text());
        assert.include(html, "Resend");
        assert.include(html, "Slack");
        assert.include(html, "App setup required");
        const before = requests.length;
        for (const action of ["run", "connect", "disconnect", "delete"])
          assert.strictEqual(
            (yield* send(
              owners[1]!.user,
              `${target}/${ids[0]}/${action}`,
              action === "connect"
                ? {
                    handle: "workspace",
                    "credential.secret_text": resendTokens[1]!
                  }
                : {}
            )).status,
            404
          );
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${target}/${ids[0]}/run/send_email`, {})).status,
          422
        );
        assert.strictEqual(
          (yield* send(owners[0]!.user, target, {
            handle: "workspace",
            "credential.secret_text": resendTokens[0]!,
            "credential.baseUrl": "https://elsewhere.example"
          })).status,
          422
        );
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${CommunityPages.path}/__proto__`)).status,
          404
        );
        assert.strictEqual(requests.length, before);
        echoCredential = true;
        const reflected = yield* send(owners[0]!.user, `${target}/${ids[0]}/run`, {});
        const reflectedHtml = yield* Effect.promise(() => reflected.text());
        assert.strictEqual(reflected.status, 200);
        assert.notInclude(reflectedHtml, resendTokens[0]!);
        assert.include(reflectedHtml, "[redacted]");
        echoCredential = false;
        const invalidToken = "re_MockInvalidCredential0001";
        const failure = yield* send(owners[0]!.user, target, {
          handle: "invalid",
          "credential.secret_text": invalidToken
        });
        assert.strictEqual(failure.status, 422);
        assert.notInclude(yield* Effect.promise(() => failure.text()), invalidToken);
        assert.lengthOf(
          yield* sql`SELECT id FROM connections WHERE company_id = ${owners[0]!.company.id} AND handle = 'invalid'`,
          0
        );

        assert.strictEqual(
          (yield* send(owners[0]!.user, slackPath, {
            handle: "workspace",
            "credential.botToken": tokens[0]!
          })).status,
          303
        );
        const slack = (yield* sql<{
          id: string;
        }>`SELECT id FROM connections WHERE company_id = ${owners[0]!.company.id} AND integration = 'activepieces:slack'`)[0]!;
        const count = requests.length;
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${target}/${slack.id}/run`, {})).status,
          404
        );
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${slackPath}/${ids[0]}/run`, {})).status,
          404
        );
        assert.strictEqual(requests.length, count);
        // A connection created by the previous branch stores an encrypted raw bot token.
        const legacy = yield* (yield* CredentialKeys.CredentialKeys).encrypt(
          { companyId: owners[0]!.company.id, id: slack.id, integration: "activepieces:slack" },
          Redacted.make(tokens[0]!)
        );
        yield* sql`UPDATE connections SET credentials = ${legacy.credentials}, key_id = ${legacy.keyId}, display = '{"piece":"slack","version":"0.23.1"}'::jsonb WHERE id = ${slack.id}`;
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${slackPath}/${slack.id}/run`, {})).status,
          200
        );
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${target}/${ids[0]}/disconnect`, {})).status,
          303
        );
        const stopped = requests.length;
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${target}/${ids[0]}/run`, {})).status,
          404
        );
        assert.strictEqual(requests.length, stopped);
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${target}/${ids[0]}/connect`, {
            handle: "workspace",
            "credential.secret_text": resendTokens[0]!
          })).status,
          303
        );
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${target}/${ids[0]}/run`, {})).status,
          200
        );
      })
  );
});
