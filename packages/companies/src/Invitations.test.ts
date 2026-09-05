import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Testing from "@patchy/sql/testing";
import * as Companies from "./Companies.js";
import * as Invitations from "./Invitations.js";
import * as InviteMail from "./InviteMail.js";

const companyInput = (handle: string): Companies.CreateInput => ({
  handle,
  name: handle,
  clerkUserId: `clerk_${handle}`,
  email: `${handle}@example.com`,
  userName: "Founder"
});

it.layer(Companies.layer.pipe(Layer.provideMerge(Testing.layer())))("Invitations", (it) => {
  it.effect("keeps a joinable invitation when Clerk cannot deliver its email", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const { company, user } = yield* companies.create(companyInput("mail-failure"));
      const result = yield* Invitations.create({
        companyId: company.id,
        invitedBy: user.id,
        email: "No-Mail@EXAMPLE.com",
        role: "admin"
      }).pipe(Effect.provide(InviteMail.layerFailing));
      assert.isTrue(result.mailFailed);
      const [pending] = yield* companies.findInvitesByEmail("no-mail@example.com");
      assert.strictEqual(pending!.id, result.invite.id);
      assert.isNull(pending!.clerkInvitationId);
      yield* TestClock.adjust("31 days");
      const joined = yield* companies.consumeInvite({
        inviteId: pending!.id,
        clerkUserId: "clerk_no_mail",
        email: "no-mail@example.com",
        name: "No Mail"
      });
      assert.strictEqual(joined.companyId, company.id);
      assert.strictEqual(joined.role, "admin");
    })
  );

  it.effect(
    "replaces the previous emailed link on resend and revokes every delivered invitation",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const recording = yield* InviteMail.Recording;
        const { company, user } = yield* companies.create(companyInput("mail-lifecycle"));
        const created = yield* Invitations.create({
          companyId: company.id,
          invitedBy: user.id,
          email: "Lifecycle@EXAMPLE.com",
          role: "member"
        });
        const reference = { companyId: company.id, inviteId: created.invite.id };
        const resent = yield* Invitations.resend(reference);
        assert.isFalse(created.mailFailed);
        assert.isFalse(resent.mailFailed);
        assert.strictEqual(resent.invite.id, created.invite.id);
        assert.notStrictEqual(resent.invite.clerkInvitationId, created.invite.clerkInvitationId);
        assert.deepStrictEqual(yield* companies.listInvites(company.id), [resent.invite]);
        const revoked = yield* Invitations.revoke(reference);
        assert.isFalse(revoked.mailFailed);
        assert.isNotNull(revoked.invite.revokedAt);
        assert.deepStrictEqual(yield* companies.findInvitesByEmail(created.invite.email), []);
        assert.deepStrictEqual(yield* recording.events, [
          {
            operation: "create",
            email: "lifecycle@example.com",
            id: created.invite.clerkInvitationId
          },
          { operation: "revoke", id: created.invite.clerkInvitationId },
          {
            operation: "create",
            email: "lifecycle@example.com",
            id: resent.invite.clerkInvitationId
          },
          { operation: "revoke", id: resent.invite.clerkInvitationId }
        ]);
        assert.strictEqual(
          (yield* Invitations.resend(reference).pipe(Effect.flip))._tag,
          "InviteUnavailable"
        );
        assert.strictEqual(
          (yield* companies
            .consumeInvite({
              inviteId: reference.inviteId,
              clerkUserId: "clerk_mail_revoked",
              email: created.invite.email,
              name: "Revoked"
            })
            .pipe(Effect.flip))._tag,
          "InviteUnavailable"
        );
      }).pipe(Effect.provide(InviteMail.layerRecording))
  );

  it.effect(
    "retries failed delivery without duplicating the invite and sends nothing when the previous link cannot be revoked",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const recording = yield* InviteMail.Recording;
        const mail = yield* InviteMail.InviteMail;
        const failing = yield* InviteMail.InviteMail.pipe(Effect.provide(InviteMail.layerFailing));
        const revokeFails = Layer.succeed(
          InviteMail.InviteMail,
          InviteMail.InviteMail.of({ create: mail.create, revoke: failing.revoke })
        );
        const { company, user } = yield* companies.create(companyInput("mail-retry"));
        const created = yield* Invitations.create({
          companyId: company.id,
          invitedBy: user.id,
          email: "retry@example.com"
        }).pipe(Effect.provide(InviteMail.layerFailing));
        const reference = { companyId: company.id, inviteId: created.invite.id };
        const resent = yield* Invitations.resend(reference);
        assert.isFalse(resent.mailFailed);
        assert.strictEqual(resent.invite.id, created.invite.id);
        assert.isNotNull(resent.invite.clerkInvitationId);
        const failed = yield* Invitations.resend(reference).pipe(Effect.provide(revokeFails));
        assert.isTrue(failed.mailFailed);
        assert.deepStrictEqual(yield* companies.listInvites(company.id), [resent.invite]);
        const revoked = yield* Invitations.revoke(reference);
        assert.isFalse(revoked.mailFailed);
        assert.deepStrictEqual(yield* recording.events, [
          { operation: "create", email: "retry@example.com", id: resent.invite.clerkInvitationId },
          { operation: "revoke", id: resent.invite.clerkInvitationId }
        ]);
      }).pipe(Effect.provide(InviteMail.layerRecording))
  );

  it.effect(
    "clears the revoked delivery when sending its replacement fails, then recovers on resend",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const recording = yield* InviteMail.Recording;
        const mail = yield* InviteMail.InviteMail;
        const failing = yield* InviteMail.InviteMail.pipe(Effect.provide(InviteMail.layerFailing));
        const createFails = Layer.succeed(
          InviteMail.InviteMail,
          InviteMail.InviteMail.of({ create: failing.create, revoke: mail.revoke })
        );
        const { company, user } = yield* companies.create(companyInput("mail-replace-failure"));
        const created = yield* Invitations.create({
          companyId: company.id,
          invitedBy: user.id,
          email: "replace-failure@example.com"
        });
        const reference = { companyId: company.id, inviteId: created.invite.id };
        const failed = yield* Invitations.resend(reference).pipe(Effect.provide(createFails));
        assert.isTrue(failed.mailFailed);
        const [pending] = yield* companies.listInvites(company.id);
        assert.strictEqual(pending!.id, created.invite.id);
        assert.isNull(pending!.clerkInvitationId);
        assert.isNull(failed.invite.clerkInvitationId);
        const recovered = yield* Invitations.resend(reference);
        assert.isFalse(recovered.mailFailed);
        assert.strictEqual(recovered.invite.id, created.invite.id);
        const revoked = yield* Invitations.revoke(reference);
        assert.isFalse(revoked.mailFailed);
        assert.deepStrictEqual(yield* recording.events, [
          {
            operation: "create",
            email: "replace-failure@example.com",
            id: created.invite.clerkInvitationId
          },
          { operation: "revoke", id: created.invite.clerkInvitationId },
          {
            operation: "create",
            email: "replace-failure@example.com",
            id: recovered.invite.clerkInvitationId
          },
          { operation: "revoke", id: recovered.invite.clerkInvitationId }
        ]);
      }).pipe(Effect.provide(InviteMail.layerRecording))
  );

  it.effect("recovers resend when Clerk revoked the old link but its response was lost", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const recording = yield* InviteMail.Recording;
      const mail = yield* InviteMail.InviteMail;
      const { company, user } = yield* companies.create(companyInput("mail-lost-response"));
      const created = yield* Invitations.create({
        companyId: company.id,
        invitedBy: user.id,
        email: "lost-response@example.com"
      });
      const reference = { companyId: company.id, inviteId: created.invite.id };
      const lostResponse = Layer.succeed(
        InviteMail.InviteMail,
        InviteMail.InviteMail.of({
          create: mail.create,
          revoke: (id) =>
            mail
              .revoke(id)
              .pipe(
                Effect.andThen(
                  Effect.fail(
                    new InviteMail.InviteMailError({ operation: "revoke", invitationId: id })
                  )
                )
              )
        })
      );
      assert.isTrue(
        (yield* Invitations.resend(reference).pipe(Effect.provide(lostResponse))).mailFailed
      );
      const alreadyRevoked = Layer.succeed(
        InviteMail.InviteMail,
        InviteMail.InviteMail.of({
          create: mail.create,
          revoke: (id) => Effect.fail(new InviteMail.InvitationAlreadyRevoked({ invitationId: id }))
        })
      );
      const recovered = yield* Invitations.resend(reference).pipe(Effect.provide(alreadyRevoked));
      assert.isFalse(recovered.mailFailed);
      assert.strictEqual(recovered.invite.id, created.invite.id);
      assert.notStrictEqual(recovered.invite.clerkInvitationId, created.invite.clerkInvitationId);
      assert.deepStrictEqual(yield* companies.listInvites(company.id), [recovered.invite]);
      const events = yield* recording.events;
      assert.strictEqual(events.filter((event) => event.operation === "create").length, 2);
      const revoked = yield* Invitations.revoke(reference).pipe(Effect.provide(alreadyRevoked));
      assert.isFalse(revoked.mailFailed);
      assert.deepStrictEqual(yield* companies.listInvites(company.id), []);
    }).pipe(Effect.provide(InviteMail.layerRecording))
  );

  it.effect("ends local admission even when Clerk refuses to revoke the delivered email", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const { company, user } = yield* companies.create(companyInput("mail-revoke-failure"));
      const created = yield* Invitations.create({
        companyId: company.id,
        invitedBy: user.id,
        email: "revoke-failure@example.com"
      });
      const reference = { companyId: company.id, inviteId: created.invite.id };
      const revoked = yield* Invitations.revoke(reference).pipe(
        Effect.provide(InviteMail.layerFailing)
      );
      assert.isTrue(revoked.mailFailed);
      assert.isNotNull(revoked.invite.revokedAt);
      assert.deepStrictEqual(yield* companies.listInvites(company.id), []);
      assert.strictEqual(
        (yield* companies
          .consumeInvite({
            inviteId: reference.inviteId,
            clerkUserId: "clerk_revoke_failure",
            email: created.invite.email,
            name: "Revoked"
          })
          .pipe(Effect.flip))._tag,
        "InviteUnavailable"
      );
      const replacement = yield* Invitations.create({
        companyId: company.id,
        invitedBy: user.id,
        email: created.invite.email
      });
      assert.notStrictEqual(replacement.invite.id, created.invite.id);
      assert.deepStrictEqual(yield* companies.listInvites(company.id), [replacement.invite]);
    }).pipe(Effect.provide(InviteMail.layerRecording))
  );

  it.effect(
    "sends no email for a refused invite while allowing another company to invite the address",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const recording = yield* InviteMail.Recording;
        const first = yield* companies.create(companyInput("mail-first"));
        const second = yield* companies.create(companyInput("mail-second"));
        const input = {
          companyId: first.company.id,
          invitedBy: first.user.id,
          email: "shared-mail@example.com"
        };
        const created = yield* Invitations.create(input);
        assert.strictEqual(
          (yield* Invitations.create({ ...input, email: "SHARED-MAIL@EXAMPLE.COM" }).pipe(
            Effect.flip
          ))._tag,
          "AlreadyInvited"
        );
        assert.strictEqual(
          (yield* Invitations.create({ ...input, email: second.user.email }).pipe(Effect.flip))
            ._tag,
          "AlreadyInCompany"
        );
        const otherReference = { companyId: second.company.id, inviteId: created.invite.id };
        assert.strictEqual(
          (yield* Invitations.resend(otherReference).pipe(Effect.flip))._tag,
          "InviteUnavailable"
        );
        assert.strictEqual(
          (yield* Invitations.revoke(otherReference).pipe(Effect.flip))._tag,
          "InviteUnavailable"
        );
        const other = yield* Invitations.create({
          ...input,
          companyId: second.company.id,
          invitedBy: second.user.id
        });
        assert.deepStrictEqual(
          (yield* companies.findInvitesByEmail(input.email)).map((invite) => invite.id).sort(),
          [created.invite.id, other.invite.id].sort()
        );
        assert.deepStrictEqual(yield* recording.events, [
          { operation: "create", email: input.email, id: created.invite.clerkInvitationId },
          { operation: "create", email: input.email, id: other.invite.clerkInvitationId }
        ]);
      }).pipe(Effect.provide(InviteMail.layerRecording))
  );

  it.effect("serializes a resend racing with revoke so the final delivery is revoked", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const recording = yield* InviteMail.Recording;
      const { company, user } = yield* companies.create(companyInput("mail-race"));
      const created = yield* Invitations.create({
        companyId: company.id,
        invitedBy: user.id,
        email: "mail-race-invitee@example.com"
      });
      const reference = { companyId: company.id, inviteId: created.invite.id };
      const [resent, revoked] = yield* Effect.all(
        [
          Invitations.resend(reference).pipe(
            Effect.catchTags({ InviteUnavailable: () => Effect.succeed(null) })
          ),
          Invitations.revoke(reference)
        ],
        { concurrency: "unbounded" }
      );
      const finalId = resent?.invite.clerkInvitationId ?? created.invite.clerkInvitationId;
      assert.strictEqual(revoked.invite.clerkInvitationId, finalId);
      const events = yield* recording.events;
      assert.deepStrictEqual(events.at(-1), { operation: "revoke", id: finalId });
      assert.deepStrictEqual(yield* companies.listInvites(company.id), []);
    }).pipe(Effect.provide(InviteMail.layerRecording))
  );
});
