import { assert, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { migrate } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import * as Companies from "./Companies.js";
import * as Directory from "./Directory.js";
import * as Users from "./Users.js";
import { migrations } from "./migrations.js";

const createCompany = Effect.fn("createDirectoryCompany")(function* (handle: string) {
  const companies = yield* Companies.Companies;
  return yield* companies.create({
    handle,
    name: handle,
    clerkUserId: `clerk_${handle}`,
    email: `${handle}@example.com`,
    userName: "Founder"
  });
});
const join = Effect.fn("joinDirectoryCompany")(function* (
  companyId: string,
  adminId: string,
  email: string,
  name: string
) {
  const companies = yield* Companies.Companies;
  const invite = yield* companies.createInvite({ companyId, invitedBy: adminId, email });
  return yield* companies.consumeInvite({
    inviteId: invite.id,
    clerkUserId: `clerk_${email}`,
    email,
    name
  });
});
const memberValue = (user: Users.User): Directory.Member =>
  new Directory.Member({
    id: user.id,
    name: user.name,
    email: user.email,
    admin: user.role === "admin",
    active: user.deactivatedAt === null
  });
const decodeWake = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ keys: Schema.Array(Schema.String) }))
);
const services = Layer.mergeAll(Companies.layer, Users.layer, Directory.layer).pipe(
  Layer.provideMerge(Testing.layer())
);

it.layer(services)("company directory", (it) => {
  it.effect("keeps deactivated users resolvable but never candidates, and isolates companies", () =>
    Effect.gen(function* () {
      const directory = yield* Directory.Directory;
      const users = yield* Users.Users;
      const { company, user: admin } = yield* createCompany("directory-candidates");
      const { user: outsider } = yield* createCompany("directory-outsider");
      const member = yield* join(company.id, admin.id, "anna@example.com", "Anna Park");
      assert.deepStrictEqual(yield* directory.list(company.id, 50), {
        rows: [memberValue(member), memberValue(admin)],
        cursor: null
      });
      assert.isTrue(yield* directory.isCandidate(company.id, member.id));
      const left = yield* users.deactivate({ companyId: company.id, userId: member.id });
      assert.deepStrictEqual(yield* directory.list(company.id, 50), {
        rows: [memberValue(admin)],
        cursor: null
      });
      assert.deepStrictEqual(yield* directory.search(company.id, "ann", 50), {
        rows: [],
        cursor: null
      });
      assert.deepStrictEqual(yield* directory.get(company.id, member.id), memberValue(left));
      assert.isFalse(yield* directory.isCandidate(company.id, member.id));
      assert.isFalse(yield* directory.isCandidate(company.id, outsider.id));
      assert.isFalse(yield* directory.isCandidate(company.id, "missing"));
      assert.isNull(yield* directory.get(company.id, outsider.id));
      assert.isNull(yield* directory.get(company.id, "missing"));
      assert.deepStrictEqual(
        yield* directory.getMany(company.id, [
          member.id,
          outsider.id,
          admin.id,
          "missing",
          member.id
        ]),
        [memberValue(left), null, memberValue(admin), null, memberValue(left)]
      );
      assert.deepStrictEqual(yield* directory.getMany(company.id, []), []);
      yield* users.reactivate({ companyId: company.id, userId: member.id });
      assert.deepStrictEqual(yield* directory.get(company.id, member.id), memberValue(member));
      assert.isTrue(yield* directory.isCandidate(company.id, member.id));
    })
  );

  it.effect(
    "pages tied names deterministically and searches literal full-name or email prefixes",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* Directory.Directory;
        const { company } = yield* createCompany("directory-pages");
        const rows = Array.from({ length: 103 }, (_, index) => {
          const suffix = String(index).padStart(3, "0");
          return {
            id: `usr_directory_${suffix}`,
            clerk_user_id: `clerk_directory_${suffix}`,
            company_id: company.id,
            email: `person${suffix}@directory.test`,
            name: index % 2 === 0 ? "Anna Team" : "ANNA TEAM",
            role: "member"
          };
        });
        yield* sql`INSERT INTO users ${sql.insert(rows.toReversed())}`;
        const expected = rows.map(
          ({ id, name, email }) =>
            new Directory.Member({
              id,
              name,
              email,
              admin: false,
              active: true
            })
        );
        const first = yield* directory.list(company.id, 50);
        assert.deepStrictEqual(first.rows, expected.slice(0, 50));
        assert.isNotNull(first.cursor);
        const second = yield* directory.list(company.id, 50, first.cursor!);
        assert.deepStrictEqual(second.rows, expected.slice(50, 100));
        const third = yield* directory.list(company.id, 50, second.cursor!);
        assert.deepStrictEqual(third.rows.slice(0, 3), expected.slice(100));
        assert.strictEqual(third.rows[3]?.name, "Founder");
        assert.isNull(third.cursor);
        const search = yield* directory.search(company.id, "aNn", 50);
        assert.deepStrictEqual(search.rows, expected.slice(0, 50));
        const searchNext = yield* directory.search(company.id, "aNn", 50, search.cursor!);
        assert.deepStrictEqual(searchNext.rows, expected.slice(50, 100));
        assert.deepStrictEqual(yield* directory.search(company.id, "aNn", 50, searchNext.cursor!), {
          rows: expected.slice(100),
          cursor: null
        });
        assert.deepStrictEqual(yield* directory.search(company.id, "PERSON100@", 50), {
          rows: [expected[100]],
          cursor: null
        });
        assert.deepStrictEqual(yield* directory.search(company.id, "Team", 50), {
          rows: [],
          cursor: null
        });
        assert.deepStrictEqual(yield* directory.search(company.id, "nna", 50), {
          rows: [],
          cursor: null
        });
        for (const [index, name] of ["%Percent", "_Under", "\\Slash", "Joanne"].entries()) {
          yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
          VALUES (${`usr_literal_${index}`}, ${`clerk_literal_${index}`}, ${company.id},
            ${`literal${index}@directory.test`}, ${name}, 'member')`;
        }
        for (const [prefix, name] of [
          ["%", "%Percent"],
          ["_", "_Under"],
          ["\\", "\\Slash"]
        ]) {
          const page = yield* directory.search(company.id, prefix!, 50);
          assert.deepStrictEqual(
            page.rows.map((member) => member.name),
            [name]
          );
          assert.isNull(page.cursor);
        }
        assert.deepStrictEqual(
          (yield* directory.search(company.id, "ann", 50)).rows,
          expected.slice(0, 50)
        );
      })
  );

  it.effect("refuses malformed cursors and cursors belonging to another company or search", () =>
    Effect.gen(function* () {
      const directory = yield* Directory.Directory;
      const { company, user } = yield* createCompany("directory-cursors");
      yield* join(company.id, user.id, "cursor@directory.test", "Anna Cursor");
      const first = yield* directory.list(company.id, 1);
      assert.isNotNull(first.cursor);
      const invalid = [
        "not+base64",
        "x",
        Encoding.encodeBase64Url("{}"),
        Encoding.encodeBase64Url(
          JSON.stringify({
            version: 2,
            companyId: company.id,
            text: null,
            name: "anna",
            email: "cursor@directory.test",
            id: user.id
          })
        )
      ];
      for (const cursor of invalid)
        assert.instanceOf(
          yield* directory.list(company.id, 50, cursor).pipe(Effect.flip),
          Directory.InvalidCursor
        );
      assert.instanceOf(
        yield* directory.list("other-company", 50, first.cursor!).pipe(Effect.flip),
        Directory.InvalidCursor
      );
      assert.instanceOf(
        yield* directory.search(company.id, "ann", 50, first.cursor!).pipe(Effect.flip),
        Directory.InvalidCursor
      );
      const search = yield* directory.search(company.id, "", 1);
      assert.instanceOf(
        yield* directory.search(company.id, "founder", 50, search.cursor!).pipe(Effect.flip),
        Directory.InvalidCursor
      );
    })
  );

  it.effect(
    "commits revisions for joins, profile, role and active-state changes, but not no-ops",
    () =>
      Effect.gen(function* () {
        const companies = yield* Companies.Companies;
        const directory = yield* Directory.Directory;
        const users = yield* Users.Users;
        const sql = yield* SqlClient.SqlClient;
        const { company, user } = yield* createCompany("directory-revisions");
        assert.strictEqual(yield* directory.revision(company.id), "1");
        const invite = yield* companies.createInvite({
          companyId: company.id,
          invitedBy: user.id,
          email: "revision@directory.test"
        });
        assert.strictEqual(yield* directory.revision(company.id), "1");
        const joined = yield* companies.consumeInvite({
          inviteId: invite.id,
          clerkUserId: "clerk_directory_revision",
          email: invite.email,
          name: "Joined"
        });
        const ref = { companyId: company.id, userId: joined.id };
        assert.strictEqual(yield* directory.revision(company.id), "2");
        yield* users.refreshClaims({
          clerkUserId: joined.clerkUserId,
          email: joined.email,
          name: "Renamed"
        });
        assert.strictEqual(yield* directory.revision(company.id), "3");
        const claims = {
          clerkUserId: joined.clerkUserId,
          email: "renamed@directory.test",
          name: "Renamed"
        };
        yield* users.refreshClaims(claims);
        assert.strictEqual(yield* directory.revision(company.id), "4");
        yield* users.setRole({ ...ref, role: "admin" });
        assert.strictEqual(yield* directory.revision(company.id), "5");
        assert.isTrue((yield* directory.get(company.id, joined.id))!.admin);
        yield* users.deactivate(ref);
        assert.strictEqual(yield* directory.revision(company.id), "6");
        yield* users.reactivate(ref);
        assert.strictEqual(yield* directory.revision(company.id), "7");
        yield* users.refreshClaims(claims);
        yield* users.setRole({ ...ref, role: "admin" });
        yield* users.reactivate(ref);
        assert.strictEqual(yield* directory.revision(company.id), "7");
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* users.setRole({ ...ref, role: "member" });
              yield* users.deactivate(ref);
              yield* users.refreshClaims({ ...claims, name: "Rolled back" });
              assert.strictEqual(yield* directory.revision(company.id), "10");
              return yield* Effect.fail("rollback");
            })
          )
          .pipe(Effect.flip);
        assert.strictEqual(yield* directory.revision(company.id), "7");
        assert.deepStrictEqual(
          yield* directory.get(company.id, joined.id),
          new Directory.Member({
            id: joined.id,
            name: "Renamed",
            email: claims.email,
            admin: true,
            active: true
          })
        );
        assert.instanceOf(
          yield* directory.revision("missing-company").pipe(Effect.flip),
          Companies.CompanyNotFound
        );
      })
  );

  it.effect(
    "delivers change facts only after the outermost commit and discards rolled-back facts",
    () =>
      Effect.gen(function* () {
        const pg = yield* PgClient.PgClient;
        const sql = yield* SqlClient.SqlClient;
        const users = yield* Users.Users;
        const directory = yield* Directory.Directory;
        const notifications = yield* pg.listen("patchy_runtime_wakes");
        const { company, user } = yield* createCompany("directory-notifications");
        const expected = { keys: [`members:${company.id}`] };
        assert.deepStrictEqual(decodeWake((yield* Queue.take(notifications)).payload), expected);
        const member = yield* join(company.id, user.id, "notify@directory.test", "Notify");
        assert.deepStrictEqual(decodeWake((yield* Queue.take(notifications)).payload), expected);
        const ref = { companyId: company.id, userId: member.id };
        // pg.notify uses a separate pooled connection. Its marker proves the
        // listener has received prior committed notifications without a sleep.
        const marker = Effect.gen(function* () {
          yield* pg.notify("patchy_runtime_wakes", "barrier");
          assert.strictEqual((yield* Queue.take(notifications)).payload, "barrier");
        });
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* users.deactivate(ref);
              yield* marker;
              return yield* Effect.fail("rollback");
            })
          )
          .pipe(Effect.flip);
        yield* marker;
        assert.strictEqual(yield* directory.revision(company.id), "2");
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* users.deactivate(ref);
            yield* marker;
          })
        );
        assert.deepStrictEqual(decodeWake((yield* Queue.take(notifications)).payload), expected);
        assert.isFalse((yield* directory.get(company.id, member.id))!.active);
        yield* marker;
        yield* users.deactivate(ref);
        yield* marker;
        yield* sql`UPDATE users SET deactivated_at = deactivated_at + interval '1 second',
        created_at = created_at + interval '1 second' WHERE id = ${member.id}`;
        yield* marker;
        assert.strictEqual(yield* directory.revision(company.id), "3");
      }).pipe(Effect.scoped)
  );

  it.effect(
    "refreshes a profile while an admin holds the company lock without reversing lock order",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* Directory.Directory;
        const users = yield* Users.Users;
        const { company, user } = yield* createCompany("directory-lock-order");
        const member = yield* join(company.id, user.id, "lock@directory.test", "Before");
        const locked = yield* Deferred.make<void>();
        const refreshed = yield* Deferred.make<void>();
        const admin = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT id FROM companies WHERE id = ${company.id} FOR UPDATE`;
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(refreshed);
              yield* users.setRole({ companyId: company.id, userId: member.id, role: "admin" });
            })
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(locked);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET LOCAL lock_timeout = '1s'`;
            yield* users.refreshClaims({
              clerkUserId: member.clerkUserId,
              email: member.email,
              name: "After"
            });
          })
        );
        yield* Deferred.succeed(refreshed, undefined);
        yield* Fiber.join(admin);
        assert.strictEqual(yield* directory.revision(company.id), "4");
        assert.deepStrictEqual(
          yield* directory.get(company.id, member.id),
          new Directory.Member({
            id: member.id,
            name: "After",
            email: member.email,
            admin: true,
            active: true
          })
        );
      }).pipe(Effect.scoped)
  );

  it.effect("invalidates both companies on a membership move and retains deletion evidence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* Directory.Directory;
      const source = yield* createCompany("directory-move-source");
      const target = yield* createCompany("directory-move-target");
      const member = yield* join(
        source.company.id,
        source.user.id,
        "move@directory.test",
        "Moving"
      );
      yield* sql`UPDATE users SET company_id = ${target.company.id} WHERE id = ${member.id}`;
      assert.strictEqual(yield* directory.revision(source.company.id), "3");
      assert.strictEqual(yield* directory.revision(target.company.id), "2");
      assert.isNull(yield* directory.get(source.company.id, member.id));
      assert.isTrue(yield* directory.isCandidate(target.company.id, member.id));
      yield* sql`DELETE FROM users WHERE id = ${member.id}`;
      assert.strictEqual(yield* directory.revision(target.company.id), "3");
      assert.isNull(yield* directory.get(target.company.id, member.id));
    })
  );
});

const priorMigrations = Object.fromEntries(
  Object.entries(migrations).filter(([name]) => name !== "0015_companies_directory")
);
it.layer(Testing.emptyLayer(priorMigrations))("existing company directory migration", (it) => {
  it.effect("adds revisions to existing companies without changing their users", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.make;
      const created = yield* createCompany("directory-upgrade").pipe(
        Effect.provideService(Companies.Companies, companies)
      );
      yield* migrate(migrations);
      const directory = yield* Directory.make;
      const users = yield* Users.make;
      assert.strictEqual(yield* directory.revision(created.company.id), "0");
      assert.deepStrictEqual(
        yield* directory.get(created.company.id, created.user.id),
        memberValue(created.user)
      );
      yield* users.refreshClaims({
        clerkUserId: created.user.clerkUserId,
        email: created.user.email,
        name: "Updated after migration"
      });
      assert.strictEqual(yield* directory.revision(created.company.id), "1");
    })
  );
});
