import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Testing from "@patchy/sql/testing";
import * as Companies from "./Companies.js";
import * as Users from "./Users.js";

const companyWithMember = Effect.fn("companyWithMember")(function* (
  handle: string,
  role: Users.Role = "member"
) {
  const companies = yield* Companies.Companies;
  const { company, user: admin } = yield* companies.create({
    handle,
    name: handle,
    clerkUserId: `clerk_${handle}`,
    email: `${handle}@example.com`,
    userName: "Admin"
  });
  const invite = yield* companies.createInvite({
    companyId: company.id,
    invitedBy: admin.id,
    email: `${handle}-member@example.com`,
    role
  });
  const member = yield* companies.consumeInvite({
    inviteId: invite.id,
    clerkUserId: `clerk_${handle}_member`,
    email: invite.email,
    name: "Member"
  });
  return { company, admin, member };
});
const outcome = {
  onSuccess: () => "ok",
  onFailure: (error: { readonly _tag: string }) => error._tag
};

it.layer(Layer.mergeAll(Companies.layer, Users.layer).pipe(Layer.provideMerge(Testing.layer())))(
  "Users",
  (it) => {
    it.effect(
      "refreshes changed claims, matches email case-insensitively, and performs no update for unchanged claims",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sql = yield* SqlClient.SqlClient;
          const { admin } = yield* companyWithMember("claim-refresh");
          // An audit observer makes unnecessary writes observable without
          // inspecting the service's query text or PostgreSQL's row internals.
          yield* sql.unsafe(`
          CREATE TABLE claim_refresh_audit (user_id TEXT NOT NULL);
          CREATE FUNCTION audit_claim_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            INSERT INTO claim_refresh_audit (user_id) VALUES (NEW.id);
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER claim_refresh_audit AFTER UPDATE ON users
            FOR EACH ROW EXECUTE FUNCTION audit_claim_refresh();
        `);
          const claims = {
            clerkUserId: admin.clerkUserId,
            email: admin.email.toUpperCase(),
            name: admin.name
          };
          assert.deepStrictEqual(yield* users.refreshClaims(claims), admin);
          assert.deepStrictEqual(
            yield* sql`SELECT user_id FROM claim_refresh_audit WHERE user_id = ${admin.id}`,
            []
          );
          const changed = yield* users.refreshClaims({
            ...claims,
            email: "Changed@Example.COM",
            name: "Changed Name"
          });
          assert.strictEqual(changed?.email, "changed@example.com");
          assert.strictEqual(changed?.name, "Changed Name");
          assert.isNull(yield* users.findByEmail(admin.email));
          assert.strictEqual((yield* users.findByEmail("CHANGED@example.com"))?.id, admin.id);
          assert.strictEqual((yield* users.findByClerkId(admin.clerkUserId))?.name, "Changed Name");
          yield* users.refreshClaims({
            ...claims,
            email: "changed@example.com",
            name: "Changed Name"
          });
          assert.deepStrictEqual(
            yield* sql`SELECT user_id FROM claim_refresh_audit WHERE user_id = ${admin.id}`,
            [{ user_id: admin.id }]
          );
          assert.isNull(
            yield* users.refreshClaims({
              clerkUserId: "clerk_absent",
              email: "absent@example.com",
              name: "Absent"
            })
          );
        })
    );

    it.effect(
      "promotes and demotes within the company, but cannot remove its final active admin",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const { company, admin, member } = yield* companyWithMember("roles-company");
          const adminRef = { companyId: company.id, userId: admin.id };
          const memberRef = { companyId: company.id, userId: member.id };
          assert.strictEqual(
            (yield* users.setRole({ ...adminRef, role: "member" }).pipe(Effect.flip))._tag,
            "LastAdmin"
          );
          assert.strictEqual(
            (yield* users.deactivate(adminRef).pipe(Effect.flip))._tag,
            "LastAdmin"
          );
          assert.strictEqual((yield* users.setRole({ ...memberRef, role: "admin" })).role, "admin");
          assert.strictEqual(
            (yield* users.setRole({ ...adminRef, role: "member" })).role,
            "member"
          );
          assert.strictEqual(
            (yield* users.setRole({ ...memberRef, role: "member" }).pipe(Effect.flip))._tag,
            "LastAdmin"
          );
          assert.strictEqual((yield* users.findByClerkId(member.clerkUserId))?.role, "admin");
          assert.strictEqual(
            (yield* users
              .setRole({ companyId: "cmp_elsewhere", userId: member.id, role: "member" })
              .pipe(Effect.flip))._tag,
            "UserNotFound"
          );
          assert.strictEqual(
            (yield* users
              .deactivate({ companyId: "cmp_elsewhere", userId: admin.id })
              .pipe(Effect.flip))._tag,
            "UserNotFound"
          );
          assert.strictEqual(
            (yield* users
              .reactivate({ companyId: "cmp_elsewhere", userId: admin.id })
              .pipe(Effect.flip))._tag,
            "UserNotFound"
          );
        })
    );

    it.effect("leaves one active admin when two admins are concurrently demoted", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const { company, admin, member } = yield* companyWithMember("demotion-race", "admin");
        const results = yield* Effect.all(
          [admin, member].map((user) =>
            users
              .setRole({ companyId: company.id, userId: user.id, role: "member" })
              .pipe(Effect.match(outcome))
          ),
          { concurrency: "unbounded" }
        );
        assert.deepStrictEqual(results.sort(), ["LastAdmin", "ok"]);
        const remaining = (yield* users.list(company.id)).filter(
          (user) => user.role === "admin" && user.deactivatedAt === null
        );
        assert.strictEqual(remaining.length, 1);
      })
    );

    it.effect(
      "serializes deactivation against demotion so the company never loses both admins",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const { company, admin, member } = yield* companyWithMember("deactivation-race", "admin");
          const results = yield* Effect.all(
            [
              users
                .deactivate({ companyId: company.id, userId: admin.id })
                .pipe(Effect.match(outcome)),
              users
                .setRole({ companyId: company.id, userId: member.id, role: "member" })
                .pipe(Effect.match(outcome))
            ],
            { concurrency: "unbounded" }
          );
          assert.deepStrictEqual(results.sort(), ["LastAdmin", "ok"]);
          assert.strictEqual(
            (yield* users.list(company.id)).filter(
              (user) => user.role === "admin" && user.deactivatedAt === null
            ).length,
            1
          );
        })
    );

    it.effect(
      "revokes every machine atomically on deactivation and never revives a key on reactivation",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sql = yield* SqlClient.SqlClient;
          const { company, admin, member } = yield* companyWithMember(
            "reactivation-company",
            "admin"
          );
          const input = { companyId: company.id, userId: member.id };
          yield* TestClock.setTime(Date.UTC(2026, 0, 1));
          yield* sql`
          INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at, revoked_at)
          VALUES ('tok_reactivate_one', ${member.id}, 'Laptop', 'reactivate-one-hash', now(), now() + interval '90 days', now(), NULL),
                 ('tok_reactivate_two', ${member.id}, 'Desktop', 'reactivate-two-hash', now(), now() + interval '90 days', now(), NULL),
                 ('tok_reactivate_old', ${member.id}, 'Old laptop', 'reactivate-old-hash', now(), now() + interval '90 days', now(), '2025-01-01'),
                 ('tok_reactivate_admin', ${admin.id}, 'Admin laptop', 'reactivate-admin-hash', now(), now() + interval '90 days', now(), NULL)`;
          const deactivated = yield* users.deactivate(input);
          assert.isNotNull(deactivated.deactivatedAt);
          assert.isNotNull((yield* users.findByClerkId(member.clerkUserId))?.deactivatedAt);
          const revoked = yield* sql`
          SELECT id, revoked_at IS NOT NULL AS revoked FROM machine_tokens
          WHERE user_id = ${member.id} ORDER BY id`;
          assert.deepStrictEqual(revoked, [
            { id: "tok_reactivate_old", revoked: true },
            { id: "tok_reactivate_one", revoked: true },
            { id: "tok_reactivate_two", revoked: true }
          ]);
          assert.strictEqual(
            (yield* users.deactivate({ companyId: company.id, userId: admin.id }).pipe(Effect.flip))
              ._tag,
            "LastAdmin"
          );
          assert.deepStrictEqual(
            yield* sql`SELECT revoked_at IS NULL AS live FROM machine_tokens WHERE id = 'tok_reactivate_admin'`,
            [{ live: true }]
          );
          yield* TestClock.adjust(60_000);
          assert.deepStrictEqual(
            (yield* users.deactivate(input)).deactivatedAt,
            deactivated.deactivatedAt
          );
          const restored = yield* users.reactivate(input);
          assert.isNull(restored.deactivatedAt);
          assert.strictEqual(restored.role, "admin");
          assert.strictEqual(restored.companyId, company.id);
          assert.deepStrictEqual(yield* users.reactivate(input), restored);
          assert.deepStrictEqual(
            yield* sql`
          SELECT id, revoked_at IS NOT NULL AS revoked FROM machine_tokens
          WHERE user_id = ${member.id} ORDER BY id`,
            revoked
          );
          assert.deepStrictEqual(
            yield* sql`SELECT revoked_at = '2025-01-01'::timestamptz AS preserved FROM machine_tokens WHERE id = 'tok_reactivate_old'`,
            [{ preserved: true }]
          );
          // A restored admin counts again, so the other admin can now step down.
          yield* users.setRole({ companyId: company.id, userId: admin.id, role: "member" });
          assert.strictEqual((yield* users.findByClerkId(member.clerkUserId))?.role, "admin");
        })
    );

    it.effect("rolls deactivation back if token revocation cannot complete", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sql = yield* SqlClient.SqlClient;
        const { company, member } = yield* companyWithMember("deactivation-atomic");
        yield* sql`
          INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
          VALUES ('tok_deactivation_atomic', ${member.id}, 'Laptop', 'deactivation-atomic-hash', now(), now() + interval '90 days', now())`;
        yield* sql.unsafe(`
          CREATE FUNCTION refuse_atomic_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.id = 'tok_deactivation_atomic' THEN
              RAISE EXCEPTION 'Revocation unavailable';
            END IF;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER refuse_atomic_revocation BEFORE UPDATE ON machine_tokens
            FOR EACH ROW EXECUTE FUNCTION refuse_atomic_revocation();
        `);
        assert.strictEqual(
          (yield* users.deactivate({ companyId: company.id, userId: member.id }).pipe(Effect.flip))
            ._tag,
          "SqlError"
        );
        assert.isNull((yield* users.findByClerkId(member.clerkUserId))?.deactivatedAt);
        assert.deepStrictEqual(
          yield* sql`SELECT revoked_at IS NULL AS live FROM machine_tokens WHERE id = 'tok_deactivation_atomic'`,
          [{ live: true }]
        );
      })
    );
  }
);
