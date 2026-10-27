import { assert, it } from "@effect/vitest";
import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Source from "./Source.js";

/** The production source over `answer`, and every request it sent. */
const over = (answer: (url: URL) => Response | Promise<Response>) =>
  Effect.gen(function* () {
    const requests: Array<{ url: URL; headers: Readonly<Record<string, string>> }> = [];
    const http = HttpClient.make((request, url) =>
      Effect.promise(async () => {
        requests.push({ url: new URL(url), headers: request.headers });
        return HttpClientResponse.fromWeb(request, await answer(new URL(url)));
      })
    );
    const source = yield* Source.Source.pipe(
      Effect.provide(
        Layer.effect(Source.Source, Source.make).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http))
        )
      )
    );
    return { source, requests };
  });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
const refusal = (code: string, message: string, field?: string) => ({
  error: { code, message, ...(field === undefined ? {} : { field }) }
});
const key = Redacted.make("pgn_live_sourceTestKey0001");

it.effect("names each of Pidgeon's answers as Patchy's refusal, by status and code", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [Response, (error: Source.CallError) => void]> = [
      [
        json(401, refusal("unauthenticated", "That API key is not valid.")),
        (error) => assert.instanceOf(error, Source.KeyRejected)
      ],
      [
        json(402, refusal("entitlement", "You can have 3 inboxes at the moment.")),
        (error) => assert.deepInclude(error, { _tag: "PidgeonRateLimited", limit: "plan" })
      ],
      [
        json(403, refusal("forbidden", "This key has read access, and that needs draft.")),
        (error) => assert.instanceOf(error, Source.Forbidden)
      ],
      [
        json(403, refusal("not_permitted", "support@ only replies to people who wrote first.")),
        (error) =>
          assert.deepInclude(error, {
            _tag: "PidgeonRefused",
            details: {
              reason: "not_permitted",
              message: "support@ only replies to people who wrote first."
            }
          })
      ],
      [
        json(403, refusal("blocked", "That recipient is blocked.")),
        (error) => assert.deepInclude(error, { _tag: "PidgeonRefused" })
      ],
      [
        json(404, refusal("not_found", "We couldn't find that conversation.")),
        (error) => assert.instanceOf(error, Source.NotFound)
      ],
      [
        json(409, refusal("conflict", "help@acme.example already exists.", "localPart")),
        (error) =>
          assert.deepInclude(error, {
            _tag: "PidgeonConflict",
            details: { field: "localPart", message: "help@acme.example already exists." }
          })
      ],
      [
        // The same Idempotency-Key with another request, or from another key: nothing was done.
        json(409, refusal("idempotency_mismatch", "That Idempotency-Key was used differently.")),
        (error) => assert.instanceOf(error, Source.IdempotencyMismatch)
      ],
      [
        json(403, refusal("held", "A person must release this message first.")),
        (error) => assert.instanceOf(error, Source.Held)
      ],
      [
        json(
          403,
          refusal(
            "exfiltration_blocked",
            "This contains text an API key read in conversation 7c0e…."
          )
        ),
        (error) =>
          assert.deepInclude(error, {
            _tag: "PidgeonRefused",
            details: {
              reason: "exfiltration_blocked",
              message: "This contains text an API key read in conversation 7c0e…."
            }
          })
      ],
      [
        // Test mode's dropped answer: the work was done, so it reads as an answer lost.
        json(504, refusal("test_dropped", "Pidgeon-Test-Fail: drop dropped this answer.")),
        (error) => assert.deepInclude(error, { stage: "status", upstreamStatus: 504 })
      ],
      [
        json(
          400,
          refusal("validation", "Too big: expected string to have <=60 characters", "name")
        ),
        (error) => assert.deepInclude(error, { _tag: "PidgeonInvalid" })
      ],
      [
        json(429, refusal("rate_limited", "Too many attempts. Try again in 9 minutes.")),
        (error) => {
          assert.deepInclude(error, { _tag: "PidgeonRateLimited", limit: "requests" });
          assert.notProperty(error, "retryAfterSeconds");
        }
      ],
      [
        json(429, refusal("rate_limited", "Slow down."), { "retry-after": "30" }),
        (error) => {
          assert.deepInclude(error, { retryAfterSeconds: 30 });
          assert.include(error.message, "Try again in 30 seconds.");
        }
      ],
      [
        json(429, refusal("rate_limited", "Slow down."), { "retry-after": "1500" }),
        (error) => assert.include(error.message, "Try again in 25 minutes.")
      ],
      [
        json(500, refusal("internal", "Something went wrong.")),
        (error) => assert.deepInclude(error, { stage: "status", upstreamStatus: 500 })
      ],
      [
        new Response("<html>not json</html>", { status: 200 }),
        (error) => assert.deepInclude(error, { stage: "response" })
      ],
      [
        // Pidgeon's words are kept for people, never anything shaped like a secret.
        json(400, refusal("validation", "pgn_live_secretEchoedBack1 is not allowed here.")),
        (error) =>
          assert.deepInclude(error, {
            details: { message: "pgn_… is not allowed here." }
          })
      ]
    ];
    for (const [answer, check] of cases) {
      const { source } = yield* over(() => answer.clone());
      check(
        yield* source
          .call(key, { method: "GET", path: "/me" }, Number.MAX_SAFE_INTEGER)
          .pipe(Effect.flip)
      );
    }
    const { source } = yield* over(() =>
      json(202, { data: { id: "m1" } }, { "idempotent-replay": "true" })
    );
    assert.deepStrictEqual(
      yield* source.call(
        key,
        { method: "POST", path: "/messages", body: {}, idempotencyKey: "a" },
        Number.MAX_SAFE_INTEGER
      ),
      { body: { data: { id: "m1" } }, replayed: true }
    );
  })
);

it.effect(
  "waits out a write Pidgeon is still answering, then sends it again under the same key",
  () =>
    Effect.gen(function* () {
      // Recorded: Pidgeon's answer while the first request with this Idempotency-Key runs.
      const inProgress = () =>
        json(
          409,
          refusal(
            "idempotency_in_progress",
            "The first request with this Idempotency-Key hasn't answered yet."
          ),
          { "retry-after": "2" }
        );
      const answers = [
        inProgress(),
        json(201, { data: { id: "k1", token: null } }, { "idempotent-replay": "true" })
      ];
      const { source, requests } = yield* over(() => answers.shift()!);
      const request = {
        method: "POST",
        path: "/api-keys",
        body: { name: "Patchy support attempt00001" },
        idempotencyKey: "mint-1"
      } as const;
      const sent = yield* source.call(key, request, 60_000).pipe(Effect.forkChild);
      for (let turn = 0; turn < 100 && requests.length < 1; turn++) yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      assert.deepStrictEqual(yield* Fiber.join(sent), {
        body: { data: { id: "k1", token: null } },
        replayed: true
      });
      assert.deepStrictEqual(
        requests.map((sentRequest) => sentRequest.headers["idempotency-key"]),
        ["mint-1", "mint-1"]
      );
      // Past the deadline, nothing is sent at all.
      const expired = yield* over(() => json(200, { data: {} }));
      assert.deepInclude(
        yield* expired.source
          .call(key, request, (yield* Clock.currentTimeMillis) - 1)
          .pipe(Effect.flip),
        { _tag: "PidgeonTimeout", milliseconds: 0 }
      );
      assert.strictEqual(expired.requests.length, 0);
      // One still running at the deadline is a timeout, with nothing more sent.
      const late = yield* over(inProgress);
      assert.instanceOf(
        yield* late.source
          .call(key, request, (yield* Clock.currentTimeMillis) + 1_000)
          .pipe(Effect.flip),
        Source.Timeout
      );
      assert.strictEqual(late.requests.length, 1);
      // A request that asks to fail is told Pidgeon's wait instead, with nothing sent again.
      const told = yield* over(inProgress);
      assert.deepInclude(
        yield* told.source.call(key, { ...request, inProgress: "fail" }, 60_000).pipe(Effect.flip),
        { _tag: "PidgeonIdempotencyInProgress", retryAfterSeconds: 2 }
      );
      assert.strictEqual(told.requests.length, 1);
    })
);

it.effect("sends only to Pidgeon's API, with the key as a bearer token, never a path out", () =>
  Effect.gen(function* () {
    const { source, requests } = yield* over(() => json(200, { data: {} }));
    yield* source.call(
      key,
      {
        method: "POST",
        path: "/identities",
        query: { limit: 2, skipped: undefined },
        body: { local_part: "help" },
        idempotencyKey: "attempt"
      },
      Number.MAX_SAFE_INTEGER
    );
    assert.strictEqual(requests[0]!.url.href, "https://pidgeon.ai/api/v1/identities?limit=2");
    assert.strictEqual(requests[0]!.headers.authorization, `Bearer ${Redacted.value(key)}`);
    assert.strictEqual(requests[0]!.headers["idempotency-key"], "attempt");
    for (const path of ["/../../elsewhere", "/me/../../../v2/me", "me"]) {
      const refused = yield* source
        .call(key, { method: "GET", path }, Number.MAX_SAFE_INTEGER)
        .pipe(Effect.flip);
      assert.deepInclude(refused, { _tag: "PidgeonUnavailable", stage: "request" });
    }
    assert.strictEqual(requests.length, 1);
  })
);

it.effect("refuses a redirect without following it", () =>
  Effect.gen(function* () {
    const { source, requests } = yield* over(
      () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } })
    );
    const refused = yield* source
      .call(key, { method: "GET", path: "/me" }, Number.MAX_SAFE_INTEGER)
      .pipe(Effect.flip);
    assert.deepInclude(refused, { stage: "redirect", upstreamStatus: 307 });
    assert.strictEqual(requests.length, 1);
  })
);

it.effect("refuses an endless body at the byte cap before decoding it", () =>
  Effect.gen(function* () {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    const { source } = yield* over(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              sent++;
              controller.enqueue(chunk);
            }
          }),
          { status: 200 }
        )
    );
    const refused = yield* source
      .call(key, { method: "GET", path: "/threads" }, Number.MAX_SAFE_INTEGER)
      .pipe(Effect.flip);
    assert.instanceOf(refused, Source.TooLarge);
    assert.isAtMost(sent, registry["runtime.result.bytes"].default / chunk.byteLength + 2);
  })
);

it.effect("gives up at the caller's deadline, and never waits past a call's own", () =>
  Effect.gen(function* () {
    const { source } = yield* over(() => new Promise<Response>(() => {}));
    const short = yield* source
      .call(key, { method: "GET", path: "/me" }, 2_000)
      .pipe(Effect.forkChild);
    const long = yield* source
      .call(key, { method: "GET", path: "/me" }, Number.MAX_SAFE_INTEGER)
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    assert.deepInclude(yield* Fiber.join(short).pipe(Effect.flip), { milliseconds: 2_000 });
    yield* TestClock.adjust(registry["integration.deadline"].default);
    assert.deepInclude(yield* Fiber.join(long).pipe(Effect.flip), {
      milliseconds: registry["integration.deadline"].default
    });
  })
);

it.effect("lets four calls run per address and refuses the next busy, with nothing sent", () =>
  Effect.gen(function* () {
    const releases: Array<() => void> = [];
    const { source, requests } = yield* over(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(json(200, { data: {} })));
        })
    );
    const slots = registry["pidgeon.calls.concurrent"].default;
    const run = (identity: string, deadline: number) =>
      source
        .withSlot(
          identity,
          deadline
        )(source.call(key, { method: "GET", path: "/threads" }, deadline))
        .pipe(Effect.forkChild);
    const running = yield* Effect.forEach(Array.from({ length: slots }), () =>
      run("addr-help", 60_000)
    );
    for (let turn = 0; turn < 100 && requests.length < slots; turn++) yield* Effect.yieldNow;
    assert.strictEqual(requests.length, slots);
    const queued = yield* run("addr-help", 30_000);
    const refused = yield* run("addr-help", 3_000);
    // Another address has its own gate.
    const elsewhere = yield* source
      .withSlot(
        "addr-orders",
        3_000
      )(Effect.succeed("ran"))
      .pipe(Effect.forkChild);
    assert.strictEqual(yield* Fiber.join(elsewhere), "ran");
    // The refused call keeps a second's reserve before its deadline.
    yield* TestClock.adjust("2 seconds");
    assert.instanceOf(yield* Fiber.join(refused).pipe(Effect.flip), Source.Busy);
    assert.strictEqual(requests.length, slots);
    releases.shift()!();
    yield* Fiber.join(running[0]!);
    for (let turn = 0; turn < 100 && requests.length === slots; turn++) yield* Effect.yieldNow;
    assert.strictEqual(requests.length, slots + 1);
    for (const release of releases.splice(0)) release();
    yield* Fiber.join(queued);
    yield* Effect.forEach(running.slice(1), Fiber.join);
  })
);

it.effect("keeps the key's stored form round-tripping, and refuses anything else", () =>
  Effect.gen(function* () {
    const stored = {
      identityId: "00000000-0000-4000-8000-000000000001",
      key: { id: "k1", token: "pgn_live_storedKey0001" }
    };
    assert.deepStrictEqual(yield* Source.parseCredentials(Source.credentials(stored)), stored);
    assert.instanceOf(
      yield* Source.parseCredentials(Redacted.make(JSON.stringify({ ...stored, extra: 1 }))).pipe(
        Effect.flip
      ),
      Source.InvalidCredentials
    );
  })
);
