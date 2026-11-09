import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { migrate } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import { migrations } from "./migrations.js";

// Steps after launch run on databases that already hold people.
const before = (step: string) =>
  Object.fromEntries(Object.entries(migrations).filter(([key]) => key < step));

it.layer(Testing.emptyLayer(before("0009_whats_new_seen")))(
  "the What's new marker upgrade",
  (it) => {
    it.effect("keeps everyone already signed up, with every release new to them", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_upgrade', 'upgrade', 'Northwind')`;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES ('usr_upgrade', 'clerk_upgrade', 'cmp_upgrade', 'sam@example.com', 'Sam', 'member')`;
        yield* migrate(migrations);
        assert.deepStrictEqual(yield* sql`SELECT id, name, whats_new_seen AS seen FROM users`, [
          { id: "usr_upgrade", name: "Sam", seen: 0 }
        ]);
      })
    );
  }
);

it.layer(Testing.emptyLayer(before("0015_user_name_never_blank")))(
  "the nameless backfill",
  (it) => {
    it.effect(
      "names nameless users by their email, active or not, and leaves named users as they were",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_names', 'names', 'Northwind')`;
          yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role, deactivated_at) VALUES
        ('usr_empty', 'clerk_empty', 'cmp_names', 'ada.lovelace@example.com', '', 'member', NULL),
        ('usr_blank', 'clerk_blank', 'cmp_names', 'grace@example.com', ${" \t\n"}, 'member', NULL),
        ('usr_left', 'clerk_left', 'cmp_names', 'alan@example.com', '', 'member', now()),
        ('usr_unicode', 'clerk_unicode', 'cmp_names', 'mei@example.com', ${"\u00a0\ufeff\u3000"}, 'member', NULL),
        ('usr_no_local', 'clerk_no_local', 'cmp_names', '@example.com', '', 'member', NULL),
        ('usr_named', 'clerk_named', 'cmp_names', 'sam@example.com', ' Sam  ', 'member', NULL)`;
          yield* migrate(migrations);
          assert.deepStrictEqual(yield* sql`SELECT id, name FROM users ORDER BY id`, [
            { id: "usr_blank", name: "grace" },
            { id: "usr_empty", name: "ada.lovelace" },
            { id: "usr_left", name: "alan" },
            { id: "usr_named", name: " Sam  " },
            { id: "usr_no_local", name: "@example.com" },
            { id: "usr_unicode", name: "mei" }
          ]);
        })
    );
  }
);

it.layer(Testing.emptyLayer(before("0036_company_roles")))("the company roles upgrade", (it) => {
  it.effect(
    "preserves every existing admin as a super admin, including inactive accounts and pending invitations",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_roles', 'roles', 'Roles')`;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role, deactivated_at) VALUES
        ('a', 'clerk_a', 'cmp_roles', 'a@example.com', 'A', 'admin', NULL),
        ('b', 'clerk_b', 'cmp_roles', 'b@example.com', 'B', 'admin', now()),
        ('m', 'clerk_m', 'cmp_roles', 'm@example.com', 'M', 'member', NULL)`;
        yield* sql`INSERT INTO invites (id, company_id, email, role, invited_by, expires_at) VALUES
        ('i', 'cmp_roles', 'invited@example.com', 'admin', 'a', now() + interval '1 day')`;
        yield* migrate(migrations);
        // The old server's two-role decoder and write shape remain usable after upgrading.
        assert.deepStrictEqual(yield* sql`SELECT id, role FROM users ORDER BY id`, [
          { id: "a", role: "admin" },
          { id: "b", role: "admin" },
          { id: "m", role: "member" }
        ]);
        yield* sql`UPDATE users SET role = 'member' WHERE id = 'b'`;
        yield* sql`UPDATE users SET role = 'admin' WHERE id = 'b'`;
        assert.deepStrictEqual(yield* sql`SELECT role FROM invites WHERE id = 'i'`, [
          { role: "admin" }
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT id, CASE WHEN role = 'admin' THEN 'super_admin' WHEN is_regular_admin THEN 'admin' ELSE 'member' END AS role FROM users ORDER BY id`,
          [
            { id: "a", role: "super_admin" },
            { id: "b", role: "super_admin" },
            { id: "m", role: "member" }
          ]
        );
        assert.deepStrictEqual(
          yield* sql`SELECT CASE WHEN role = 'admin' THEN 'super_admin' WHEN is_regular_admin THEN 'admin' ELSE 'member' END AS role FROM invites WHERE id = 'i'`,
          [{ role: "super_admin" }]
        );
        // Emulate a rollback accepting a regular-admin invitation with its old INSERT shape.
        yield* sql`UPDATE invites SET role = 'member', is_regular_admin = true WHERE id = 'i'`;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
          VALUES ('r', 'clerk_r', 'cmp_roles', 'invited@example.com', 'Regular', 'member')`;
        assert.deepStrictEqual(
          yield* sql`SELECT role, is_regular_admin FROM users WHERE id = 'r'`,
          [{ role: "member", is_regular_admin: true }]
        );
        // The old last-admin safeguard counts only the actual super admin.
        assert.deepStrictEqual(
          yield* sql`SELECT count(*)::int AS count FROM users
          WHERE company_id = 'cmp_roles' AND role = 'admin' AND deactivated_at IS NULL`,
          [{ count: 1 }]
        );
        // Legacy promotions/demotions carry no flag: never resurrect an earlier grant.
        yield* sql`UPDATE users SET role = 'admin' WHERE id = 'r'`;
        assert.deepStrictEqual(yield* sql`SELECT is_regular_admin FROM users WHERE id = 'r'`, [
          { is_regular_admin: false }
        ]);
        yield* sql`UPDATE users SET role = 'member' WHERE id = 'r'`;
        assert.deepStrictEqual(
          yield* sql`SELECT role, is_regular_admin FROM users WHERE id = 'r'`,
          [{ role: "member", is_regular_admin: false }]
        );
      })
  );
});
