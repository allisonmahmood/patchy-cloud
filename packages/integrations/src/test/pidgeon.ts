import type { PidgeonSnapshot } from "@patchy/api";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import * as CredentialKeys from "../CredentialKeys.js";
import * as Source from "../pidgeon/Source.js";

/**
 * Offline Pidgeon for the tests that need no Pidgeon: a saved connection written straight into
 * the database, and a transport that answers only what Patchy's own logic sends once a key is
 * saved, a revoke or a read. Anything about what Pidgeon does is the live tier's
 * (`packages/integrations/live`), against Pidgeon's test mode.
 */

/** One request the canned transport saw. */
export interface Sent {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
}

/** Matches requests by method and path under `/api/v1`, such as `DELETE /api-keys/k1`. */
export const route =
  (method: string, path: string | RegExp) =>
  (sent: Sent): boolean =>
    sent.method === method &&
    (typeof path === "string" ? sent.path === path : path.test(sent.path));

/**
 * The production source over a transport that revokes any key (200) and answers any read with an
 * empty page, holding a request a test asked it to until released. It answers nothing else.
 */
export const canned = () => {
  const requests: Sent[] = [];
  const holds: Array<{
    match: (sent: Sent) => boolean;
    release: Deferred.Deferred<void>;
    times: number;
  }> = [];
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const sent: Sent = {
        method: request.method,
        path: url.pathname.replace(/^\/api\/v1/, ""),
        authorization: request.headers.authorization
      };
      requests.push(sent);
      const index = holds.findIndex((hold) => hold.match(sent));
      if (index !== -1) {
        const hold = holds[index]!;
        if (--hold.times === 0) holds.splice(index, 1);
        yield* Deferred.await(hold.release);
      }
      const body =
        sent.method === "DELETE"
          ? { data: { revoked: true } }
          : sent.method === "GET"
            ? { data: [], has_more: false, next_cursor: null }
            : undefined;
      return HttpClientResponse.fromWeb(
        request,
        body === undefined
          ? new Response(JSON.stringify({ error: { code: "internal", message: "Not canned." } }), {
              status: 500
            })
          : Response.json(body)
      );
    })
  );
  return {
    requests,
    /** Holds the next `times` requests that match until `release` completes. */
    hold: (match: (sent: Sent) => boolean, release: Deferred.Deferred<void>, times = 1) => {
      holds.push({ match, release, times });
    },
    layer: Layer.effect(Source.Source, Source.make).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http))
    )
  };
};

/** One request as Patchy built it: everything a test of the request compares. */
export interface Built extends Sent {
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly idempotencyKey: string | undefined;
}

/** An answer recorded from Pidgeon, for the requests it matches. */
export interface Recorded {
  readonly match: (sent: Built) => boolean;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * The production source over answers recorded from Pidgeon, for what Patchy sends and how it
 * reads an answer: each request gets the first answer that matches it, and anything else a 500.
 * It decides nothing Pidgeon decides, such as idempotency or what a key reaches: those are the
 * live tier's. A test can hold matching requests until it releases them.
 */
export const recorded = (answers: ReadonlyArray<Recorded>) => {
  const requests: Built[] = [];
  const holds: Array<{
    match: (sent: Built) => boolean;
    release: Deferred.Deferred<void>;
    times: number;
  }> = [];
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const sent: Built = {
        method: request.method,
        path: url.pathname.replace(/^\/api\/v1/, ""),
        authorization: request.headers.authorization,
        query: Object.fromEntries(url.searchParams),
        body:
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
        idempotencyKey: request.headers["idempotency-key"]
      };
      requests.push(sent);
      const index = holds.findIndex((hold) => hold.match(sent));
      if (index !== -1) {
        const hold = holds[index]!;
        if (--hold.times === 0) holds.splice(index, 1);
        yield* Deferred.await(hold.release);
      }
      const answer = answers.find((item) => item.match(sent));
      return HttpClientResponse.fromWeb(
        request,
        answer === undefined
          ? Response.json(
              { error: { code: "internal", message: "Not recorded." } },
              { status: 500 }
            )
          : Response.json(answer.body, { status: answer.status ?? 200, headers: answer.headers })
      );
    })
  );
  return {
    requests,
    /** Holds the next `times` requests that match until `release` completes. */
    hold: (match: (sent: Built) => boolean, release: Deferred.Deferred<void>, times = 1) => {
      holds.push({ match, release, times });
    },
    layer: Layer.effect(Source.Source, Source.make).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http))
    )
  };
};

/** A Pidgeon connection as connect saves one, written straight into the database. */
export const seed = Effect.fn("PidgeonTest.seed")(function* (input: {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly handle: string;
  readonly test?: boolean;
  readonly access?: "read" | "send";
  /** Old keys not yet revoked, as Replace key leaves them. */
  readonly retired?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* CredentialKeys.CredentialKeys;
  const test = input.test ?? false;
  const access = input.access ?? "send";
  const email = `${input.handle}@acme.example`;
  const identityId = `idn-${input.id}`;
  const key = {
    id: `key-${input.id}`,
    token: `pgn_${test ? "test" : "live"}_seeded${input.id.replace(/[^A-Za-z0-9]/g, "")}`
  };
  const retired = input.retired ?? [];
  const display: Source.Display = {
    email,
    identityId,
    sendPolicy: "reply_only",
    access,
    test,
    key: {
      id: key.id,
      name: `Patchy ${input.handle} seededseed01`,
      madeAt: "2026-10-26T00:00:00.000Z"
    },
    ...(retired.length === 0 ? {} : { retired })
  };
  const credentials: Source.Credentials = {
    identityId,
    key,
    ...(retired.length === 0
      ? {}
      : {
          retired: retired.map((item) => ({
            id: item.id,
            token: `pgn_live_retired${item.id.replace(/[^A-Za-z0-9]/g, "")}`
          }))
        })
  };
  const encrypted = yield* keys.encrypt(
    { companyId: input.companyId, id: input.id, integration: "pidgeon" },
    Source.credentials(credentials)
  );
  const snapshot: PidgeonSnapshot = {
    version: 1,
    address: { email, displayName: null, sendPolicy: "reply_only" },
    access,
    test,
    labels: [
      { id: "lbl-1", name: "Billing", colour: "amber" },
      { id: "lbl-2", name: "Bugs", colour: "red" }
    ],
    plan: "free"
  };
  yield* sql`INSERT INTO connections
    (id, company_id, integration, handle, description, mode, status, display, credentials, key_id,
     credential_revision, metadata_revision, created_by, last_tested_at, last_discovered_at)
    VALUES (${input.id}, ${input.companyId}, 'pidgeon', ${input.handle}, 'Customer questions',
      'company', 'connected', ${JSON.stringify(display)}::jsonb, ${encrypted.credentials},
      ${encrypted.keyId}, 1, 1, ${input.userId}, now(), now())`;
  yield* sql`INSERT INTO connection_snapshots
    (company_id, connection_id, integration, revision, snapshot, created_at)
    VALUES (${input.companyId}, ${input.id}, 'pidgeon', 1, ${JSON.stringify(snapshot)}::jsonb, now())`;
  return { key, display, credentials };
});

/**
 * A tier 2 support desk, the same offline and live. `answer` finds the open conversation with
 * `subject`, reads it to the end and its first attachment's text, replies to its newest message
 * with the draft key the page made, and marks it waiting. `forced` writes through `invoices`, a
 * read connection, and `peek` writes from a read-only action: the host refuses both.
 */
export const desk = {
  source: `import { action, createGuest, t } from "patchy/server";
const answer = action({
  args: { subject: t.text(), draft: t.text(), text: t.text() },
  result: t.json(),
  handler: async (ctx, { subject, draft, text }) => {
    const inbox = ctx.connections.support;
    const { threads } = await inbox.threads.list({ status: "open", cursor: undefined });
    const thread = threads.find((item) => item.subject === subject);
    if (thread === undefined) return { found: false };
    const messages = [];
    let cursor;
    do {
      const page = await inbox.threads.get(thread.id, { cursor });
      messages.push(...page.messages);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    const file = messages.flatMap((message) => message.attachments)[0];
    const receipt = file === undefined ? null : (await inbox.attachments.text(file.id)).text;
    const repliedTo = messages.at(-1).id;
    const sent = await inbox.messages.reply(repliedTo, { text, idempotencyKey: draft });
    const after = await inbox.threads.update(thread.id, { status: "waiting" });
    return { found: true, threadId: thread.id, messages: messages.length, receipt, repliedTo, sent, status: after.status };
  }
});
const forced = action({ args: {}, result: t.json(), handler: async (ctx) =>
  ctx.connections.invoices.messages.reply("msg_1", { text: "Hi", idempotencyKey: "desk-forced-01" })
});
const peek = action({ readOnly: true, args: {}, result: t.json(), handler: async (ctx) =>
  ctx.connections.support.messages.reply("msg_1", { text: "Hi", idempotencyKey: "desk-peek-0001" })
});
export default createGuest({ desk: { answer, forced, peek } }, [], {}, ["support", "invoices"]);
`,
  handlers: {
    "desk.answer": {
      kind: "action",
      args: { subject: { kind: "text" }, draft: { kind: "text" }, text: { kind: "text" } },
      result: { kind: "json" }
    },
    "desk.forced": { kind: "action", args: {}, result: { kind: "json" } },
    "desk.peek": { kind: "action", readOnly: true, args: {}, result: { kind: "json" } }
  }
} as const;
