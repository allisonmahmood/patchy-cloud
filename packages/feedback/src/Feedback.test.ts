import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Analytics } from "@patchy/analytics";
import * as WideEvents from "@patchy/analytics/wide-events";
import { SubmissionId } from "@patchy/api";
import { NodeCryptography } from "@patchy/core";
import { Limits, OperatingLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Feedback from "./Feedback.js";

const events: Analytics.AnalyticsEvent[] = [];
const recording = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
);
const wide: WideEvents.WideEvent[] = [];
const sink = Layer.succeed(WideEvents.Sink)(
  WideEvents.Sink.of({ write: (event) => Effect.sync(() => void wide.push(event)) })
);

const layer = Layer.mergeAll(
  Feedback.layer,
  WideEvents.layerWithSink.pipe(Layer.provide(sink))
).pipe(
  Layer.provideMerge(Layer.mergeAll(Limits.layer, OperatingLimits.layer, recording)),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(Layer.mergeAll(NodeCryptography.layer, NodeCrypto.layer))
);

/** A company with two people, and the ways each of them sends. */
const company = Effect.fn("company")(function* (handle: string) {
  const sql = yield* SqlClient.SqlClient;
  const companyId = `cmp_${handle}`;
  yield* sql`INSERT INTO companies (id, handle, name) VALUES (${companyId}, ${handle}, ${handle})`;
  const person = (key: string) =>
    Effect.gen(function* () {
      const userId = `usr_${handle}_${key}`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES (${userId}, ${`clerk_${handle}_${key}`}, ${companyId},
          ${`${key}@${handle}.example`}, ${key}, 'member')`;
      const me = { userId, companyId };
      return {
        ...me,
        cli: {
          ...me,
          surface: "cli",
          agent: "claude-code",
          cliVersion: "0.34.0",
          patchId: null
        } satisfies Feedback.Sender,
        mcp: { ...me, surface: "mcp", agent: "Claude" } satisfies Feedback.Sender,
        dashboard: { ...me, surface: "dashboard" } satisfies Feedback.Sender
      };
    });
  return { id: companyId, ada: yield* person("ada"), ben: yield* person("ben") };
});

const general = Effect.fn("general")(function* (
  title: string,
  status: "open" | "planned" | "shipped" | "declined",
  note: string | null = null
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ id: string }>`
    INSERT INTO feedback.general_requests (title, status, note) VALUES (${title}, ${status}, ${note})
    RETURNING id`;
  return row!.id;
});

const stored = (id: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<Record<string, unknown>>`
    SELECT id, kind, text, why, surface, agent, cli_version AS "cliVersion", patch_id AS "patchId",
      link_request_id AS "linkRequestId", link_general_id AS "linkGeneralId", link_why AS "linkWhy"
    FROM feedback.submissions WHERE id = ${id}`
  );

const isSubmissionId = Schema.is(SubmissionId);

const send = Effect.fn("send")(function* (sender: Feedback.Sender, text: string, why?: string) {
  return yield* (yield* Feedback.Feedback).sendRequest({ sender, text, ...(why ? { why } : {}) });
});

it.layer(layer)("requests and feedback", (it) => {
  it.effect(
    "a request in one company is matched to its own similar requests and Patchy's general ones, never another company's",
    () =>
      Effect.gen(function* () {
        const a = yield* company("aes");
        const b = yield* company("rsa");
        const options = yield* general(
          "Postgres encryption options",
          "shipped",
          "Every Postgres connection is encrypted with TLS; ask for anything more here."
        );
        const theirs = yield* send(
          a.ada.cli,
          "Postgres connection encrypted with AES",
          "Compliance"
        );
        const tls = yield* send(b.ben.cli, "Postgres connections over TLS only");
        yield* send(b.ben.cli, "Slack integration");

        const filed = yield* send(
          b.ada.cli,
          "Postgres connection encrypted with RSA",
          "Our auditors"
        );
        assert.deepStrictEqual(
          [...filed.similar].sort((x, y) => x.id.localeCompare(y.id)),
          [
            {
              id: options,
              title: "Postgres encryption options",
              status: "shipped",
              note: "Every Postgres connection is encrypted with TLS; ask for anything more here."
            },
            { id: tls.id, title: "Postgres connections over TLS only", status: "open" }
          ].sort((x, y) => x.id.localeCompare(y.id))
        );
        assert.notInclude(JSON.stringify(filed), theirs.id);
        assert.notInclude(JSON.stringify(filed), "AES");
        // The new request is never its own match; feedback matches nothing.
        assert.notInclude(JSON.stringify(filed.similar), filed.id);
        yield* (yield* Feedback.Feedback).sendFeedback({
          sender: b.ada.cli,
          text: "Postgres connection encrypted with RSA would be nice"
        });
        assert.lengthOf(
          (yield* send(b.ben.cli, "Postgres connection encrypted with RSA")).similar,
          3
        );
      })
  );

  it.effect("ranks by shared words, keeps the top three and leaves out a lone common word", () =>
    Effect.gen(function* () {
      const c = yield* company("ranks");
      yield* send(c.ada.cli, "Slack integration");
      const long = yield* send(
        c.ben.cli,
        "Gmail integration that sends weekly digest emails to customers"
      );
      assert.deepStrictEqual(long.similar, []);
      const short = yield* send(c.ben.cli, "Gmail integration");
      assert.deepStrictEqual(
        short.similar.map(({ title }) => title),
        ["Gmail integration that sends weekly digest emails to customers", "Slack integration"]
      );
    })
  );

  it.effect(
    "a match takes the status of the general request it links straight to; links don't chain",
    () =>
      Effect.gen(function* () {
        const c = yield* company("status");
        const feedback = yield* Feedback.Feedback;
        const planned = yield* general("Webhooks for patches", "planned");
        const linked = yield* send(c.ada.cli, "Webhooks when a row changes");
        yield* feedback.link({ sender: c.ada.cli, id: linked.id, to: planned });
        const chained = yield* send(c.ada.cli, "Webhooks on publish");
        yield* feedback.link({ sender: c.ada.cli, id: chained.id, to: linked.id });

        const filed = yield* send(c.ben.cli, "Webhooks please");
        const status = Object.fromEntries(filed.similar.map(({ id, status }) => [id, status]));
        assert.deepStrictEqual(status, {
          [planned]: "planned",
          [linked.id]: "planned",
          [chained.id]: "open"
        });
      })
  );

  it.effect("mints request and feedback ids of the shape the CLI checks before calling", () =>
    Effect.gen(function* () {
      const c = yield* company("ids");
      const filed = yield* send(c.ada.cli, "Gmail integration");
      const sent = yield* (yield* Feedback.Feedback).sendFeedback({
        sender: c.ada.cli,
        text: "Publish was slow"
      });
      assert.match(filed.id, /^req_/);
      assert.match(sent.id, /^fbk_/);
      assert.isTrue(isSubmissionId(filed.id) && isSubmissionId(sent.id));
    })
  );

  it.effect("records who sent it and through what, and only a patch of the sender's company", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const c = yield* company("senders");
      const other = yield* company("elsewhere");
      for (const [id, owner] of [
        ["senders00001", c.ada],
        ["elsewhere001", other.ada]
      ] as const)
        yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
          VALUES (${id}, ${owner.companyId}, ${owner.userId}, 'CRM', ${`crm-${id.slice(0, 5)}`})`;
      const feedback = yield* Feedback.Feedback;

      const own = yield* send({ ...c.ada.cli, patchId: "senders00001" }, "Gmail integration");
      const foreign = yield* send({ ...c.ada.cli, patchId: "elsewhere001" }, "Gmail integration");
      const mcp = yield* feedback.sendFeedback({ sender: c.ada.mcp, text: "  Odd refusal  " });
      const dashboard = yield* send(c.ada.dashboard, "  Gmail\n  integration ", "  Sales  ");
      const rows = [own, foreign, mcp, dashboard].map(({ id }) => stored(id));
      assert.deepStrictEqual(
        (yield* Effect.all(rows)).map(([row]) => row),
        [
          {
            id: own.id,
            kind: "request",
            text: "Gmail integration",
            why: null,
            surface: "cli",
            agent: "claude-code",
            cliVersion: "0.34.0",
            patchId: "senders00001",
            linkRequestId: null,
            linkGeneralId: null,
            linkWhy: null
          },
          {
            id: foreign.id,
            kind: "request",
            text: "Gmail integration",
            why: null,
            surface: "cli",
            agent: "claude-code",
            cliVersion: "0.34.0",
            patchId: null,
            linkRequestId: null,
            linkGeneralId: null,
            linkWhy: null
          },
          {
            id: mcp.id,
            kind: "feedback",
            text: "Odd refusal",
            why: null,
            surface: "mcp",
            agent: "Claude",
            cliVersion: null,
            patchId: null,
            linkRequestId: null,
            linkGeneralId: null,
            linkWhy: null
          },
          {
            id: dashboard.id,
            kind: "request",
            text: "Gmail integration",
            why: "Sales",
            surface: "dashboard",
            agent: null,
            cliVersion: null,
            patchId: null,
            linkRequestId: null,
            linkGeneralId: null,
            linkWhy: null
          }
        ]
      );
      assert.match(own.id, /^req_[a-z0-9]{24}$/);
      assert.match(mcp.id, /^fbk_[a-z0-9]{24}$/);
    })
  );

  it.effect(
    "refuses a credential in any field, naming the field and kind, and stores nothing",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const c = yield* company("secrets");
        const feedback = yield* Feedback.Feedback;
        const token = ["gh", "p_", "a1B2".repeat(9)].join("");
        const refused = yield* send(c.ada.cli, `Sync breaks with ${token}`).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "ContainsSecret");
        assert.deepInclude(refused, {
          secrets: [{ field: "text", kind: "github_token", label: "a GitHub token" }]
        });
        assert.strictEqual(
          refused.message,
          "Nothing was stored: `text` holds a GitHub token. Remove it, or replace it with <token>, and send it again."
        );
        assert.notInclude(refused.message, token);
        const [counted] = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM feedback.submissions WHERE company_id = ${c.id}`;
        assert.strictEqual(counted?.count, "0");

        const filed = yield* send(c.ada.cli, "Gmail integration");
        const linkWhy = yield* feedback
          .link({ sender: c.ada.cli, id: filed.id, to: filed.id, why: `same as ${token}` })
          .pipe(Effect.flip);
        assert.deepInclude(linkWhy, {
          secrets: [{ field: "why", kind: "github_token", label: "a GitHub token" }]
        });
        const note = yield* feedback
          .sendFeedback({ sender: c.ada.cli, text: `postgres://app:hunter2@db.internal/app` })
          .pipe(Effect.flip);
        assert.deepInclude(note, {
          secrets: [{ field: "text", kind: "url_password", label: "a password in a URL" }]
        });
      })
  );

  it.effect("bounds each field before checking it", () =>
    Effect.gen(function* () {
      const c = yield* company("bounds");
      const feedback = yield* Feedback.Feedback;
      const refusals = [
        yield* send(c.ada.cli, " ab ").pipe(Effect.flip),
        yield* send(c.ada.cli, "x".repeat(201)).pipe(Effect.flip),
        yield* send(c.ada.cli, "Gmail", "x".repeat(4_001)).pipe(Effect.flip),
        yield* send(c.ada.cli, "Gmail\u0000integration").pipe(Effect.flip),
        yield* feedback.sendFeedback({ sender: c.ada.cli, text: "  " }).pipe(Effect.flip)
      ];
      assert.deepStrictEqual(
        refusals.map((error) =>
          error._tag === "InvalidText" ? [error.field, error.message] : error._tag
        ),
        [
          [
            "text",
            "Nothing was stored: `text` must be 3–200 characters, with no control characters."
          ],
          [
            "text",
            "Nothing was stored: `text` must be 3–200 characters, with no control characters."
          ],
          [
            "why",
            "Nothing was stored: `why` must be 1–4,000 characters, with no control characters."
          ],
          [
            "text",
            "Nothing was stored: `text` must be 3–200 characters, with no control characters."
          ],
          [
            "text",
            "Nothing was stored: `text` must be 1–4,000 characters, with no control characters."
          ]
        ]
      );
      // A title at the bound, in characters rather than code units, is stored.
      yield* send(c.ada.cli, "🙂".repeat(200), "x".repeat(4_000));
    })
  );

  it.effect(
    "a person sends ten a minute across kinds and surfaces; linking, listing and withdrawing spend none",
    () =>
      Effect.gen(function* () {
        // Past every window earlier tests opened: the limiter's clock never steps back.
        yield* TestClock.setTime(Date.parse("2030-01-01T00:00:00Z"));
        const c = yield* company("limited");
        const feedback = yield* Feedback.Feedback;
        const first = yield* send(c.ada.cli, "Gmail integration");
        for (let index = 1; index < 10; index++)
          yield* index % 2 === 0
            ? send(c.ada.mcp, `Request ${index}`)
            : feedback.sendFeedback({ sender: c.ada.dashboard, text: `Feedback ${index}` });

        const limited = yield* feedback
          .sendFeedback({ sender: c.ada.cli, text: "One more" })
          .pipe(Effect.flip);
        assert.deepInclude(limited, { _tag: "SendLimited", limit: 10, retryAfterSeconds: 60 });
        // Someone else at the company still sends, and the limited person still manages theirs.
        yield* send(c.ben.cli, "Slack integration");
        const options = yield* general("Email integrations", "open");
        yield* feedback.link({ sender: c.ada.cli, id: first.id, to: options });
        yield* feedback.unlink({ person: c.ada, id: first.id });
        assert.lengthOf((yield* feedback.list({ person: c.ada })).submissions, 10);
        yield* feedback.withdraw({ person: c.ada, id: first.id });

        yield* TestClock.adjust("1 minute");
        yield* send(c.ada.cli, "Gmail integration");
      })
  );

  it.effect(
    "links a person's own request to a company request or a general one, and nothing else",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const c = yield* company("links");
        const other = yield* company("outside");
        const feedback = yield* Feedback.Feedback;
        const mine = yield* send(c.ada.cli, "RSA for Postgres");
        const colleagues = yield* send(c.ben.cli, "Postgres encryption with AES");
        const foreign = yield* send(other.ada.cli, "Postgres encryption with RSA");
        const note = yield* feedback.sendFeedback({ sender: c.ben.cli, text: "Odd" });
        const options = yield* general("Postgres encryption options", "shipped", "Use AES.");

        const linked = yield* feedback.link({
          sender: c.ada.cli,
          id: mine.id,
          to: colleagues.id,
          why: "AES is fine"
        });
        assert.deepStrictEqual(linked, {
          id: mine.id,
          link: { id: colleagues.id, title: "Postgres encryption with AES", status: "open" }
        });
        // A new link replaces the old one and its reason.
        const relinked = yield* feedback.link({ sender: c.ada.cli, id: mine.id, to: options });
        assert.deepStrictEqual(relinked.link, {
          id: options,
          title: "Postgres encryption options",
          status: "shipped",
          note: "Use AES."
        });
        assert.deepInclude((yield* stored(mine.id))[0], {
          linkRequestId: null,
          linkGeneralId: options,
          linkWhy: null
        });

        for (const to of [
          mine.id,
          foreign.id,
          note.id,
          "req_000000000000000000000000",
          "gen_\u0000"
        ]) {
          const refused = yield* feedback
            .link({ sender: c.ada.cli, id: mine.id, to })
            .pipe(Effect.flip);
          assert.strictEqual(refused._tag, "InvalidLink", to);
        }
        // Only the person's own request links or unlinks; another's and a missing one answer alike.
        for (const id of [
          colleagues.id,
          foreign.id,
          note.id,
          "req_000000000000000000000000",
          "req_\u0000"
        ]) {
          const link = yield* feedback
            .link({ sender: c.ada.cli, id, to: options })
            .pipe(Effect.flip);
          const unlink = yield* feedback.unlink({ person: c.ada, id }).pipe(Effect.flip);
          const withdraw = yield* feedback.withdraw({ person: c.ada, id }).pipe(Effect.flip);
          assert.deepStrictEqual(
            [link._tag, unlink._tag, withdraw._tag],
            ["SubmissionNotFound", "SubmissionNotFound", "SubmissionNotFound"]
          );
          assert.strictEqual(link.message, `You sent no request or feedback with id ${id}.`);
        }

        yield* feedback.link({
          sender: c.ada.cli,
          id: mine.id,
          to: colleagues.id,
          why: "AES is fine"
        });
        assert.deepStrictEqual(yield* feedback.unlink({ person: c.ada, id: mine.id }), {
          id: mine.id,
          link: null
        });
        assert.deepInclude((yield* stored(mine.id))[0], {
          linkRequestId: null,
          linkGeneralId: null,
          linkWhy: null
        });
        yield* feedback.unlink({ person: c.ada, id: mine.id });
        const [counted] = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM feedback.submissions
        WHERE company_id = ${c.id} AND link_why IS NOT NULL`;
        assert.strictEqual(counted?.count, "0");
      })
  );

  it.effect("withdrawing a request someone linked to removes only it and clears their link", () =>
    Effect.gen(function* () {
      const c = yield* company("withdraw");
      const feedback = yield* Feedback.Feedback;
      const adas = yield* send(c.ada.cli, "RSA for Postgres");
      const bens = yield* send(c.ben.cli, "Postgres encryption", "Auditors");
      yield* feedback.link({ sender: c.ben.cli, id: bens.id, to: adas.id, why: "Same need" });

      // Ben can't withdraw Ada's, and a missing id answers the same.
      for (const id of [adas.id, "req_000000000000000000000000"])
        assert.strictEqual(
          (yield* feedback.withdraw({ person: c.ben, id }).pipe(Effect.flip))._tag,
          "SubmissionNotFound"
        );
      assert.deepStrictEqual(yield* feedback.withdraw({ person: c.ada, id: adas.id }), {
        id: adas.id
      });
      assert.deepStrictEqual(yield* stored(adas.id), []);
      assert.deepInclude((yield* stored(bens.id))[0], {
        text: "Postgres encryption",
        why: "Auditors",
        linkRequestId: null,
        linkWhy: null
      });
      assert.strictEqual(
        (yield* feedback.withdraw({ person: c.ada, id: adas.id }).pipe(Effect.flip))._tag,
        "SubmissionNotFound"
      );
    })
  );

  it.effect(
    "lists only the person's own, newest first, a page at a time, never a note or a why",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const c = yield* company("lists");
        const feedback = yield* Feedback.Feedback;
        const options = yield* general("Email integrations", "planned", "In the works.");
        const request = yield* send(c.ada.cli, "Gmail integration", "Sales needs it");
        yield* feedback.link({ sender: c.ada.cli, id: request.id, to: options, why: "Same" });
        const note = yield* feedback.sendFeedback({
          sender: c.ada.dashboard,
          text: "Secret plans"
        });
        yield* send(c.ben.cli, "Slack integration");

        const page = yield* feedback.list({ person: c.ada });
        assert.deepStrictEqual(
          page.submissions.map((sent): unknown => Struct.omit(sent, ["createdAt"])),
          [
            { id: note.id, kind: "feedback", surface: "dashboard", agent: null },
            {
              id: request.id,
              kind: "request",
              surface: "cli",
              agent: "claude-code",
              title: "Gmail integration",
              status: "planned",
              link: {
                id: options,
                title: "Email integrations",
                status: "planned",
                note: "In the works."
              }
            }
          ]
        );
        assert.isNull(page.nextCursor);
        assert.notInclude(JSON.stringify(page), "Secret plans");
        assert.notInclude(JSON.stringify(page), "Sales needs it");
        assert.deepStrictEqual(
          (yield* feedback.list({ person: c.ada, kind: "feedback" })).submissions.map(
            ({ id }) => id
          ),
          [note.id]
        );

        // 55 more, some in the same microsecond, read back two pages without a gap or repeat.
        yield* sql`
        INSERT INTO feedback.submissions (id, kind, text, company_id, user_id, surface, agent, created_at)
        SELECT 'fbk_' || lpad(n::text, 24, '0'), 'feedback', 'Bulk', ${c.id}, ${c.ben.userId}, 'cli',
          'codex', timestamptz '2026-11-01 00:00:00.123456Z' + (n / 2) * interval '1 microsecond'
        FROM generate_series(1, 55) AS n`;
        const first = yield* feedback.list({ person: c.ben });
        assert.lengthOf(first.submissions, Feedback.PAGE_SIZE);
        assert.isString(first.nextCursor);
        const second = yield* feedback.list({ person: c.ben, cursor: first.nextCursor! });
        const ids = [...first.submissions, ...second.submissions].map(({ id }) => id);
        assert.lengthOf(ids, 56);
        assert.strictEqual(new Set(ids).size, 56);
        assert.isNull(second.nextCursor);
        assert.strictEqual(
          (yield* feedback.list({ person: c.ben, cursor: "not-a-cursor" }).pipe(Effect.flip))._tag,
          "InvalidCursor"
        );
      })
  );

  it.effect("stores no request when its matching fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const c = yield* company("atomic");
      events.length = 0;
      yield* sql`ALTER TABLE feedback.general_requests RENAME TO general_requests_away`;
      const failed = yield* send(c.ada.cli, "Gmail integration").pipe(Effect.flip);
      yield* sql`ALTER TABLE feedback.general_requests_away RENAME TO general_requests`;
      assert.strictEqual(failed._tag, "SqlError");
      const [counted] = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM feedback.submissions WHERE company_id = ${c.id}`;
      assert.strictEqual(counted?.count, "0");
      assert.deepStrictEqual(events, []);
    })
  );

  it.effect(
    "events carry ids, surface, agent and match counts; text never reaches either stream",
    () =>
      Effect.gen(function* () {
        const c = yield* company("canary");
        const feedback = yield* Feedback.Feedback;
        const wideEvents = yield* WideEvents.WideEvents;
        const canary = "Zanzibar-canary-7731";
        const token = ["gh", "p_", "a1B2".repeat(9)].join("");
        const options = yield* general("Zanzibar canary requests", "open");
        events.length = 0;
        wide.length = 0;
        /** Runs `work` as one request's event, answering its success or none. */
        const request = <A, E, R>(work: Effect.Effect<A, E, R>) =>
          wideEvents.withEvent({ type: "request" }, work).pipe(Effect.option);

        const filed = Option.getOrThrow(
          yield* request(send(c.ada.mcp, `${canary} requests`, `${canary} why`))
        ).id;
        yield* request(send(c.ada.mcp, `${canary} ${token}`, `${canary} why`));
        yield* request(feedback.link({ sender: c.ada.cli, id: filed, to: options, why: canary }));
        const sent = Option.getOrThrow(
          yield* request(feedback.sendFeedback({ sender: c.ada.dashboard, text: canary }))
        ).id;
        yield* request(
          feedback.sendFeedback({ sender: c.ada.dashboard, text: `${canary} ${token}` })
        );
        // Events are delivered on their own fibers.
        for (let turn = 0; turn < 100 && wide.length < 5; turn++) yield* Effect.yieldNow;

        assert.deepStrictEqual(
          events.map(({ name, principalId, companyId, properties }) => ({
            name,
            principalId,
            companyId,
            properties
          })),
          [
            {
              name: "request.sent",
              principalId: c.ada.userId,
              companyId: c.id,
              properties: { submissionId: filed, surface: "mcp", agent: "Claude", matches: 1 }
            },
            {
              name: "request.linked",
              principalId: c.ada.userId,
              companyId: c.id,
              properties: {
                submissionId: filed,
                surface: "cli",
                agent: "claude-code",
                targetId: options,
                target: "general"
              }
            },
            {
              name: "feedback.sent",
              principalId: c.ada.userId,
              companyId: c.id,
              properties: { submissionId: sent, surface: "dashboard", agent: null }
            }
          ]
        );
        assert.lengthOf(wide, 5);
        assert.strictEqual(wide[0]?.type === "request" ? wide[0].submissionId : undefined, filed);
        for (const line of [...events, ...wide].map((event) => JSON.stringify(event))) {
          assert.notInclude(line, canary);
          assert.notInclude(line, token);
        }
      })
  );
});
