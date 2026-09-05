import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { classify } from "./ApiGuard.js";
import { DEV_SEED } from "@patchy/auth/seed";
import { answer, html, send, server, upload } from "./test/server.js";

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
        // The limit is the API's alone: pages answer on.
        assert.strictEqual((yield* send(HttpClientRequest.get("/healthz"))).status, 200);
        assert.strictEqual((yield* send(HttpClientRequest.get("/apix"))).status, 404);

        yield* TestClock.adjust("61 seconds");
        const as = (method: "get" | "post" | "delete", target: string) =>
          send(
            HttpClientRequest[method](target).pipe(HttpClientRequest.bearerToken(DEV_SEED.token))
          );
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
              yield* answer(
                yield* send(request.pipe(HttpClientRequest.bearerToken(DEV_SEED.token)))
              ),
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

it.layer(server())("the guard: only the device-login POST routes are anonymous", (it) => {
  it.effect("admits a start and poll without a credential, even with an invalid bearer", () =>
    Effect.gen(function* () {
      for (const authorization of [undefined, "Bearer invalid-machine-token"]) {
        const headers = authorization === undefined ? {} : { authorization };
        const started = yield* send(
          HttpClientRequest.post("/api/login/device").pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyJsonUnsafe({ machineNameHint: "Laptop" })
          )
        );
        assert.strictEqual(started.status, 201);
        const poll = yield* send(
          HttpClientRequest.post("/api/login/device/token").pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyJsonUnsafe({ deviceCode: "unknown-device" })
          )
        );
        assert.strictEqual(poll.status, 410);
        assert.propertyVal(yield* poll.json, "code", "unknown");
      }
    })
  );

  it.effect("requires a bearer on other methods, adjacent paths and malformed targets", () =>
    Effect.gen(function* () {
      for (const request of [
        HttpClientRequest.get("/api/login/device"),
        HttpClientRequest.put("/api/login/device"),
        HttpClientRequest.delete("/api/login/device/token"),
        HttpClientRequest.post("/api/login/device/extra"),
        HttpClientRequest.post("/api/login/device/token/extra"),
        HttpClientRequest.post("/api/login/device-other"),
        HttpClientRequest.post("/api/login/device/%"),
        HttpClientRequest.post("/api%2Flogin/device"),
        HttpClientRequest.post("/api/does-not-exist"),
        HttpClientRequest.get("/api/me"),
        HttpClientRequest.post("/api/logout"),
        HttpClientRequest.post("/api/uploads")
      ]) {
        assert.deepStrictEqual(
          yield* answer(yield* send(request)),
          {
            status: 401,
            body: UNAUTHORIZED
          },
          `${request.method} ${request.url}`
        );
      }
      for (const path of ["/api/login/device", "/api/login/device/token"]) {
        assert.strictEqual((yield* send(HttpClientRequest.head(path))).status, 401);
      }
    })
  );

  it.effect("applies the default five-start limit to all spellings the router matches", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("61 seconds");
      for (const path of [
        "/api/login/device",
        "/api/login/device?ignored=true",
        "/api//login/device",
        "/api/login/device/",
        "/%61pi/login/device"
      ]) {
        assert.strictEqual(
          (yield* send(
            HttpClientRequest.post(path).pipe(
              HttpClientRequest.bodyJsonUnsafe({ machineNameHint: "Laptop" })
            )
          )).status,
          201,
          path
        );
      }
      const limited = yield* send(
        HttpClientRequest.post("/api/login/device").pipe(
          HttpClientRequest.bodyJsonUnsafe({ machineNameHint: "Laptop" })
        )
      );
      assert.strictEqual(limited.headers["retry-after"], "60");
      assert.deepStrictEqual(yield* answer(limited), { status: 429, body: LIMITED });
      const poll = yield* send(
        HttpClientRequest.post("/api/login/device//token/").pipe(
          HttpClientRequest.bodyJsonUnsafe({ deviceCode: "unknown-device" })
        )
      );
      assert.strictEqual(poll.status, 410);
      assert.propertyVal(yield* poll.json, "code", "unknown");
    })
  );
});

it.layer(
  server({
    PATCHY_DEVICE_LOGIN_RATE_LIMIT_PER_MINUTE: "2",
    PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE: "1",
    PATCHY_TRUST_PROXY: "127.0.0.1"
  })
)("the guard: device starts have their own per-address bucket", (it) => {
  it.effect(
    "limits starts before reading the body, independently of bearers, polls and other addresses",
    () =>
      Effect.gen(function* () {
        const from = (address: string) => HttpClientRequest.setHeader("x-forwarded-for", address);
        const start = (address: string) =>
          send(
            HttpClientRequest.post("/api/login/device").pipe(
              from(address),
              HttpClientRequest.bodyJsonUnsafe({ machineNameHint: "Laptop" })
            )
          );
        const protectedRequest = HttpClientRequest.get("/api/me").pipe(from("203.0.113.1"));
        assert.strictEqual((yield* send(protectedRequest)).status, 401);
        assert.strictEqual((yield* send(protectedRequest)).status, 429);
        const malformed = yield* send(
          HttpClientRequest.post("/api/login/device").pipe(
            from("203.0.113.1"),
            HttpClientRequest.setHeader("content-type", "application/json"),
            HttpClientRequest.bodyText("{not-json")
          )
        );
        assert.deepStrictEqual(yield* answer(malformed), {
          status: 400,
          body: { ok: false, error: "Malformed request body." }
        });
        assert.strictEqual((yield* start("203.0.113.1")).status, 201);
        const limited = yield* send(
          HttpClientRequest.post("/api/login/device").pipe(
            from("203.0.113.1"),
            HttpClientRequest.bearerToken(DEV_SEED.token),
            HttpClientRequest.setHeader("content-type", "application/json"),
            HttpClientRequest.bodyText("{still-not-json")
          )
        );
        assert.strictEqual(limited.headers["retry-after"], "60");
        assert.deepStrictEqual(yield* answer(limited), { status: 429, body: LIMITED });
        assert.strictEqual((yield* start("203.0.113.2")).status, 201);
        const malformedPoll = yield* send(
          HttpClientRequest.post("/api/login/device/token").pipe(
            from("203.0.113.1"),
            HttpClientRequest.bodyJsonUnsafe({})
          )
        );
        assert.deepStrictEqual(yield* answer(malformedPoll), {
          status: 400,
          body: { ok: false, error: "Malformed request body." }
        });
        const poll = yield* send(
          HttpClientRequest.post("/api/login/device/token").pipe(
            from("203.0.113.1"),
            HttpClientRequest.bodyJsonUnsafe({ deviceCode: "unknown-device" })
          )
        );
        assert.strictEqual(poll.status, 410);
        assert.propertyVal(yield* poll.json, "code", "unknown");
        yield* TestClock.adjust("61 seconds");
        assert.strictEqual((yield* start("203.0.113.1")).status, 201);
        assert.strictEqual((yield* send(protectedRequest)).status, 401);
      })
  );
});

it.layer(
  server({
    PATCHY_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE: "2",
    PATCHY_MAX_HTML_BYTES: String(512 * 1024)
  })
)("the upload route: the per-token limit before the body", (it) => {
  it.effect("spends the token's upload attempts before the body is read", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* answer(yield* upload(DEV_SEED.token, {})), {
        status: 400,
        body: { ok: false, error: "Missing HTML document." }
      });
      assert.strictEqual((yield* upload(DEV_SEED.token, {})).status, 400);
      const limited = yield* upload(DEV_SEED.token, { html: html("Never read") });
      assert.strictEqual(limited.headers["retry-after"], "60");
      assert.deepStrictEqual(yield* answer(limited), { status: 429, body: LIMITED });

      yield* TestClock.adjust("61 seconds");
      assert.strictEqual((yield* upload(DEV_SEED.token, { html: html("Read now") })).status, 201);
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
                HttpClientRequest.bearerToken(DEV_SEED.token),
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
            HttpClientRequest.post("/api%2Fuploads").pipe(
              HttpClientRequest.bearerToken(DEV_SEED.token)
            )
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
          HttpClientRequest.bearerToken(DEV_SEED.token),
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
          HttpClientRequest.bearerToken(DEV_SEED.token),
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
        yield* answer(yield* upload(DEV_SEED.token, { patchId: "", html: html("Bad target") })),
        { status: 400, body: { ok: false, error: "Invalid patch ID." } }
      );
      assert.deepStrictEqual(
        yield* answer(
          yield* upload(DEV_SEED.token, { draftId: "abcdefghijkl", html: html("Old client") })
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
