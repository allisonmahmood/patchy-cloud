// @effect-diagnostics nodeBuiltinImport:off -- raw HTTP over a socket, so a test sends the Host, duplicated headers and chunked bodies fetch never would.
/**
 * Patchy MCP's door in the whole server, booted as a dev instance boots it, spoken to over a
 * raw socket as a client's bytes arrive: the `Host` a client wrote, a real persona sign-in's
 * cookie, Node's handling of duplicated headers and chunked bodies, HEAD through the serving
 * headers, and the request event the server writes around each request. The door's own rules
 * are packages/mcp's tests.
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
import * as HttpServer from "effect/http/HttpServer";
import * as WideEvents from "@patchy/analytics/wide-events";
import { AgentConnections } from "@patchy/auth";
import { DEV_SEED, mintDevAgentConnection } from "@patchy/auth/seed";
import { server } from "./test/server.js";

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
}).pipe(Effect.provide(AgentConnections.layer));

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
