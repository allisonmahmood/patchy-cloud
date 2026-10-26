/** OFFLINE: pinned community modules call a loopback provider double. No real provider calls. */
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { expect } from "vitest";
import { build } from "esbuild";
import { CURRENT_RELEASE, RuntimeGroup, WIRE_VERSION } from "@patchy/api";
import { Session } from "@patchy/auth";
import { clerkEnv, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import {
  LoadedVersions,
  RuntimeApi,
  RuntimeLog,
  RuntimeProduction,
  StreamAdmission
} from "@patchy/runtime";
import { Limits, OperatingLimits } from "@patchy/limits";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as Testing from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
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
import * as CommunityRuntime from "./CommunityRuntime.js";

const tokens = ["xoxb-MockCompanyA000001", "xoxb-MockCompanyB000002"];
const resendTokens = ["re_MockCompanyA000001", "re_MockCompanyB000002"];
const githubTokens = ["github_pat_MockCompanyA000001", "github_pat_MockCompanyB000002"];
const notionTokens = ["ntn_MockCompanyA000001", "ntn_MockCompanyB000002"];
const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const slackPath = `${CommunityPages.path}/slack`;
const TestApi = HttpApi.make("patchy").add(
  RuntimeGroup.add(
    HttpApiEndpoint.post("call", "/api/runtime/call", {
      headers: Schema.Record(Schema.String, Schema.String),
      payload: Schema.Unknown,
      success: Schema.Unknown
    })
  )
);
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
        const provider = req.url!.split("/")[1]!;
        const path = req.url!.split("?")[0]!.replace(/^\/(?:github|notion|resend|slack)/, "");
        const fields = Object.fromEntries(new URLSearchParams(bodyText));
        requests.push({ provider, path, token, fields });
        if (provider === "github" || provider === "notion") {
          const customer = (provider === "github" ? githubTokens : notionTokens).indexOf(token);
          res.setHeader("content-type", "application/json");
          if (customer < 0 || rejectProvider)
            res.writeHead(401).end(JSON.stringify({ message: "Mock authentication refused" }));
          else if (provider === "github" && path === "/user")
            res.end(JSON.stringify({ login: `mock-company-${customer}` }));
          else if (provider === "github" && path === `/repos/mock-${customer}/repository`)
            res.end(
              JSON.stringify({ full_name: `mock-${customer}/repository`, description: token })
            );
          else if (provider === "notion" && path === "/v1/users/me")
            res.end(JSON.stringify({ object: "user", type: "bot", id: `mock-${customer}` }));
          else if (provider === "notion" && path === `/v1/pages/mock-page-${customer}`)
            res.end(JSON.stringify({ object: "page", id: `mock-page-${customer}`, title: token }));
          else res.writeHead(404).end("{}");
          return;
        }
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
    const origins = { 'https://slack.com': 'slack', 'https://api.resend.com': 'resend', 'https://api.github.com': 'github', 'https://api.notion.com': 'notion' };
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const provider = origins[url.origin];
      if (!provider) throw new Error('Offline test refused external request');
      return fetch(new URL('/' + provider + url.pathname + url.search, ${JSON.stringify(mockBase)}), init);
    };
    https.request = (options, callback) => {
      const provider = origins['https://' + options.hostname];
      if (!provider) throw new Error('Offline test refused external request');
      return http.request({...options, path: '/' + provider + options.path, protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1', port: ${address.port}, agent: undefined}, callback);
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
    "runs GitHub and Notion read actions with separate encrypted company credentials and rejects cross-company calls before HTTP",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const sql = yield* SqlClient.SqlClient;
        const logs = yield* RuntimeLog.RuntimeLog;
        const hooks = yield* CommunityRuntime.make;
        for (const entry of [
          {
            key: "github",
            field: "secret_text",
            tokens: githubTokens,
            action: "get_repository",
            version: "0.11.0"
          },
          {
            key: "notion",
            field: "accessToken",
            tokens: notionTokens,
            action: "notion_get_page",
            version: "0.8.2"
          }
        ] as const) {
          const target = `${CommunityPages.path}/${entry.key}`;
          const owners = [];
          const ids: string[] = [];
          for (const suffix of ["a", "b"]) {
            const name = `${entry.key}-${suffix}`;
            owners.push(
              yield* companies.create({
                handle: name,
                name,
                clerkUserId: `user_${name}`,
                email: `${name}@test.local`,
                userName: name
              })
            );
          }
          for (const [i, owner] of owners.entries()) {
            const form = yield* send(owner.user, target);
            assert.strictEqual(form.status, 200);
            assert.include(
              yield* Effect.promise(() => form.text()),
              `name="credential.${entry.field}" type="password"`
            );
            assert.strictEqual(
              (yield* send(owner.user, target, {
                handle: "workspace",
                [`credential.${entry.field}`]: entry.tokens[i]!
              })).status,
              303
            );
            const rows = yield* sql<{
              id: string;
              credentials: string;
            }>`SELECT id, credentials FROM connections WHERE company_id = ${owner.company.id} AND integration = ${`activepieces:${entry.key}`}`;
            assert.lengthOf(rows, 1);
            const row = rows[0]!;
            ids.push(row.id);
            assert.notInclude(row.credentials, entry.tokens[i]!);
            const resolved = yield* hooks.resolve(owner.company.id, {
              kind: "community",
              piece: entry.key,
              version: entry.version,
              handle: "workspace",
              actions: [entry.action]
            });
            assert.strictEqual(resolved.id, row.id);
            assert.include(resolved.client, entry.action);
            for (const token of entry.tokens) assert.notInclude(resolved.client, token);
            const inputs: Record<string, string> =
              entry.key === "github"
                ? { "input.owner": `mock-${i}`, "input.repo": "repository" }
                : { "input.page_id": `mock-page-${i}` };
            const start = requests.length;
            const result = yield* send(
              owner.user,
              `${target}/${row.id}/run/${entry.action}`,
              inputs
            );
            assert.strictEqual(result.status, 200);
            const html = yield* Effect.promise(() => result.text());
            assert.include(
              html,
              entry.key === "github" ? `mock-${i}/repository` : `mock-page-${i}`
            );
            for (const token of entry.tokens) assert.notInclude(html, token);
            assert.deepStrictEqual(
              requests.slice(start).map((call) => ({ provider: call.provider, token: call.token })),
              [{ provider: entry.key, token: entry.tokens[i]! }]
            );
            const history = yield* logs.recent({
              companyId: owner.company.id,
              connectionId: row.id
            });
            assert.strictEqual(history[0]!.outcome, "success");
            assert.strictEqual(history[0]!.resource, entry.action);
            for (const token of entry.tokens) assert.notInclude(JSON.stringify(history), token);
          }
          const inputs: Record<string, string> =
            entry.key === "github"
              ? { "input.owner": "mock-0", "input.repo": "repository" }
              : { "input.page_id": "mock-page-0" };
          const before = requests.length;
          assert.strictEqual(
            (yield* send(owners[1]!.user, `${target}/${ids[0]}/run/${entry.action}`, inputs))
              .status,
            404
          );
          assert.strictEqual(
            (yield* send(owners[0]!.user, `${target}/${ids[0]}/run/create_repository`, inputs))
              .status,
            422
          );
          assert.strictEqual(
            (yield* send(owners[0]!.user, `${target}/${ids[0]}/run/${entry.action}`, {
              ...inputs,
              "input.accessToken": "injected"
            })).status,
            422
          );
          assert.strictEqual(requests.length, before);
        }
      })
  );

  it.effect(
    "runs the generated community client through runtime authorization, never trusting ids or credentials from patch code",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const sql = yield* SqlClient.SqlClient;
        const logs = yield* RuntimeLog.RuntimeLog;
        const owners: Array<Effect.Success<ReturnType<Companies.Companies["Service"]["create"]>>> =
          [];
        const ids: string[] = [];
        for (const [i, suffix] of ["runtime-a", "runtime-b"].entries()) {
          const owner = yield* companies.create({
            handle: suffix,
            name: suffix,
            clerkUserId: `user_${suffix}`,
            email: `${suffix}@test.local`,
            userName: suffix
          });
          owners.push(owner);
          assert.strictEqual(
            (yield* send(owner.user, slackPath, {
              handle: "runtime",
              "credential.botToken": tokens[i]!
            })).status,
            303
          );
          const found = yield* sql<{
            id: string;
          }>`SELECT id FROM connections WHERE company_id = ${owner.company.id} AND handle = 'runtime'`;
          ids.push(found[0]!.id);
        }
        const hooks = yield* CommunityRuntime.make;
        const version = `ver_${"a".repeat(24)}`;
        const poisoned = `ver_${"b".repeat(24)}`;
        const patchIds = ["community01a", "community01b"];
        const versions = LoadedVersions.LoadedVersions.of({
          find: (patchId, versionId = version) => {
            const index = patchIds.indexOf(patchId);
            if (index < 0 || ![version, poisoned].includes(versionId))
              return Effect.succeed(Option.none());
            return Effect.succeed(
              Option.some({
                patchId,
                versionId,
                patchTier: 1,
                companyId: owners[index]!.company.id,
                scope: "company" as const,
                wireVersion: WIRE_VERSION,
                manifest: {
                  manifestVersion: 1,
                  release: CURRENT_RELEASE,
                  tier: 1 as const,
                  tables: {},
                  files: {},
                  uses: {
                    external: {
                      kind: "community" as const,
                      piece: "slack",
                      version: "0.23.1",
                      handle: "runtime",
                      revision: 1,
                      id: ids[versionId === poisoned ? 1 - index : index]!,
                      actions: ["slack_get_thread_replies"]
                    }
                  }
                }
              })
            );
          }
        });
        const api = yield* HttpApiTest.groups(TestApi, ["runtime"], { baseUrl: base }).pipe(
          Effect.provide(
            Layer.mergeAll(RuntimeApi.layer, HttpServer.layerServices).pipe(
              Layer.provide(RuntimeProduction.layer(hooks.handlers)),
              Layer.provide(StreamAdmission.layer),
              Layer.provide(Layer.succeed(LoadedVersions.LoadedVersions, versions)),
              Layer.provide([Limits.layer, OperatingLimits.layer])
            )
          )
        );
        const run = yield* FiberSet.makeRuntimePromise();
        const transport =
          (
            viewer: (typeof owners)[number],
            patchId = patchIds[owners.indexOf(viewer)]!,
            versionId = version
          ) =>
          (op: string, args: unknown) =>
            run(
              api
                .call({
                  payload: {
                    wire: WIRE_VERSION,
                    patchId,
                    versionId,
                    principal: { userId: viewer.user.id },
                    op,
                    args
                  },
                  headers: {
                    "x-patchy-wire": String(WIRE_VERSION),
                    "x-patchy-principal": JSON.stringify({ userId: viewer.user.id }),
                    origin: base,
                    cookie: signedInCookies(
                      signSession({
                        sub: viewer.user.clerkUserId,
                        email: viewer.user.email,
                        name: viewer.user.name
                      })
                    )
                  },
                  responseMode: "response-only"
                })
                .pipe(
                  Effect.flatMap((response) => response.json),
                  Effect.map((body) => {
                    const envelope = body as { ok?: boolean; value?: unknown };
                    return envelope.ok === true ? envelope.value : body;
                  })
                )
            );
        const info = (yield* Pieces.Pieces).infos.find((info) => info.key === "slack")!;
        const source = CommunityRuntime.generateClient(info, ["slack_get_thread_replies"]);
        for (const token of tokens) assert.notInclude(source, token);
        const bundle = yield* Effect.promise(() =>
          build({
            stdin: {
              contents: source,
              resolveDir: new URL("../../patchy", import.meta.url).pathname,
              loader: "ts"
            },
            bundle: true,
            write: false,
            platform: "node",
            format: "esm"
          })
        );
        const generated = yield* Effect.promise(
          () =>
            import(
              `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`
            )
        );
        const client = (viewer: (typeof owners)[number], patchId?: string, versionId?: string) =>
          generated.createClient("external", transport(viewer, patchId, versionId)) as {
            slack_get_thread_replies: (input: Record<string, string>) => Promise<unknown>;
          };
        const start = requests.length;
        for (const [i, owner] of owners.entries()) {
          const value = yield* Effect.promise(() =>
            client(owner).slack_get_thread_replies({
              channel: `D${i}`,
              threadTs: "1700000000.000001"
            })
          );
          assert.include(JSON.stringify(value), `mock-thread-company-${i}`);
          const calls = yield* logs.recent({ companyId: owner.company.id, connectionId: ids[i]! });
          assert.strictEqual(calls[0]!.op, "community.call");
          assert.strictEqual(calls[0]!.patchId, patchIds[i]);
          assert.strictEqual(calls[0]!.userId, owner.user.id);
          assert.strictEqual(calls[0]!.outcome, "success");
          assert.notInclude(JSON.stringify(calls), "1700000000.000001");
          for (const token of tokens) assert.notInclude(JSON.stringify(calls), token);
        }
        assert.deepStrictEqual(
          requests.slice(start).map((request) => request.token),
          tokens
        );
        const before = requests.length;
        const inputs = { channel: "D0", threadTs: "1700000000.000001" };
        for (const call of [
          () => client(owners[1]!, patchIds[0]).slack_get_thread_replies(inputs),
          () => client(owners[0]!, patchIds[0], poisoned).slack_get_thread_replies(inputs)
        ])
          yield* Effect.promise(() =>
            expect(call()).rejects.toMatchObject({ code: "access_denied" })
          );
        for (const args of [
          { connection: "missing", action: "slack_get_thread_replies", inputs },
          { connection: "external", action: "slack_list_channels", inputs: {} },
          {
            connection: "external",
            action: "slack_get_thread_replies",
            inputs,
            companyId: owners[1]!.company.id,
            credentials: tokens[1]
          },
          {
            connection: "external",
            action: "slack_get_thread_replies",
            inputs: { ...inputs, botToken: tokens[1]! }
          }
        ]) {
          const reply = yield* Effect.promise(() => transport(owners[0]!)("community.call", args));
          assert.isFalse((reply as { ok: boolean }).ok);
        }
        assert.strictEqual(requests.length, before);
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${slackPath}/${ids[0]}/disconnect`, {})).status,
          303
        );
        yield* Effect.promise(() =>
          expect(client(owners[0]!).slack_get_thread_replies(inputs)).rejects.toMatchObject({
            code: "access_denied"
          })
        );
        assert.strictEqual(requests.length, before);
        assert.strictEqual(
          (yield* send(owners[0]!.user, `${slackPath}/${ids[0]}/connect`, {
            handle: "runtime",
            "credential.botToken": tokens[0]!
          })).status,
          303
        );
        assert.include(
          JSON.stringify(
            yield* Effect.promise(() => client(owners[0]!).slack_get_thread_replies(inputs))
          ),
          "mock-thread-company-0"
        );
      })
  );
  it.effect(
    "selects each company's encrypted token, refuses foreign ids and members, removes tokens on disconnect",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const sql = yield* SqlClient.SqlClient;
        const logs = yield* RuntimeLog.RuntimeLog;
        const owners = [];
        const requestStart = requests.length;
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
            .slice(requestStart)
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
