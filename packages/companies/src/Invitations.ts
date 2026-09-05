import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Companies from "./Companies.js";
import * as InviteMail from "./InviteMail.js";
import type { AlreadyInCompany } from "./Users.js";

export interface InviteReference {
  readonly companyId: string;
  readonly inviteId: string;
}

export interface DeliveryResult {
  readonly invite: Companies.Invite;
  readonly mailFailed: boolean;
}

const lockPendingRow = SqlSchema.findOneOption({
  Request: Schema.Struct({ companyId: Schema.String, inviteId: Schema.String }),
  Result: Companies.Invite,
  execute: Effect.fn("Invitations.lockPendingRow")(function* ({ companyId, inviteId }) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`
      SELECT id, company_id AS "companyId", email, role, invited_by AS "invitedBy",
        clerk_invitation_id AS "clerkInvitationId", created_at AS "createdAt",
        revoked_at AS "revokedAt", consumed_at AS "consumedAt"
      FROM invites WHERE id = ${inviteId} AND company_id = ${companyId}
        AND revoked_at IS NULL AND consumed_at IS NULL FOR UPDATE`;
  })
});

const lockPending = Effect.fn("Invitations.lockPending")(function* (input: InviteReference) {
  const row = yield* lockPendingRow(input).pipe(Effect.catchTags({ SchemaError: Effect.die }));
  if (Option.isNone(row))
    return yield* new Companies.InviteUnavailable({ inviteId: input.inviteId });
  return row.value;
});

const deliver = Effect.fn("Invitations.deliver")(function* (invite: Companies.Invite) {
  const sql = yield* SqlClient.SqlClient;
  const mail = yield* InviteMail.InviteMail;
  const id = yield* mail
    .create(invite.email)
    .pipe(Effect.catchTags({ InviteMailError: () => Effect.succeed(null) }));
  if (id === null) return { invite, mailFailed: true };
  yield* sql`UPDATE invites SET clerk_invitation_id = ${id} WHERE id = ${invite.id}`;
  return { invite: new Companies.Invite({ ...invite, clerkInvitationId: id }), mailFailed: false };
});

// Hold the invite's row lock through delivery and commit. Consumption, revoke and
// resend cannot replace each other's Clerk id; interruption cannot roll back an
// invitation after the external request has already sent its email.
export const create = Effect.fn("Invitations.create")(function* (
  input: Companies.InviteInput
): Effect.fn.Return<
  DeliveryResult,
  Companies.CompanyNotFound | AlreadyInCompany | Companies.AlreadyInvited | SqlError,
  Companies.Companies | SqlClient.SqlClient | InviteMail.InviteMail
> {
  const sql = yield* SqlClient.SqlClient;
  const companies = yield* Companies.Companies;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const invite = yield* companies.createInvite(input);
      return yield* deliver(invite);
    })
  );
}, Effect.uninterruptible);

export const revoke = Effect.fn("Invitations.revoke")(function* (
  input: InviteReference
): Effect.fn.Return<
  DeliveryResult,
  Companies.InviteUnavailable | SqlError,
  Companies.Companies | SqlClient.SqlClient | InviteMail.InviteMail
> {
  const sql = yield* SqlClient.SqlClient;
  const companies = yield* Companies.Companies;
  const mail = yield* InviteMail.InviteMail;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* lockPending(input);
      const invite = yield* companies.revokeInvite(input);
      const mailFailed =
        invite.clerkInvitationId === null
          ? false
          : yield* mail.revoke(invite.clerkInvitationId).pipe(
              Effect.as(false),
              Effect.catchTags({
                InvitationAlreadyRevoked: () => Effect.succeed(false),
                InviteMailError: () => Effect.succeed(true)
              })
            );
      return { invite, mailFailed };
    })
  );
}, Effect.uninterruptible);

export const resend = Effect.fn("Invitations.resend")(function* (
  input: InviteReference
): Effect.fn.Return<
  DeliveryResult,
  Companies.InviteUnavailable | SqlError,
  SqlClient.SqlClient | InviteMail.InviteMail
> {
  const sql = yield* SqlClient.SqlClient;
  const mail = yield* InviteMail.InviteMail;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      let invite = yield* lockPending(input);
      if (invite.clerkInvitationId !== null) {
        const revokeFailed = yield* mail.revoke(invite.clerkInvitationId).pipe(
          Effect.as(false),
          // Clerk can commit a revoke whose response never reaches us.
          Effect.catchTags({
            InvitationAlreadyRevoked: () => Effect.succeed(false),
            InviteMailError: () => Effect.succeed(true)
          })
        );
        if (revokeFailed) return { invite, mailFailed: true };
        yield* sql`UPDATE invites SET clerk_invitation_id = NULL WHERE id = ${invite.id}`;
        invite = new Companies.Invite({ ...invite, clerkInvitationId: null });
      }
      return yield* deliver(invite);
    })
  );
}, Effect.uninterruptible);
