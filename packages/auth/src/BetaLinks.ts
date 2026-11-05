/**
 * Beta links: one forwardable address that lets one person past the waitlist, for a prospect
 * whose teammate nobody knows the email of yet. An operator makes a link for a company's name
 * (`pnpm beta-links create --for Acme`). Whoever opens it enters their work email, which reserves
 * the link for that address for good, and Clerk emails the address an ordinary invitation, whose
 * sign-up proves the mailbox and takes the terms. The person's first visit to create-or-join
 * marks the link used and suggests its name for their company.
 *
 * The secret lives only in the link; Postgres keeps its SHA-256. Each change locks the link's
 * row and holds it through the Clerk call and the commit, uninterruptible, as company
 * invitations do (`Invitations.ts`), so a revoke can't cross a send, and an interrupt can't roll
 * back an invitation Clerk already emailed.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { InviteMail } from "@patchy/companies";
import { Cryptography } from "@patchy/core";

/** How long a link takes an email. An invitation it sent lasts Clerk's own 30 days after that. */
export const DEFAULT_DAYS = 30;
const DAY_MS = 86_400_000;

export class BetaLinkNotFound extends Schema.TaggedError<BetaLinkNotFound>()("BetaLinkNotFound", {
  id: Schema.optional(Schema.String)
}) {
  override get message() {
    return this.id === undefined ? "No beta link has that address." : `No beta link ${this.id}.`;
  }
}

export class InvalidEmail extends Schema.TaggedError<InvalidEmail>()("InvalidEmail", {}) {
  override get message() {
    return "Enter your work email address.";
  }
}

/** Another live link holds the address, so an arrival with it could name either. */
export class EmailAlreadyReserved extends Schema.TaggedError<EmailAlreadyReserved>()(
  "EmailAlreadyReserved",
  {}
) {
  override get message() {
    return "That email already has an invitation.";
  }
}

/** The name a link is made for, which its page shows the person and their company starts with. */
export const Label = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));

export class BetaLink extends Schema.Class<BetaLink>("BetaLink")({
  id: Schema.String,
  label: Schema.String,
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  revokedAt: Schema.NullOr(Schema.Date),
  email: Schema.NullOr(Schema.String),
  clerkInvitationId: Schema.NullOr(Schema.String),
  invitedAt: Schema.NullOr(Schema.Date),
  signedInAt: Schema.NullOr(Schema.Date),
  clerkUserId: Schema.NullOr(Schema.String),
  inviteAttempts: Schema.Number
}) {}

/**
 * Where a link stands, from its facts in this order: used once its person reached
 * create-or-join; ended once revoked; sent once Clerk took an invitation, which outlives the
 * link's end date; ended past that date; failed when an email is reserved but Clerk took no
 * invitation for it; otherwise open.
 */
export type State = "open" | "failed" | "sent" | "used" | "ended";

export const state = (link: BetaLink, now: number): State =>
  link.signedInAt !== null
    ? "used"
    : link.revokedAt !== null
      ? "ended"
      : link.clerkInvitationId !== null
        ? "sent"
        : link.expiresAt.getTime() <= now
          ? "ended"
          : link.email !== null
            ? "failed"
            : "open";

/**
 * How many times a link may ask Clerk for its invitation from its own page: Continue and then
 * Try again. Plenty for an outage, and it keeps a link Clerk keeps refusing, such as one held for
 * an address Clerk won't invite, from spending the instance's hourly invitation allowance. The
 * operator's resend is not counted against it.
 */
export const MAX_ATTEMPTS = 5;

/** Whether a failed link's page still offers Try again. */
export const canRetry = (link: BetaLink) => link.inviteAttempts < MAX_ATTEMPTS;

/**
 * An operator's resend or revoke: the link after it, and its emailed invitation's fate. `sent`
 * is a new one; `withdrawn` is gone at Clerk; `accepted` means its person already signed up;
 * `none` means there was nothing to send or withdraw; `unconfirmed` means Clerk never confirmed
 * one, but may hold one whose answer was lost, which Patchy can't name to withdraw; `failed`
 * means Clerk didn't answer.
 */
export interface Outcome {
  readonly link: BetaLink;
  readonly invitation: "sent" | "withdrawn" | "accepted" | "none" | "unconfirmed" | "failed";
}

/** A link as `list` shows it, with the handle of the company its person is in, if any. */
export class Listed extends BetaLink.extend<Listed>("Listed")({
  company: Schema.NullOr(Schema.String)
}) {}

const decodeLinks = Schema.decodeUnknownEffect(Schema.Array(BetaLink));
const decodeListed = Schema.decodeUnknownEffect(Schema.Array(Listed));
const decodeLabels = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ label: Schema.String }))
);

const columns = (sql: SqlClient.SqlClient) => sql`
  b.id, b.label, b.created_at AS "createdAt", b.expires_at AS "expiresAt",
  b.revoked_at AS "revokedAt", b.email, b.clerk_invitation_id AS "clerkInvitationId",
  b.invited_at AS "invitedAt", b.signed_in_at AS "signedInAt", b.clerk_user_id AS "clerkUserId",
  b.invite_attempts AS "inviteAttempts"`;

const first = (rows: ReadonlyArray<unknown>) =>
  decodeLinks(rows).pipe(
    Effect.map((links) => Option.fromNullishOr(links[0])),
    Effect.catchTags({ SchemaError: Effect.die })
  );

/** Locks the link at `secret`, or fails when there is none. */
const lockBySecret = Effect.fn("BetaLinks.lockBySecret")(function* (secret: string) {
  const sql = yield* SqlClient.SqlClient;
  const hash = yield* (yield* Cryptography.Cryptography).sha256(secret);
  const link = yield* first(
    yield* sql`SELECT ${columns(sql)} FROM beta_links b WHERE b.secret_hash = ${hash} FOR UPDATE`
  );
  if (Option.isNone(link)) return yield* new BetaLinkNotFound({});
  return link.value;
});

const lockById = Effect.fn("BetaLinks.lockById")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const link = yield* first(
    yield* sql`SELECT ${columns(sql)} FROM beta_links b WHERE b.id = ${id} FOR UPDATE`
  );
  if (Option.isNone(link)) return yield* new BetaLinkNotFound({ id });
  return link.value;
});

/** Asks Clerk to invite the link's reserved address, counting the attempt. A failure leaves the link failed. */
const deliver = Effect.fn("BetaLinks.deliver")(function* (id: string, email: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE beta_links SET invite_attempts = invite_attempts + 1 WHERE id = ${id}`;
  const invitationId = yield* (yield* InviteMail.InviteMail)
    .create(email)
    .pipe(Effect.catchTags({ InviteMailError: () => Effect.succeed(null) }));
  if (invitationId === null) return "failed" as const;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE beta_links SET clerk_invitation_id = ${invitationId},
    invited_at = to_timestamp(${now / 1_000}) WHERE id = ${id}`;
  return "sent" as const;
});

/** A new link for `label`, open for `days`. The secret is returned once and stored nowhere. */
export const create = Effect.fn("BetaLinks.create")(function* (input: {
  readonly label: string;
  readonly days: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const cryptography = yield* Cryptography.Cryptography;
  const secret = yield* cryptography.token(32);
  const now = yield* Clock.currentTimeMillis;
  const link = yield* first(
    yield* sql`
      INSERT INTO beta_links AS b (id, label, secret_hash, created_at, expires_at)
      VALUES (${yield* cryptography.internalId("bln")}, ${input.label},
        ${yield* cryptography.sha256(secret)}, to_timestamp(${now / 1_000}),
        to_timestamp(${(now + input.days * DAY_MS) / 1_000}))
      RETURNING ${columns(sql)}`
  );
  return { link: Option.getOrThrow(link), secret };
});

/** The link at `secret`, read without changing anything. */
export const find = Effect.fn("BetaLinks.find")(function* (secret: string) {
  const sql = yield* SqlClient.SqlClient;
  const hash = yield* (yield* Cryptography.Cryptography).sha256(secret);
  return yield* first(
    yield* sql`SELECT ${columns(sql)} FROM beta_links b WHERE b.secret_hash = ${hash}`
  );
});

/** A shape check only; Clerk validates the address when it invites it. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Another claim for the same address won the race to the live-email index first. */
const isLiveEmailTaken = (error: SqlError) =>
  error.reason._tag === "UniqueViolation" &&
  error.reason.constraint === "beta_links_live_email_idx";

/**
 * Reserves an open link for `entered` and asks Clerk to invite it. A link that is no longer open
 * is left as it is, whatever was entered, for its page to show. Clerk failing keeps the
 * reservation, so only the same address can be retried: Clerk may have made an invitation whose
 * answer never reached us.
 */
export const claim = Effect.fn("BetaLinks.claim")(function* (secret: string, entered: string) {
  const email = entered.trim().toLowerCase();
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const link = yield* lockBySecret(secret);
        if (state(link, yield* Clock.currentTimeMillis) !== "open") return;
        if (email.length > 254 || !EMAIL.test(email)) return yield* new InvalidEmail({});
        const held = yield* sql`SELECT 1 FROM beta_links
          WHERE email = ${email} AND revoked_at IS NULL`;
        if (held.length > 0) return yield* new EmailAlreadyReserved({});
        // A claim racing this one for the same address waits here on the index, before it asks
        // Clerk anything, and fails once the first commits.
        yield* sql`UPDATE beta_links SET email = ${email} WHERE id = ${link.id}`;
        yield* deliver(link.id, email);
      })
    )
    .pipe(
      Effect.catchTags({
        SqlError: (error) =>
          isLiveEmailTaken(error) ? Effect.fail(new EmailAlreadyReserved({})) : Effect.fail(error)
      })
    );
}, Effect.uninterruptible);

/**
 * Asks Clerk again for a failed link's reserved address, while it has attempts left; any other
 * link is left as it is.
 */
export const retry = Effect.fn("BetaLinks.retry")(function* (secret: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const link = yield* lockBySecret(secret);
      const now = yield* Clock.currentTimeMillis;
      if (state(link, now) !== "failed" || link.email === null || !canRetry(link)) return;
      yield* deliver(link.id, link.email);
    })
  );
}, Effect.uninterruptible);

/**
 * A signed-in person without a company reached create-or-join. The live link reserved for their
 * email, if any, records its first arrival and gives its name to suggest for their company.
 */
export const arrive = Effect.fn("BetaLinks.arrive")(function* (person: {
  readonly clerkUserId: string;
  readonly email: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* sql`
    WITH live AS (
      SELECT id, label FROM beta_links
      WHERE email = ${person.email.toLowerCase()} AND revoked_at IS NULL FOR UPDATE
    ), marked AS (
      UPDATE beta_links b SET signed_in_at = to_timestamp(${now / 1_000}),
        clerk_user_id = ${person.clerkUserId}
      FROM live WHERE b.id = live.id AND b.signed_in_at IS NULL
    )
    SELECT label FROM live`;
  const [row] = yield* decodeLabels(rows).pipe(Effect.catchTags({ SchemaError: Effect.die }));
  return Option.fromNullishOr(row?.label);
});

/** Every link, newest first, with the company its address's person is in. */
export const list = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT ${columns(sql)}, c.handle AS company FROM beta_links b
    LEFT JOIN LATERAL (
      SELECT company_id FROM users u WHERE u.clerk_user_id = b.clerk_user_id OR u.email = b.email
      LIMIT 1
    ) u ON true
    LEFT JOIN companies c ON c.id = u.company_id
    ORDER BY b.created_at DESC, b.id`;
  return yield* decodeListed(rows).pipe(Effect.catchTags({ SchemaError: Effect.die }));
}).pipe(Effect.withSpan("BetaLinks.list"));

/** Withdraws a link's invitation at Clerk: what is left of it there. */
const withdraw = Effect.fn("BetaLinks.withdraw")(function* (
  link: BetaLink
): Effect.fn.Return<Outcome["invitation"], never, InviteMail.InviteMail> {
  if (link.clerkInvitationId === null) return link.email === null ? "none" : "unconfirmed";
  return yield* (yield* InviteMail.InviteMail).revoke(link.clerkInvitationId).pipe(
    Effect.as<Outcome["invitation"]>("withdrawn"),
    Effect.catchTags({
      // Clerk can commit a revoke whose answer never reached us.
      InvitationNotPending: ({ state }) =>
        Effect.succeed<Outcome["invitation"]>(state === "revoked" ? "withdrawn" : "accepted"),
      InviteMailError: () => Effect.succeed<Outcome["invitation"]>("failed")
    })
  );
});

/**
 * A new invitation for a link whose person lost theirs: the old one is withdrawn first, and
 * none is made once the old one was accepted, its person used the link, or it was revoked.
 */
export const resend = Effect.fn("BetaLinks.resend")(function* (
  id: string
): Effect.fn.Return<
  Outcome,
  BetaLinkNotFound | SqlError,
  SqlClient.SqlClient | InviteMail.InviteMail
> {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const link = yield* lockById(id);
      if (link.revokedAt !== null || link.signedInAt !== null || link.email === null)
        return { link, invitation: "none" } satisfies Outcome;
      const old = yield* withdraw(link);
      if (old === "accepted" || old === "failed")
        return { link, invitation: old } satisfies Outcome;
      if (old === "withdrawn")
        yield* sql`UPDATE beta_links SET clerk_invitation_id = NULL, invited_at = NULL
          WHERE id = ${id}`;
      const invitation = yield* deliver(id, link.email);
      return { link: yield* lockById(id), invitation } satisfies Outcome;
    })
  );
}, Effect.uninterruptible);

/**
 * Ends a link and withdraws its invitation. Running it again retries a withdrawal Clerk failed.
 * A person who already accepted keeps their account; deactivating them is their company's call.
 */
export const revoke = Effect.fn("BetaLinks.revoke")(function* (
  id: string
): Effect.fn.Return<
  Outcome,
  BetaLinkNotFound | SqlError,
  SqlClient.SqlClient | InviteMail.InviteMail
> {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const link = yield* lockById(id);
      const now = yield* Clock.currentTimeMillis;
      if (link.revokedAt === null)
        yield* sql`UPDATE beta_links SET revoked_at = to_timestamp(${now / 1_000})
          WHERE id = ${id}`;
      const invitation = yield* withdraw(link);
      return { link: yield* lockById(id), invitation } satisfies Outcome;
    })
  );
}, Effect.uninterruptible);
