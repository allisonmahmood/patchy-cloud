import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { classify } from "./ApiGuard.js";
import { answer, DEV_TOKEN, html, send, server, upload } from "./test/server.js";

const UNAUTHORIZED = { ok: false, error: "Missing or invalid API token." };
const NOT_FOUND = { ok: false, error: "Not found." };
const LIMITED = {
  ok: false,
  error: "Rate limit exceeded.",
  code: "rate_limited",
  retryAfterSeconds: 60
};

describe("classify", () => {
  it("guards every target under /api, however it is spelled, and nothing else", () => {
    const route = { kind: "route" };
    assert.deepStrictEqual(classify("GET", "/api/me"), route);
    assert.deepStrictEqual(classify("GET", "/api?ignored=true"), route);
    assert.deepStrictEqual(classify("GET", "/api#fragment"), route);
    assert.deepStrictEqual(classify("GET", "/%61pi/does-not-exist"), route);
    assert.deepStrictEqual(classify("GET", "/api//does-not-exist/"), route);
    assert.deepStrictEqual(classify("GET", "http://host/api/does-not-exist?x"), route);
    assert.deepStrictEqual(classify("GET", "HtTp://host/%61pi/does-not-exist"), route);

    const open = { kind: "public" };
    assert.deepStrictEqual(classify("POST", "/api/tokens/self-service"), open);
    assert.deepStrictEqual(classify("GET", "/apix"), open);
    assert.deepStrictEqual(classify("GET", "/d/abc"), open);
    assert.deepStrictEqual(classify("GET", "http://host?x=/api/%"), open);
    assert.deepStrictEqual(classify("GET", "/public/%"), open);
    // An encoded slash is one segment to the router, so nothing routes here —
    // but it reads as a probe of the API, and answers as one after the token.
    assert.deepStrictEqual(classify("POST", "/api%2Fuploads"), { kind: "refused", status: 404 });
  });

  it("answers the shapes the router never sees, by the wire's status for each", () => {
    const long = "x".repeat(101);
    assert.deepStrictEqual(classify("GET", "/api/%"), { kind: "refused", status: 400 });
    assert.deepStrictEqual(classify("GET", "HtTp://host/%61pi/%"), {
      kind: "refused",
      status: 400
    });
    for (const [method, target] of [
      ["DELETE", `/api/patches/${"x".repeat(60)}%2F${"x".repeat(60)}`],
      ["DELETE", `/api/patches/${long}`]
    ] as const) {
      assert.deepStrictEqual(classify(method, target), { kind: "refused", status: 414 }, target);
    }
    for (const [method, target] of [
      ["POST", `/api/patches/${long}`],
      ["GET", `/api/patches/${long}`],
      ["PUT", `/api/patches/${long}`]
    ] as const) {
      assert.deepStrictEqual(classify(method, target), { kind: "refused", status: 404 }, target);
    }
    // A parameter the routes take is the router's to answer, as is anything
    // long outside the patch routes: the catch-all 404s it once it has a token.
    assert.deepStrictEqual(classify("DELETE", `/api/patches/${"x".repeat(100)}`), {
      kind: "route"
    });
    assert.deepStrictEqual(classify("POST", `/api/unmatched/${long}`), { kind: "route" });
  });
});

it.layer(server({ PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE: "3" }))(
  "the guard: a token before anything, one attempt per address before that",
  (it) => {
    it.effect("authenticates and limits what the router never sees, then answers by shape", () =>
      Effect.gen(function* () {
        const long = "x".repeat(101);
        // Three tokenless attempts on shapes the router cannot route: all 401,
        // and each spends the address's protected-API attempt.
        for (const target of ["/api/%", `/api/patches/${long}`, "/api/does-not-exist"]) {
          assert.deepStrictEqual(yield* answer(yield* send(HttpClientRequest.post(target))), {
            status: 401,
            body: UNAUTHORIZED
          });
        }
        const limited = yield* send(HttpClientRequest.post("/api/does-not-exist"));
        assert.strictEqual(limited.headers["retry-after"], "60");
        assert.deepStrictEqual(yield* answer(limited), { status: 429, body: LIMITED });
        // The limit is the API's alone: pages and the mint answer on.
        assert.strictEqual((yield* send(HttpClientRequest.get("/healthz"))).status, 200);
        assert.strictEqual(
          (yield* send(HttpClientRequest.post("/api/tokens/self-service"))).status,
          403
        );
        assert.strictEqual((yield* send(HttpClientRequest.get("/apix"))).status, 404);

        yield* TestClock.adjust("61 seconds");
        const as = (method: "get" | "post" | "delete", target: string) =>
          send(HttpClientRequest[method](target).pipe(HttpClientRequest.bearerToken(DEV_TOKEN)));
        assert.deepStrictEqual(yield* answer(yield* as("post", "/api/%")), {
          status: 400,
          body: { ok: false, error: "Malformed request target." }
        });
        assert.deepStrictEqual(yield* answer(yield* as("delete", `/api/patches/${long}`)), {
          status: 414,
          body: { ok: false, error: "Request target is too long." }
        });
        assert.deepStrictEqual(yield* answer(yield* as("post", `/api/patches/${long}`)), {
          status: 404,
          body: NOT_FOUND
        });
      })
    );

    it.effect(
      "404s an unmatched API target only once it has a token, the wrong method included",
      () =>
        Effect.gen(function* () {
          yield* TestClock.adjust("61 seconds");
          assert.deepStrictEqual(
            yield* answer(yield* send(HttpClientRequest.put("/api/uploads"))),
            { status: 401, body: UNAUTHORIZED }
          );
          for (const request of [
            HttpClientRequest.put("/api/uploads"),
            HttpClientRequest.get("/api/does-not-exist"),
            HttpClientRequest.get("/api")
          ]) {
            yield* TestClock.adjust("61 seconds");
            assert.deepStrictEqual(
              yield* answer(yield* send(request.pipe(HttpClientRequest.bearerToken(DEV_TOKEN)))),
              { status: 404, body: NOT_FOUND },
              request.url
            );
          }
        })
    );

    it.effect("refuses a credential before it reads a body, on every route", () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("61 seconds");
        const oversized = `{"html":"${"x".repeat(2 * 1024 * 1024)}`;
        const post = (target: string, token?: string) =>
          send(
            HttpClientRequest.post(target).pipe(
              token === undefined ? (r) => r : HttpClientRequest.bearerToken(token),
              HttpClientRequest.setHeader("content-type", "application/json"),
              HttpClientRequest.bodyText(oversized)
            )
          );
        assert.deepStrictEqual(yield* answer(yield* post("/api/uploads")), {
          status: 401,
          body: UNAUTHORIZED
        });
        assert.deepStrictEqual(yield* answer(yield* post("/api/uploads", "nope")), {
          status: 401,
          body: UNAUTHORIZED
        });
        assert.deepStrictEqual(yield* answer(yield* post("/api/does-not-exist", "nope")), {
          status: 401,
          body: UNAUTHORIZED
        });
      })
    );
  }
);

it.layer(
  server({
    PATCHY_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE: "2",
    PATCHY_MAX_HTML_BYTES: String(512 * 1024)
  })
)("the upload route: the per-token limit before the body", (it) => {
  it.effect("spends the token's upload attempts before the body is read", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* answer(yield* upload(DEV_TOKEN, {})), {
        status: 400,
        body: { ok: false, error: "Missing HTML document." }
      });
      assert.strictEqual((yield* upload(DEV_TOKEN, {})).status, 400);
      const limited = yield* upload(DEV_TOKEN, { html: html("Never read") });
      assert.strictEqual(limited.headers["retry-after"], "60");
      assert.deepStrictEqual(yield* answer(limited), { status: 429, body: LIMITED });

      yield* TestClock.adjust("61 seconds");
      assert.strictEqual((yield* upload(DEV_TOKEN, { html: html("Read now") })).status, 201);
    })
  );

  it.effect("routes the spellings the router normalises, and answers the ones it cannot", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("61 seconds");
      // A trailing or doubled slash is the real route: the limit applies,
      // and the body decides the answer.
      for (const target of ["/api/uploads/", "/api//uploads"]) {
        assert.deepStrictEqual(
          yield* answer(
            yield* send(
              HttpClientRequest.post(target).pipe(
                HttpClientRequest.bearerToken(DEV_TOKEN),
                HttpClientRequest.bodyJsonUnsafe({})
              )
            )
          ),
          { status: 400, body: { ok: false, error: "Missing HTML document." } },
          target
        );
      }
      assert.deepStrictEqual(yield* answer(yield* send(HttpClientRequest.post("/api%2Fuploads"))), {
        status: 401,
        body: UNAUTHORIZED
      });
      assert.deepStrictEqual(
        yield* answer(
          yield* send(
            HttpClientRequest.post("/api%2Fuploads").pipe(HttpClientRequest.bearerToken(DEV_TOKEN))
          )
        ),
        { status: 404, body: NOT_FOUND }
      );
    })
  );

  it.effect("refuses a body larger than it reads, and names what a malformed one lacks", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("61 seconds");
      const tooLarge = yield* send(
        HttpClientRequest.post("/api/uploads").pipe(
          HttpClientRequest.bearerToken(DEV_TOKEN),
          HttpClientRequest.setHeader("content-type", "application/json"),
          HttpClientRequest.bodyText(`{"html":"${"x".repeat(2 * 1024 * 1024)}`)
        )
      );
      assert.deepStrictEqual(yield* answer(tooLarge), {
        status: 413,
        body: { ok: false, error: "Request body is too large." }
      });

      yield* TestClock.adjust("61 seconds");
      const malformed = yield* send(
        HttpClientRequest.post("/api/uploads").pipe(
          HttpClientRequest.bearerToken(DEV_TOKEN),
          HttpClientRequest.setHeader("content-type", "application/json"),
          HttpClientRequest.bodyText("{oops")
        )
      );
      assert.deepStrictEqual(yield* answer(malformed), {
        status: 400,
        body: { ok: false, error: "Malformed request body." }
      });

      yield* TestClock.adjust("61 seconds");
      assert.deepStrictEqual(
        yield* answer(yield* upload(DEV_TOKEN, { patchId: "", html: html("Bad target") })),
        { status: 400, body: { ok: false, error: "Invalid patch ID." } }
      );
      assert.deepStrictEqual(
        yield* answer(
          yield* upload(DEV_TOKEN, { draftId: "abcdefghijkl", html: html("Old client") })
        ),
        {
          status: 400,
          body: {
            ok: false,
            error:
              "Unknown field draftId: the wire renamed it to patchId. Send patchId to update that patch."
          }
        }
      );
    })
  );
});
