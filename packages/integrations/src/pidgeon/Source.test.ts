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
const key = Redacted.make("pgn_test_sourceTestKey00000000000001");

it.effect("names each of Pidgeon's answers as Patchy's refusal, by status and code", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [Response, (error: Source.CallError) => void]> = [
      [
        json(401, refusal("unauthenticated", "That API key is not valid.")),
        (error) => assert.instanceOf(error, Source.KeyRejected)
      ],
      [
        json(402, refusal("payment_required", "This month's free emails are used.")),
        (error) => assert.deepInclude(error, { _tag: "PidgeonRateLimited", limit: "plan" })
      ],
      [
        json(403, refusal("forbidden", "This key cannot do that: it needs `send` access or more.")),
        (error) => assert.instanceOf(error, Source.Forbidden)
      ],
      [
        json(403, refusal("held", "This message is held for a person.")),
        (error) => assert.instanceOf(error, Source.Held)
      ],
      [
        // Pidgeon's words name a conversation that may not be the connection's: never kept.
        json(
          403,
          refusal(
            "exfiltration_blocked",
            "This contains text an API key read in conversation 7c0e…."
          )
        ),
        (error) => {
          assert.instanceOf(error, Source.ExfiltrationBlocked);
          assert.notInclude(error.message, "7c0e");
        }
      ],
      [
        json(404, refusal("not_found", "There is no such draft in this account.")),
        (error) => assert.instanceOf(error, Source.NotFound)
      ],
      [
        json(409, refusal("draft_not_editable", "This draft is no longer a draft.")),
        (error) => assert.deepInclude(error, { _tag: "PidgeonConflict" })
      ],
      [
        json(400, refusal("invalid", "Send `to`: at least one address.", "to")),
        (error) =>
          assert.deepInclude(error, {
            _tag: "PidgeonInvalid",
            details: { field: "to", message: "Send `to`: at least one address." }
          })
      ],
      [
        json(429, refusal("rate_limited", "Too many requests.")),
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
        json(502, refusal("send_failed", "The mail service refused the message.")),
        (error) => assert.deepInclude(error, { _tag: "PidgeonMailRefused", reason: "send_failed" })
      ],
      [
        json(503, refusal("unavailable", "The mail service is busy.")),
        (error) => assert.deepInclude(error, { _tag: "PidgeonMailRefused", reason: "unavailable" })
      ],
      [
        json(507, refusal("storage_full", "The account's 10 GB is used.")),
        (error) => assert.deepInclude(error, { _tag: "PidgeonMailRefused", reason: "storage_full" })
      ],
      [
        // A 5xx is Pidgeon's own word only with the code its docs give it.
        json(502, refusal("bad_gateway", "Upstream.")),
        (error) => assert.deepInclude(error, { stage: "status", upstreamStatus: 502 })
      ],
      [
        new Response("<html>busy</html>", { status: 503 }),
        (error) => assert.deepInclude(error, { stage: "status", upstreamStatus: 503 })
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
        json(400, refusal("invalid", "pgn_test_secretEchoedBack1 is not allowed here.")),
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
          .call(key, { method: "GET", path: "/email/inboxes" }, Number.MAX_SAFE_INTEGER)
          .pipe(Effect.flip)
      );
    }
    const { source } = yield* over(() => json(202, { id: "m1", thread_id: "t1", status: "held" }));
    assert.deepStrictEqual(
      yield* source.call(
        key,
        { method: "POST", path: "/email/drafts/m1/send" },
        Number.MAX_SAFE_INTEGER
      ),
      { status: 202, body: { id: "m1", thread_id: "t1", status: "held" } }
    );
    const deleted = yield* over(() => new Response(null, { status: 204 }));
    assert.deepStrictEqual(
      yield* deleted.source.call(
        key,
        { method: "DELETE", path: "/email/drafts/m1" },
        Number.MAX_SAFE_INTEGER
      ),
      { status: 204, body: null }
    );
    // Past the deadline, nothing is sent at all.
    const expired = yield* over(() => json(200, {}));
    assert.deepInclude(
      yield* expired.source
        .call(key, { method: "GET", path: "/email/inboxes" }, (yield* Clock.currentTimeMillis) - 1)
        .pipe(Effect.flip),
      { _tag: "PidgeonTimeout", milliseconds: 0 }
    );
    assert.strictEqual(expired.requests.length, 0);
  })
);

it.effect("sends only to Pidgeon's API, with the key as a bearer token, never a path out", () =>
  Effect.gen(function* () {
    const { source, requests } = yield* over(() => json(200, {}));
    yield* source.call(
      key,
      {
        method: "POST",
        path: "/email/inboxes/inb_1/drafts",
        query: { limit: 2, skipped: undefined },
        body: { to: ["help@acme.example"] }
      },
      Number.MAX_SAFE_INTEGER
    );
    assert.strictEqual(
      requests[0]!.url.href,
      "https://pidgeon.ai/v1/email/inboxes/inb_1/drafts?limit=2"
    );
    assert.strictEqual(requests[0]!.headers.authorization, `Bearer ${Redacted.value(key)}`);
    // Pidgeon ignores Idempotency-Key, so Patchy never sends one.
    assert.notProperty(requests[0]!.headers, "idempotency-key");
    for (const path of ["/../../elsewhere", "/email/../../api/v1/me", "email"]) {
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
      .call(key, { method: "GET", path: "/email/inboxes" }, Number.MAX_SAFE_INTEGER)
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
      .call(key, { method: "GET", path: "/email/threads" }, Number.MAX_SAFE_INTEGER)
      .pipe(Effect.flip);
    assert.instanceOf(refused, Source.TooLarge);
    assert.isAtMost(sent, registry["runtime.result.bytes"].default / chunk.byteLength + 2);
  })
);

it.effect("gives up at the caller's deadline, and never waits past a call's own", () =>
  Effect.gen(function* () {
    const { source } = yield* over(() => new Promise<Response>(() => {}));
    const short = yield* source
      .call(key, { method: "GET", path: "/email/inboxes" }, 2_000)
      .pipe(Effect.forkChild);
    const long = yield* source
      .call(key, { method: "GET", path: "/email/inboxes" }, Number.MAX_SAFE_INTEGER)
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    assert.deepInclude(yield* Fiber.join(short).pipe(Effect.flip), { milliseconds: 2_000 });
    yield* TestClock.adjust(registry["integration.deadline"].default);
    assert.deepInclude(yield* Fiber.join(long).pipe(Effect.flip), {
      milliseconds: registry["integration.deadline"].default
    });
  })
);

it.effect("lets four calls run per inbox and refuses the next busy, with nothing sent", () =>
  Effect.gen(function* () {
    const releases: Array<() => void> = [];
    const { source, requests } = yield* over(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(json(200, {})));
        })
    );
    const slots = registry["pidgeon.calls.concurrent"].default;
    const run = (identity: string, deadline: number) =>
      source
        .withSlot(
          identity,
          deadline
        )(source.call(key, { method: "GET", path: "/email/threads" }, deadline))
        .pipe(Effect.forkChild);
    const running = yield* Effect.forEach(Array.from({ length: slots }), () =>
      run("inb-help", 60_000)
    );
    for (let turn = 0; turn < 100 && requests.length < slots; turn++) yield* Effect.yieldNow;
    assert.strictEqual(requests.length, slots);
    const queued = yield* run("inb-help", 30_000);
    const refused = yield* run("inb-help", 3_000);
    // Another inbox has its own gate.
    const elsewhere = yield* source
      .withSlot(
        "inb-orders",
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
      inboxId: "00000000-0000-4000-8000-000000000001",
      key: `pgn_${"k".repeat(32)}`
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
