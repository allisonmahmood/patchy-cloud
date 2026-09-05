import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { AuthGroup } from "@patchy/api";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AuthApi from "./AuthApi.js";
import * as Authorization from "./Authorization.js";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";

const routes = HttpApiBuilder.layer(HttpApi.make("patchy").add(AuthGroup)).pipe(
  Layer.provide(AuthApi.layer),
  Layer.provide(Authorization.layer)
);
const layer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provide(MachineTokens.layer),
  Layer.provide(Analytics.layerNoop),
  Layer.provide(Limits.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ PATCHY_PUBLIC_BASE_URL: "https://patchy.example" })
    )
  )
);

const post = (url: string, body: string, framing: "declared" | "chunked") =>
  Effect.tryPromise(async () => {
    const bytes = new TextEncoder().encode(body);
    const options: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(framing === "declared" ? { "content-length": String(bytes.byteLength) } : {})
      },
      duplex: "half",
      body:
        framing === "declared"
          ? body
          : new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 2048));
                controller.enqueue(bytes.subarray(2048));
                controller.close();
              }
            })
    };
    const response = await fetch(url, options);
    return { status: response.status, body: await response.json() };
  });

it.layer(layer)("anonymous device JSON bodies on a socket", (it) => {
  for (const framing of ["declared", "chunked"] as const) {
    it.effect(`refuses ${framing} overflow on start without storing the machine hint`, () =>
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        assert.strictEqual(server.address._tag, "TcpAddress");
        if (server.address._tag !== "TcpAddress") return;
        const machineNameHint = `${framing}-${"x".repeat(4096)}`;
        const request = post(
          `http://127.0.0.1:${server.address.port}/api/login/device`,
          JSON.stringify({ machineNameHint }),
          framing
        );
        if (framing === "chunked") {
          const failure = yield* request.pipe(Effect.flip);
          assert.instanceOf(failure.cause, TypeError);
          if (!(failure.cause instanceof TypeError)) return assert.fail("Expected fetch failure");
          assert.propertyVal(failure.cause.cause, "code", "UND_ERR_SOCKET");
        } else {
          const response = yield* request;
          assert.strictEqual(response.status, 413);
          assert.deepStrictEqual(response.body, { ok: false, error: "Request body is too large." });
        }
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT user_code FROM device_logins WHERE machine_name_hint = ${machineNameHint}`,
          []
        );
      })
    );

    it.effect(`refuses ${framing} overflow on poll without advancing the polling interval`, () =>
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        assert.strictEqual(server.address._tag, "TcpAddress");
        if (server.address._tag !== "TcpAddress") return;
        const logins = yield* DeviceLogins.DeviceLogins;
        const started = yield* logins.start({ machineNameHint: "Bounded poll" });
        const body = JSON.stringify({ deviceCode: started.deviceCode }) + " ".repeat(4096);
        const request = post(
          `http://127.0.0.1:${server.address.port}/api/login/device/token`,
          body,
          framing
        );
        if (framing === "chunked") {
          const failure = yield* request.pipe(Effect.flip);
          assert.instanceOf(failure.cause, TypeError);
          if (!(failure.cause instanceof TypeError)) return assert.fail("Expected fetch failure");
          assert.propertyVal(failure.cause.cause, "code", "UND_ERR_SOCKET");
        } else {
          const response = yield* request;
          assert.strictEqual(response.status, 413);
          assert.deepStrictEqual(response.body, { ok: false, error: "Request body is too large." });
        }
        assert.deepStrictEqual(yield* logins.poll(started.deviceCode), { status: "pending" });
      })
    );
  }
});
