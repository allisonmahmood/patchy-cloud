import type { IncomingMessage, ServerResponse } from "node:http";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { Limits } from "@patchy/limits";
import * as ClientDocumentNetwork from "./ClientDocumentNetwork.js";
import * as ClientDocuments from "./ClientDocuments.js";
import {
  clientDocumentFixtures,
  clientDocumentHost,
  serveDocuments,
  type ServedDocument
} from "./testing.js";

const AGENT = "https://agent.example/client.json";

/** A ClientDocuments over `network`, with its own limiter and these operating limits. */
const loader = (
  network: ClientDocumentNetwork.ClientDocumentNetwork["Service"],
  limits: Readonly<Record<string, number>> = {}
) =>
  ClientDocuments.make.pipe(
    Effect.provideService(ClientDocumentNetwork.ClientDocumentNetwork, network),
    Effect.provide(Limits.layer),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ PATCHY_LIMITS_JSON: JSON.stringify(limits) })
      )
    )
  );

/** A document for AGENT with `fields` over a valid public client's. */
const agentDocument = (fields: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  ({
    url: AGENT,
    body: JSON.stringify({
      client_id: AGENT,
      client_name: "Agent",
      redirect_uris: ["https://agent.example/callback"],
      token_endpoint_auth_method: "none",
      ...fields
    }),
    ...(headers === undefined ? {} : { headers })
  }) satisfies ServedDocument;

/** Answers each request with the next of `answers`, repeating the last. */
const inTurn = (
  ...answers: Array<(request: IncomingMessage, response: ServerResponse) => void>
) => {
  let next = 0;
  return (request: IncomingMessage, response: ServerResponse) =>
    answers[Math.min(next++, answers.length - 1)]!(request, response);
};

/** A promise and the function that settles it. */
const signal = () => {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  return { settled, settle };
};

describe("accepting a document", () => {
  it.effect("accepts Claude's, Claude Code's, ChatGPT's and Codex's recorded documents", () =>
    Effect.gen(function* () {
      const fixtures = Object.values(clientDocumentFixtures);
      const host = yield* clientDocumentHost(serveDocuments(fixtures));
      const documents = yield* loader(host.network);
      const loaded = yield* Effect.forEach(fixtures, ({ url }) => documents.load(url));
      assert.deepStrictEqual(loaded, [
        {
          clientId: clientDocumentFixtures.claude.url,
          name: "Claude",
          site: "claude.ai",
          redirectUris: ["https://claude.ai/api/mcp/auth_callback"]
        },
        {
          clientId: clientDocumentFixtures.claudeCode.url,
          name: "Claude Code",
          site: "claude.ai",
          redirectUris: ["http://localhost/callback", "http://127.0.0.1/callback"]
        },
        // Its single field says private_key_jwt; its list offers none, and the list is read first.
        {
          clientId: clientDocumentFixtures.chatgpt.url,
          name: "ChatGPT",
          site: "chatgpt.com",
          redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"]
        },
        {
          clientId: clientDocumentFixtures.codex.url,
          name: "Codex",
          site: "chatgpt.com",
          redirectUris: ["http://127.0.0.1/callback", "http://localhost/callback"]
        }
      ]);
    })
  );

  it.effect("reads the list of auth methods when there is one, the single field otherwise", () =>
    Effect.gen(function* () {
      for (const [fields, accepted] of [
        [{ token_endpoint_auth_method: "none" }, true],
        [
          {
            token_endpoint_auth_method: "private_key_jwt",
            token_endpoint_auth_methods_supported: ["private_key_jwt", "none"]
          },
          true
        ],
        [
          {
            token_endpoint_auth_method: "none",
            token_endpoint_auth_methods_supported: ["private_key_jwt"]
          },
          false
        ],
        [{ token_endpoint_auth_method: "client_secret_basic" }, false],
        [{ token_endpoint_auth_method: undefined }, false]
      ] as const) {
        const host = yield* clientDocumentHost(serveDocuments([agentDocument(fields)]));
        const result = yield* Effect.result((yield* loader(host.network)).load(AGENT));
        if (accepted) assert.isTrue(Result.isSuccess(result), JSON.stringify(fields));
        else
          assert.deepStrictEqual(
            result,
            Result.fail(
              new ClientDocuments.ClientDocumentRefused({
                reason: "auth_method",
                site: "agent.example"
              })
            ),
            JSON.stringify(fields)
          );
      }
    })
  );

  it.effect("accepts only a client_id that is exactly the URL fetched", () =>
    Effect.gen(function* () {
      for (const clientId of [
        "https://agent.example/other.json",
        `${AGENT}/`,
        "https://AGENT.example/client.json",
        "https://agent.example:443/client.json",
        "http://agent.example/client.json"
      ]) {
        const host = yield* clientDocumentHost(
          serveDocuments([agentDocument({ client_id: clientId })])
        );
        const refused = yield* Effect.flip((yield* loader(host.network)).load(AGENT));
        assert.deepStrictEqual(
          refused,
          new ClientDocuments.ClientDocumentRefused({ reason: "client_id", site: "agent.example" }),
          clientId
        );
      }
    })
  );

  it.effect("refuses a document whose required fields aren't valid", () =>
    Effect.gen(function* () {
      for (const body of [
        "not json",
        "[]",
        JSON.stringify({ client_id: AGENT, token_endpoint_auth_method: "none" }),
        agentDocument({ client_id: undefined }).body,
        agentDocument({ redirect_uris: [] }).body,
        agentDocument({ redirect_uris: "https://agent.example/callback" }).body,
        agentDocument({ redirect_uris: ["https://agent.example/callback", 7] }).body,
        agentDocument({ client_name: 7 }).body,
        agentDocument({ client_name: undefined }).body,
        agentDocument({ redirect_uris: ["https://agent.example/callback", "not a uri"] }).body,
        agentDocument({ redirect_uris: ["https://agent.example/callback#x"] }).body,
        agentDocument({ token_endpoint_auth_methods_supported: "none" }).body,
        // Invalid UTF-8 is refused, not replaced.
        Buffer.concat([
          Buffer.from(agentDocument().body.slice(0, -1)),
          Buffer.from(',"x":"\xff"}', "latin1")
        ])
      ]) {
        const host = yield* clientDocumentHost((_, response) => response.end(body));
        const refused = yield* Effect.flip((yield* loader(host.network)).load(AGENT));
        assert.deepStrictEqual(
          refused,
          new ClientDocuments.ClientDocumentRefused({ reason: "document", site: "agent.example" }),
          String(body)
        );
      }
    })
  );

  it.effect(
    "ignores grant types and fields Patchy doesn't use, and trusts no list of clients",
    () =>
      Effect.gen(function* () {
        const host = yield* clientDocumentHost(
          serveDocuments([
            agentDocument({
              grant_types: ["urn:ietf:params:oauth:grant-type:jwt-bearer", "client_credentials"],
              response_types: ["token"],
              jwks_uri: "https://agent.example/jwks.json"
            })
          ])
        );
        const loaded = yield* (yield* loader(host.network)).load(AGENT);
        assert.deepStrictEqual(loaded, {
          clientId: AGENT,
          name: "Agent",
          site: "agent.example",
          redirectUris: ["https://agent.example/callback"]
        });
      })
  );

  it.effect("shows the name cleaned, or the site when nothing is left of it", () =>
    Effect.gen(function* () {
      for (const [name, shown] of [
        ["  Agent\u202e\u0007 Pro ", "Agent Pro"],
        ["x".repeat(80), "x".repeat(64)],
        ["\u0007", "agent.example"],
        ["  ", "agent.example"]
      ] as const) {
        const host = yield* clientDocumentHost(
          serveDocuments([agentDocument({ client_name: name })])
        );
        const loaded = yield* (yield* loader(host.network)).load(AGENT);
        assert.strictEqual(loaded.name, shown);
      }
    })
  );
});

describe("the client id", () => {
  it.effect(
    "must be a canonical https URL with a path, on a host name, before anything is fetched",
    () =>
      Effect.gen(function* () {
        const host = yield* clientDocumentHost(serveDocuments([agentDocument()]));
        const documents = yield* loader(host.network);
        for (const clientId of [
          "http://agent.example/client.json",
          "https://agent.example",
          "https://agent.example/",
          "https://agent.example/client.json#x",
          "https://agent.example/client.json#",
          "https://user@agent.example/client.json",
          "https://user:pass@agent.example/client.json",
          "https://Agent.example/client.json",
          "https://agent.example:443/client.json",
          "https://agent.example/a/../client.json",
          "https://agent.example/./client.json",
          "https://agent.example/%2e%2e/client.json",
          " https://agent.example/client.json",
          // Decimal, octal, hex and short-form IPv4 all parse to an address, and a literal is refused.
          "https://2130706433/client.json",
          "https://0177.0.0.1/client.json",
          "https://0x7f.0.0.1/client.json",
          "https://127.1/client.json",
          "https://127.0.0.1/client.json",
          "https://8.8.8.8/client.json",
          "https://[::1]/client.json",
          "https://[2606:4700:4700::1111]/client.json",
          `https://agent.example/${"x".repeat(2_048)}`,
          "agent.example/client.json",
          ""
        ]) {
          const refused = yield* Effect.flip(documents.load(clientId));
          assert.deepStrictEqual(
            refused,
            new ClientDocuments.ClientDocumentRefused({ reason: "client_id_url" }),
            clientId
          );
        }
        assert.deepStrictEqual(host.seen.lookups, []);
      })
  );
});

describe("fetching a document", () => {
  it.effect("never reaches special-use, private, link-local or cloud metadata addresses", () =>
    Effect.gen(function* () {
      for (const answer of [
        ["127.0.0.1"],
        ["10.0.0.1"],
        ["192.168.1.1"],
        ["100.100.100.200"],
        ["169.254.169.254"],
        ["169.254.170.2"],
        ["fd00:ec2::254"],
        ["fe80::1"],
        ["0.0.0.0"],
        ["::"],
        ["::1"],
        ["::ffff:127.0.0.1"],
        ["::ffff:169.254.169.254"],
        ["64:ff9b::a9fe:a9fe"],
        ["2002:a9fe:a9fe::1"],
        // One bad answer among good ones refuses them all.
        ["8.8.8.8", "10.0.0.1"],
        ["2606:4700:4700::1111", "::ffff:10.0.0.1"]
      ]) {
        const host = yield* clientDocumentHost(serveDocuments([agentDocument()]), {
          resolve: () =>
            answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
        });
        const refused = yield* Effect.flip((yield* loader(host.network)).load(AGENT));
        assert.deepStrictEqual(
          refused,
          new ClientDocuments.ClientDocumentUnavailable({
            site: "agent.example",
            stage: "address"
          }),
          answer.join()
        );
        assert.deepStrictEqual(host.seen.connections, [], answer.join());
      }
    })
  );

  it.effect("resolves once and connects only to the addresses it checked", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const host = yield* clientDocumentHost(
        serveDocuments([agentDocument({}, { "cache-control": "max-age=60" })]),
        {
          // A rebinding answer: public when checked, private on any later lookup.
          resolve: () =>
            ++lookups === 1
              ? [
                  { address: "8.8.8.8", family: 4 },
                  { address: "2606:4700:4700::1111", family: 6 }
                ]
              : [{ address: "127.0.0.1", family: 4 }]
        }
      );
      const documents = yield* loader(host.network);
      yield* documents.load(AGENT);
      assert.deepStrictEqual(host.seen.lookups, ["agent.example"]);
      assert.deepStrictEqual(host.seen.connections, [["8.8.8.8", "2606:4700:4700::1111"]]);
      // The next fetch checks again, and refuses the new answer without connecting.
      yield* TestClock.adjust("61 seconds");
      const refused = yield* Effect.flip(documents.load(AGENT));
      assert.deepStrictEqual(
        refused,
        new ClientDocuments.ClientDocumentUnavailable({ site: "agent.example", stage: "address" })
      );
      assert.deepStrictEqual(host.seen.connections, [["8.8.8.8", "2606:4700:4700::1111"]]);
    })
  );

  it.effect("names the host and port it was given, and asks nothing the stranger chose", () =>
    Effect.gen(function* () {
      const headers: Array<IncomingMessage["headers"]> = [];
      const url = "https://agent.example:8443/c?v=1";
      const host = yield* clientDocumentHost((request, response) => {
        headers.push(request.headers);
        serveDocuments([{ ...agentDocument({ client_id: url }), url }])(request, response);
      });
      const documents = yield* loader(host.network);
      assert.strictEqual((yield* documents.load(url)).site, "agent.example:8443");
      assert.deepStrictEqual(host.seen.requests, ["GET https://agent.example:8443/c?v=1"]);
      assert.strictEqual(headers[0]!["accept-encoding"], "identity");
      assert.isUndefined(headers[0]!.cookie);
      assert.isUndefined(headers[0]!.authorization);
    })
  );

  it.effect("refuses a host that doesn't resolve", () =>
    Effect.gen(function* () {
      const host = yield* clientDocumentHost(serveDocuments([agentDocument()]), {
        resolve: () => []
      });
      for (const network of [
        host.network,
        {
          ...host.network,
          resolve: (name: string) =>
            Effect.fail(
              new ClientDocumentNetwork.LookupFailed({ host: name, cause: new Error("ENOTFOUND") })
            )
        }
      ]) {
        const refused = yield* Effect.flip((yield* loader(network)).load(AGENT));
        assert.strictEqual(refused._tag, "ClientDocumentUnavailable");
        assert.strictEqual(refused._tag === "ClientDocumentUnavailable" && refused.stage, "dns");
      }
    })
  );

  it.effect("follows no redirect and accepts only a 200", () =>
    Effect.gen(function* () {
      for (const status of [301, 302, 303, 307, 308, 201, 203, 204, 304, 404, 500]) {
        const host = yield* clientDocumentHost((_, response) => {
          response.writeHead(status, { location: "https://agent.example/next.json" });
          response.end(status === 204 || status === 304 ? undefined : agentDocument().body);
        });
        const refused = yield* Effect.flip((yield* loader(host.network)).load(AGENT));
        assert.deepStrictEqual(
          refused,
          new ClientDocuments.ClientDocumentUnavailable({
            site: "agent.example",
            stage: "status",
            status
          }),
          String(status)
        );
        assert.deepStrictEqual(host.seen.requests, [`GET ${AGENT}`], String(status));
      }
    })
  );

  it.effect("reads at most 5,000 bytes, whether declared or chunked", () =>
    Effect.gen(function* () {
      const exact = agentDocument();
      const padded = `${exact.body.slice(0, -1)}${" ".repeat(5_000 - exact.body.length)}}`;
      assert.strictEqual(Buffer.byteLength(padded), 5_000);
      const accepted = yield* clientDocumentHost((_, response) => response.end(padded));
      assert.strictEqual((yield* (yield* loader(accepted.network)).load(AGENT)).clientId, AGENT);

      const tooLarge = new ClientDocuments.ClientDocumentUnavailable({
        site: "agent.example",
        stage: "size"
      });
      // Declared too large: refused from the header, before any body is sent.
      const declared = yield* clientDocumentHost((_, response) => {
        response.writeHead(200, { "content-length": "5001" });
        response.flushHeaders();
      });
      assert.deepStrictEqual(
        yield* Effect.flip((yield* loader(declared.network)).load(AGENT)),
        tooLarge
      );
      // Chunked past the bound, with more promised: refused once the bound is crossed.
      const crossed = signal();
      const chunked = yield* clientDocumentHost((request, response) => {
        response.writeHead(200);
        response.write(" ".repeat(4_000));
        response.write(" ".repeat(1_001));
        request.socket.once("close", crossed.settle);
      });
      assert.deepStrictEqual(
        yield* Effect.flip((yield* loader(chunked.network)).load(AGENT)),
        tooLarge
      );
      yield* Effect.promise(() => crossed.settled);
    })
  );

  it.effect("gives up after 5 seconds, including on a body that trickles", () =>
    Effect.gen(function* () {
      for (const answer of [
        () => {},
        (response: ServerResponse) => {
          response.writeHead(200);
          response.write("{");
        }
      ]) {
        const arrived = signal();
        const host = yield* clientDocumentHost((_, response) => {
          answer(response);
          arrived.settle();
        });
        const documents = yield* loader(host.network);
        const fiber = yield* Effect.forkChild(Effect.flip(documents.load(AGENT)));
        yield* Effect.promise(() => arrived.settled);
        yield* TestClock.adjust("4999 millis");
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust("1 millis");
        assert.deepStrictEqual(
          yield* Fiber.join(fiber),
          new ClientDocuments.ClientDocumentUnavailable({ site: "agent.example", stage: "timeout" })
        );
      }
    })
  );
});

describe("caching", () => {
  it.effect("keeps a document as its headers say, within an hour", () =>
    Effect.gen(function* () {
      const date = "Thu, 22 Oct 2026 12:00:00 GMT";
      for (const [headers, keptSeconds] of [
        [{ "cache-control": "public, max-age=300" }, 300],
        [{ "cache-control": "PUBLIC, MAX-AGE=30" }, 30],
        [{ "cache-control": "max-age=300", age: "290" }, 10],
        [{ "cache-control": "max-age=300", age: "301" }, 0],
        [{ "cache-control": "max-age=7200" }, 3_600],
        [{}, 3_600],
        [{ age: "600" }, 3_000],
        [{ age: "999999" }, 0],
        [{ "cache-control": "no-store" }, 0],
        [{ "cache-control": "max-age=300, no-store" }, 0],
        [{ "cache-control": "no-cache" }, 0],
        [{ "cache-control": "max-age=0" }, 0],
        [{ "cache-control": "max-age=-1" }, 0],
        [{ "cache-control": "max-age=abc" }, 0],
        [{ "cache-control": "max-age=60, max-age=300" }, 0],
        [{ date, expires: "Thu, 22 Oct 2026 12:02:00 GMT" }, 120],
        [{ date, expires: "Thu, 22 Oct 2026 11:59:00 GMT" }, 0],
        [{ date, expires: "0" }, 0],
        [{ date, expires: "Thu, 22 Oct 2026 12:02:00 GMT", "cache-control": "max-age=60" }, 60]
      ] as const) {
        const host = yield* clientDocumentHost(serveDocuments([agentDocument({}, headers)]));
        const documents = yield* loader(host.network);
        const label = JSON.stringify(headers);
        yield* documents.load(AGENT);
        if (keptSeconds > 0) {
          yield* TestClock.adjust(`${keptSeconds * 1_000 - 1} millis`);
          yield* documents.load(AGENT);
          assert.strictEqual(host.seen.requests.length, 1, label);
          yield* TestClock.adjust("1 millis");
        }
        yield* documents.load(AGENT);
        assert.strictEqual(host.seen.requests.length, 2, label);
      }
    })
  );

  it.effect("never keeps a failure or a refused document", () =>
    Effect.gen(function* () {
      const host = yield* clientDocumentHost(
        inTurn(
          (_, response) => response.writeHead(500, { "cache-control": "max-age=300" }).end(),
          (_, response) =>
            response
              .writeHead(200, { "cache-control": "max-age=300" })
              .end(agentDocument({ token_endpoint_auth_method: "private_key_jwt" }).body),
          serveDocuments([agentDocument({}, { "cache-control": "max-age=300" })])
        )
      );
      const documents = yield* loader(host.network);
      assert.strictEqual(
        (yield* Effect.flip(documents.load(AGENT)))._tag,
        "ClientDocumentUnavailable"
      );
      assert.strictEqual((yield* Effect.flip(documents.load(AGENT)))._tag, "ClientDocumentRefused");
      yield* documents.load(AGENT);
      yield* documents.load(AGENT);
      assert.strictEqual(host.seen.requests.length, 3);
    })
  );

  it.effect("keeps one fetch per URL in flight even when the kept documents are full", () =>
    Effect.gen(function* () {
      const slow = "https://slow.example/client.json";
      const quick = "https://quick.example/client.json";
      const arrived = signal();
      const release = signal();
      const documents = [slow, quick].map((url) => ({ ...agentDocument({ client_id: url }), url }));
      const host = yield* clientDocumentHost((request, response) => {
        if (request.headers.host !== "slow.example")
          return serveDocuments(documents)(request, response);
        arrived.settle();
        void release.settled.then(() => serveDocuments(documents)(request, response));
      });
      const loader1 = yield* loader(host.network, { "oauth.clientDocuments.entries": 1 });
      const first = yield* Effect.forkChild(loader1.load(slow));
      yield* Effect.promise(() => arrived.settled);
      // A kept document fills the cache while the slow fetch runs; the fetch isn't forgotten.
      yield* loader1.load(quick);
      const second = yield* Effect.forkChild(loader1.load(slow));
      yield* Effect.yieldNow;
      release.settle();
      assert.strictEqual((yield* Fiber.join(first)).clientId, slow);
      assert.strictEqual((yield* Fiber.join(second)).clientId, slow);
      assert.deepStrictEqual(host.seen.requests, [`GET ${slow}`, `GET ${quick}`]);
    })
  );

  it.effect("keeps at most its entries, dropping the least recently used", () =>
    Effect.gen(function* () {
      const urls = ["a", "b", "c"].map((name) => `https://${name}.example/client.json`);
      const host = yield* clientDocumentHost(
        serveDocuments(urls.map((url) => ({ ...agentDocument({ client_id: url }), url })))
      );
      const documents = yield* loader(host.network, { "oauth.clientDocuments.entries": 2 });
      yield* documents.load(urls[0]!);
      yield* documents.load(urls[1]!);
      yield* documents.load(urls[0]!);
      yield* documents.load(urls[2]!);
      yield* documents.load(urls[0]!);
      assert.strictEqual(host.seen.requests.length, 3);
      yield* documents.load(urls[1]!);
      assert.strictEqual(host.seen.requests.length, 4);
    })
  );
});

describe("limits", () => {
  it.effect("starts at most the minute's fetches host-wide, and a kept document spends none", () =>
    Effect.gen(function* () {
      const urls = ["a", "b", "c"].map((name) => `https://${name}.example/client.json`);
      const host = yield* clientDocumentHost(
        serveDocuments(urls.map((url) => ({ ...agentDocument({ client_id: url }), url })))
      );
      const documents = yield* loader(host.network, { "oauth.clientDocuments.perMinute": 2 });
      yield* documents.load(urls[0]!);
      yield* documents.load(urls[1]!);
      yield* documents.load(urls[0]!);
      assert.deepStrictEqual(
        yield* Effect.flip(documents.load(urls[2]!)),
        new ClientDocuments.ClientDocumentsBusy({ retryAfterSeconds: 60 })
      );
      assert.strictEqual(host.seen.requests.length, 2);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual((yield* documents.load(urls[2]!)).clientId, urls[2]);
    })
  );

  it.effect("runs one fetch per URL, which every load during it shares, failures included", () =>
    Effect.gen(function* () {
      for (const status of [200, 500]) {
        const arrived = signal();
        const release = signal();
        const host = yield* clientDocumentHost((request, response) => {
          arrived.settle();
          void release.settled.then(() =>
            status === 200
              ? serveDocuments([agentDocument()])(request, response)
              : response.writeHead(status).end()
          );
        });
        // One start a minute: a second fetch would be refused as busy.
        const documents = yield* loader(host.network, { "oauth.clientDocuments.perMinute": 1 });
        const loads = yield* Effect.forkChild(
          Effect.forEach(Array.from({ length: 20 }), () => Effect.result(documents.load(AGENT)), {
            concurrency: "unbounded"
          })
        );
        yield* Effect.promise(() => arrived.settled);
        yield* Effect.yieldNow;
        release.settle();
        const results = yield* Fiber.join(loads);
        assert.strictEqual(host.seen.requests.length, 1);
        if (status === 200) assert.isTrue(results.every(Result.isSuccess));
        else
          for (const result of results)
            assert.deepStrictEqual(
              result,
              Result.fail(
                new ClientDocuments.ClientDocumentUnavailable({
                  site: "agent.example",
                  stage: "status",
                  status
                })
              )
            );
      }
    })
  );

  it.effect("ends every waiting load when the service closes before its fetch starts", () =>
    Effect.gen(function* () {
      const host = yield* clientDocumentHost(serveDocuments([agentDocument()]));
      const scope = yield* Scope.make();
      const documents = yield* loader(host.network).pipe(Scope.provide(scope));
      // The load claims the URL and forks its fetch, which hasn't run when the service closes.
      const waiting = yield* Effect.forkChild(documents.load(AGENT), { startImmediately: true });
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(waiting)));
      assert.deepStrictEqual(host.seen.lookups, []);
    })
  );

  it.effect("holds to the minute's starts when many URLs load at once", () =>
    Effect.gen(function* () {
      const urls = Array.from({ length: 40 }, (_, i) => `https://agent${i}.example/client.json`);
      const host = yield* clientDocumentHost(
        serveDocuments(urls.map((url) => ({ ...agentDocument({ client_id: url }), url })))
      );
      const documents = yield* loader(host.network);
      const exits = yield* Effect.forEach(urls, (url) => Effect.exit(documents.load(url)), {
        concurrency: "unbounded"
      });
      assert.strictEqual(exits.filter(Exit.isSuccess).length, 30);
      assert.strictEqual(host.seen.requests.length, 30);
    })
  );
});

describe("redirects", () => {
  const document = (redirectUris: ReadonlyArray<string>): ClientDocuments.ClientDocument => ({
    clientId: AGENT,
    name: "Agent",
    site: "agent.example",
    redirectUris
  });

  it("accepts only a redirect the document lists, exactly", () => {
    const listed = document(["https://claude.ai/api/mcp/auth_callback"]);
    assert.isTrue(
      ClientDocuments.redirectAllowed(listed, "https://claude.ai/api/mcp/auth_callback")
    );
    for (const redirect of [
      "https://claude.ai/api/mcp/auth_callback/",
      "https://claude.ai/api/mcp/auth_callback?x=1",
      "https://claude.ai/api/mcp/auth_callback#x",
      "https://claude.ai:8443/api/mcp/auth_callback",
      "https://CLAUDE.ai/api/mcp/auth_callback",
      "http://claude.ai/api/mcp/auth_callback",
      "https://claude.ai.evil.example/api/mcp/auth_callback",
      "not a url"
    ])
      assert.isFalse(ClientDocuments.redirectAllowed(listed, redirect), redirect);
  });

  it("matches a loopback redirect on any port, with host and path exact, localhost included", () => {
    const listed = document([
      "http://localhost/callback",
      "http://127.0.0.1/callback",
      "http://[::1]:33418/"
    ]);
    for (const redirect of [
      "http://localhost/callback",
      "http://localhost:53682/callback",
      "http://127.0.0.1:1/callback",
      "http://127.0.0.1:65535/callback",
      "http://[::1]/",
      "http://[::1]:5000/"
    ])
      assert.isTrue(ClientDocuments.redirectAllowed(listed, redirect), redirect);
    for (const redirect of [
      "http://localhost:53682/callback/",
      "http://localhost:53682/other",
      "http://localhost:53682/callback?x=1",
      "http://localhost:53682/callback#x",
      "http://user@localhost:53682/callback",
      "https://localhost:53682/callback",
      "http://127.0.0.2:53682/callback",
      "http://[::1]:5000/callback",
      "http://localhost.evil.example:53682/callback",
      "http://LOCALHOST:53682/callback"
    ])
      assert.isFalse(ClientDocuments.redirectAllowed(listed, redirect), redirect);
    // Only the port varies: a listed loopback that isn't written canonically matches nothing.
    for (const written of ["http://localhost/a/../callback", "http://LOCALHOST/callback"])
      assert.isFalse(
        ClientDocuments.redirectAllowed(document([written]), "http://localhost:49152/callback"),
        written
      );
    // A loopback name only matches itself.
    assert.isFalse(
      ClientDocuments.redirectAllowed(
        document(["http://127.0.0.1/callback"]),
        "http://localhost:53682/callback"
      )
    );
  });

  it("never sends an answer over plain http to another computer, even when listed", () => {
    assert.isFalse(
      ClientDocuments.redirectAllowed(
        document(["http://agent.example/callback"]),
        "http://agent.example/callback"
      )
    );
    assert.isFalse(
      ClientDocuments.redirectAllowed(document(["cursor://anysphere/cb"]), "cursor://anysphere/cb")
    );
  });
});
