import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Cookies from "effect/http/Cookies";
import { RuntimeStreamFrame, RuntimeStreamGroup } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { DEV_SEED } from "@patchy/auth/seed";
import * as RuntimeStream from "./RuntimeStream.js";
import * as RuntimeStreamApi from "./RuntimeStreamApi.js";
import * as Fixtures from "./test/fixtures.js";
import * as StreamAdmission from "./StreamAdmission.js";
import * as StreamLimits from "./StreamLimits.js";
import * as Subscriptions from "./Subscriptions.js";

const layer = RuntimeStreamApi.layer.pipe(
  Layer.provideMerge(RuntimeStream.layer),
  Layer.provide(Subscriptions.layer),
  Layer.provide(StreamAdmission.layer),
  Layer.provide(StreamLimits.layer),
  Layer.provideMerge(Fixtures.streamPorts),
  Layer.provide(WideEvents.layerNoop),
  Layer.provideMerge(Fixtures.layer())
);
const api = HttpApiTest.groups(HttpApi.make("patchy").add(RuntimeStreamGroup), ["runtimeStream"], {
  baseUrl: PUBLIC_BASE_URL
});
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeStreamFrame));
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
      const now = Math.floor(Date.now() / 1000);
      for (const [changes, status, code] of [
        [{ cookie: "" }, 401, "session_expired"],
        [
          {
            cookie: signedInCookies(signSession({ iat: now - 120, nbf: now - 120, exp: now - 60 }))
          },
          401,
          "session_refresh_required"
        ],
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
        assert.isTrue(Option.isNone(Cookies.get(response.cookies, "patchy_stream_affinity")));
      }
    })
  );

  it.effect(
    "refuses subscription controls without cookie admission, or for a document the caller does not own",
    () =>
      Effect.gen(function* () {
        const client = yield* api;
        const document = { ...query, documentId: "controlled_document" };
        // Over HttpApiTest a streamed body ends after its first chunk, so the document
        // is opened on the shared RuntimeStream and only its control goes over HTTP.
        const body = yield* (yield* RuntimeStream.RuntimeStream)
          .open(document)
          .pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(`${PUBLIC_BASE_URL}/api/runtime/stream`, { headers })
              )
            )
          );
        const pull = yield* Stream.toPull(body);
        const next = Effect.map(pull, (chunks) =>
          decodeFrame(new TextDecoder().decode(chunks[0]).slice(6).trim())
        );
        const hello = yield* next;
        assert(hello.type === "hello");
        assert.strictEqual((yield* next).type, "served");
        const control = (
          sequence: number,
          sent: Parameters<typeof client.subscriptions>[0]["headers"],
          changes: { readonly generation?: string; readonly versionId?: string } = {}
        ) =>
          client.subscriptions({
            payload: {
              ...document,
              generation: hello.generation,
              ...changes,
              sequence,
              type: "replace",
              subscriptions: []
            },
            headers: sent,
            responseMode: "response-only"
          });
        const viewer = (userId: string, sub: string, email: string) => ({
          ...headers,
          ...Fixtures.headers({ userId }),
          cookie: signedInCookies(signSession({ sub, email }))
        });
        const now = Math.floor(Date.now() / 1000);
        const refusals = [
          [{ ...headers, cookie: "" }, {}, 401, "session_expired"],
          [
            {
              ...headers,
              cookie: signedInCookies(
                signSession({ iat: now - 120, nbf: now - 120, exp: now - 60 })
              )
            },
            {},
            401,
            "session_refresh_required"
          ],
          [{ ...headers, authorization: "Bearer machine-token" }, {}, 403, "access_denied"],
          [{ ...headers, "sec-fetch-site": "cross-site" }, {}, 403, "access_denied"],
          [{ ...headers, "sec-fetch-site": "same-site" }, {}, 403, "access_denied"],
          [{ ...headers, "x-patchy-wire": "99" }, {}, 409, "shell_outdated"],
          [
            { ...headers, "x-patchy-principal": '{"userId":"changed"}' },
            {},
            409,
            "principal_changed"
          ],
          [{ ...headers, "x-patchy-principal": "null" }, {}, 409, "principal_changed"],
          // The document is another viewer's, another company's, or from a previous
          // generation or version: each is a replaced stream (409), never control.
          [viewer("usr_member", "user_member", "member@patchy.local"), {}, 409, "invalid_request"],
          [viewer("usr_other", "user_other", "other@patchy.local"), {}, 409, "invalid_request"],
          [headers, { generation: "stream_stale" }, 409, "invalid_request"],
          [headers, { versionId: Fixtures.tier1VersionId }, 409, "invalid_request"]
        ] as const;
        for (const [index, [sent, changes, status, code]] of refusals.entries()) {
          // Each refusal carries a later sequence than the accepted control below,
          // so one that applied would surface as the first admitted frame.
          const response = yield* control(10 + index, sent, changes);
          assert.strictEqual(response.status, status, `${index}`);
          assert.include(yield* response.json, { ok: false, source: "patchy", code });
        }
        const accepted = yield* control(1, headers);
        assert.strictEqual(accepted.status, 200);
        assert.deepStrictEqual(yield* accepted.json, { ok: true });
        assert.deepStrictEqual(yield* next, { type: "admitted", sequence: 1 });
      }).pipe(Effect.scoped)
  );

  it.effect("asks the browser to refresh a handshake instead of ending its session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Session;
      const admission = yield* StreamAdmission.make.pipe(
        Effect.provideService(Session.Session, {
          ...session,
          authenticate: () =>
            Effect.succeed<Session.SessionResult>({
              status: "handshake",
              response: new Response(null, { status: 307 }),
              completed: false
            })
        })
      );
      const streams = yield* RuntimeStream.make.pipe(
        Effect.provideServiceEffect(Subscriptions.Subscriptions, Subscriptions.make),
        Effect.provideService(StreamAdmission.StreamAdmission, admission),
        Effect.provide(StreamLimits.layer),
        Effect.provide(WideEvents.layerNoop)
      );
      const error = yield* streams
        .open(query)
        .pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`${PUBLIC_BASE_URL}/api/runtime/stream`, { headers })
            )
          ),
          Effect.flip
        );
      assert.include(error, { _tag: "SessionRefreshRequired" });
    }).pipe(Effect.scoped)
  );

  it.effect("admits a same-company public lifecycle but refuses another company's patch", () =>
    Effect.gen(function* () {
      const client = yield* api;
      const response = yield* client.stream({
        query: { ...query, versionId: Fixtures.publicVersionId },
        headers,
        responseMode: "response-only"
      });
      assert.strictEqual(response.status, 200);
      const pull = yield* Stream.toPull(response.stream);
      assert.include(new TextDecoder().decode((yield* pull)[0]), '"type":"hello"');
      const refused = yield* client.stream({
        query: { ...query, patchId: "otherpatch11", versionId: Fixtures.publicVersionId },
        headers,
        responseMode: "response-only"
      });
      assert.strictEqual(refused.status, 403);
      assert.include(yield* refused.json, { code: "access_denied" });
    }).pipe(Effect.scoped)
  );

  it.effect(
    "streams hello without waiting for the document to close, on one replica per affinity cookie",
    () =>
      Effect.gen(function* () {
        const client = yield* api;
        let affinity: string | undefined;
        for (const documentId of ["first_affinity_document", "second_affinity_document"]) {
          const response = yield* client.stream({
            query: { ...query, documentId },
            headers,
            responseMode: "response-only"
          });
          assert.strictEqual(response.status, 200);
          assert.include(response.headers["content-type"], "text/event-stream");
          assert.include(response.headers["cache-control"], "no-store");
          const cookie = Option.getOrThrow(Cookies.get(response.cookies, "patchy_stream_affinity"));
          assert.match(cookie.value, /^replica_[a-z0-9]+$/);
          assert.strictEqual(cookie.options?.path, "/api/runtime");
          assert.isTrue(cookie.options?.httpOnly);
          assert.strictEqual(cookie.options?.sameSite, "strict");
          assert.strictEqual(
            cookie.options?.secure === true,
            new URL(PUBLIC_BASE_URL).protocol === "https:"
          );
          if (affinity === undefined) affinity = cookie.value;
          else assert.strictEqual(cookie.value, affinity);
          const pull = yield* Stream.toPull(response.stream);
          // The frame schema requires hello's generation and server time.
          const hello = decodeFrame(
            new TextDecoder()
              .decode((yield* pull)[0])
              .slice(6)
              .trim()
          );
          assert.strictEqual(hello.type, "hello");
        }
      }).pipe(Effect.scoped)
  );
});
