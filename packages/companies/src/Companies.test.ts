import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Testing from "@patchy/sql/testing";
import * as Companies from "./Companies.js";
import * as Users from "./Users.js";

const companyInput = (handle: string): Companies.CreateInput => ({
  handle,
  name: handle,
  clerkUserId: `clerk_${handle}`,
  email: `${handle}@example.com`,
  userName: "Founder"
});
const outcome = {
  onSuccess: () => "ok",
  onFailure: (error: { readonly _tag: string }) => error._tag
};

it.layer(Layer.mergeAll(Companies.layer, Users.layer).pipe(Layer.provideMerge(Testing.layer())))(
  "Companies",
  (it) => {
    it.effect(
      "enforces handle boundaries and the fixed reserved list without normalizing addresses",
      () =>
        Effect.gen(function* () {
          const companies = yield* Companies.Companies;
          for (const handle of ["ab", "a".repeat(33), "-abc", "abc-", "Abc", "a_b", "a b"]) {
            assert.strictEqual(
              (yield* companies.create(companyInput(handle)).pipe(Effect.flip))._tag,
              "InvalidHandle"
            );
          }
          for (const handle of Companies.RESERVED_HANDLES) {
            assert.strictEqual(
              (yield* companies.create(companyInput(handle)).pipe(Effect.flip))._tag,
              "ReservedHandle"
            );
          }
          for (const handle of ["a-1", "a".repeat(32)]) {
            const created = yield* companies.create(companyInput(handle));
            assert.strictEqual((yield* companies.findById(created.company.id))?.handle, handle);
            assert.strictEqual(created.user.companyId, created.company.id);
            assert.strictEqual(created.user.role, "admin");
          }
        })
    );

    it.effect(
      "creates a company and its initial admin together, rolling back either user uniqueness conflict",
      () =>
        Effect.gen(function* () {
          const companies = yield* Companies.Companies;
          const users = yield* Users.Users;
          const sql = yield* SqlClient.SqlClient;
          const input = { ...companyInput("atomic-company"), email: "Founder@Example.COM" };
          const created = yield* companies.create(input);
          assert.strictEqual(
            (yield* users.findByEmail("FOUNDER@example.com"))?.id,
            created.user.id
          );
          assert.strictEqual((yield* users.findByClerkId(input.clerkUserId))?.role, "admin");
          assert.strictEqual(
            (yield* companies
              .create({ ...input, handle: "duplicate-clerk", email: "other@example.com" })
              .pipe(Effect.flip))._tag,
            "AlreadyInCompany"
          );
          assert.strictEqual(
            (yield* companies
              .create({ ...input, handle: "duplicate-email", clerkUserId: "clerk_other" })
              .pipe(Effect.flip))._tag,
            "AlreadyInCompany"
          );
          const orphaned =
            yield* sql`SELECT id FROM companies WHERE handle IN ('duplicate-clerk', 'duplicate-email')`;
          assert.deepStrictEqual(orphaned, []);
          assert.strictEqual((yield* users.list(created.company.id)).length, 1);
        })
    );

    it.effect("lets only one create win a handle race without leaving an orphan admin", () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const sql = yield* SqlClient.SqlClient;
        const first = companyInput("handle-race");
        const results = yield* Effect.all(
          [
            companies.create(first).pipe(Effect.match(outcome)),
            companies
              .create({
                ...first,
                clerkUserId: "clerk_race_other",
                email: "race-other@example.com"
              })
              .pipe(Effect.match(outcome))
          ],
          { concurrency: "unbounded" }
        );
        assert.deepStrictEqual(results.sort(), ["HandleTaken", "ok"]);
        const rows = yield* sql`
          SELECT count(DISTINCT c.id)::int AS companies, count(u.id)::int AS admins
          FROM companies c JOIN users u ON u.company_id = c.id
          WHERE c.handle = 'handle-race' AND u.role = 'admin'`;
        assert.deepStrictEqual(rows, [{ companies: 1, admins: 1 }]);
      })
    );

    it.effect(
      "keeps one live invite per company and lowercased email, and allows revocation and reinviting",
      () =>
        Effect.gen(function* () {
          const companies = yield* Companies.Companies;
          const first = yield* companies.create(companyInput("invites-first"));
          const second = yield* companies.create(companyInput("invites-second"));
          const input = {
            companyId: first.company.id,
            invitedBy: first.user.id,
            email: "Invitee@EXAMPLE.com"
          };
          const results = yield* Effect.all(
            [
              companies.createInvite(input).pipe(Effect.match(outcome)),
              companies
                .createInvite({ ...input, email: "invitee@example.com" })
                .pipe(Effect.match(outcome))
            ],
            { concurrency: "unbounded" }
          );
          assert.deepStrictEqual(results.sort(), ["AlreadyInvited", "ok"]);
          const [invite] = yield* companies.listInvites(first.company.id);
          assert.strictEqual(invite!.email, "invitee@example.com");
          const other = yield* companies.createInvite({
            ...input,
            companyId: second.company.id,
            invitedBy: second.user.id
          });
          assert.deepStrictEqual(
            (yield* companies.findInvitesByEmail("INVITEE@example.com"))
              .map((row) => row.id)
              .sort(),
            [invite!.id, other.id].sort()
          );
          assert.strictEqual(
            (yield* companies
              .revokeInvite({ companyId: second.company.id, inviteId: invite!.id })
              .pipe(Effect.flip))._tag,
            "InviteUnavailable"
          );
          const revoked = yield* companies.revokeInvite({
            companyId: first.company.id,
            inviteId: invite!.id
          });
          assert.isNotNull(revoked.revokedAt);
          const again = yield* companies.revokeInvite({
            companyId: first.company.id,
            inviteId: invite!.id
          });
          assert.deepStrictEqual(again.revokedAt, revoked.revokedAt);
          assert.deepStrictEqual(yield* companies.listInvites(first.company.id), []);
          const replacement = yield* companies.createInvite(input);
          assert.notStrictEqual(replacement.id, invite!.id);
          assert.deepStrictEqual(
            (yield* companies.listInvites(first.company.id)).map((row) => row.id),
            [replacement.id]
          );
          assert.strictEqual(
            (yield* companies
              .consumeInvite({
                inviteId: invite!.id,
                clerkUserId: "clerk_revoked",
                email: input.email,
                name: "Invitee"
              })
              .pipe(Effect.flip))._tag,
            "InviteUnavailable"
          );
        })
    );

    it.effect(
      "matches claims case-insensitively, keeps the invited role, and refuses users already in any company",
      () =>
        Effect.gen(function* () {
          const companies = yield* Companies.Companies;
          const users = yield* Users.Users;
          const first = yield* companies.create(companyInput("join-first"));
          const second = yield* companies.create(companyInput("join-second"));
          const invite = yield* companies.createInvite({
            companyId: first.company.id,
            invitedBy: first.user.id,
            email: "join@example.com",
            role: "admin"
          });
          const other = yield* companies.createInvite({
            companyId: second.company.id,
            invitedBy: second.user.id,
            email: invite.email
          });
          const claims = { clerkUserId: "clerk_join", email: "JOIN@EXAMPLE.COM", name: "Joined" };
          assert.strictEqual(
            (yield* companies
              .consumeInvite({ ...claims, inviteId: invite.id, email: "wrong@example.com" })
              .pipe(Effect.flip))._tag,
            "InviteUnavailable"
          );
          const joined = yield* companies.consumeInvite({ ...claims, inviteId: invite.id });
          assert.strictEqual(joined.companyId, first.company.id);
          assert.strictEqual(joined.role, "admin");
          assert.strictEqual(joined.email, "join@example.com");
          assert.deepStrictEqual(yield* companies.listInvites(first.company.id), []);
          assert.strictEqual(
            (yield* companies.consumeInvite({ ...claims, inviteId: other.id }).pipe(Effect.flip))
              ._tag,
            "AlreadyInCompany"
          );
          assert.deepStrictEqual(
            (yield* companies.listInvites(second.company.id)).map((row) => row.id),
            [other.id]
          );
          assert.strictEqual(
            (yield* companies
              .createInvite({
                companyId: second.company.id,
                invitedBy: second.user.id,
                email: claims.email
              })
              .pipe(Effect.flip))._tag,
            "AlreadyInCompany"
          );
          yield* users.refreshClaims({ ...claims, email: "joined-new@example.com" });
          const replacement = yield* companies.createInvite({
            companyId: first.company.id,
            invitedBy: first.user.id,
            email: invite.email
          });
          assert.notStrictEqual(replacement.id, invite.id);
        })
    );

    it.effect("consumes one invite only once under concurrent sign-ins", () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const users = yield* Users.Users;
        const created = yield* companies.create(companyInput("consume-race"));
        const invite = yield* companies.createInvite({
          companyId: created.company.id,
          invitedBy: created.user.id,
          email: "consume-race@example.net"
        });
        const results = yield* Effect.all(
          ["clerk_consume_a", "clerk_consume_b"].map((clerkUserId) =>
            companies
              .consumeInvite({
                inviteId: invite.id,
                clerkUserId,
                email: invite.email,
                name: "Joining"
              })
              .pipe(Effect.match(outcome))
          ),
          { concurrency: "unbounded" }
        );
        assert.strictEqual(results.filter((result) => result === "ok").length, 1);
        assert.isTrue(
          results.every((result) =>
            ["ok", "AlreadyInCompany", "InviteUnavailable"].includes(result)
          )
        );
        assert.strictEqual(
          (yield* users.list(created.company.id)).filter((user) => user.email === invite.email)
            .length,
          1
        );
        assert.deepStrictEqual(yield* companies.findInvitesByEmail(invite.email), []);
      })
    );

    it.effect("joins exactly one company when two different invitations race", () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const users = yield* Users.Users;
        const first = yield* companies.create(companyInput("company-race-one"));
        const second = yield* companies.create(companyInput("company-race-two"));
        const email = "company-race@example.net";
        const invites = yield* Effect.all(
          [first, second].map(({ company, user }) =>
            companies.createInvite({ companyId: company.id, invitedBy: user.id, email })
          )
        );
        const results = yield* Effect.all(
          invites.map((invite) =>
            companies
              .consumeInvite({
                inviteId: invite.id,
                clerkUserId: "clerk_company_race",
                email,
                name: "Joining"
              })
              .pipe(Effect.match(outcome))
          ),
          { concurrency: "unbounded" }
        );
        assert.deepStrictEqual(results.sort(), ["AlreadyInCompany", "ok"]);
        const user = yield* users.findByClerkId("clerk_company_race");
        const remaining = yield* companies.findInvitesByEmail(email);
        assert.strictEqual(remaining.length, 1);
        assert.notStrictEqual(remaining[0]!.companyId, user!.companyId);
      })
    );
  }
);
