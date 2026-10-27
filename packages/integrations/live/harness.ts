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
 * serves every run and every developer's dev environment, its budgets shared: 120 requests a
 * minute on the free plan, 300 test mints an hour and 10 active keys, test keys included, two of
 * them the admin keys. So a run paces its calls, waits out a 429 or a full key count, keeps few
 * keys alive at once, and tags what it makes with its own code; it sweeps what's left, its own
 * when it ends and anyone's stale ones before it starts. That account also holds an address that
 * isn't ours: the tests read and assert only on what they made, and nothing here prints what
 * Pidgeon lists.
 */

/**
 * Node's own fetch, taken before anything replaces it: the pages' offline Clerk fixture refuses
 * every host but loopback, so a suite importing it imports this module first.
 */
const realFetch = globalThis.fetch;

/** The test admin key, when this machine or CI has one; the suite skips without it. */
export const ADMIN_KEY = process.env.PIDGEON_TEST_ADMIN_KEY;
export const admin = () => Redacted.make(ADMIN_KEY ?? "");

/**
 * This run's tag, in every handle, key name and address it makes: CI's run id, so its sweep step
 * finds the same run after a cancel, or six random characters.
 */
export const RUN = `lv${(process.env.PIDGEON_TEST_RUN_ID ?? randomBytes(3).toString("hex"))
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "")
  .slice(0, 16)}`;

/** One request as the harness saw it, for matching faults and counting calls. */
export interface Sent {
  readonly method: string;
  /** Under `/api/v1`. */
  readonly path: string;
  readonly body: string;
}

/** At most one request per this many milliseconds: two runs at once stay under 120 a minute. */
const PACE_MS = 1_250;
/** The longest one call sits out 429s and a full key count before it fails, saying so. */
const MAX_WAIT_S = 240;
/** How long a full key count is waited out before the mint is asked again. */
const KEY_CAP_WAIT_S = 15;
/**
 * The longest a run's tests may use Pidgeon, from when this module loads; CI's job stops at the
 * same mark. After it, only the run's own sweep calls Pidgeon.
 */
const RUN_LIMIT_MS = 20 * 60_000;
const runEnds = Date.now() + RUN_LIMIT_MS;
/** Older than any run can still be using: three run limits. */
const STALE_MS = 3 * RUN_LIMIT_MS;

const faults: Array<{ match: (sent: Sent) => boolean; value: string; times: number }> = [];
/** Every request sent, and what the run made: its keys and its addresses. */
export const sent: Sent[] = [];
export const minted = new Set<string>();
export const created = new Set<string>();

/**
 * Sends `Pidgeon-Test-Fail: value` on the next `times` requests that match. The suite never asks
 * for a 429: every 429 is the shared budget's, which the harness waits out.
 */
export const fail = (match: (sent: Sent) => boolean, value: string, times = 1) => {
  faults.push({ match, value, times });
};
export const route =
  (method: string, path: string | RegExp) =>
  (request: Sent): boolean =>
    request.method === method &&
    (typeof path === "string" ? request.path === path : path.test(request.path));

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

/** Node's fetch, paced, with the faults a test asked for, recording what the run made. */
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
      yield* next;
      sent.push(seen);
      const response = yield* fetch
        .execute(outgoing)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, realFetch));
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
    })
  );
});

/**
 * Seconds to sit out a refusal of the shared budget before asking again: a 429's Retry-After, or
 * a while for the account's full key count to free a slot. Any other refusal is the test's.
 */
const budgetWait = (error: Source.CallError): number | undefined =>
  error._tag !== "PidgeonRateLimited"
    ? undefined
    : error.limit === "requests"
      ? (error.retryAfterSeconds ?? 5)
      : /active keys/i.test(error.details.message)
        ? KEY_CAP_WAIT_S
        : undefined;

/**
 * The production source over that paced fetch, waiting out the shared budget outside the call's
 * own timeout and asking again with the caller's allowance anew, as if the wait never happened.
 * `limited`, it refuses every call once the run's limit has passed, sending nothing.
 */
const waiting = (limited: boolean) =>
  Effect.gen(function* () {
    const inner = yield* Source.make;
    const call: Source.Source["Service"]["call"] = (token, request, deadline) => {
      if (limited && Date.now() > runEnds)
        return Effect.die(
          new Error(`The live Pidgeon run ${RUN} passed its ${RUN_LIMIT_MS / 60_000}-minute limit.`)
        );
      const allowance = Math.max(1_000, deadline - Date.now());
      const attempt = (until: number, waited: number): ReturnType<typeof inner.call> =>
        inner.call(token, request, until).pipe(
          Effect.catch((error) => {
            const seconds = budgetWait(error);
            if (seconds === undefined || waited + seconds > MAX_WAIT_S) return Effect.fail(error);
            return Effect.sleep(Math.ceil(seconds * 1_000) + 250).pipe(
              Effect.andThen(
                Effect.suspend(() => attempt(Date.now() + allowance, waited + seconds))
              )
            );
          })
        );
      return attempt(deadline, 0);
    };
    return Source.Source.of({ call, withSlot: inner.withSlot });
  });

const http = Layer.effect(HttpClient.HttpClient, paced).pipe(Layer.provide(FetchHttpClient.layer));
/** The live tier's Pidgeon, for its tests: nothing after the run's limit. */
export const layer = Layer.effect(Source.Source, waiting(true)).pipe(Layer.provide(http));
/** The same Pidgeon for the sweeps, which may run after the limit to clear up. */
export const sweepLayer = Layer.effect(Source.Source, waiting(false)).pipe(Layer.provide(http));

/**
 * Refuses, before anything changes, a `PIDGEON_TEST_ADMIN_KEY` that isn't a test key: a live
 * key's addresses and keys would be live ones, which no sweep touches. Never says the key.
 */
export const requireTestKey = Effect.gen(function* () {
  const source = yield* Source.Source;
  const answer = yield* source.call(admin(), { method: "GET", path: "/me" }, Date.now() + 60_000);
  const data = Source.data(answer.body);
  const key =
    typeof data === "object" && data !== null && "key" in data && typeof data.key === "object"
      ? data.key
      : null;
  if (key === null || !("test" in key) || key.test !== true)
    return yield* Effect.die(
      new Error(
        "PIDGEON_TEST_ADMIN_KEY isn't a test key. The live tier only runs with a test admin key, so it changed nothing."
      )
    );
});

/** One call as the admin, for what a test sets up or checks itself. */
export const call = Effect.fn("live.call")(function* (
  token: Redacted.Redacted<string>,
  request: Source.Request
) {
  const source = yield* Source.Source;
  return yield* source.call(token, request, Date.now() + 60_000);
});

/** How many requests this run has sent that match. */
export const count = (match: (request: Sent) => boolean) => sent.filter(match).length;

/** Every item of one of Pidgeon's lists, as plain records; never printed. */
const everything = (path: string) =>
  Effect.gen(function* () {
    const source = yield* Source.Source;
    const items: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const page = yield* source.call(
        admin(),
        {
          method: "GET",
          path,
          // Pidgeon's own page size: `/api-keys` refuses a larger limit.
          query: cursor === null ? {} : { cursor }
        },
        Date.now() + 60_000
      );
      const data = Source.data(page.body);
      for (const item of Array.isArray(data) ? data : [])
        if (typeof item === "object" && item !== null) items.push({ ...item });
      const envelope: unknown = page.body;
      cursor =
        typeof envelope === "object" &&
        envelope !== null &&
        "next_cursor" in envelope &&
        typeof envelope.next_cursor === "string"
          ? envelope.next_cursor
          : null;
    } while (cursor !== null);
    return items;
  });

const text = (item: Record<string, unknown>, field: string) =>
  typeof item[field] === "string" ? item[field] : "";
const older = (item: Record<string, unknown>) =>
  Date.now() - Date.parse(text(item, "created_at")) > STALE_MS;

/** One sweep's counts, and what stopped it when it couldn't list. */
export interface Swept {
  readonly keys: number;
  readonly addresses: number;
  readonly problem?: string;
}

/**
 * Revokes keys and deletes test addresses the live tier left: this run's, by its tag, and, when
 * `stale`, anyone's that no run still uses. It only ever touches a key named `Patchy …`, in test
 * mode and below admin: this run's, or a stale one, reaching nothing because its address is gone.
 * It only ever deletes a test address: this run's, or a stale run-tagged one. Never a live
 * address, an admin key or a key Patchy didn't name. Stale means older than any run can still be
 * using, three run limits.
 */
export const sweep = (stale: boolean) =>
  Effect.gen(function* () {
    const source = yield* Source.Source;
    const until = () => Date.now() + 60_000;
    let keys = 0;
    let addresses = 0;
    // Addresses first, so a key that reached one reaches nothing by the time keys are listed.
    for (const identity of yield* everything("/identities")) {
      const local = text(identity, "local_part");
      if (identity.test !== true) continue;
      const ours = local.startsWith(`patchy-${RUN}-`);
      const left = stale && /^patchy-lv[a-z0-9]+-/.test(local) && older(identity);
      if (!(ours || left)) continue;
      const deleted = yield* source
        .call(admin(), { method: "DELETE", path: `/identities/${text(identity, "id")}` }, until())
        .pipe(Effect.option);
      if (deleted._tag === "Some") addresses++;
    }
    for (const key of yield* everything("/api-keys")) {
      const name = text(key, "name");
      // Never anything but a test key Patchy named, below admin: never an admin key, ours or not.
      if (
        key.revoked_at !== null ||
        !name.startsWith("Patchy ") ||
        key.test !== true ||
        !(key.access === "read" || key.access === "draft" || key.access === "send")
      )
        continue;
      const ours = name.startsWith(`Patchy ${RUN}-`);
      const dead =
        stale && Array.isArray(key.identity_ids) && key.identity_ids.length === 0 && older(key);
      if (!(ours || dead)) continue;
      const revoked = yield* source
        .call(admin(), { method: "DELETE", path: `/api-keys/${text(key, "id")}` }, until())
        .pipe(Effect.option);
      if (revoked._tag === "Some") keys++;
    }
    const swept: Swept = { keys, addresses };
    return swept;
  }).pipe(
    // A sweep that couldn't list says so by the refusal's name, never its words or what it listed.
    Effect.catch((error) => Effect.succeed<Swept>({ keys: 0, addresses: 0, problem: error._tag }))
  );

const told = (swept: Swept, what: string) =>
  swept.problem === undefined
    ? `${swept.keys} ${what}keys and ${swept.addresses} ${what}addresses`
    : `nothing (${swept.problem})`;

/** What a run cost the account's shared budgets, and what the sweeps took: counts only. */
export const summary = (swept: { readonly before: Swept; readonly after: Swept }) =>
  console.log(
    `Pidgeon live run ${RUN}: ${sent.length} calls, ${minted.size} keys minted; swept ${told(swept.before, "stale ")} before, ${told(swept.after, "")} after.`
  );
