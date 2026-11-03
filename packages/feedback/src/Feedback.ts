/**
 * Requests and feedback: the one place they land, whichever surface sent them. The CLI's routes,
 * the dashboard and Patchy MCP each authenticate the person and hand over a `Sender`; the service
 * records it as given and never reads who sent something from a request body.
 *
 * Sending bounds each field, refuses credentials (`Secrets.scan`), spends the person's
 * `feedback.sends.perMinute` and stores the submission. A request's insert and its matching run
 * in one transaction; business events follow the commit, and carry ids, never text. Linking,
 * unlinking, listing and withdrawing touch only the person's own submissions and spend nothing.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Analytics } from "@patchy/analytics";
import * as WideEvents from "@patchy/analytics/wide-events";
import { RequestStatus, SubmissionKind, SubmissionSurface, type RequestBrief } from "@patchy/api";
import { Cryptography } from "@patchy/core";
import { Limits, OperatingLimits } from "@patchy/limits";
import { withReportedCommit } from "@patchy/sql";
import * as Secrets from "./Secrets.js";

/** A request title's bounds, in characters. */
export const TITLE_MIN = 3;
export const TITLE_MAX = 200;
/** The most characters a request's `why`, a link's `why` or a feedback note holds. */
export const TEXT_MAX = 4_000;
/** Submissions in one page of a person's list. */
export const PAGE_SIZE = 50;
/** The most similar requests filing one returns. */
export const SIMILAR_MAX = 3;

const count = (value: number) => value.toLocaleString("en-US");

export class InvalidText extends Schema.TaggedError<InvalidText>()("InvalidText", {
  field: Schema.String,
  minimum: Schema.Int,
  maximum: Schema.Int
}) {
  override get message() {
    const bounds =
      this.minimum > 0
        ? `${count(this.minimum)}–${count(this.maximum)} characters`
        : `at most ${count(this.maximum)} characters`;
    return `Nothing was stored: \`${this.field}\` must be ${bounds}, with no control characters.`;
  }
}

/** Each field that held a credential and the kind it looked like; never the value. */
export class ContainsSecret extends Schema.TaggedError<ContainsSecret>()("ContainsSecret", {
  secrets: Schema.Array(
    Schema.Struct({ field: Schema.String, kind: Schema.String, label: Schema.String })
  )
}) {
  override get message() {
    const found = this.secrets.map(({ field, label }) => `\`${field}\` holds ${label}`);
    return `Nothing was stored: ${found.join("; ")}. Remove it, or replace it with <token>, and send it again.`;
  }
}

/** The person spent `feedback.sends.perMinute`, or the host can track no one else this minute. */
export class SendLimited extends Schema.TaggedError<SendLimited>()("SendLimited", {
  limit: Schema.Number,
  retryAfterSeconds: Schema.Int
}) {
  override get message() {
    return `Nothing was stored: a person sends at most ${count(this.limit)} requests and feedback a minute. Send it again in ${this.retryAfterSeconds} seconds.`;
  }
}

/** Nothing the person sent has this id, which is what another person's id gets too. */
export class SubmissionNotFound extends Schema.TaggedError<SubmissionNotFound>()(
  "SubmissionNotFound",
  { id: Schema.String }
) {
  override get message() {
    return `You sent no request or feedback with id ${this.id}.`;
  }
}

/** The link's target is the request itself, or nothing the person could have been shown. */
export class InvalidLink extends Schema.TaggedError<InvalidLink>()("InvalidLink", {
  id: Schema.String,
  to: Schema.String
}) {
  override get message() {
    return "Nothing changed: a request links only to another request of your company or to a general request, by the id a match or list gave.";
  }
}

export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("InvalidCursor", {}) {
  override get message() {
    return "Invalid cursor: send a page's `nextCursor` as it came.";
  }
}

/** The person a call acts for, as an adapter authenticated them. */
export interface Person {
  readonly userId: string;
  readonly companyId: string;
}

/**
 * Who sends a submission and through what, as the adapter authenticated it. The CLI names its
 * coding agent (`unknown` when it detected none), its release and the patch whose repo it ran
 * in; Patchy MCP names the connection's client; the dashboard names no agent.
 */
export type Sender = Person &
  (
    | {
        readonly surface: "cli";
        readonly agent: string;
        readonly cliVersion: string | null;
        /** Stored only when it is a patch of the sender's company. */
        readonly patchId: string | null;
      }
    | { readonly surface: "mcp"; readonly agent: string }
    | { readonly surface: "dashboard" }
  );

/** A request in a person's list: its title, status and current link. */
export interface SentRequest {
  readonly kind: "request";
  readonly id: string;
  readonly createdAt: Date;
  readonly surface: SubmissionSurface;
  readonly agent: string | null;
  readonly title: string;
  readonly status: RequestStatus;
  readonly link: RequestBrief | null;
}

/** Feedback in a person's list: when and how it was sent, never its note. */
export interface SentFeedback {
  readonly kind: "feedback";
  readonly id: string;
  readonly createdAt: Date;
  readonly surface: SubmissionSurface;
  readonly agent: string | null;
}

export interface Page {
  readonly submissions: ReadonlyArray<SentRequest | SentFeedback>;
  /** Null on the last page. */
  readonly nextCursor: string | null;
}

/** What sending can refuse; nothing is stored or spent for any of them but `SendLimited`. */
export type SendRefusal = InvalidText | ContainsSecret | SendLimited;

export class Feedback extends Context.Service<
  Feedback,
  {
    /**
     * Stores a request and returns its id with up to three similar requests: the company's own
     * (never another company's) and general requests, ranked by shared words. A match's status is
     * a general request's own, or that of the general request a company request links straight
     * to, otherwise `open`; only a general request carries a note.
     */
    readonly sendRequest: (input: {
      readonly sender: Sender;
      /** The request's title. */
      readonly text: string;
      readonly why?: string | null;
    }) => Effect.Effect<
      { readonly id: string; readonly similar: ReadonlyArray<RequestBrief> },
      SendRefusal | SqlError
    >;
    readonly sendFeedback: (input: {
      readonly sender: Sender;
      readonly text: string;
    }) => Effect.Effect<{ readonly id: string }, SendRefusal | SqlError>;
    /**
     * Links the sender's own request `id` to `to`: another request of their company or a general
     * request, replacing any link it had and its reason.
     */
    readonly link: (input: {
      readonly sender: Sender;
      readonly id: string;
      readonly to: string;
      readonly why?: string | null;
    }) => Effect.Effect<
      { readonly id: string; readonly link: RequestBrief },
      SubmissionNotFound | InvalidLink | InvalidText | ContainsSecret | SqlError
    >;
    /** Clears the person's own request's link and its reason; unlinked already is fine. */
    readonly unlink: (input: {
      readonly person: Person;
      readonly id: string;
    }) => Effect.Effect<
      { readonly id: string; readonly link: null },
      SubmissionNotFound | SqlError
    >;
    /** One page of what the person sent, newest first, through every surface. */
    readonly list: (input: {
      readonly person: Person;
      readonly kind?: SubmissionKind;
      readonly cursor?: string;
    }) => Effect.Effect<Page, InvalidCursor | SqlError>;
    /**
     * Deletes one of the person's submissions, and clears the links other requests had to it,
     * their reasons included, in the same transaction. No other submission is deleted.
     */
    readonly withdraw: (input: {
      readonly person: Person;
      readonly id: string;
    }) => Effect.Effect<{ readonly id: string }, SubmissionNotFound | SqlError>;
  }
>()("@patchy/feedback/Feedback") {}

/** Control characters other than tab, line feed and carriage return. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

/** A field trimmed, or refused when outside its bounds or holding control characters. */
const bounded = (field: string, text: string, minimum: number, maximum: number) => {
  const length = [...text].length;
  return length < minimum || length > maximum || CONTROL.test(text)
    ? Effect.fail(new InvalidText({ field, minimum, maximum }))
    : Effect.succeed(text);
};

/** A request's title is one line: whitespace runs collapse to a space. */
const titleOf = (text: string) =>
  bounded("text", text.replace(/\s+/gu, " ").trim(), TITLE_MIN, TITLE_MAX);

/** An optional reason: blank is none. */
const reasonOf = (field: string, text: string | null | undefined) => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? Effect.succeed(null) : bounded(field, trimmed, 1, TEXT_MAX);
};

const refuseSecrets = (fields: Readonly<Record<string, string | null>>) => {
  const secrets = Secrets.scan(fields);
  return secrets.length === 0 ? Effect.void : Effect.fail(new ContainsSecret({ secrets }));
};

const MatchRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: RequestStatus,
  note: Schema.NullOr(Schema.String)
});
const brief = ({ id, title, status, note }: typeof MatchRow.Type): RequestBrief =>
  note === null ? { id, title, status } : { id, title, status, note };

const ListRow = Schema.Struct({
  id: Schema.String,
  kind: SubmissionKind,
  text: Schema.String,
  surface: SubmissionSurface,
  agent: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  micros: Schema.String,
  status: RequestStatus,
  linkId: Schema.NullOr(Schema.String),
  linkTitle: Schema.NullOr(Schema.String),
  linkStatus: Schema.NullOr(RequestStatus),
  linkNote: Schema.NullOr(Schema.String)
});

/** A cursor names the last item of a page: its time in microseconds and its id. */
const CURSOR = /^(\d{1,19})-([a-z]{3}_[a-z0-9]{24})$/;
/**
 * The latest time a cursor may name, the end of 9999 in microseconds since 1970. A larger one
 * would overflow Postgres's `bigint` or its timestamps, and no submission was made then.
 */
const LATEST_CURSOR_MICROS = 253_402_300_799_999_999n;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cryptography = yield* Cryptography.Cryptography;
  const analytics = yield* Analytics.Analytics;
  const limits = yield* Limits.Limits;
  const operating = yield* OperatingLimits.OperatingLimits;
  const dieOnSchemaError = { SchemaError: Effect.die } as const;

  /** Commits `change`, then reports it; a refusal or rollback reports nothing. */
  const committed = <A, E>(
    change: Effect.Effect<A, E>,
    report: (value: A) => Effect.Effect<void>
  ) => withReportedCommit(change, report).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  /** Spends one of the sender's sends this minute, or refuses with the wait. */
  const spend = Effect.fn("Feedback.spend")(function* (sender: Sender) {
    const limit = yield* operating
      .get({ companyId: sender.companyId, limitId: "feedback.sends.perMinute" })
      .pipe(Effect.catchTags({ InvalidLimit: Effect.die, CompanyNotFound: Effect.die }));
    const attempt = yield* limits.consume({
      key: `feedback-sends:${sender.userId}`,
      limit: limit.value,
      window: "1 minute"
    });
    yield* WideEvents.enrich({
      limits: [
        {
          limitId: limit.limitId,
          value: limit.value,
          peak: limit.value - attempt.remaining,
          configRevision: limit.configRevision
        }
      ]
    });
    if (attempt.allowed) return;
    yield* WideEvents.enrich({
      limitId: attempt.reason === "capacity" ? "rate.trackedKeys" : limit.limitId
    });
    return yield* new SendLimited({
      limit: limit.value,
      retryAfterSeconds: attempt.retryAfterSeconds
    });
  });

  /** Stores a submission. A patch outside the sender's company is stored as none. */
  const insert = (
    sender: Sender,
    row: {
      readonly id: string;
      readonly kind: SubmissionKind;
      readonly text: string;
      readonly why: string | null;
    }
  ) => {
    const cli = sender.surface === "cli" ? sender : null;
    return sql`
      INSERT INTO feedback.submissions
        (id, kind, text, why, company_id, user_id, surface, agent, cli_version, patch_id)
      VALUES (${row.id}, ${row.kind}, ${row.text}, ${row.why}, ${sender.companyId},
        ${sender.userId}, ${sender.surface}, ${sender.surface === "dashboard" ? null : sender.agent},
        ${cli?.cliVersion ?? null},
        (SELECT id FROM patches WHERE id = ${cli?.patchId ?? null} AND company_id = ${sender.companyId}))`;
  };

  // Any shared word counts: the title's lexemes OR'd together, ranked, above a small floor that
  // keeps one common word in a long title from matching. The company's own requests and every
  // general request compete for the same three places.
  const similar = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, id: Schema.String, text: Schema.String }),
    Result: MatchRow,
    execute: ({ companyId, id, text }) => sql`
      WITH q AS (
        SELECT replace(plainto_tsquery('english', ${text})::text, ' & ', ' | ')::tsquery AS q
      ), candidates AS (
        SELECT s.id, s.text AS title, COALESCE(g.status, 'open') AS status, NULL::text AS note,
          ts_rank(s.search, q.q) AS rank, s.created_at AS at
        FROM q, feedback.submissions s
        LEFT JOIN feedback.general_requests g ON g.id = s.link_general_id
        WHERE s.company_id = ${companyId} AND s.kind = 'request' AND s.id <> ${id}
          AND s.search @@ q.q
        UNION ALL
        SELECT g.id, g.title, g.status, g.note, ts_rank(g.search, q.q), g.updated_at
        FROM q, feedback.general_requests g
        WHERE g.search @@ q.q
      )
      SELECT id, title, status, note FROM candidates
      WHERE rank >= 0.01
      ORDER BY rank DESC, at DESC, id
      LIMIT ${SIMILAR_MAX}`
  });

  /** The person's own request, locked for the change, or none. */
  const ownRequest = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String, userId: Schema.String, companyId: Schema.String }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ id, userId, companyId }) => sql`
      SELECT id FROM feedback.submissions
      WHERE id = ${id} AND user_id = ${userId} AND company_id = ${companyId} AND kind = 'request'
      FOR UPDATE`
  });

  /** A link target the person could have been shown, held until the link commits. */
  const target = SqlSchema.findOneOption({
    Request: Schema.Struct({ to: Schema.String, companyId: Schema.String }),
    Result: Schema.Struct({ ...MatchRow.fields, general: Schema.Boolean }),
    execute: ({ to, companyId }) =>
      sql`
      SELECT id, title, status, note, true AS general
      FROM feedback.general_requests WHERE id = ${to}
      FOR KEY SHARE`.pipe(
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.succeed(rows)
            : sql`
            SELECT s.id, s.text AS title, COALESCE(g.status, 'open') AS status, NULL AS note,
              false AS general
            FROM feedback.submissions s
            LEFT JOIN feedback.general_requests g ON g.id = s.link_general_id
            WHERE s.id = ${to} AND s.company_id = ${companyId} AND s.kind = 'request'
            FOR KEY SHARE OF s`
        )
      )
  });

  const page = SqlSchema.findAll({
    Request: Schema.Struct({
      userId: Schema.String,
      companyId: Schema.String,
      kind: Schema.NullOr(SubmissionKind),
      after: Schema.NullOr(Schema.Struct({ micros: Schema.String, id: Schema.String }))
    }),
    Result: ListRow,
    execute: ({ userId, companyId, kind, after }) => sql`
      SELECT s.id, s.kind, s.text, s.surface, s.agent, s.created_at AS "createdAt",
        ((extract(epoch FROM s.created_at) * 1000000)::bigint)::text AS micros,
        COALESCE(lg.status, 'open') AS status,
        COALESCE(lg.id, lr.id) AS "linkId",
        COALESCE(lg.title, lr.text) AS "linkTitle",
        CASE WHEN lg.id IS NOT NULL THEN lg.status
          WHEN lr.id IS NOT NULL THEN COALESCE(lrg.status, 'open') END AS "linkStatus",
        lg.note AS "linkNote"
      FROM feedback.submissions s
      LEFT JOIN feedback.general_requests lg ON lg.id = s.link_general_id
      LEFT JOIN feedback.submissions lr ON lr.id = s.link_request_id
      LEFT JOIN feedback.general_requests lrg ON lrg.id = lr.link_general_id
      WHERE s.user_id = ${userId} AND s.company_id = ${companyId}
        ${kind === null ? sql`` : sql`AND s.kind = ${kind}`}
        ${
          after === null
            ? sql``
            : sql`AND (s.created_at, s.id) <
                ('epoch'::timestamptz + ${after.micros}::bigint * interval '1 microsecond', ${after.id})`
        }
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ${PAGE_SIZE + 1}`
  });

  /** Who a business event is about, and what it came through: never any text. */
  const subject = (sender: Sender, submissionId: string) => ({
    submissionId,
    surface: sender.surface,
    agent: sender.surface === "dashboard" ? null : sender.agent
  });

  const sendRequest = Effect.fn("Feedback.sendRequest")(function* (input: {
    readonly sender: Sender;
    readonly text: string;
    readonly why?: string | null;
  }) {
    const { sender } = input;
    const text = yield* titleOf(input.text);
    const why = yield* reasonOf("why", input.why);
    yield* refuseSecrets({ text, why });
    yield* spend(sender);
    const id = yield* cryptography.internalId("req");
    const filed = yield* committed(
      Effect.gen(function* () {
        yield* insert(sender, { id, kind: "request", text, why });
        const matches = yield* similar({ companyId: sender.companyId, id, text }).pipe(
          Effect.catchTags(dieOnSchemaError)
        );
        return { id, similar: matches.map(brief) };
      }),
      ({ similar: matches }) =>
        analytics.track({
          name: "request.sent",
          principalId: sender.userId,
          companyId: sender.companyId,
          properties: { ...subject(sender, id), matches: matches.length }
        })
    );
    yield* WideEvents.enrich({ submissionId: id });
    return filed;
  });

  const sendFeedback = Effect.fn("Feedback.sendFeedback")(function* (input: {
    readonly sender: Sender;
    readonly text: string;
  }) {
    const { sender } = input;
    const text = yield* bounded("text", input.text.trim(), 1, TEXT_MAX);
    yield* refuseSecrets({ text });
    yield* spend(sender);
    const id = yield* cryptography.internalId("fbk");
    yield* committed(insert(sender, { id, kind: "feedback", text, why: null }), () =>
      analytics.track({
        name: "feedback.sent",
        principalId: sender.userId,
        companyId: sender.companyId,
        properties: subject(sender, id)
      })
    );
    yield* WideEvents.enrich({ submissionId: id });
    return { id };
  });

  const link = Effect.fn("Feedback.link")(function* (input: {
    readonly sender: Sender;
    readonly id: string;
    readonly to: string;
    readonly why?: string | null;
  }) {
    const { sender, id, to } = input;
    const why = yield* reasonOf("why", input.why);
    yield* refuseSecrets({ why });
    const linked = yield* committed(
      Effect.gen(function* () {
        const own = yield* ownRequest({ id, userId: sender.userId, companyId: sender.companyId });
        if (Option.isNone(own)) return yield* new SubmissionNotFound({ id });
        if (to === id) return yield* new InvalidLink({ id, to });
        const found = yield* target({ to, companyId: sender.companyId });
        if (Option.isNone(found)) return yield* new InvalidLink({ id, to });
        const { general } = found.value;
        yield* sql`
          UPDATE feedback.submissions
          SET link_request_id = ${general ? null : to}, link_general_id = ${general ? to : null},
            link_why = ${why}
          WHERE id = ${id}`;
        return { general, link: brief(found.value) };
      }).pipe(Effect.catchTags(dieOnSchemaError)),
      ({ general }) =>
        analytics.track({
          name: "request.linked",
          principalId: sender.userId,
          companyId: sender.companyId,
          properties: {
            ...subject(sender, id),
            targetId: to,
            target: general ? "general" : "request"
          }
        })
    );
    yield* WideEvents.enrich({ submissionId: id });
    return { id, link: linked.link };
  });

  const unlink = Effect.fn("Feedback.unlink")(function* ({
    person,
    id
  }: {
    readonly person: Person;
    readonly id: string;
  }) {
    const rows = yield* sql`
      UPDATE feedback.submissions
      SET link_request_id = NULL, link_general_id = NULL, link_why = NULL
      WHERE id = ${id} AND user_id = ${person.userId} AND company_id = ${person.companyId}
        AND kind = 'request'
      RETURNING id`;
    if (rows.length === 0) return yield* new SubmissionNotFound({ id });
    yield* WideEvents.enrich({ submissionId: id });
    return { id, link: null };
  });

  const list = Effect.fn("Feedback.list")(function* ({
    person,
    kind,
    cursor
  }: {
    readonly person: Person;
    readonly kind?: SubmissionKind;
    readonly cursor?: string;
  }) {
    const match = cursor === undefined ? null : CURSOR.exec(cursor);
    if (cursor !== undefined && (match === null || BigInt(match[1]!) > LATEST_CURSOR_MICROS))
      return yield* new InvalidCursor();
    const rows = yield* page({
      userId: person.userId,
      companyId: person.companyId,
      kind: kind ?? null,
      after: match === null ? null : { micros: match[1]!, id: match[2]! }
    }).pipe(Effect.catchTags(dieOnSchemaError));
    const shown = rows.slice(0, PAGE_SIZE);
    const last = shown.at(-1);
    return {
      submissions: shown.map((row): SentRequest | SentFeedback => {
        const sent = {
          id: row.id,
          createdAt: row.createdAt,
          surface: row.surface,
          agent: row.agent
        };
        if (row.kind === "feedback") return { ...sent, kind: "feedback" };
        return {
          ...sent,
          kind: "request",
          title: row.text,
          status: row.status,
          link:
            row.linkId === null || row.linkTitle === null || row.linkStatus === null
              ? null
              : brief({
                  id: row.linkId,
                  title: row.linkTitle,
                  status: row.linkStatus,
                  note: row.linkNote
                })
        };
      }),
      nextCursor: rows.length > PAGE_SIZE && last !== undefined ? `${last.micros}-${last.id}` : null
    };
  });

  const withdraw = Effect.fn("Feedback.withdraw")(function* ({
    person,
    id
  }: {
    readonly person: Person;
    readonly id: string;
  }) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const own = yield* sql`
          SELECT id FROM feedback.submissions
          WHERE id = ${id} AND user_id = ${person.userId} AND company_id = ${person.companyId}
          FOR UPDATE`;
        if (own.length === 0) return yield* new SubmissionNotFound({ id });
        yield* sql`
          UPDATE feedback.submissions SET link_request_id = NULL, link_why = NULL
          WHERE link_request_id = ${id}`;
        yield* sql`DELETE FROM feedback.submissions WHERE id = ${id}`;
      })
    );
    yield* WideEvents.enrich({ submissionId: id });
    return { id };
  });

  return Feedback.of({ sendRequest, sendFeedback, link, unlink, list, withdraw });
});

export const layer = Layer.effect(Feedback, make);
