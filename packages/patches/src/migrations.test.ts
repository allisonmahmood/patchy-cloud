import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { migrate, type Migrations } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import { migrations as companies } from "../../companies/src/migrations.js";
import { migrations as auth } from "../../auth/src/migrations.js";
import { migrations as companyDatabase } from "../../company-database/src/migrations.js";
import { migrations as runtime } from "../../runtime/src/migrations.js";
import { migrations as integrations } from "../../integrations/src/migrations.js";
import { migrations } from "./migrations.js";

const previous: Migrations = {
  ...companies,
  ...auth,
  "0003_patches_baseline": migrations["0003_patches_baseline"]!,
  ...companyDatabase,
  ...runtime,
  ...integrations
};

it.effect(
  "finalizes legacy hard-deletes without stealing reused names or deleting live receipts",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_upgrade', 'upgrade', 'Upgrade')`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES ('usr_upgrade', 'clerk_upgrade', 'cmp_upgrade', 'upgrade@patchy.local', 'Owner', 'member')`;
      yield* sql`INSERT INTO machine_tokens (id, user_id, name, token_hash, expires_at, last_used_at)
      VALUES ('tok_upgrade', 'usr_upgrade', 'Machine', 'hash_upgrade', now() + interval '1 day', now())`;
      yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name, expires_at, deleted_at)
      VALUES
        ('oldclaimed01', 'cmp_upgrade', 'usr_upgrade', 'Old claimed', 'reused-name', now() + interval '90 days', now()),
        ('oldunclaimed', 'cmp_upgrade', 'usr_upgrade', 'Old free', 'free-name', now() + interval '90 days', now()),
        ('replacement1', 'cmp_upgrade', 'usr_upgrade', 'Replacement', 'reused-name', now() + interval '90 days', NULL)`;
      // Legacy delete already removed both old patches' claims. Another patch took one name.
      yield* sql`INSERT INTO patch_names (company_id, name, patch_id, current)
      VALUES ('cmp_upgrade', 'reused-name', 'replacement1', true)`;
      yield* sql`INSERT INTO patch_versions (
      id, patch_id, version_number, object_key, content_hash, file_size, created_by_machine_token_id,
      owner_user_id, tier, release, manifest_version, wire_version, schema_revision, manifest,
      publish_key, payload_digest, publish_response, publish_status
    ) SELECT 'ver_' || id, id, 1, 'patches/' || id || '/version.html', 'hash', 1, 'tok_upgrade',
      'usr_upgrade', 0, 'old-release', 1, 1, 0, '{}', id, id,
      jsonb_build_object('ok', true, 'patchId', id, 'versionId', 'ver_' || id), 201
      FROM patches WHERE company_id = 'cmp_upgrade'`;
      yield* sql`UPDATE patches SET current_version_id = 'ver_' || id WHERE company_id = 'cmp_upgrade'`;
      const [liveReceipt] =
        yield* sql`SELECT publish_response FROM patch_versions WHERE patch_id = 'replacement1'`;
      yield* sql`INSERT INTO pending_patch_objects (object_key, expires_at, claimed)
      VALUES ('patches/oldclaimed01/version.html', now() + interval '1 day', true)`;

      yield* migrate({ ...previous, ...migrations });

      assert.deepStrictEqual(yield* sql`SELECT id FROM patches ORDER BY id`, [
        { id: "replacement1" }
      ]);
      assert.deepStrictEqual(yield* sql`SELECT name, patch_id FROM patch_names`, [
        { name: "reused-name", patch_id: "replacement1" }
      ]);
      assert.deepStrictEqual(yield* sql`SELECT patch_id, publish_response FROM patch_versions`, [
        { patch_id: "replacement1", publish_response: liveReceipt!.publish_response }
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT object_key, claimed, expires_at <= now() AS eligible
      FROM pending_patch_objects ORDER BY object_key`,
        [
          { object_key: "patches/oldclaimed01/version.html", claimed: false, eligible: true },
          { object_key: "patches/oldunclaimed/version.html", claimed: false, eligible: true }
        ]
      );

      // A deletion under the new contract remains recoverable when migrations run again.
      yield* sql`UPDATE patches SET deleted_at = now() WHERE id = 'replacement1'`;
      assert.deepStrictEqual(yield* migrate({ ...previous, ...migrations }), []);
      assert.deepStrictEqual(
        yield* sql`SELECT patch_id FROM patch_names WHERE name = 'reused-name'`,
        [{ patch_id: "replacement1" }]
      );
      assert.deepStrictEqual(yield* sql`SELECT id FROM patches`, [{ id: "replacement1" }]);
    }).pipe(Effect.provide(Testing.emptyLayer(previous)))
);
