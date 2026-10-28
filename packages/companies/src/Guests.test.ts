import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as Testing from "@patchy/sql/testing";
import * as Guests from "./Guests.js";

it.layer(Testing.layer())("company guests", (it) => {
  it.effect("keeps independent relationships beside a member account", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO companies (id, handle, name) VALUES
        ('cmp_a', 'guest-a', 'A'), ('cmp_b', 'guest-b', 'B'), ('cmp_c', 'guest-c', 'C')`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES ('usr_a', 'clerk_jordan', 'cmp_a', 'jordan@example.com', 'Jordan', 'member')`;
      const b = yield* Guests.create({
        companyId: "cmp_b",
        clerkUserId: "clerk_jordan",
        email: "Jordan@Example.com",
        name: "Jordan"
      });
      const c = yield* Guests.create({
        companyId: "cmp_c",
        clerkUserId: "clerk_jordan",
        email: "jordan@example.com",
        name: "Jordan"
      });
      assert.notStrictEqual(b.id, c.id);
      assert.deepStrictEqual(
        (yield* Guests.listByClerkId("clerk_jordan")).map((g) => g.companyId),
        ["cmp_b", "cmp_c"]
      );
      const deactivated = yield* Guests.setDeactivated({
        companyId: "cmp_b",
        clerkUserId: "clerk_jordan",
        deactivated: true
      });
      assert.instanceOf(deactivated?.deactivatedAt, Date);
      assert.isNull(
        (yield* Guests.find({ companyId: "cmp_c", clerkUserId: "clerk_jordan" }))?.deactivatedAt
      );
      const reactivated = yield* Guests.setDeactivated({
        companyId: "cmp_b",
        clerkUserId: "clerk_jordan",
        deactivated: false
      });
      assert.isNull(reactivated?.deactivatedAt);
      const ended = yield* Guests.end({ companyId: "cmp_b", clerkUserId: "clerk_jordan" });
      assert.instanceOf(ended?.endedAt, Date);
      assert.strictEqual(
        (yield* Guests.find({ companyId: "cmp_b", clerkUserId: "clerk_jordan" }))?.id,
        b.id
      );
      assert.strictEqual((yield* Guests.findById(b.id))?.id, b.id);
      assert.isNull(
        (yield* Guests.find({ companyId: "cmp_c", clerkUserId: "clerk_jordan" }))?.endedAt
      );
      assert.isNull(
        yield* Guests.setDeactivated({
          companyId: "cmp_b",
          clerkUserId: "clerk_jordan",
          deactivated: false
        })
      );
      const duplicate = yield* Effect.flip(
        Guests.create({
          companyId: "cmp_b",
          clerkUserId: "clerk_jordan",
          email: "jordan@example.com",
          name: "Jordan"
        })
      );
      assert.strictEqual(duplicate._tag, "GuestAlreadyExists");
      assert.deepStrictEqual(
        yield* sql`SELECT id, company_id, clerk_user_id FROM users WHERE clerk_user_id = 'clerk_jordan'`,
        [{ id: "usr_a", company_id: "cmp_a", clerk_user_id: "clerk_jordan" }]
      );
    })
  );

  it.effect("refuses an existing member, including a deactivated member, in the same company", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_member', 'guest-member', 'B')`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role, deactivated_at)
        VALUES ('usr_b', 'clerk_mia', 'cmp_member', 'mia@example.com', 'Mia', 'member', now())`;
      const input = {
        companyId: "cmp_member",
        clerkUserId: "clerk_mia",
        email: "mia@example.com",
        name: "Mia"
      };
      const refused = yield* Effect.flip(Guests.create(input));
      assert.strictEqual(refused._tag, "GuestAlreadyMember");
      const direct = yield* Effect.exit(sql`INSERT INTO company_guests
        (id, company_id, clerk_user_id, email, name)
        VALUES ('gst_direct', 'cmp_member', 'clerk_mia', 'mia@example.com', 'Mia')`);
      assert.isTrue(Exit.isFailure(direct));
      assert.deepStrictEqual(
        yield* sql`SELECT id FROM company_guests WHERE company_id = 'cmp_member'`,
        []
      );
    })
  );

  it.effect("ends a guest when that account joins the same company and retains the identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_join', 'guest-join', 'B')`;
      const guest = yield* Guests.create({
        companyId: "cmp_join",
        clerkUserId: "clerk_join",
        email: "join@example.com",
        name: "Mia"
      });
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES ('usr_join', 'clerk_join', 'cmp_join', 'join@example.com', 'Mia', 'member')`;
      const ended = yield* Guests.find({ companyId: "cmp_join", clerkUserId: "clerk_join" });
      assert.strictEqual(ended?.id, guest.id);
      assert.instanceOf(ended?.endedAt, Date);
      const reopen = yield* Effect.exit(
        sql`UPDATE company_guests SET ended_at = NULL WHERE id = ${guest.id}`
      );
      assert.isTrue(Exit.isFailure(reopen));
    })
  );

  it.effect("serializes a guest creation racing a member join", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_race', 'guest-race', 'Race')`;
      const [guestAttempt] = yield* Effect.all(
        [
          Guests.create({
            companyId: "cmp_race",
            clerkUserId: "clerk_race",
            email: "race@example.com",
            name: "Race"
          }).pipe(Effect.exit),
          sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
            VALUES ('usr_race', 'clerk_race', 'cmp_race', 'race@example.com', 'Race', 'member')`
        ],
        { concurrency: 2 }
      );
      if (Exit.isFailure(guestAttempt)) {
        assert.strictEqual(
          yield* Guests.find({ companyId: "cmp_race", clerkUserId: "clerk_race" }),
          null
        );
      } else {
        assert.instanceOf(
          (yield* Guests.find({ companyId: "cmp_race", clerkUserId: "clerk_race" }))?.endedAt,
          Date
        );
      }
      assert.deepStrictEqual(yield* sql`SELECT id FROM users WHERE company_id = 'cmp_race'`, [
        { id: "usr_race" }
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT id FROM company_guests
        WHERE company_id = 'cmp_race' AND ended_at IS NULL`,
        []
      );
    })
  );
});
