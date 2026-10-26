// @effect-diagnostics nodeBuiltinImport:off — node:crypto draws the run's tag.
import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Source from "../src/pidgeon/Source.js";

/**
 * The live tier's Pidgeon: pidgeon.ai in test mode, with `PIDGEON_TEST_ADMIN_KEY`. One account
 * serves every run, its budgets shared: 120 requests a minute on the free plan and 300 test mints
 * an hour. So this run paces its calls, waits out any 429, and tags everything it makes with its
 * own code, which cleanup goes by. That account also holds an address that isn't ours: the tests
 * read and assert only on what they made, and nothing here prints what Pidgeon lists.
 */

/**
 * Node's own fetch, taken before anything replaces it: the pages' offline Clerk fixture refuses
 * every host but loopback, so a suite importing it imports this module first.
 */
const realFetch = globalThis.fetch;

/** The test admin key, when this machine or CI has one; the suite skips without it. */
export const ADMIN_KEY = process.env.PIDGEON_TEST_ADMIN_KEY;
export const admin = () => Redacted.make(ADMIN_KEY ?? "");

/** This run's tag, in every handle, key name and address it makes. */
export const RUN = `lv${randomBytes(4).toString("hex").slice(0, 6)}`;

/** One request as the harness saw it, for matching faults and counting calls. */
export interface Sent {
  readonly method: string;
  /** Under `/api/v1`. */
  readonly path: string;
  readonly body: string;
}

/** At most one request per this many milliseconds: two runs at once stay under 120 a minute. */
const PACE_MS = 1_250;
/** The longest wait for a 429 the harness sits out; longer, and the run fails saying so. */
const MAX_WAIT_S = 120;

const faults: Array<{ match: (sent: Sent) => boolean; value: string; times: number }> = [];
/** Every request sent, and what the run made: its keys and its addresses. */
export const sent: Sent[] = [];
export const minted = new Set<string>();
export const created = new Set<string>();

/** Sends `Pidgeon-Test-Fail: value` on the next `times` requests that match. */
export const fail = (match: (sent: Sent) => boolean, value: string, times = 1) => {
  faults.push({ match, value, times });
};
export const route =
  (method: string, path: string | RegExp) =>
  (request: Sent): boolean =>
    request.method === method &&
    (typeof path === "string" ? request.path === path : path.test(request.path));

/** Seconds Pidgeon asked to wait: `Retry-After`, else `X-RateLimit-Reset` as seconds or a time. */
const waitFor = (headers: Readonly<Record<string, string | undefined>>) => {
  const after = Number(headers["retry-after"]);
  if (Number.isFinite(after) && after >= 0) return after;
  const reset = Number(headers["x-ratelimit-reset"]);
  if (!Number.isFinite(reset)) return 1;
  // An epoch in seconds, or seconds from now.
  return reset > 1e9 ? Math.max(0, reset - Date.now() / 1_000) : reset;
};

const bodyOf = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

/** The data id of a write's answer, when it made something. */
const idOf = (text: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || !("data" in parsed)) return undefined;
    const data = parsed.data;
    return typeof data === "object" && data !== null && "id" in data && typeof data.id === "string"
      ? data.id
      : undefined;
  } catch {
    return undefined;
  }
};

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

const paced = Effect.gen(function* () {
  const fetch = yield* HttpClient.HttpClient;
  return HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      const seen: Sent = {
        method: request.method,
        path: url.pathname.replace(/^\/api\/v1/, ""),
        body: bodyOf(request)
      };
      const index = faults.findIndex((fault) => fault.match(seen));
      const fault = index === -1 ? undefined : faults[index]!;
      if (fault !== undefined && --fault.times === 0) faults.splice(index, 1);
      const outgoing =
        fault === undefined
          ? request
          : request.pipe(HttpClientRequest.setHeader("pidgeon-test-fail", fault.value));
      for (let attempt = 0; ; attempt++) {
        yield* next;
        sent.push(seen);
        const response = yield* fetch
          .execute(outgoing)
          .pipe(Effect.provideService(FetchHttpClient.Fetch, realFetch));
        // A 429 this run didn't ask for is the shared budget: sit it out and send again.
        if (response.status === 429 && fault === undefined && attempt < 3) {
          const seconds = waitFor(response.headers);
          if (seconds <= MAX_WAIT_S) {
            yield* Effect.sleep(Math.ceil(seconds * 1_000) + 250);
            continue;
          }
        }
        const text = yield* response.text;
        if (response.status >= 200 && response.status < 300 && seen.method === "POST") {
          const id = idOf(text);
          if (id !== undefined && seen.path === "/api-keys") minted.add(id);
          if (id !== undefined && seen.path === "/identities") created.add(id);
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(text, { status: response.status, headers: new Headers(response.headers) })
        );
      }
    })
  );
});

/** The production source over pidgeon.ai, paced, as the live tier's Pidgeon. */
export const layer = Layer.effect(Source.Source, Source.make).pipe(
  Layer.provide(
    Layer.effect(HttpClient.HttpClient, paced).pipe(Layer.provide(FetchHttpClient.layer))
  )
);

/** One call as the admin, for what a test sets up or checks itself. */
export const call = Effect.fn("live.call")(function* (
  token: Redacted.Redacted<string>,
  request: Source.Request
) {
  const source = yield* Source.Source;
  return yield* source.call(token, request, Date.now() + 60_000);
});

/** Keys the run minted, a replay's included once. */
const mints = () => minted.size;

/** How many requests this run has sent that match. */
export const count = (match: (request: Sent) => boolean) => sent.filter(match).length;

/**
 * Revokes every key the run made and deletes every address it made, then revokes any key whose
 * name carries the run's tag that an answer lost along the way kept from the record.
 */
export const cleanup = Effect.gen(function* () {
  const source = yield* Source.Source;
  const until = Date.now() + 120_000;
  for (const id of minted)
    yield* source
      .call(
        admin(),
        { method: "DELETE", path: `/api-keys/${id}`, idempotencyKey: `cleanup-${id}` },
        until
      )
      .pipe(Effect.ignore);
  let cursor: string | null = null;
  do {
    const page = yield* source
      .call(
        admin(),
        {
          method: "GET",
          path: "/api-keys",
          query: { limit: 100, ...(cursor === null ? {} : { cursor }) }
        },
        until
      )
      .pipe(Effect.option);
    if (page._tag === "None") break;
    const body = Source.data(page.value.body);
    const keys = Array.isArray(body) ? body : [];
    for (const key of keys)
      if (
        typeof key === "object" &&
        key !== null &&
        "id" in key &&
        "name" in key &&
        "revoked_at" in key &&
        typeof key.id === "string" &&
        typeof key.name === "string" &&
        key.name.includes(RUN) &&
        key.revoked_at === null
      )
        yield* source
          .call(admin(), { method: "DELETE", path: `/api-keys/${key.id}` }, until)
          .pipe(Effect.ignore);
    const envelope: unknown = page.value.body;
    cursor =
      typeof envelope === "object" &&
      envelope !== null &&
      "next_cursor" in envelope &&
      typeof envelope.next_cursor === "string"
        ? envelope.next_cursor
        : null;
  } while (cursor !== null);
  for (const id of created)
    yield* source
      .call(
        admin(),
        { method: "DELETE", path: `/identities/${id}`, idempotencyKey: `cleanup-${id}` },
        until
      )
      .pipe(Effect.ignore);
  // Counts only: what the run cost the account's shared budgets.
  yield* Effect.log(`Pidgeon live run ${RUN}: ${sent.length} calls, ${mints()} keys minted.`);
});
