import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import { RuntimeStreamGroup } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { PUBLIC_BASE_URL, signedInCookies } from "@patchy/auth/testing";
import { DEV_SEED } from "@patchy/auth/seed";
import * as RuntimeStream from "./RuntimeStream.js";
import * as RuntimeStreamApi from "./RuntimeStreamApi.js";
import * as Fixtures from "./test/fixtures.js";

const layer = RuntimeStreamApi.layer.pipe(
  Layer.provideMerge(RuntimeStream.layer),
  Layer.provide(WideEvents.layerNoop),
  Layer.provideMerge(Fixtures.layer())
);
const api = HttpApiTest.groups(HttpApi.make("patchy").add(RuntimeStreamGroup), ["runtimeStream"], {
  baseUrl: PUBLIC_BASE_URL
});
const query = {
  patchId: Fixtures.patchId,
  versionId: Fixtures.versionId,
  documentId: "http_stream_document"
};
const headers = {
  ...Fixtures.headers({ userId: DEV_SEED.userId }),
  "sec-fetch-site": "same-origin",
  cookie: signedInCookies()
};

it.layer(layer)("stream HTTP admission", (it) => {
  it.effect("uses cookie admission and runtime refusals before opening SSE", () =>
    Effect.gen(function* () {
      const client = yield* api;
      for (const [changes, status, code] of [
        [{ cookie: "" }, 401, "session_expired"],
        [{ authorization: "Bearer machine-token" }, 403, "access_denied"],
        [{ "sec-fetch-site": "cross-site" }, 403, "access_denied"],
        [{ "x-patchy-wire": "99" }, 409, "shell_outdated"],
        [{ "x-patchy-principal": '{"userId":"changed"}' }, 409, "principal_changed"]
      ] as const) {
        const response = yield* client.stream({
          query,
          headers: { ...headers, ...changes },
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, status);
        assert.include(yield* response.json, { ok: false, source: "patchy", code });
      }
    })
  );

  it.effect("responds with a streaming hello rather than waiting for the document to close", () =>
    Effect.gen(function* () {
      const client = yield* api;
      const response = yield* client.stream({ query, headers, responseMode: "response-only" });
      assert.strictEqual(response.status, 200);
      assert.include(response.headers["content-type"], "text/event-stream");
      assert.include(response.headers["cache-control"], "no-store");
      const pull = yield* Stream.toPull(response.stream);
      const first = new TextDecoder().decode((yield* pull)[0]);
      const hello = JSON.parse(first.slice(6).split("\n\n")[0]!);
      assert.strictEqual(hello.type, "hello");
      assert.isString(hello.generation);
      assert.isNumber(hello.serverTime);
    }).pipe(Effect.scoped)
  );
});
