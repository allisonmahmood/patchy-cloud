import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { InviteMail } from "@patchy/companies";
import { newInternalId } from "@patchy/core";
import { Wakes } from "@patchy/runtime/core";

export const Grant = Schema.Struct({
  id: Schema.String,
  patchId: Schema.String,
  email: Schema.String,
  subject: Schema.NullOr(Schema.String),
  revoked: Schema.Boolean,
  access: Schema.Literals(["read", "write"]),
  name: Schema.String,
  title: Schema.String,
  tier: Schema.Literals([0, 1, 2]),
  companyId: Schema.String,
  company: Schema.String,
  handle: Schema.String
});
export type Grant = typeof Grant.Type;
export type Account = { readonly sub: string; readonly email: string };
export type Recipient = { readonly sub: string; readonly verifiedEmails: readonly string[] };

export class CannotSharePatch extends Schema.TaggedError<CannotSharePatch>()("CannotSharePatch", {
  patchId: Schema.String
}) {
  override get message() {
    return "Only the owner or a company admin can share a live, company-only patch.";
  }
}
export class InvitationDeliveryFailed extends Schema.TaggedError<InvitationDeliveryFailed>()(
  "InvitationDeliveryFailed",
  { cause: Schema.Defect() }
) {
  override get message() {
    return "The invitation is saved, but its email could not be sent.";
  }
}
export class InvitationCompensationFailed extends Schema.TaggedError<InvitationCompensationFailed>()(
  "InvitationCompensationFailed",
  { cause: Schema.Defect() }
) {
  override get message() {
    return "The patch invitation changed while email was being sent. Its account invitation could not be cancelled; it grants no patch or company access.";
  }
}
export class GrantRevocationMailFailed extends Schema.TaggedError<GrantRevocationMailFailed>()(
  "GrantRevocationMailFailed",
  { cause: Schema.Defect() }
) {
  override get message() {
    return "Patch access has ended, but the account invitation email could not be cancelled. It grants no patch or company access.";
  }
}
type ChangeError =
  SqlError | CannotSharePatch | InvitationDeliveryFailed | InvitationCompensationFailed;

/** The patch grant owns its lifecycle and interpretation; it never creates a company User. */
export class PatchGrants extends Context.Service<
  PatchGrants,
  {
    readonly inbox: (account: Recipient) => Effect.Effect<readonly Grant[], SqlError>;
    readonly managed: (account: Account) => Effect.Effect<readonly Grant[], SqlError>;
    readonly admit: (
      subject: string,
      patchId: string,
      versionId?: string
    ) => Effect.Effect<Grant | null, SqlError>;
    readonly accept: (account: Recipient, id: string) => Effect.Effect<Grant | null, SqlError>;
    readonly invite: (
      account: Account,
      input: {
        readonly patchId: string;
        readonly email: string;
        readonly access?: "read" | "write";
        readonly destination?: (id: string) => string;
      }
    ) => Effect.Effect<string, ChangeError>;
    readonly revoke: (
      account: Account,
      id: string
    ) => Effect.Effect<boolean, SqlError | GrantRevocationMailFailed>;
    readonly setAccess: (
      account: Account,
      id: string,
      access: "read" | "write"
    ) => Effect.Effect<boolean, SqlError>;
  }
>()("@patchy/patches/PatchGrants") {}

const decode = Schema.decodeUnknownEffect(Schema.Array(Grant));
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wakes = yield* Wakes.Wakes;
  const mail = yield* InviteMail.InviteMail;
  const rows = (query: Effect.Effect<readonly unknown[], SqlError>) =>
    query.pipe(Effect.flatMap(decode), Effect.catchTags({ SchemaError: Effect.die }));
  const columns = sql`s.id, p.id AS "patchId", s.email, s.subject, s.revoked, s.access,
     p.name, p.title, v.tier, c.id AS "companyId", c.name AS company, c.handle`;
  const joins = (versionId?: string) => sql`FROM patch_grants s JOIN patches p ON p.id = s.patch_id
    JOIN companies c ON c.id = p.company_id JOIN patch_versions v ON v.patch_id = p.id
    AND v.id = coalesce(${versionId ?? null}, p.current_version_id)`;
  const live = sql`p.scope = 'company' AND p.retired_at IS NULL AND p.deleted_at IS NULL AND p.disabled_at IS NULL`;
  const manages = (subject: string) => sql`EXISTS (SELECT 1 FROM users actor
    WHERE actor.clerk_user_id = ${subject} AND actor.deactivated_at IS NULL
    AND actor.company_id = p.company_id AND (actor.id = p.owner_user_id OR actor.role = 'admin'))`;
  const wake = (patchId: string) => wakes.publish([`patch:${patchId}`]);
  const inbox = Effect.fn("PatchGrants.inbox")(function* (account: Recipient) {
    return yield* rows(sql`SELECT ${columns} ${joins()} WHERE NOT s.revoked AND ${live}
      AND (s.subject = ${account.sub} OR (s.subject IS NULL AND s.email = ANY(${[...account.verifiedEmails]}::text[])))
      ORDER BY c.name, p.name`);
  });
  const managed = Effect.fn("PatchGrants.managed")(function* (account: Account) {
    return yield* rows(
      sql`SELECT ${columns} ${joins()} WHERE ${manages(account.sub)} ORDER BY p.name, s.email`
    );
  });
  const admit = Effect.fn("PatchGrants.admit")(function* (
    subject: string,
    patchId: string,
    versionId?: string
  ) {
    const found =
      yield* rows(sql`SELECT ${columns} ${joins(versionId)} WHERE s.patch_id = ${patchId}
      AND s.subject = ${subject} AND NOT s.revoked AND ${live}
      AND NOT EXISTS (SELECT 1 FROM users member WHERE member.clerk_user_id = ${subject}
        AND member.company_id = p.company_id AND member.deactivated_at IS NOT NULL)
`);
    return found[0] ?? null;
  });
  const accept = Effect.fn("PatchGrants.accept")(function* (account: Recipient, id: string) {
    // Email claims an invitation once. Accepted access subsequently follows the stable subject.
    const changed = yield* sql`UPDATE patch_grants s SET subject = ${account.sub}
      FROM patches p WHERE s.id = ${id} AND p.id = s.patch_id AND ${live} AND NOT s.revoked
      AND ((s.subject IS NULL AND s.email = ANY(${[...account.verifiedEmails]}::text[])) OR s.subject = ${account.sub})
      RETURNING s.patch_id AS "patchId"`;
    return changed[0] === undefined ? null : yield* admit(account.sub, String(changed[0].patchId));
  });
  const cancel = Effect.fn("PatchGrants.cancelMail")(function* (id: string) {
    yield* mail.revoke(id).pipe(Effect.catchTags({ InvitationNotPending: () => Effect.void }));
  });
  const invite: PatchGrants["Service"]["invite"] = Effect.fn("PatchGrants.invite")(
    function* (account, input) {
      const allowed =
        yield* sql`SELECT p.id FROM patches p JOIN patch_versions v ON v.id = p.current_version_id
      WHERE p.id = ${input.patchId} AND ${live} AND ${manages(account.sub)}`;
      if (allowed.length === 0) return yield* new CannotSharePatch({ patchId: input.patchId });
      const [grant] = yield* sql<{ id: string; subject: string | null; mailId: string | null }>`
      INSERT INTO patch_grants (id, patch_id, email, created_by, access)
      SELECT ${newInternalId("share")}, p.id, ${input.email.toLowerCase()}, actor.id, ${input.access ?? "read"}
      FROM patches p JOIN users actor ON actor.clerk_user_id = ${account.sub}
      WHERE p.id = ${input.patchId} AND actor.deactivated_at IS NULL AND ${live} AND ${manages(account.sub)}
      ON CONFLICT (patch_id, email) DO UPDATE SET
        id = CASE WHEN patch_grants.revoked THEN excluded.id ELSE patch_grants.id END,
        subject = CASE WHEN patch_grants.revoked THEN NULL ELSE patch_grants.subject END,
        clerk_invitation_id = CASE WHEN patch_grants.revoked THEN NULL ELSE patch_grants.clerk_invitation_id END,
        created_by = CASE WHEN patch_grants.revoked THEN excluded.created_by ELSE patch_grants.created_by END,
        access = CASE WHEN patch_grants.revoked THEN excluded.access ELSE patch_grants.access END,
        revoked = false
      RETURNING id, subject, clerk_invitation_id AS "mailId"`;
      if (grant === undefined) return yield* new CannotSharePatch({ patchId: input.patchId });
      yield* wake(input.patchId);
      if (input.destination !== undefined && grant.subject === null && grant.mailId === null) {
        const sent = yield* mail
          .create(input.email.toLowerCase(), input.destination(grant.id), "patch-recipient")
          .pipe(Effect.mapError((cause) => new InvitationDeliveryFailed({ cause })));
        const attached = yield* sql`UPDATE patch_grants SET clerk_invitation_id = ${sent}
        WHERE id = ${grant.id} AND NOT revoked AND clerk_invitation_id IS NULL RETURNING id`;
        if (attached.length === 0) {
          const kept =
            yield* sql`SELECT id FROM patch_grants WHERE id = ${grant.id} AND NOT revoked AND clerk_invitation_id = ${sent}`;
          if (kept.length === 0)
            yield* cancel(sent).pipe(
              Effect.mapError((cause) => new InvitationCompensationFailed({ cause }))
            );
        }
      }
      return grant.id;
    }
  );
  const revoke = Effect.fn("PatchGrants.revoke")(function* (account: Account, id: string) {
    // Durable denial precedes best-effort notification and remote email cancellation.
    const changed = yield* sql<{ patchId: string; mailId: string | null }>`UPDATE patch_grants s
      SET revoked = true FROM patches p
      WHERE s.id = ${id} AND p.id = s.patch_id AND ${manages(account.sub)}
      RETURNING s.patch_id AS "patchId", s.clerk_invitation_id AS "mailId"`;
    if (changed[0] === undefined) return false;
    yield* wake(changed[0].patchId);
    if (changed[0].mailId !== null)
      yield* cancel(changed[0].mailId).pipe(
        Effect.mapError((cause) => new GrantRevocationMailFailed({ cause }))
      );
    return true;
  });
  const setAccess = Effect.fn("PatchGrants.setAccess")(function* (
    account: Account,
    id: string,
    access: "read" | "write"
  ) {
    const changed = yield* sql<{ patchId: string }>`UPDATE patch_grants s SET access = ${access}
      FROM patches p WHERE s.id = ${id} AND p.id = s.patch_id AND NOT s.revoked
      AND ${manages(account.sub)} RETURNING s.patch_id AS "patchId"`;
    if (changed[0] === undefined) return false;
    yield* wake(changed[0].patchId);
    return true;
  });
  return PatchGrants.of({ inbox, managed, admit, accept, invite, revoke, setAccess });
});
export const layer = Layer.effect(PatchGrants, make);
