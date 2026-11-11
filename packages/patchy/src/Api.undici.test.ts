// Why the instance gave no usable answer, as `Api.classify` records it: through the generated
// client over the undici dispatcher the CLI runs on, so Node only (see vitest.bun.config.ts).
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Api from "./Api.js";
import { UnreachableError } from "./CliError.js";
import * as Instance from "./Instance.js";

describe("classify", () => {
  let answer: (response: ServerResponse) => void = (response) => response.end();
  const server = createServer((_, response) => answer(response));
  beforeAll(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  const json = (status: number, body: string) => (response: ServerResponse) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  };

  it.effect.each([
    { failure: "an undeclared 500", answer: json(500, '{"ok":false}'), reason: "response" },
    { failure: "a success body that isn't JSON", answer: json(200, '{"user":'), reason: "decode" },
    { failure: "a success body of another shape", answer: json(200, "{}"), reason: "decode" },
    {
      failure: "a success body cut off mid-stream",
      // The headers promise more than arrives before the socket closes.
      answer: (response: ServerResponse) => {
        response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
        response.write('{"user":', () => response.destroy());
      },
      reason: "transport"
    }
  ] as const)("records $failure as $reason", ({ answer: respond, reason }) => {
    answer = respond;
    const { port } = server.address() as AddressInfo;
    return Effect.gen(function* () {
      const failure = yield* Effect.gen(function* () {
        const client = yield* Api.client(Redacted.make("token"));
        return yield* client.me();
      }).pipe(Effect.flip);
      const error = yield* Api.classify(failure, "Authentication failed.").pipe(Effect.flip);
      assert.instanceOf(error, UnreachableError);
      assert.strictEqual(error.reason, reason);
    }).pipe(
      Effect.provideService(Instance.Instance, {
        apiUrl: `http://127.0.0.1:${port}`,
        source: "env",
        token: Option.none()
      }),
      Effect.provideService(Api.CurrentCommand, "whoami"),
      Effect.provide(NodeHttpClient.layerUndici)
    );
  });
});
