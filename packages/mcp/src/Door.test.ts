/**
 * The door over a migrated database, a request at a time as the router hands it over. Each test
 * builds its own door, so its in-memory buckets start full, and sends from its own address.
 * The socket's view, cookies from a real sign-in and the server's own request events are
 * apps/server's tests.
 */
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as WideEvents from "@patchy/analytics/wide-events";
import { AgentConnections, MachineTokens } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { Limits, OperatingLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Door from "./Door.js";
import * as Tools from "./Tools.js";

const PRODUCTION = "https://cloud.example";
const DEV = "http://patchy-door.localhost:29276";
const CLAUDE = "https://claude.ai/oauth/claude-code-client-metadata";

/** Every event the door's requests closed, in order. */
const recorded: WideEvents.WideEvent[] = [];
const sink = Layer.succeed(WideEvents.Sink)(
  WideEvents.Sink.of({ write: (event) => Effect.sync(() => void recorded.push(event)) })
);

const layer = Layer.mergeAll(
  AgentConnections.layer,
  MachineTokens.layer,
  Limits.layer,
  OperatingLimits.layer,
  WideEvents.layerWithSink.pipe(Layer.provide(sink))
).pipe(Layer.provideMerge(Testing.layer()));

/** The field at a dotted path of a decoded answer, or `undefined`. */
const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (current, key) => (Predicate.hasProperty(current, key) ? current[key] : undefined),
      value
    );

/** The object at a dotted path of a decoded answer, failing the test when there is none. */
const objectAt = (value: unknown, path: string): Readonly<Record<string, unknown>> => {
  const found = at(value, path);
  if (!Predicate.isObject(found)) return assert.fail(`No object at ${path}`);
  return { ...found };
};

interface Sent {
  readonly method?: string;
  readonly path?: string;
  readonly token?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly raw?: string;
  /** Sends the body as a stream with no declared length. */
  readonly chunked?: boolean;
}

/**
 * A door for an instance at `base`, and a way to send it requests from `address`. Requests
 * carry the instance's own `Host` unless a test says otherwise.
 */
const door = (base: string, address: string) =>
  Effect.gen(function* () {
    const app = yield* HttpRouter.toHttpEffect(
      Layer.mergeAll(
        Door.layer,
        HttpRouter.use((router) =>
          router.add("*", "/*", Effect.succeed(HttpServerResponse.empty({ status: 404 })))
        )
      )
    ).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_PUBLIC_BASE_URL: base }))
      )
    );
    const wide = yield* WideEvents.WideEvents;
    return Effect.fn("send")(function* (sent: Sent) {
      const body = sent.raw ?? (sent.body === undefined ? undefined : JSON.stringify(sent.body));
      const headers: Record<string, string> = {
        host: new URL(base).host,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(body === undefined || sent.chunked === true
          ? {}
          : { "content-length": String(Buffer.byteLength(body)) }),
        ...(sent.token === undefined ? {} : { authorization: `Bearer ${sent.token}` }),
        ...sent.headers
      };
      const init: RequestInit & { duplex?: "half" } = {
        method: sent.method ?? "POST",
        headers,
        ...(body === undefined
          ? {}
          : sent.chunked === true
            ? { body: new Blob([body]).stream(), duplex: "half" }
            : { body })
      };
      const request = HttpServerRequest.fromWeb(
        new Request(new URL(sent.path ?? "/mcp", base), init)
      ).modify({ remoteAddress: Option.some(address) });
      const before = recorded.length;
      const response = yield* wide
        .withEvent({ type: "request", route: "/mcp" }, app)
        .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));
      const web = HttpServerResponse.toWeb(response);
      const text = yield* Effect.promise(() => web.text());
      // Delivery is detached; let it land before reading the event.
      while (recorded.length === before) yield* Effect.yieldNow;
      return {
        status: web.status,
        headers: web.headers,
        text,
        json: text === "" ? undefined : (JSON.parse(text) as unknown),
        event: recorded[before]!
      };
    });
  });

const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.308" },
  "io.modelcontextprotocol/clientCapabilities": {}
};

/** A modern request, with the headers a conforming client mirrors from it. */
const modern = (token: string, method: string, params: Record<string, unknown> = {}): Sent => ({
  token,
  headers: {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(typeof params["name"] === "string" ? { "mcp-name": params["name"] } : {})
  },
  body: { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }
});

const legacy = (token: string, method: string, params: Record<string, unknown> = {}): Sent => ({
  token,
  headers: { "mcp-protocol-version": "2025-06-18" },
  body: { jsonrpc: "2.0", id: 1, method, params }
});

/** A fresh person in a company of their own, connected through an agent. */
const connected = (key: string, clientName = "Claude Code") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const company = `cmp_door_${key}`;
    yield* sql`
      INSERT INTO companies (id, handle, name, created_at)
      VALUES (${company}, ${`door-${key}`}, ${`Door ${key}`}, now())`;
    const userId = `usr_door_${key}`;
    yield* sql`
      INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES (${userId}, ${`clerk_door_${key}`}, ${company}, ${`${key}@door.test`},
        ${`Person ${key}`}, 'member')`;
    const { connection, tokens } = yield* AgentConnections.AgentConnections.use((connections) =>
      connections.create({ userId, clientId: CLAUDE, clientName })
    );
    return { company, userId, connection, token: tokens.accessToken };
  });

it.layer(layer)("the door", (it) => {
  it.effect("refuses a host that isn't the instance's with 421 and no challenge", () =>
    Effect.gen(function* () {
      const { token } = yield* connected("host");
      for (const [base, host] of [
        [PRODUCTION, "evil.example"],
        [PRODUCTION, "cloud.example:8443"],
        // DNS rebinding: a stranger's name resolving to a dev instance's address.
        [DEV, "evil.example:29276"],
        [DEV, "127.0.0.1:29276"]
      ] as const) {
        const send = yield* door(base, "203.0.113.1");
        const response = yield* send({ ...legacy(token, "tools/list"), headers: { host } });
        assert.strictEqual(response.status, 421, host);
        assert.strictEqual(at(response.json, "error"), "invalid_host");
        assert.isNull(response.headers.get("www-authenticate"));
        assert.strictEqual(response.event.code, "invalid_host");
      }
      const send = yield* door(PRODUCTION, "203.0.113.1");
      for (const host of ["Cloud.Example", "cloud.example.", "cloud.example:443"])
        assert.strictEqual(
          (yield* send({ ...legacy(token, "ping"), headers: { host } })).status,
          200
        );
    })
  );

  it.effect("refuses a malformed or duplicated Origin, and on a dev instance anyone else's", () =>
    Effect.gen(function* () {
      const { token } = yield* connected("origin");
      const production = yield* door(PRODUCTION, "203.0.113.2");
      for (const origin of ["null", "https://claude.ai", "vscode-webview://abc"])
        assert.strictEqual(
          (yield* production({ ...legacy(token, "ping"), headers: { origin } })).status,
          200,
          origin
        );
      for (const origin of [
        "claude.ai",
        "https://claude.ai/",
        "https://claude.ai, https://a.example"
      ]) {
        const response = yield* production({ ...legacy(token, "ping"), headers: { origin } });
        assert.strictEqual(response.status, 403, origin);
        assert.strictEqual(response.event.code, "invalid_origin");
      }
      const dev = yield* door(DEV, "203.0.113.2");
      assert.strictEqual(
        (yield* dev({ ...legacy(token, "ping"), headers: { origin: DEV } })).status,
        200
      );
      assert.strictEqual((yield* dev(legacy(token, "ping"))).status, 200);
      for (const origin of ["https://evil.example", "null", "http://127.0.0.1:29276"])
        assert.strictEqual(
          (yield* dev({ ...legacy(token, "ping"), headers: { origin } })).status,
          403,
          origin
        );
    })
  );

  it.effect(
    "answers CORS for any origin in production, preflights without auth, and none on dev",
    () =>
      Effect.gen(function* () {
        const production = yield* door(PRODUCTION, "203.0.113.3");
        const preflight = yield* production({
          method: "OPTIONS",
          headers: { origin: "https://claude.ai", "access-control-request-method": "POST" }
        });
        assert.strictEqual(preflight.status, 204);
        assert.strictEqual(preflight.headers.get("access-control-allow-origin"), "*");
        assert.strictEqual(
          preflight.headers.get("access-control-allow-headers"),
          "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name"
        );
        assert.isNull(preflight.headers.get("access-control-allow-credentials"));
        const unauthorized = yield* production({ body: { jsonrpc: "2.0", id: 1, method: "ping" } });
        assert.strictEqual(unauthorized.headers.get("access-control-allow-origin"), "*");
        assert.strictEqual(
          unauthorized.headers.get("access-control-expose-headers"),
          "WWW-Authenticate, Retry-After"
        );

        const dev = yield* door(DEV, "203.0.113.3");
        const devPreflight = yield* dev({ method: "OPTIONS", headers: { origin: DEV } });
        assert.strictEqual(devPreflight.status, 405);
        assert.isNull(devPreflight.headers.get("access-control-allow-origin"));
        const devUnauthorized = yield* dev({ body: { jsonrpc: "2.0", id: 1, method: "ping" } });
        assert.isNull(devUnauthorized.headers.get("access-control-allow-origin"));
      })
  );

  it.effect("answers GET, HEAD and DELETE 405 before any token is read", () =>
    Effect.gen(function* () {
      const send = yield* door(PRODUCTION, "203.0.113.4");
      for (const method of ["GET", "HEAD", "DELETE", "PUT"]) {
        const response = yield* send({ method, headers: { "mcp-session-id": "abc" } });
        assert.strictEqual(response.status, 405, method);
        assert.strictEqual(response.headers.get("allow"), "POST, OPTIONS");
        assert.isNull(response.headers.get("www-authenticate"));
      }
    })
  );

  it.effect("opens only for a live agent connection's work token", () =>
    Effect.gen(function* () {
      const send = yield* door(PRODUCTION, "203.0.113.5");
      const metadata = `${PRODUCTION}/.well-known/oauth-protected-resource/mcp`;
      const missing = yield* send({ body: { jsonrpc: "2.0", id: 1, method: "ping" } });
      assert.strictEqual(missing.status, 401);
      assert.strictEqual(
        missing.headers.get("www-authenticate"),
        `Bearer resource_metadata="${metadata}", scope="patches"`
      );
      assert.strictEqual(missing.event.code, "missing_token");

      const { connection, token } = yield* connected("bearer");
      // The dev seed's machine token is a `build` credential: unknown here, on any release.
      for (const bad of [DEV_SEED.token, "pwa_unknown", `${token}x`]) {
        const response = yield* send(legacy(bad, "ping"));
        assert.strictEqual(response.status, 401, bad);
        assert.strictEqual(
          response.headers.get("www-authenticate"),
          `Bearer resource_metadata="${metadata}", scope="patches", error="invalid_token"`
        );
        assert.strictEqual(at(response.json, "error"), "invalid_token");
        assert.strictEqual(response.event.code, "invalid_token");
      }

      const open = yield* send(legacy(token, "ping"));
      assert.strictEqual(open.status, 200);
      assert.deepStrictEqual(open.json, { jsonrpc: "2.0", id: 1, result: {} });

      // Ended connections answer 401 so the client runs its own reconnect.
      yield* AgentConnections.AgentConnections.use((connections) =>
        connections.disconnect({ userId: `usr_door_bearer`, id: connection.id })
      );
      const ended = yield* send(legacy(token, "ping"));
      assert.strictEqual(ended.status, 401);
      assert.include(ended.headers.get("www-authenticate") ?? "", 'error="invalid_token"');
    })
  );

  it.effect("never takes authority from a cookie", () =>
    Effect.gen(function* () {
      const send = yield* door(PRODUCTION, "203.0.113.6");
      const response = yield* send({
        headers: { cookie: "__session=anything; __client_uat=1" },
        body: { jsonrpc: "2.0", id: 1, method: "ping" }
      });
      assert.strictEqual(response.status, 401);
    })
  );

  it.effect(
    "counts 60 failed checks a minute an address after each fails, and never a good one",
    () =>
      Effect.gen(function* () {
        const { token } = yield* connected("failures");
        const send = yield* door(PRODUCTION, "203.0.113.7");
        for (let attempt = 0; attempt < 60; attempt++) {
          assert.strictEqual((yield* send(legacy("pwa_unknown", "ping"))).status, 401);
          // Every working token passes between the failures and spends none of them.
          assert.strictEqual((yield* send(legacy(token, "ping"))).status, 200);
        }
        const limited = yield* send({ body: { jsonrpc: "2.0", id: 1, method: "ping" } });
        assert.strictEqual(limited.status, 429);
        assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
        assert.strictEqual(limited.event.limitId, "mcp.bearer.failures.perMinute");
        assert.strictEqual((yield* send(legacy(token, "ping"))).status, 200);
        // Another address has its own minute.
        const elsewhere = yield* door(PRODUCTION, "203.0.113.8");
        assert.strictEqual((yield* elsewhere(legacy("pwa_unknown", "ping"))).status, 401);
      })
  );

  it.effect("answers a body over 1 MiB and 64 KiB 413 before parsing it", () =>
    Effect.gen(function* () {
      const { token } = yield* connected("body");
      const send = yield* door(PRODUCTION, "203.0.113.9");
      const cap = 1024 * 1024 + 64 * 1024;
      // At the cap the body is read; it isn't JSON, which only parsing can tell.
      const atCap = yield* send({ token, raw: "x".repeat(cap) });
      assert.strictEqual(atCap.status, 400);
      assert.strictEqual(at(atCap.json, "error.code"), -32700);
      const over = yield* send({ token, raw: "x".repeat(cap + 1) });
      assert.strictEqual(over.status, 413);
      assert.strictEqual(over.event.code, "too_large");
      assert.strictEqual(over.headers.get("connection"), "close");
      // With no declared length the body is read to the cap, never parsed past it.
      const streamed = yield* send({ token, raw: "x".repeat(cap + 1), chunked: true });
      assert.strictEqual(streamed.status, 413);
      const fits = yield* send({ ...legacy(token, "ping"), chunked: true });
      assert.strictEqual(fits.status, 200);
    })
  );

  it.effect("spends the person's minute on a request too large to read", () =>
    Effect.gen(function* () {
      const person = yield* connected("oversized");
      yield* OperatingLimits.OperatingLimits.use((limits) =>
        limits.setOverride({
          companyId: person.company,
          limitId: "mcp.requests.perMinute",
          value: 2,
          actor: "test"
        })
      );
      const send = yield* door(PRODUCTION, "203.0.113.17");
      const cap = 1024 * 1024 + 64 * 1024;
      assert.strictEqual(
        (yield* send({ token: person.token, raw: "x".repeat(cap + 1) })).status,
        413
      );
      assert.strictEqual((yield* send(legacy(person.token, "ping"))).status, 200);
      assert.strictEqual((yield* send(legacy(person.token, "ping"))).status, 429);
    })
  );

  it.effect("answers a legacy initialize with its version, or the newest legacy one", () =>
    Effect.gen(function* () {
      const { token } = yield* connected("initialize");
      const send = yield* door(PRODUCTION, "203.0.113.10");
      for (const [offered, answered] of [
        ["2025-06-18", "2025-06-18"],
        ["2025-11-25", "2025-11-25"],
        ["2025-03-26", "2025-11-25"],
        ["2026-07-28", "2025-11-25"]
      ] as const) {
        const response = yield* send({
          token,
          body: {
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
              protocolVersion: offered,
              capabilities: { elicitation: {}, sampling: {} },
              clientInfo: { name: "codex-mcp-client", version: "0.163.0" }
            }
          }
        });
        assert.strictEqual(response.status, 200);
        const result = objectAt(response.json, "result");
        assert.strictEqual(result["protocolVersion"], answered);
        assert.deepStrictEqual(result["capabilities"], { tools: { listChanged: false } });
        assert.strictEqual(at(result, "serverInfo.name"), "patchy");
        assert.isUndefined(result["resultType"]);
        const instructions = String(result["instructions"]);
        assert.include(instructions, "Person initialize at Door initialize");
        assert.isBelow([...instructions].length, 512);
        assert.isNull(response.headers.get("mcp-session-id"));
        assert.include(response.event, {
          protocolEra: "legacy",
          protocolVersion: offered,
          mcpMethod: "initialize",
          clientInfoName: "codex-mcp-client",
          clientInfoVersion: "0.163.0"
        });
      }
      const initialized = yield* send({
        token,
        body: { jsonrpc: "2.0", method: "notifications/initialized" }
      });
      assert.strictEqual(initialized.status, 202);
      assert.strictEqual(initialized.text, "");
      assert.include(initialized.event, {
        protocolEra: "legacy",
        mcpMethod: "notifications/initialized"
      });
    })
  );

  it.effect("serves 2026-07-28 statelessly: discovery cached privately, the tools publicly", () =>
    Effect.gen(function* () {
      const { token } = yield* connected("modern");
      const send = yield* door(PRODUCTION, "203.0.113.11");
      const discover = yield* send(modern(token, "server/discover"));
      assert.strictEqual(discover.status, 200);
      const found = objectAt(discover.json, "result");
      assert.deepStrictEqual(found["supportedVersions"], [
        "2026-07-28",
        "2025-11-25",
        "2025-06-18"
      ]);
      assert.deepStrictEqual(found["capabilities"], { tools: { listChanged: false } });
      assert.include(found, { resultType: "complete", cacheScope: "private" });
      assert.isAbove(Number(found["ttlMs"]), 0);
      assert.strictEqual(
        at(objectAt(found, "_meta")["io.modelcontextprotocol/serverInfo"], "name"),
        "patchy"
      );
      assert.include(String(found["instructions"]), "Person modern at Door modern");
      assert.include(discover.event, {
        protocolEra: "modern",
        protocolVersion: "2026-07-28",
        mcpMethod: "server/discover",
        clientInfoName: "claude-code"
      });

      const list = objectAt((yield* send(modern(token, "tools/list"))).json, "result");
      assert.include(list, { resultType: "complete", cacheScope: "public" });
      assert.isAtLeast(Number(list["ttlMs"]), 60 * 60 * 1000);

      // Neither ping nor initialize exists in this revision.
      for (const method of ["ping", "initialize", "resources/list", "prompts/list"]) {
        const response = yield* send(modern(token, method));
        assert.strictEqual(response.status, 404, method);
        assert.strictEqual(at(response.json, "error.code"), -32601, method);
      }
    })
  );

  it.effect(
    "lists the same four tools for everyone, read_patch read-only and change_patch destructive",
    () =>
      Effect.gen(function* () {
        const first = yield* connected("list-a");
        const second = yield* connected("list-b", "Codex");
        const send = yield* door(PRODUCTION, "203.0.113.12");
        const lists = [
          at((yield* send(legacy(first.token, "tools/list"))).json, "result"),
          at((yield* send(legacy(second.token, "tools/list"))).json, "result"),
          at((yield* send(modern(second.token, "tools/list"))).json, "result.tools")
        ];
        assert.deepStrictEqual(lists[0], lists[1]);
        assert.deepStrictEqual(at(lists[0], "tools"), lists[2]);
        const tools = Tools.tools;
        assert.deepStrictEqual(lists[2], JSON.parse(JSON.stringify(tools)));
        assert.deepStrictEqual(
          tools.map((tool) => tool.name),
          ["find_patches", "open_patch", "read_patch", "change_patch"]
        );
        for (const tool of tools) assert.isAbove(tool.description.length, 50, tool.name);
        assert.deepStrictEqual(tools[2]!.annotations, { readOnlyHint: true });
        assert.deepStrictEqual(tools[3]!.annotations, {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false
        });
      })
  );

  it.effect("answers each tool as not built yet, and an unknown tool name -32602", () =>
    Effect.gen(function* () {
      const { token } = yield* connected("call");
      const send = yield* door(PRODUCTION, "203.0.113.13");
      for (const name of Tools.NAMES) {
        const response = yield* send(
          modern(token, "tools/call", { name, arguments: { patch: "new-business" } })
        );
        assert.strictEqual(response.status, 200, name);
        const result = objectAt(response.json, "result");
        assert.include(result, { resultType: "complete", isError: true });
        assert.include(objectAt(result, "structuredContent.error"), {
          code: "not_built",
          from: "patchy"
        });
        assert.include(response.event, { mcpTool: name, code: "not_built", outcome: "refused" });
      }
      const unknown = yield* send(legacy(token, "tools/call", { name: "delete_everything" }));
      assert.strictEqual(unknown.status, 200);
      assert.strictEqual(at(unknown.json, "error.code"), -32602);
      assert.include(unknown.event, { code: "unknown_tool", outcome: "refused" });
      assert.isUndefined(unknown.event.type === "request" ? unknown.event.mcpTool : undefined);
    })
  );

  it.effect("answers the modern status table with real statuses", () =>
    Effect.gen(function* () {
      const { token } = yield* connected("statuses");
      const send = yield* door(PRODUCTION, "203.0.113.14");
      const call = modern(token, "tools/call", { name: "find_patches", arguments: {} });
      const cases: ReadonlyArray<readonly [Sent, number, number]> = [
        [
          {
            token,
            headers: { "mcp-protocol-version": "2027-01-01", "mcp-method": "tools/list" },
            body: {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
              params: {
                _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2027-01-01" }
              }
            }
          },
          400,
          -32022
        ],
        [
          {
            ...call,
            headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call" }
          },
          400,
          -32020
        ],
        [{ ...call, headers: { ...call.headers, "mcp-method": "tools/list" } }, 400, -32020],
        [
          {
            token,
            headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
            body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
          },
          400,
          -32602
        ],
        [modern(token, "completion/complete"), 404, -32601],
        [{ token, body: [{ jsonrpc: "2.0", id: 1, method: "ping" }] }, 400, -32600],
        [{ token, raw: "{" }, 400, -32700]
      ];
      for (const [sent, status, code] of cases) {
        const response = yield* send(sent);
        assert.strictEqual(response.status, status, JSON.stringify(sent.body));
        assert.strictEqual(at(response.json, "error.code"), code, JSON.stringify(sent.body));
      }
      const unsupported = yield* send(cases[0]![0]);
      assert.deepStrictEqual(at(unsupported.json, "error.data"), {
        supported: ["2026-07-28", "2025-11-25", "2025-06-18"],
        requested: "2027-01-01"
      });
      // A legacy client hears an unknown method over 200: its 404 means the session ended.
      const legacyUnknown = yield* send(legacy(token, "resources/list"));
      assert.strictEqual(legacyUnknown.status, 200);
      assert.strictEqual(at(legacyUnknown.json, "error.code"), -32601);
    })
  );

  it.effect(
    "holds a person to their requests a minute: a tool call refuses, anything else is 429",
    () =>
      Effect.gen(function* () {
        const person = yield* connected("rate");
        // A second client of the same person shares the bucket; the person is the key.
        const other = yield* AgentConnections.AgentConnections.use((connections) =>
          connections.create({ userId: person.userId, clientId: CLAUDE, clientName: "Codex" })
        );
        yield* OperatingLimits.OperatingLimits.use((limits) =>
          limits.setOverride({
            companyId: person.company,
            limitId: "mcp.requests.perMinute",
            value: 3,
            actor: "test"
          })
        );
        const send = yield* door(PRODUCTION, "203.0.113.15");
        assert.strictEqual((yield* send(legacy(person.token, "ping"))).status, 200);
        assert.strictEqual((yield* send(legacy(other.tokens.accessToken, "ping"))).status, 200);
        const third = yield* send(legacy(person.token, "ping"));
        assert.strictEqual(third.status, 200);
        assert.deepStrictEqual(
          third.event.limits?.map(({ limitId, value, peak }) => ({ limitId, value, peak })),
          [{ limitId: "mcp.requests.perMinute", value: 3, peak: 3 }]
        );

        const listed = yield* send(legacy(other.tokens.accessToken, "tools/list"));
        assert.strictEqual(listed.status, 429);
        assert.match(listed.headers.get("retry-after") ?? "", /^\d+$/);
        assert.strictEqual(at(listed.json, "id"), 1);
        assert.include(listed.event, { code: "rate_limited", limitId: "mcp.requests.perMinute" });

        const called = yield* send(modern(person.token, "tools/call", { name: "open_patch" }));
        assert.strictEqual(called.status, 200);
        const refusal = objectAt(called.json, "result.structuredContent.error");
        assert.include(refusal, { code: "rate_limited", from: "patchy" });
        assert.isAtLeast(Number(refusal["retryAfterSeconds"]), 1);

        // Someone else in the company has their own minute.
        const colleague = yield* connected("rate-colleague");
        assert.strictEqual((yield* send(legacy(colleague.token, "ping"))).status, 200);
      })
  );

  it.effect("writes one event per request with the connection, never what the agent sent", () =>
    Effect.gen(function* () {
      const { connection, token, userId, company } = yield* connected("event", "Claude Code");
      const send = yield* door(PRODUCTION, "203.0.113.16");
      const secret = "row-9f2c-secret-argument";
      const response = yield* send({
        ...modern(token, "tools/call", {
          name: "change_patch",
          arguments: { patch: "deals", tool: "addDeal", args: { note: secret }, key: "key-77a1" }
        }),
        headers: {
          ...modern(token, "tools/call", { name: "change_patch" }).headers,
          origin: `https://claude.ai/${"x".repeat(300)}`
        }
      });
      // The malformed origin is refused, and still recorded, cut short.
      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.event.type === "request" && response.event.origin?.length, 256);

      const answered = yield* send(
        modern(token, "tools/call", {
          name: "change_patch",
          arguments: { patch: "deals", tool: "addDeal", args: { note: secret }, key: "key-77a1" }
        })
      );
      const event = answered.event;
      assert.strictEqual(event.type, "request");
      if (event.type !== "request") return;
      assert.include(event, {
        viewerId: userId,
        companyId: company,
        agentConnectionId: connection.id,
        clientName: "Claude Code",
        clientSite: "claude.ai",
        protocolEra: "modern",
        mcpMethod: "tools/call",
        mcpTool: "change_patch",
        sampleProbability: 1
      });
      const written = JSON.stringify(event);
      for (const never of [token, secret, "key-77a1", "addDeal", "You act for"])
        assert.notInclude(written, never);
    })
  );
});
