import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { WhatsNew } from "@patchy/core";
import { ddl } from "@patchy/sql";
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
// An audit observer makes unnecessary writes observable without
// inspecting the service's query text or PostgreSQL's row internals.
const auditClaimRefresh = ddl(
  `CREATE TABLE IF NOT EXISTS claim_refresh_audit (user_id TEXT NOT NULL)`,
  `CREATE OR REPLACE FUNCTION audit_claim_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO claim_refresh_audit (user_id) VALUES (NEW.id);
      RETURN NEW;
    END;
    $$`,
  `CREATE OR REPLACE TRIGGER claim_refresh_audit AFTER UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION audit_claim_refresh()`
);
// Waits until `count` sessions on this test's database wait on a lock.
const lockWaits = (count: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.pipe(
      Effect.repeat({ until: (rows) => rows.length === count })
    )
  );
// Bounds one wait in a concurrency case. It fails naming the wait when one of `fibers` ends
// first, or after three real seconds, instead of hanging until the test's own timeout.
const within = <A, E, R>(
  name: string,
  wait: Effect.Effect<A, E, R>,
  ...fibers: ReadonlyArray<Fiber.Fiber<unknown, unknown>>
) =>
  Effect.raceAllFirst([
    wait,
    TestClock.withLive(Effect.sleep("3 seconds")).pipe(
      Effect.map(() => assert.fail(`${name}: still waiting after three seconds`))
    ),
    ...fibers.map((fiber) =>
      Fiber.await(fiber).pipe(Effect.map((exit) => assert.fail(`${name}: ended first: ${exit}`)))
    )
  ]);
// Runs `change` in a transaction left open, holding its row locks, until `release` commits it.
// The transaction rolls back if the case ends first.
const hold = Effect.fn("hold")(function* <A, E>(name: string, change: Effect.Effect<A, E>) {
  const sql = yield* SqlClient.SqlClient;
  const ran = yield* Deferred.make<void>();
  const commit = yield* Deferred.make<void>();
  const fiber = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const result = yield* change;
        yield* Deferred.succeed(ran, undefined);
        yield* Deferred.await(commit);
        return result;
      })
    )
    .pipe(Effect.forkScoped);
  yield* within(name, Deferred.await(ran), fiber);
  return {
    fiber,
    release: Deferred.succeed(commit, undefined).pipe(
      Effect.andThen(within(`${name}: commit`, Fiber.join(fiber)))
    )
  };
});
const outcome = {
  onSuccess: () => "ok",
  onFailure: (error: { readonly _tag: string }) => error._tag
};

it("keeps a given name exactly and falls back to the whole email when its local part is empty", () => {
  assert.strictEqual(Users.displayName({ name: " Ada ", email: "x@example.com" }), " Ada ");
  assert.strictEqual(Users.displayName({ name: "", email: "@Example.com" }), "@example.com");
});

it.layer(Layer.mergeAll(Companies.layer, Users.layer).pipe(Layer.provideMerge(Testing.layer())))(
  "Users",
  (it) => {
    it.effect(
      "refreshes changed claims, matches email case-insensitively, and performs no update for unchanged claims",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sql = yield* SqlClient.SqlClient;
          const { company, admin } = yield* companyWithMember("claim-refresh");
          yield* auditClaimRefresh;
          const claims = {
            clerkUserId: admin.clerkUserId,
            email: admin.email.toUpperCase(),
            name: admin.name
          };
          const theirCompany = { id: company.id, handle: company.handle, name: company.name };
          assert.deepStrictEqual(yield* users.refreshClaims(claims), {
            user: admin,
            company: theirCompany
          });
          assert.deepStrictEqual(
            yield* sql`SELECT user_id FROM claim_refresh_audit WHERE user_id = ${admin.id}`,
            []
          );
          const changed = yield* users.refreshClaims({
            ...claims,
            email: "Changed@Example.COM",
            name: "Changed Name"
          });
          assert.deepStrictEqual(changed, {
            user: new Users.User({ ...admin, email: "changed@example.com", name: "Changed Name" }),
            company: theirCompany
          });
          assert.deepStrictEqual(changed?.user, yield* users.findByClerkId(admin.clerkUserId));
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

    it.effect("names a nameless person by their email's local part until a real name arrives", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sql = yield* SqlClient.SqlClient;
        const { member } = yield* companyWithMember("nameless-refresh");
        yield* auditClaimRefresh;
        const updates = sql`SELECT user_id FROM claim_refresh_audit WHERE user_id = ${member.id}`;
        const claims = { clerkUserId: member.clerkUserId, email: member.email, name: "" };
        assert.strictEqual(
          (yield* users.refreshClaims(claims))?.user.name,
          "nameless-refresh-member"
        );
        assert.strictEqual((yield* updates).length, 1);
        yield* users.refreshClaims({ ...claims, name: " \t" });
        yield* users.refreshClaims({ ...claims, email: member.email.toUpperCase() });
        assert.strictEqual((yield* updates).length, 1);
        assert.strictEqual(
          (yield* users.refreshClaims({ ...claims, name: "Grace Hopper" }))?.user.name,
          "Grace Hopper"
        );
        assert.strictEqual(
          (yield* users.refreshClaims(claims))?.user.name,
          "nameless-refresh-member"
        );
        const moved = yield* users.refreshClaims({ ...claims, email: "Grace@Example.com" });
        assert.deepInclude(moved?.user, { email: "grace@example.com", name: "grace" });
      })
    );

    it.effect("writes once and answers the stored row when two refreshes race", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sql = yield* SqlClient.SqlClient;
        const { company, member } = yield* companyWithMember("claim-race");
        yield* auditClaimRefresh;
        const claims = { clerkUserId: member.clerkUserId, email: member.email, name: "Raced" };
        const first = yield* hold("the first refresh", users.refreshClaims(claims));
        // The second reads the old name, so it writes too, and waits on the first's row.
        const second = yield* users.refreshClaims(claims).pipe(Effect.forkScoped);
        yield* within("the second refresh waiting", lockWaits(1), first.fiber, second);
        yield* first.release;
        assert.deepStrictEqual(yield* within("the second refresh", Fiber.join(second)), {
          user: (yield* users.findByClerkId(member.clerkUserId))!,
          company: { id: company.id, handle: company.handle, name: company.name }
        });
        assert.lengthOf(
          yield* sql`SELECT user_id FROM claim_refresh_audit WHERE user_id = ${member.id}`,
          1
        );
      }).pipe(Effect.scoped)
    );

    it.effect("a refresh that waits on an admin's change answers the row that change left", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const companies = yield* Companies.Companies;
        const sql = yield* SqlClient.SqlClient;
        const { company, member } = yield* companyWithMember("claim-wait", "admin");
        const ref = { companyId: company.id, userId: member.id };
        // Holds `change` until a refresh with new claims, `name`, waits on the row.
        const refreshDuring = <A, E>(change: Effect.Effect<A, E>, name: string) =>
          Effect.gen(function* () {
            const held = yield* hold(`${name}: the change`, change);
            const refreshed = yield* users
              .refreshClaims({ clerkUserId: member.clerkUserId, email: member.email, name })
              .pipe(Effect.forkScoped);
            yield* within(`${name}: the refresh waiting`, lockWaits(1), held.fiber, refreshed);
            const result = yield* held.release;
            const answer = yield* within(`${name}: the refresh`, Fiber.join(refreshed));
            assert.deepStrictEqual(answer?.user, yield* users.findByClerkId(member.clerkUserId));
            return { result, answer };
          }).pipe(Effect.scoped);

        // The company keeps its id, so only a read after the wait sees its new name.
        const demoted = yield* refreshDuring(
          Effect.gen(function* () {
            yield* sql`UPDATE companies SET name = 'Renamed Inc' WHERE id = ${company.id}`;
            return yield* users.setRole({ ...ref, role: "member" });
          }),
          "Demoted"
        );
        assert.strictEqual(demoted.answer?.user.role, "member");
        assert.deepStrictEqual(demoted.answer?.company, {
          id: company.id,
          handle: company.handle,
          name: "Renamed Inc"
        });
        const deactivated = yield* refreshDuring(users.deactivate(ref), "Deactivated");
        assert.isNotNull(deactivated.answer?.user.deactivatedAt);
        // The company the user moves to is created by the same transaction that moves them.
        const moved = yield* refreshDuring(
          Effect.gen(function* () {
            const created = yield* companies.create({
              handle: "claim-wait-moved",
              name: "Moved Inc",
              clerkUserId: "clerk_claim_wait_moved",
              email: "claim-wait-moved@example.com",
              userName: "Admin"
            });
            yield* sql`UPDATE users SET company_id = ${created.company.id} WHERE id = ${member.id}`;
            return created.company;
          }),
          "Moved"
        );
        assert.deepStrictEqual(moved.answer?.company, {
          id: moved.result.id,
          handle: "claim-wait-moved",
          name: "Moved Inc"
        });
      })
    );

    it.effect("a refresh with unchanged claims answers without waiting on a held change", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sql = yield* SqlClient.SqlClient;
        const { company, member } = yield* companyWithMember("claim-unblocked");
        yield* auditClaimRefresh;
        const held = yield* hold(
          "the deactivation",
          users.deactivate({ companyId: company.id, userId: member.id })
        );
        // Answers while the deactivation still holds the row: the active row it can see.
        const answer = yield* within(
          "the unchanged refresh",
          users.refreshClaims({
            clerkUserId: member.clerkUserId,
            email: member.email,
            name: member.name
          }),
          held.fiber
        );
        assert.deepStrictEqual(answer, {
          user: member,
          company: { id: company.id, handle: company.handle, name: company.name }
        });
        yield* held.release;
        // The deactivation's own update is the only one.
        assert.lengthOf(
          yield* sql`SELECT user_id FROM claim_refresh_audit WHERE user_id = ${member.id}`,
          1
        );
      }).pipe(Effect.scoped)
    );

    it.effect("refreshes queued on a deactivation answer it, whichever writes the claims", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sql = yield* SqlClient.SqlClient;
        const { company, member } = yield* companyWithMember("claim-queue");
        yield* auditClaimRefresh;
        const claims = { clerkUserId: member.clerkUserId, email: member.email, name: "Queued" };
        const held = yield* hold(
          "the deactivation",
          users.deactivate({ companyId: company.id, userId: member.id })
        );
        // Both read the active row and queue on the held one. Once it commits, either may take
        // the row and write the claims; the other then has nothing to write, and its answer
        // must come from a read after that wait.
        const refreshes = yield* Effect.forEach([1, 2], () =>
          users.refreshClaims(claims).pipe(Effect.forkScoped)
        );
        yield* within("both refreshes waiting", lockWaits(2), held.fiber, ...refreshes);
        yield* held.release;
        const answers = yield* within("the refreshes", Fiber.joinAll(refreshes));
        const stored = yield* users.findByClerkId(member.clerkUserId);
        assert.isNotNull(stored?.deactivatedAt);
        assert.deepStrictEqual(
          answers.map((answer) => answer?.user),
          [stored, stored]
        );
        // The deactivation and one refresh updated the row; the other refresh wrote nothing.
        assert.lengthOf(
          yield* sql`SELECT user_id FROM claim_refresh_audit WHERE user_id = ${member.id}`,
          2
        );
      }).pipe(Effect.scoped)
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
          assert.deepInclude(yield* users.setRole({ ...memberRef, role: "admin" }), {
            changed: true
          });
          assert.deepInclude(yield* users.setRole({ ...memberRef, role: "admin" }), {
            changed: false
          });
          assert.strictEqual(
            (yield* users.setRole({ ...adminRef, role: "member" })).user.role,
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

    it.effect("checks deactivation without changing access, tokens or the final active admin", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sql = yield* SqlClient.SqlClient;
        const { company, admin, member } = yield* companyWithMember("deactivation-check");
        const input = { companyId: company.id, userId: member.id };
        yield* sql`
          INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
          VALUES ('tok_deactivation_check', ${member.id}, 'Laptop', 'deactivation-check-hash', now(), now() + interval '90 days', now())`;

        assert.deepStrictEqual(yield* users.checkDeactivation(input), member);
        assert.strictEqual(
          (yield* users
            .checkDeactivation({ companyId: company.id, userId: admin.id })
            .pipe(Effect.flip))._tag,
          "LastAdmin"
        );
        assert.strictEqual(
          (yield* users
            .checkDeactivation({ companyId: "cmp_elsewhere", userId: member.id })
            .pipe(Effect.flip))._tag,
          "UserNotFound"
        );
        assert.deepStrictEqual(yield* users.findByClerkId(member.clerkUserId), member);
        assert.deepStrictEqual(yield* users.findByClerkId(admin.clerkUserId), admin);
        assert.deepStrictEqual(
          yield* sql`SELECT revoked_at IS NULL AS live FROM machine_tokens WHERE id = 'tok_deactivation_check'`,
          [{ live: true }]
        );
      })
    );

    it.effect("commits or rolls back lifecycle changes with the ambient outer transaction", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sql = yield* SqlClient.SqlClient;
        const { company, member } = yield* companyWithMember("lifecycle-outer-transaction");
        const input = { companyId: company.id, userId: member.id };
        yield* sql`
          INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
          VALUES ('tok_lifecycle_outer', ${member.id}, 'Laptop', 'lifecycle-outer-hash', now(), now() + interval '90 days', now())`;
        assert.strictEqual(
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* users.deactivate(input);
                return yield* Effect.fail("abort deactivation");
              })
            )
            .pipe(Effect.flip),
          "abort deactivation"
        );
        assert.deepStrictEqual(yield* users.findByClerkId(member.clerkUserId), member);
        assert.deepStrictEqual(
          yield* sql`SELECT revoked_at IS NULL AS live FROM machine_tokens WHERE id = 'tok_lifecycle_outer'`,
          [{ live: true }]
        );

        const deactivated = yield* sql.withTransaction(users.deactivate(input));
        assert.isNotNull(deactivated.deactivatedAt);
        assert.deepStrictEqual(yield* users.findByClerkId(member.clerkUserId), deactivated);
        assert.deepStrictEqual(
          yield* sql`SELECT revoked_at IS NOT NULL AS revoked FROM machine_tokens WHERE id = 'tok_lifecycle_outer'`,
          [{ revoked: true }]
        );

        assert.strictEqual(
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* users.reactivate(input);
                return yield* Effect.fail("abort reactivation");
              })
            )
            .pipe(Effect.flip),
          "abort reactivation"
        );
        assert.deepStrictEqual(yield* users.findByClerkId(member.clerkUserId), deactivated);

        yield* sql.withTransaction(users.reactivate(input));
        assert.deepStrictEqual(yield* users.findByClerkId(member.clerkUserId), member);
        assert.deepStrictEqual(
          yield* sql`SELECT revoked_at IS NOT NULL AS revoked FROM machine_tokens WHERE id = 'tok_lifecycle_outer'`,
          [{ revoked: true }]
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
        yield* ddl(
          `CREATE FUNCTION refuse_atomic_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN
                IF NEW.id = 'tok_deactivation_atomic' THEN
                  RAISE EXCEPTION 'Revocation unavailable';
                END IF;
                RETURN NEW;
              END;
              $$`,
          `CREATE TRIGGER refuse_atomic_revocation BEFORE UPDATE ON machine_tokens
                FOR EACH ROW EXECUTE FUNCTION refuse_atomic_revocation()`
        );
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

    it.effect("starts new members caught up on What's new and only ever raises the marker", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const { admin, member } = yield* companyWithMember("whats-new-marker");
        assert.strictEqual(admin.whatsNewSeen, WhatsNew.latestRelease);
        assert.strictEqual(member.whatsNewSeen, WhatsNew.latestRelease);
        yield* users.markWhatsNewSeen({ userId: member.id, through: WhatsNew.latestRelease + 2 });
        yield* users.markWhatsNewSeen({ userId: member.id, through: WhatsNew.latestRelease + 1 });
        assert.strictEqual(
          (yield* users.findByClerkId(member.clerkUserId))?.whatsNewSeen,
          WhatsNew.latestRelease + 2
        );
        assert.strictEqual(
          (yield* users.findByClerkId(admin.clerkUserId))?.whatsNewSeen,
          WhatsNew.latestRelease
        );
      })
    );
  }
);
