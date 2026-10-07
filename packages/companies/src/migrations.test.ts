import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { migrate } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import { migrations } from "./migrations.js";

// The first step after launch runs on databases that already hold people.
const launched = Object.fromEntries(
  Object.entries(migrations).filter(([key]) => key < "0009_whats_new_seen")
);

it.layer(Testing.emptyLayer(launched))("the What's new marker upgrade", (it) => {
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
});
