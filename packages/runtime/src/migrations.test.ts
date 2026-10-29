import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { migrate } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import * as RuntimeLog from "./RuntimeLog.js";
import { migrations } from "./migrations.js";

const before = Object.fromEntries(
  Object.entries(migrations).filter(([key]) => key < "0032_runtime_guest_attribution")
);
it.layer(Testing.emptyLayer(before))("guest log attribution upgrade", (it) => {
  it.effect("keeps old calls readable and accepts old-server inserts without guest fields", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const oldInsert = (id: string) => sql`INSERT INTO runtime_calls
      (id, company_id, user_id, effective_principal, credential_kind, op, correlation_id)
      VALUES (${id}, 'cmp_upgrade', 'usr_member', 'usr_member', 'session', 'tables.insert', ${id})`;
      yield* oldInsert("before-upgrade");
      yield* migrate(migrations);
      yield* oldInsert("after-upgrade");
      const log = yield* RuntimeLog.make;
      for (const correlationId of ["before-upgrade", "after-upgrade"]) {
        const row = yield* log.find({ companyId: "cmp_upgrade", correlationId });
        assert.include(row, {
          userId: "usr_member",
          guest: null,
          effectivePrincipal: "usr_member"
        });
      }
      yield* log.begin({
        companyId: "cmp_upgrade",
        patchId: "patch",
        versionId: "version",
        userId: null,
        guest: { id: "gst_retained", grantId: "grt_ended" },
        effectivePrincipal: "gst_retained",
        credentialKind: "session",
        op: "me",
        resource: null,
        connectionId: null,
        correlationId: "guest-call"
      });
      assert.deepStrictEqual(
        (yield* log.find({ companyId: "cmp_upgrade", correlationId: "guest-call" }))?.guest,
        { id: "gst_retained", grantId: "grt_ended" }
      );
      // No user/guest hybrid can be persisted, including by a mistaken caller.
      assert.isTrue(
        (yield* sql`UPDATE runtime_calls SET user_id = 'usr_member'
      WHERE correlation_id = 'guest-call'`.pipe(Effect.exit))._tag === "Failure"
      );
    })
  );
});
