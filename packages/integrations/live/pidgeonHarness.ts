// @effect-diagnostics nodeBuiltinImport:off — node:crypto draws the run's tag.
import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Source from "../src/pidgeon/Source.js";

/**
 * The live tier's Pidgeon: pidgeon.ai in test mode, with the account's test keys. One account
 * serves every run and every developer's dev environment, and its request budget is shared, so a
 * run paces its calls and waits out a 429. A run makes its own inboxes, named with its tag, records
 * each id as it's made, and deletes what it made when it ends; before it starts it deletes stale
 * run-tagged inboxes nobody can still be using. That account also holds an inbox that isn't the
 * tier's: the tests read and assert only on what they made, never change anything else, and
 * nothing here prints what Pidgeon lists.
 */

/**
 * Node's own fetch, taken before anything replaces it: the pages' offline Clerk fixture refuses
 * every host but loopback, so a suite importing it imports this module first.
 */
const realFetch = globalThis.fetch;

/**
 * The test admin key, when this machine or CI has one; the suite skips without it. The Send and
 * Read keys, made in Pidgeon's dashboard as an admin would, are what connections paste; the level
 * checks that need them skip without them.
 */
export const ADMIN_KEY = process.env.PIDGEON_TEST_ADMIN_KEY;
export const SEND_KEY = process.env.PIDGEON_TEST_SEND_KEY || undefined;
export const READ_KEY = process.env.PIDGEON_TEST_READ_KEY || undefined;
export const admin = () => Redacted.make(ADMIN_KEY ?? "");
/** The key a connection that sends pastes: the Send key, or the admin key without one. */
export const sender = () => SEND_KEY ?? ADMIN_KEY ?? "";

/**
 * This run's tag, in every handle and inbox it makes: CI's run id, so its sweep step finds the
 * same run after a cancel, or six random characters.
 */
export const RUN = `lv${(process.env.PIDGEON_TEST_RUN_ID ?? randomBytes(3).toString("hex"))
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "")
  .slice(0, 16)}`;
/** Every inbox the tier makes is named `patchy-<run>-…`. */
const PREFIX = `patchy-${RUN}-`;

/** One request as the harness saw it, for counting calls. */
export interface Sent {
  readonly method: string;
  /** Under `/v1`. */
  readonly path: string;
}

/** At most one request per this many milliseconds, so runs sharing the account stay polite. */
const PACE_MS = 250;
/** The longest one call sits out 429s before it fails, saying so. */
const MAX_WAIT_S = 240;
/**
 * The longest a run's tests may use Pidgeon, from when this module loads; CI's job stops at the
 * same mark. After it, only the run's own sweep calls Pidgeon.
 */
const RUN_LIMIT_MS = 20 * 60_000;
const runEnds = Date.now() + RUN_LIMIT_MS;
/** Older than any run can still be using: three run limits. */
const STALE_MS = 3 * RUN_LIMIT_MS;

/** Every request sent, and the inboxes this run made, by id. */
export const sent: Sent[] = [];
export const created = new Set<string>();

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

/** Node's fetch, paced, recording what the run sent. */
const paced = Effect.gen(function* () {
  const fetch = yield* HttpClient.HttpClient;
  return HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      yield* next;
      sent.push({ method: request.method, path: url.pathname.replace(/^\/v1/, "") });
      const response = yield* fetch
        .execute(request)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, realFetch));
      const text = response.status === 204 ? null : yield* response.text;
      return HttpClientResponse.fromWeb(
        request,
        new Response(text, { status: response.status, headers: new Headers(response.headers) })
      );
    })
  );
});

/**
 * The production source over that paced fetch, waiting out a 429 outside the call's own timeout
 * and asking again with the caller's allowance anew. `limited`, it refuses every call once the
 * run's limit has passed, sending nothing.
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
            const seconds =
              error._tag === "PidgeonRateLimited" && error.limit === "requests"
                ? (error.retryAfterSeconds ?? 5)
                : undefined;
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
 * Refuses, before anything changes, a key that isn't a test key: a live key's mail would leave
 * Pidgeon. Never says the key.
 */
export const requireTestKey = Effect.suspend(() =>
  [ADMIN_KEY, SEND_KEY, READ_KEY].every((key) => key === undefined || Source.isTestToken(key))
    ? Effect.void
    : Effect.die(
        new Error(
          "A PIDGEON_TEST_*_KEY isn't a test key. The live tier only runs with test keys, so it changed nothing."
        )
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

const Inbox = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  created_at: Schema.String
});
const decodeInbox = Schema.decodeUnknownOption(Inbox);
const Inboxes = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  next_cursor: Schema.NullOr(Schema.String)
});
const decodeInboxes = Schema.decodeUnknownOption(Inboxes);

/** Every inbox the account has, as far as the harness reads one; never printed. */
const inboxes = Effect.gen(function* () {
  const found: Array<typeof Inbox.Type> = [];
  let cursor: string | null = null;
  do {
    const page = decodeInboxes(
      (yield* call(admin(), {
        method: "GET",
        path: "/email/inboxes",
        query: { limit: 100, ...(cursor === null ? {} : { cursor }) }
      })).body
    );
    if (Option.isNone(page)) return yield* new Source.Unavailable({ stage: "response" });
    for (const item of page.value.data) {
      const inbox = decodeInbox(item);
      if (Option.isSome(inbox)) found.push(inbox.value);
    }
    cursor = page.value.next_cursor === cursor ? null : page.value.next_cursor;
  } while (cursor !== null);
  return found;
});

/** A refusal by its name, and the status Pidgeon answered, never Pidgeon's words or a key. */
const named = (error: Source.CallError) =>
  error._tag === "PidgeonUnavailable" && error.upstreamStatus !== undefined
    ? `${error._tag} ${error.upstreamStatus}`
    : error._tag;

/**
 * Makes one of the run's own inboxes, `patchy-<run>-<name>@pidgeon.email`, with the admin key,
 * recording its id. An answer lost on the way back is found again by its name, so names are
 * fixed. Every live file shares the run's tag, as CI gives all of them one, and Pidgeon never
 * gives a deleted address out again, so each file's names carry the file: `connect-desk`,
 * `ops-desk`.
 */
export const inbox = Effect.fn("live.inbox")(function* (name: string, displayName?: string) {
  const address = `${PREFIX}${name}@pidgeon.email`;
  const made = yield* call(admin(), {
    method: "POST",
    path: "/email/inboxes",
    body: {
      name: `${PREFIX}${name}`,
      kind: "agent",
      ...(displayName === undefined ? {} : { display_name: displayName })
    }
  }).pipe(
    Effect.map((answer) => decodeInbox(answer.body)),
    Effect.mapError(named),
    Effect.result
  );
  const answered = made._tag === "Success" ? made.success : Option.none<typeof Inbox.Type>();
  const found = Option.isSome(answered)
    ? answered.value
    : (yield* inboxes).find((item) => item.address === address);
  if (found === undefined || found.address !== address)
    return yield* Effect.die(
      new Error(
        `Pidgeon didn't make the run's inbox ${name}: ${made._tag === "Failure" ? `it answered ${made.failure}` : "its answer wasn't an inbox of that name"}.`
      )
    );
  created.add(found.id);
  return found;
});

/**
 * Delivers test mail from outside to one of the run's own inboxes, as Pidgeon's test mode lets a
 * test key: the message's id and whether the firewall held it.
 */
export const inbound = Effect.fn("live.inbound")(function* (
  inboxId: string,
  mail: {
    readonly from: string;
    readonly subject: string;
    readonly text: string;
    readonly html?: string;
    readonly inReplyTo?: string;
  }
) {
  if (!created.has(inboxId))
    return yield* Effect.die(new Error("The live tier only mails inboxes its own run made."));
  const answer = yield* call(admin(), {
    method: "POST",
    path: "/email/test/inbound",
    body: {
      inbox_id: inboxId,
      from: mail.from,
      from_name: "A customer",
      subject: mail.subject,
      text: mail.text,
      ...(mail.html === undefined ? {} : { html: mail.html }),
      ...(mail.inReplyTo === undefined ? {} : { in_reply_to: mail.inReplyTo })
    }
  });
  const body = answer.body as { readonly message_id?: string; readonly outcome?: string };
  if (typeof body.message_id !== "string")
    return yield* Effect.die(new Error("Pidgeon didn't deliver the run's test mail."));
  return { messageId: body.message_id, held: body.outcome === "held" };
});

/** How many requests this run has sent that match. */
export const count = (match: (request: Sent) => boolean) => sent.filter(match).length;
export const route =
  (method: string, path: string | RegExp) =>
  (request: Sent): boolean =>
    request.method === method &&
    (typeof path === "string" ? request.path === path : path.test(request.path));

/**
 * One sweep's counts: what it deleted, the deletions that failed, how many of those were this
 * run's own, and what stopped it when it couldn't list.
 */
export interface Swept {
  readonly inboxes: number;
  readonly failed: number;
  readonly left: number;
  readonly problem?: string;
}

/**
 * Deletes inboxes the live tier left: this run's, by the ids it recorded and its tag, and, when
 * `stale`, run-tagged ones older than any run can still be using, three run limits. It only ever
 * deletes an inbox named `patchy-lv…-` on pidgeon.email: never the account's own inbox, nor any
 * other. A deletion that fails doesn't stop the rest; it's counted, and `left` says how many of
 * the run's own are still there.
 */
export const sweep = (stale: boolean) =>
  Effect.gen(function* () {
    const source = yield* Source.Source;
    let deleted = 0;
    let failed = 0;
    let left = 0;
    for (const found of yield* inboxes) {
      const local = found.address.endsWith("@pidgeon.email")
        ? found.address.slice(0, -"@pidgeon.email".length)
        : "";
      const ours = local.startsWith(PREFIX) || created.has(found.id);
      const old =
        stale &&
        /^patchy-lv[a-z0-9]+-/.test(local) &&
        Date.now() - Date.parse(found.created_at) > STALE_MS;
      if (!(local.startsWith("patchy-lv") && (ours || old))) continue;
      const gone = yield* source
        .call(
          admin(),
          { method: "DELETE", path: `/email/inboxes/${encodeURIComponent(found.id)}` },
          Date.now() + 60_000
        )
        .pipe(
          Effect.asVoid,
          // Gone already, as when a test deleted it: done all the same.
          Effect.catchTags({ PidgeonNotFound: () => Effect.void }),
          Effect.option
        );
      if (Option.isSome(gone)) {
        deleted++;
        created.delete(found.id);
      } else {
        failed++;
        if (ours) left++;
      }
    }
    const swept: Swept = { inboxes: deleted, failed, left };
    return swept;
  }).pipe(
    // A sweep that couldn't list says so by the refusal's name, never its words or what it listed.
    Effect.catch((error) =>
      Effect.succeed<Swept>({ inboxes: 0, failed: 0, left: 0, problem: error._tag })
    )
  );

/**
 * Fails, saying how many, when a sweep couldn't delete an inbox it meant to, the run's own or an
 * earlier run's stale one, or couldn't list them to tell: nothing in Pidgeon expires them.
 */
export const requireSwept = (swept: Swept) =>
  swept.problem !== undefined
    ? Effect.die(
        new Error(`Pidgeon run ${RUN}'s sweep couldn't list its inboxes (${swept.problem}).`)
      )
    : swept.failed > 0
      ? Effect.die(
          new Error(
            `Pidgeon run ${RUN}'s sweep couldn't delete ${swept.failed} ${swept.failed === 1 ? "inbox" : "inboxes"}${swept.left === 0 ? "" : `, ${swept.left} of them its own`}.`
          )
        )
      : Effect.void;

const told = (swept: Swept, what: string) =>
  swept.problem === undefined
    ? `${swept.inboxes} ${what}inboxes${swept.failed === 0 ? "" : ` (${swept.failed} failed to delete)`}`
    : `nothing (${swept.problem})`;

/** What a run cost the account's shared budget, and what the sweeps took: counts only. */
export const summary = (swept: { readonly before: Swept; readonly after: Swept }) =>
  console.log(
    `Pidgeon live run ${RUN}: ${sent.length} calls; swept ${told(swept.before, "stale ")} before, ${told(swept.after, "")} after.`
  );

/**
 * A live file's cleanup, as a layer: refuses keys that aren't test keys, then sweeps stale
 * leftovers of any run before the tests; after them, however they ended, sweeps everything this
 * run made and fails the file when any of it is left.
 */
export const cleanup = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* requireTestKey;
    const before = yield* sweep(true);
    yield* Effect.addFinalizer(() =>
      sweep(false).pipe(
        Effect.tap((after) => Effect.sync(() => summary({ before, after }))),
        Effect.flatMap(requireSwept)
      )
    );
  })
).pipe(Layer.provide(sweepLayer));
