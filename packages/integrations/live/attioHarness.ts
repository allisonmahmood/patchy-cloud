import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Source from "../src/attio/Source.js";

/**
 * The live tier's Attio: Patchy's probe workspace, read with its read-only key in
 * `ATTIO_TEST_READ_KEY`. Every run, CI's and developers' dev environments alike, shares the
 * workspace's 100 reads a second and its query-complexity budget, so a run paces itself to about
 * 20 requests a second and waits out a 429's Retry-After outside the call's own deadline. It only
 * reads, so there's nothing to sweep, and nothing here prints the key or what Attio answers.
 */

/** Node's own fetch, taken before anything could replace it. */
const realFetch = globalThis.fetch;

/** The read key, when this machine or CI has one; the suite skips without it. */
export const READ_KEY = process.env.ATTIO_TEST_READ_KEY;
export const readKey = () => Redacted.make(READ_KEY ?? "");

/** At most one request per this many milliseconds: about 20 a second. */
const PACE_MS = 50;
/** The longest one call sits out 429s before it fails, saying so. */
const MAX_WAIT_S = 120;

/** How many requests this run has sent, and how many 429s it sat out. */
export const counts = { sent: 0, limited: 0 };

/** One pace for the whole run, however many sources it builds. */
const gate = Semaphore.makeUnsafe(1);
let last = 0;
const next = gate.withPermits(1)(
  Effect.gen(function* () {
    const wait = last + PACE_MS - Date.now();
    if (wait > 0) yield* Effect.sleep(wait);
    last = Date.now();
  })
);

/** Node's fetch, paced and counted. */
const paced = Effect.gen(function* () {
  const fetch = yield* HttpClient.HttpClient;
  return HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* next;
      counts.sent += 1;
      return yield* fetch
        .execute(request)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, realFetch));
    })
  );
});

/**
 * Runs `attempt` again after a 429's Retry-After, as a call of its own with its full deadline, so
 * a run sharing the workspace with another never fails a case for Attio's rate.
 */
const sitOut = <A, E>(attempt: () => Effect.Effect<A, E>): Effect.Effect<A, E> => {
  const loop = (waited: number): Effect.Effect<A, E> =>
    attempt().pipe(
      Effect.catchIf(
        (error): error is E & Source.RateLimited =>
          error instanceof Source.RateLimited && waited + error.retryAfterSeconds <= MAX_WAIT_S,
        (error) =>
          Effect.sync(() => {
            counts.limited += 1;
          }).pipe(
            Effect.andThen(Effect.sleep(error.retryAfterSeconds * 1_000 + 250)),
            Effect.andThen(Effect.suspend(() => loop(waited + error.retryAfterSeconds)))
          )
      )
    );
  return loop(0);
};

/** The production source over that paced fetch, sitting out the shared rate. */
const waiting = Effect.gen(function* () {
  const inner = yield* Source.make;
  return Source.Source.of({
    check: (key) => sitOut(() => inner.check(key)),
    inspect: (key) => sitOut(() => inner.inspect(key)),
    withSlot: inner.withSlot,
    send: (key, request, bytes) => sitOut(() => inner.send(key, request, bytes))
  });
});

const http = Layer.effect(HttpClient.HttpClient, paced).pipe(Layer.provide(FetchHttpClient.layer));
/** The live tier's Attio, for its tests. */
export const layer = Layer.effect(Source.Source, waiting).pipe(Layer.provide(http));

/** The run's request count, for the log: the workspace's budget is shared. */
export const summary = () =>
  console.log(
    `Attio live run: ${counts.sent} requests, ${counts.limited} rate-limited and sat out.`
  );
