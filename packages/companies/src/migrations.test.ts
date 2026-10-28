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

it.layer(Testing.emptyLayer(before("0029_company_guests")))(
  "the additive guest storage upgrade",
  (it) => {
    it.effect("keeps member rows and lets an older migration record start after upgrade", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO companies (id, handle, name)
          VALUES ('cmp_upgrade_guest', 'guest-upgrade', 'Northwind')`;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
          VALUES ('usr_upgrade_guest', 'clerk_upgrade_guest', 'cmp_upgrade_guest',
            'guest-upgrade@example.com', 'Sam', 'admin')`;
        const beforeUser = yield* sql`SELECT * FROM users`;
        yield* migrate(migrations);
        assert.deepStrictEqual(yield* sql`SELECT * FROM users`, beforeUser);
        yield* sql`INSERT INTO company_guests (id, company_id, clerk_user_id, email, name)
          VALUES ('gst_upgrade', 'cmp_upgrade_guest', 'clerk_external',
            'external@example.com', 'External')`;
        yield* migrate(before("0029_company_guests"));
        assert.deepStrictEqual(yield* sql`SELECT id FROM company_guests`, [{ id: "gst_upgrade" }]);
        assert.deepStrictEqual(yield* sql`SELECT * FROM users`, beforeUser);
      })
    );
  }
);
