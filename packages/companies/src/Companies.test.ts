import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Testing from "@patchy/sql/testing";
import * as Companies from "./Companies.js";
import * as Users from "./Users.js";
import { NodeCryptography } from "@patchy/core";

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
// Runs `effect` in a transaction left open, holding its locks, until `release` commits it.
// `waiter` waits until another session waits on one of those locks.
const held = Effect.fn("held")(function* <A, E>(effect: Effect.Effect<A, E>) {
  const sql = yield* SqlClient.SqlClient;
  const ran = yield* Deferred.make<number>();
  const commit = yield* Deferred.make<void>();
  const fiber = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const result = yield* effect;
        const [session] = yield* sql<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid`;
        yield* Deferred.succeed(ran, session!.pid);
        yield* Deferred.await(commit);
        return result;
      })
    )
    .pipe(Effect.forkScoped);
  const holder = yield* Deferred.await(ran);
  return {
    waiter: sql`SELECT pid FROM pg_stat_activity WHERE ${holder} = ANY(pg_blocking_pids(pid))`.pipe(
      Effect.repeat({ until: (rows) => rows.length > 0 })
    ),
    release: Deferred.succeed(commit, undefined).pipe(Effect.andThen(Fiber.join(fiber)))
  };
});

const database = Testing.layer().pipe(Layer.provideMerge(NodeCryptography.layer));

it.layer(Layer.mergeAll(Companies.layer, Users.layer).pipe(Layer.provideMerge(database)))(
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

    it.effect("keeps the MCP door's and its authorization server's paths off company handles", () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        for (const handle of ["mcp", "oauth"]) {
          assert.strictEqual(
            (yield* companies.create(companyInput(handle)).pipe(Effect.flip))._tag,
            "ReservedHandle"
          );
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

    it.effect("names a founder without a name by their email's local part", () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        for (const [handle, userName] of [
          ["nameless-empty", ""],
          ["nameless-blank", " \t\n"]
        ] as const) {
          const input = { ...companyInput(handle), email: `${handle}.Founder@Example.com` };
          const { user } = yield* companies.create({ ...input, userName });
          assert.strictEqual(user.name, `${handle}.founder`);
        }
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

    it.effect("names an invitee without a name by their email's local part", () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const { company, user: admin } = yield* companies.create(companyInput("nameless-invite"));
        const invite = yield* companies.createInvite({
          companyId: company.id,
          invitedBy: admin.id,
          email: "Ada.Lovelace@Example.com"
        });
        const joined = yield* companies.consumeInvite({
          inviteId: invite.id,
          clerkUserId: "clerk_nameless_invitee",
          email: "Ada.Lovelace@Example.com",
          name: " "
        });
        assert.strictEqual(joined.name, "ada.lovelace");
      })
    );

    it.effect("hides expired invitations from join and refuses to consume them", () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const { company, user } = yield* companies.create(companyInput("invite-expiry"));
        const invite = yield* companies.createInvite({
          companyId: company.id,
          invitedBy: user.id,
          email: "expiry@example.com"
        });
        yield* TestClock.adjust("30 days");
        assert.deepStrictEqual(yield* companies.findInvitesByEmail("EXPIRY@example.com"), []);
        assert.strictEqual(
          (yield* companies
            .consumeInvite({
              inviteId: invite.id,
              clerkUserId: "clerk_expiry",
              email: invite.email,
              name: "Expired"
            })
            .pipe(Effect.flip))._tag,
          "InviteUnavailable"
        );
        assert.deepStrictEqual(yield* companies.listInvites(company.id), [invite]);
        assert.strictEqual(
          (yield* companies
            .createInvite({
              companyId: company.id,
              invitedBy: user.id,
              email: invite.email
            })
            .pipe(Effect.flip))._tag,
          "AlreadyInvited"
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

    it.effect("starts a new company's agent access off, with no latest change", () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const { company } = yield* companies.create(companyInput("agent-access-new"));
        assert.deepStrictEqual(yield* companies.agentAccess(company.id), {
          on: false,
          latest: null
        });
      })
    );

    it.effect("records who turned agent access on or off and when, and only a real change", () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const users = yield* Users.Users;
        const { company, user: admin } = yield* companies.create(companyInput("agent-access-set"));
        const invite = yield* companies.createInvite({
          companyId: company.id,
          invitedBy: admin.id,
          email: "agent-access-second@example.com",
          role: "admin"
        });
        const second = yield* companies.consumeInvite({
          inviteId: invite.id,
          clerkUserId: "clerk_agent_access_second",
          email: invite.email,
          name: "Priya Shah"
        });
        yield* TestClock.setTime(Date.parse("2026-10-12T09:00:00Z"));
        const on = yield* companies.setAgentAccess({
          companyId: company.id,
          on: true,
          by: admin.id
        });
        const turnedOn = {
          on: true,
          latest: { by: { id: admin.id, name: "Founder" }, at: new Date("2026-10-12T09:00:00Z") }
        };
        assert.deepStrictEqual(on, { access: turnedOn, changed: true });
        // A second admin asking for the state it already has leaves the latest change alone.
        yield* TestClock.adjust("1 hour");
        assert.deepStrictEqual(
          yield* companies.setAgentAccess({ companyId: company.id, on: true, by: second.id }),
          { access: turnedOn, changed: false }
        );
        yield* TestClock.adjust("1 day");
        const off = yield* companies.setAgentAccess({
          companyId: company.id,
          on: false,
          by: second.id
        });
        const turnedOff = {
          on: false,
          latest: {
            by: { id: second.id, name: "Priya Shah" },
            at: new Date("2026-10-13T10:00:00Z")
          }
        };
        assert.deepStrictEqual(off, { access: turnedOff, changed: true });
        // Leaving keeps the name on the latest change.
        yield* users.deactivate({ companyId: company.id, userId: second.id });
        assert.deepStrictEqual(yield* companies.agentAccess(company.id), turnedOff);
      })
    );

    it.effect("refuses agent access for a company that doesn't exist", () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const { user } = yield* companies.create(companyInput("agent-access-unknown"));
        const outcomes = yield* Effect.all([
          companies.agentAccess("cmp_missing").pipe(Effect.match(outcome)),
          companies.holdAgentAccess("cmp_missing").pipe(Effect.match(outcome)),
          companies
            .setAgentAccess({ companyId: "cmp_missing", on: true, by: user.id })
            .pipe(Effect.match(outcome))
        ]);
        assert.deepStrictEqual(outcomes, Array(3).fill("CompanyNotFound"));
      })
    );

    it.effect(
      "makes a change wait for a holder of agent access, and a holder wait for a change",
      () =>
        Effect.gen(function* () {
          const companies = yield* Companies.Companies;
          const { company, user } = yield* companies.create(companyInput("agent-access-hold"));
          const set = (on: boolean) =>
            companies.setAgentAccess({ companyId: company.id, on, by: user.id });

          // An exchange holding the switch keeps its "off" until it commits.
          const exchange = yield* held(companies.holdAgentAccess(company.id));
          const turnOn = yield* set(true).pipe(Effect.forkScoped);
          yield* exchange.waiter;
          assert.isFalse(yield* exchange.release);
          assert.isTrue((yield* Fiber.join(turnOn)).changed);

          // A hold during an uncommitted "off" reads the "off" once it commits, never the "on".
          const turnOff = yield* held(set(false));
          const waiting = yield* companies.holdAgentAccess(company.id).pipe(Effect.forkScoped);
          yield* turnOff.waiter;
          assert.isTrue((yield* turnOff.release).changed);
          assert.isFalse(yield* Fiber.join(waiting));
        }).pipe(Effect.scoped)
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
