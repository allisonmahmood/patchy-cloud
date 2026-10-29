// @effect-diagnostics nodeBuiltinImport:off -- raw HTTP over a socket, so a test sends the Host, duplicated headers and chunked bodies fetch never would.
/**
 * Patchy MCP's door in the whole server, booted as a dev instance boots it, spoken to over a
 * raw socket as a client's bytes arrive: the `Host` a client wrote, a real persona sign-in's
 * cookie, Node's handling of duplicated headers and chunked bodies, HEAD through the serving
 * headers, the request event the server writes around each request, and what people find
 * beside what the portal lists them. The door's own rules are packages/mcp's tests.
 */
import { connect } from "node:net";
import { assert, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { build } from "esbuild";
import * as WideEvents from "@patchy/analytics/wide-events";
import { CURRENT_RELEASE, MANIFEST_VERSION } from "@patchy/api";
import { AgentConnections, MachineTokens } from "@patchy/auth";
import * as Inspection from "@patchy/execution/inspection";
import { DEV_SEED, mintDevAgentConnection } from "@patchy/auth/seed";
import { html, publish, publishBody, send, server } from "./test/server.js";
import { NodeCryptography } from "@patchy/core";

const BASE = "http://patchy-door.localhost:29276";
const HOST = "patchy-door.localhost:29276";
const env = { PATCHY_PUBLIC_BASE_URL: BASE, PATCHY_DEV_PERSONAS_SECRET: "door", NODE_ENV: "test" };

class Lines extends Context.Service<Lines, Queue.Queue<string>>()("test/McpDoor/Lines") {}

/** Stdout as the server writes it, where its wide events go. */
const stdout = Layer.effectContext(
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>();
    const console = yield* Console.Console;
    return Context.make(Lines, lines).pipe(
      Context.add(Console.Console, {
        ...console,
        log: (...args: ReadonlyArray<unknown>) => {
          Queue.offerUnsafe(lines, String(args[0]));
        }
      })
    );
  })
);

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(WideEvents.WideEvent));

interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** How the connection ended: the server closed it after answering, or reset it. */
  readonly ended: "closed" | "reset";
}

/** Sends `head` (and `body`) on a fresh connection and reads until the server closes it. */
const raw = (head: string, body: string | Uint8Array = "") =>
  Effect.gen(function* () {
    const address = (yield* HttpServer.HttpServer).address;
    if (!("port" in address)) return yield* Effect.die("A TCP server is expected.");
    return yield* Effect.callback<Answer>((resume) => {
      const chunks: Buffer[] = [];
      const socket = connect(address.port, "127.0.0.1");
      let reset = false;
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("error", () => {
        reset = true;
      });
      socket.on("close", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const [top = "", ...rest] = text.split("\r\n\r\n");
        const [statusLine = "", ...headerLines] = top.split("\r\n");
        const headers: Record<string, string> = {};
        for (const line of headerLines) {
          const at = line.indexOf(":");
          const name = line.slice(0, at).toLowerCase();
          const value = line.slice(at + 1).trim();
          headers[name] = headers[name] === undefined ? value : `${headers[name]}\n${value}`;
        }
        resume(
          Effect.succeed({
            status: Number(statusLine.split(" ")[1] ?? 0),
            headers,
            body: rest.join("\r\n\r\n"),
            ended: reset ? "reset" : "closed"
          })
        );
      });
      // Never half-closed: the server would end the connection before an answer that waits.
      socket.write(`${head.trim().replaceAll("\n", "\r\n")}\r\nconnection: close\r\n\r\n`);
      socket.write(body);
      return Effect.sync(() => socket.destroy());
    });
  });

const post = (headers: string, json: unknown) => {
  const body = JSON.stringify(json);
  return raw(
    `POST /mcp HTTP/1.1\n${headers}\ncontent-type: application/json\ncontent-length: ${Buffer.byteLength(body)}`,
    body
  );
};

/** The request events one exchange wrote: everything up to the fence request's event. */
const eventsOf = <A>(exchange: Effect.Effect<A, never, HttpServer.HttpServer>) =>
  Effect.gen(function* () {
    const lines = yield* Lines;
    const fence = Effect.gen(function* () {
      yield* raw(`PATCH /events-fence HTTP/1.1\nhost: ${HOST}`);
      const events: WideEvents.RequestEvent[] = [];
      while (true) {
        const event = decodeEvent(yield* Queue.take(lines));
        if (Option.isNone(event) || event.value.type !== "request") continue;
        if (event.value.method === "PATCH") return events;
        events.push(event.value);
      }
    });
    // Whatever earlier requests wrote is behind the first fence.
    yield* fence;
    const answer = yield* exchange;
    return { answer, events: yield* fence };
  });

/** An agent connection for the dev seed's person, as `pnpm dev mcp-token` mints one. */
const mint = mintDevAgentConnection({
  email: DEV_SEED.email,
  clientName: "Codex",
  clientId: "http://127.0.0.1:4100/dev/mcp-token"
}).pipe(Effect.provide(AgentConnections.layer.pipe(Layer.provideMerge(NodeCryptography.layer))));

const initialize = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-mcp-client", version: "0.163.0" }
  }
};

it.layer(server(env).pipe(Layer.provideMerge(stdout)))("the door in the server", (it) => {
  it.effect("opens for a minted work token and writes one request event under /mcp", () =>
    Effect.gen(function* () {
      const minted = yield* mint;
      const { answer, events } = yield* eventsOf(
        post(`host: ${HOST}\nauthorization: Bearer ${minted.token}`, initialize)
      );
      assert.strictEqual(answer.status, 200);
      assert.strictEqual(JSON.parse(answer.body).result.protocolVersion, "2025-06-18");
      assert.strictEqual(events.length, 1);
      assert.include(events[0], {
        route: "/mcp",
        method: "POST",
        status: 200,
        outcome: "success",
        viewerId: DEV_SEED.userId,
        companyId: DEV_SEED.companyId,
        agentConnectionId: minted.connection.id,
        clientName: "Codex",
        clientSite: "127.0.0.1:4100",
        protocolEra: "legacy",
        protocolVersion: "2025-06-18",
        clientInfoName: "codex-mcp-client"
      });
      assert.notInclude(JSON.stringify(events[0]), minted.token);
    })
  );

  it.effect("refuses the address a rebinding page reaches it at, before any challenge", () =>
    Effect.gen(function* () {
      const minted = yield* mint;
      for (const host of ["evil.example:29276", "127.0.0.1:29276"]) {
        const { answer, events } = yield* eventsOf(
          post(`host: ${host}\nauthorization: Bearer ${minted.token}`, initialize)
        );
        assert.strictEqual(answer.status, 421, host);
        assert.isUndefined(answer.headers["www-authenticate"]);
        assert.include(events[0], { route: "/mcp", code: "invalid_host", outcome: "refused" });
      }
      // An absolute-form target names the host it was sent to, whatever Host says.
      const absolute = yield* raw(
        `POST http://evil.example/mcp HTTP/1.1\nhost: ${HOST}\nauthorization: Bearer ${minted.token}\ncontent-length: 0`
      );
      assert.strictEqual(absolute.status, 421);
      // Node keeps the first of two Host fields; the door refuses both.
      const twoHosts = yield* raw(
        `POST /mcp HTTP/1.1\nhost: ${HOST}\nhost: evil.example:29276\nauthorization: Bearer ${minted.token}\ncontent-length: 0`
      );
      assert.strictEqual(twoHosts.status, 421);
      // Two Origin headers arrive joined, which no single origin is.
      const twice = yield* post(
        `host: ${HOST}\norigin: ${BASE}\norigin: ${BASE}\nauthorization: Bearer ${minted.token}`,
        initialize
      );
      assert.strictEqual(twice.status, 403);
    })
  );

  it.effect("takes no authority from a signed-in person's cookie", () =>
    Effect.gen(function* () {
      const signIn = yield* raw(
        `GET /dev/sign-in?as=${encodeURIComponent(DEV_SEED.email)}&return=%2Fmachines HTTP/1.1\nhost: ${HOST}`
      );
      const cookie = (signIn.headers["set-cookie"] ?? "")
        .split("\n")
        .map((line) => line.split(";")[0])
        .join("; ");
      assert.include(cookie, "=");
      // The cookie signs the person in everywhere a browser session counts.
      const machines = yield* raw(`GET /machines HTTP/1.1\nhost: ${HOST}\ncookie: ${cookie}`);
      assert.strictEqual(machines.status, 200);
      const door = yield* post(`host: ${HOST}\norigin: ${BASE}\ncookie: ${cookie}`, initialize);
      assert.strictEqual(door.status, 401);
      assert.include(door.headers["www-authenticate"] ?? "", 'scope="patches"');
    })
  );

  it.effect("answers HEAD like GET, and 413 to a body over the cap however it is sent", () =>
    Effect.gen(function* () {
      const head = yield* raw(`HEAD /mcp HTTP/1.1\nhost: ${HOST}`);
      assert.strictEqual(head.status, 405);
      assert.strictEqual(head.body, "");

      const minted = yield* mint;
      const chunk = Buffer.alloc(256 * 1024, "x");
      const chunked = Buffer.concat([
        ...Array.from({ length: 5 }, () =>
          Buffer.concat([
            Buffer.from(`${chunk.length.toString(16)}\r\n`),
            chunk,
            Buffer.from("\r\n")
          ])
        ),
        Buffer.from("0\r\n\r\n")
      ]);
      const { answer, events } = yield* eventsOf(
        raw(
          `POST /mcp HTTP/1.1\nhost: ${HOST}\nauthorization: Bearer ${minted.token}\ncontent-type: application/json\ntransfer-encoding: chunked`,
          chunked
        )
      );
      // Read on past the cap and dropped, so the refusal still reaches the client.
      assert.strictEqual(answer.status, 413);
      assert.strictEqual(answer.headers["connection"], "close");
      assert.strictEqual(events.length, 1);
      assert.include(events[0], { status: 413, code: "too_large" });
      assert.isUndefined(events[0]!.mcpMethod);

      // A declared length over the cap is answered before a byte of the body is read.
      const declared = yield* raw(
        `POST /mcp HTTP/1.1\nhost: ${HOST}\nauthorization: Bearer ${minted.token}\ncontent-type: application/json\ncontent-length: 2000000`
      );
      assert.strictEqual(declared.status, 413);
      assert.strictEqual(JSON.parse(declared.body).error, "too_large");
      // Sent in full, the 413 still arrives before the connection closes.
      const sentWhole = yield* raw(
        `POST /mcp HTTP/1.1\nhost: ${HOST}\nauthorization: Bearer ${minted.token}\ncontent-type: application/json\ncontent-length: 2000000`,
        Buffer.alloc(2_000_000, "x")
      );
      assert.strictEqual(sentWhole.status, 413);
      // Far past the cap, a chunked body is still read to its end so its 413 arrives.
      const huge = Buffer.concat([
        ...Array.from({ length: 24 }, () =>
          Buffer.concat([
            Buffer.from(`${chunk.length.toString(16)}\r\n`),
            chunk,
            Buffer.from("\r\n")
          ])
        ),
        Buffer.from("0\r\n\r\n")
      ]);
      const far = yield* raw(
        `POST /mcp HTTP/1.1\nhost: ${HOST}\nauthorization: Bearer ${minted.token}\ncontent-type: application/json\ntransfer-encoding: chunked`,
        huge
      );
      assert.strictEqual(far.status, 413);
    })
  );
});

/** One `tools/call` of the door, as a modern client sends it. */
const toolCall = (token: string, name: string, args: Record<string, unknown>) =>
  post(
    `host: ${HOST}\nauthorization: Bearer ${token}\nmcp-protocol-version: 2026-07-28\nmcp-method: tools/call\nmcp-name: ${name}`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.308" },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    }
  ).pipe(
    Effect.map(
      (answer) =>
        JSON.parse(answer.body).result as {
          readonly isError?: true;
          readonly structuredContent: Record<string, unknown>;
        }
    )
  );

/** The patch names on a portal page's list. */
const listed = (html: string) =>
  [
    ...(/<tbody>([\s\S]*)<\/tbody>/.exec(html)?.[1] ?? "").matchAll(
      /<strong>([a-z0-9-]+)<\/strong><\/a>/g
    )
  ].map((match) => match[1]!);

it.layer(
  server(env).pipe(
    Layer.provideMerge(stdout),
    Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })),
    Layer.provideMerge(NodeCryptography.layer)
  )
)("finding patches against the portal", (it) => {
  it.effect("finds exactly what the portal lists for each person, and opens nothing else", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rival = { id: "cmp_rival", handle: "rival", name: "Rival" };
      yield* sql`INSERT INTO companies (id, handle, name) VALUES (${rival.id}, ${rival.handle}, ${rival.name})`;
      yield* sql`UPDATE companies SET agent_access_on = true WHERE id IN (${DEV_SEED.companyId}, ${rival.id})`;
      const people = {
        dev: {
          email: DEV_SEED.email,
          id: DEV_SEED.userId,
          company: DEV_SEED.companyId,
          role: "admin"
        },
        priya: {
          email: "priya@door.test",
          id: "usr_find_priya",
          company: DEV_SEED.companyId,
          role: "admin"
        },
        ben: {
          email: "ben@door.test",
          id: "usr_find_ben",
          company: DEV_SEED.companyId,
          role: "member"
        },
        cleo: {
          email: "cleo@door.test",
          id: "usr_find_cleo",
          company: DEV_SEED.companyId,
          role: "member"
        },
        dot: {
          email: "dot@door.test",
          id: "usr_find_dot",
          company: DEV_SEED.companyId,
          role: "member"
        },
        rachel: {
          email: "rachel@door.test",
          id: "usr_find_rachel",
          company: rival.id,
          role: "admin"
        }
      } as const;
      type Key = keyof typeof people;
      const tokens = new Map<Key, string>([["dev", DEV_SEED.token]]);
      for (const [key, person] of Object.entries(people) as Array<[Key, (typeof people)[Key]]>) {
        if (key === "dev") continue;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
          VALUES (${person.id}, ${`clerk_${person.id}`}, ${person.company}, ${person.email}, ${key}, ${person.role})`;
        const minted = yield* MachineTokens.MachineTokens.use((machines) =>
          machines.mint({ userId: person.id, name: "Finding test" })
        ).pipe(Effect.provide(MachineTokens.layer));
        tokens.set(key, minted.token);
      }

      // Every sharing scope and lifecycle state a patch can be in, owned by every kind of person.
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly owner: Key;
        readonly scope?: "public";
        readonly state?: "retired" | "deleted" | "disabled";
      }> = [
        { name: "shared-board", owner: "dev" },
        { name: "public-page", owner: "ben", scope: "public" },
        { name: "bens-notes", owner: "ben" },
        { name: "cleos-retired", owner: "cleo", state: "retired" },
        { name: "cleos-deleted", owner: "cleo", state: "deleted" },
        { name: "taken-down", owner: "ben", state: "disabled" },
        { name: "dots-tracker", owner: "dot" },
        { name: "rival-board", owner: "rachel" },
        { name: "rival-public", owner: "rachel", scope: "public" }
      ];
      const published = new Map<string, { readonly patchId: string; readonly address: string }>();
      for (const patch of cases) {
        const token = tokens.get(patch.owner)!;
        const created = yield* send(
          HttpClientRequest.post("/api/publish").pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.bodyJsonUnsafe(
              publishBody({
                html: html(patch.name),
                metadata: { filename: `${patch.name}.html` },
                ...(patch.scope === undefined ? {} : { scope: patch.scope })
              })
            )
          )
        );
        assert.strictEqual(created.status, 201, patch.name);
        const { patchId, address } = (yield* created.json) as { patchId: string; address: string };
        published.set(patch.name, { patchId, address });
        const off =
          patch.state === "retired"
            ? HttpClientRequest.post(`/api/patches/${patchId}/retire`).pipe(
                HttpClientRequest.bodyJsonUnsafe({})
              )
            : patch.state === "deleted"
              ? HttpClientRequest.delete(`/api/patches/${patchId}`)
              : undefined;
        if (off !== undefined)
          assert.strictEqual(
            (yield* send(off.pipe(HttpClientRequest.bearerToken(token)))).status,
            200
          );
        if (patch.state === "disabled")
          yield* sql`UPDATE patches SET disabled_at = now(), disabled_reason = 'test' WHERE id = ${patchId}`;
      }
      // An owner who has left keeps their patches listed.
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${people.dot.id}`;

      const expected: Record<string, ReadonlyArray<string>> = {
        [DEV_SEED.companyId]: ["bens-notes", "dots-tracker", "public-page", "shared-board"],
        [rival.id]: ["rival-board", "rival-public"]
      };
      for (const key of ["dev", "priya", "ben", "cleo", "rachel"] as const) {
        const person = people[key];
        // The portal's own list, as the person sees it at All patches.
        const signedIn = yield* send(
          HttpClientRequest.get(
            `/dev/sign-in?as=${encodeURIComponent(person.email)}&return=%2Fpatches`
          )
        );
        const page = yield* send(
          HttpClientRequest.get("/patches").pipe(
            HttpClientRequest.setHeader("cookie", Cookies.toCookieHeader(signedIn.cookies))
          )
        );
        assert.strictEqual(page.status, 200, key);
        const portal = listed(yield* page.text).sort();
        assert.deepStrictEqual(portal, expected[person.company], key);

        const { token } = yield* mintDevAgentConnection({
          email: person.email,
          clientName: "Claude Code",
          clientId: "http://127.0.0.1:4100/dev/mcp-token"
        }).pipe(
          Effect.provide(AgentConnections.layer.pipe(Layer.provideMerge(NodeCryptography.layer)))
        );
        const found = (yield* toolCall(token, "find_patches", {})).structuredContent as {
          total: number;
          patches: ReadonlyArray<{ name: string; address: string }>;
        };
        assert.deepStrictEqual(found.patches.map((entry) => entry.name).sort(), portal, key);
        assert.strictEqual(found.total, portal.length, key);

        // Every patch it lists opens; every other one, however it's named, is the same refusal.
        const refusals = new Set<string>();
        for (const [name, { patchId, address }] of published) {
          for (const patch of [name, patchId, address]) {
            const opened = yield* toolCall(token, "open_patch", { patch });
            if (portal.includes(name)) {
              assert.isUndefined(opened.isError, `${key} ${patch}`);
              assert.strictEqual(opened.structuredContent["name"], name);
            } else {
              assert.isTrue(opened.isError, `${key} ${patch}`);
              refusals.add(JSON.stringify(opened));
            }
          }
          if (!portal.includes(name)) {
            const searched = (yield* toolCall(token, "find_patches", { search: name }))
              .structuredContent;
            assert.deepStrictEqual(
              [searched["total"], searched["patches"]],
              [0, []],
              `${key} ${name}`
            );
          }
        }
        assert.strictEqual(refusals.size, 1, key);
      }
    })
  );
});

it.layer(server({ ...env, NODE_ENV: "development" }), { excludeTestServices: true })(
  "the door's calls on a server that runs patch code",
  (it) => {
    it.effect(
      "read_patch runs a published agent tool as the person, through the server's own invocation",
      () =>
        Effect.gen(function* () {
          const source = (yield* Effect.promise(() =>
            build({
              stdin: {
                contents: `import { query, createGuest, t } from "patchy/server";
const whoami = query({description:"Who is asking, and through which agent.",args:{},result:t.json(),handler:async ctx => ({viewer:ctx.viewer.user.id, agent:ctx.agent})});
export default createGuest({}, [], { tools: { whoami } });`,
                resolveDir: new URL("../../../packages/patchy", import.meta.url).pathname,
                sourcefile: "door-read-fixture.ts"
              },
              bundle: true,
              write: false,
              platform: "browser",
              format: "esm",
              target: "es2022",
              conditions: ["development"]
            })
          )).outputFiles[0]!.text;
          const handlers = yield* Inspection.inspect(source).pipe(
            Effect.provide(NodeServices.layer)
          );
          const created = yield* publish(DEV_SEED.token, {
            html: html("Who asks"),
            server: source,
            manifest: {
              manifestVersion: MANIFEST_VERSION,
              release: CURRENT_RELEASE,
              tier: 2,
              tables: {},
              files: {},
              uses: {},
              handlers
            }
          });
          assert.strictEqual(created.status, 201);
          const { patchId } = (yield* created.json) as { patchId: string };
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE companies SET agent_access_on = true WHERE id = ${DEV_SEED.companyId}`;
          const minted = yield* mint;
          const answered = yield* toolCall(minted.token, "read_patch", {
            patch: patchId,
            tool: "whoami",
            args: {}
          });
          assert.isUndefined(answered.isError, JSON.stringify(answered));
          assert.deepStrictEqual(answered.structuredContent, {
            result: { viewer: DEV_SEED.userId, agent: { name: "Codex" } },
            version: 1
          });
        }),
      60_000
    );
  }
);
