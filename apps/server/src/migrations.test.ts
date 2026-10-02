import { assert, it } from "@effect/vitest";
import { capabilityMigrations, migrations } from "./migrations.js";

it("allocates migration ids once each, with no gaps", () => {
  const count = capabilityMigrations.reduce(
    (total, record) => total + Object.keys(record).length,
    0
  );
  assert.strictEqual(
    Object.keys(migrations).length,
    count,
    "two capabilities share a migration key"
  );
  const ids = Object.keys(migrations)
    .map((key) => Number(key.split("_")[0]))
    .sort((a, b) => a - b);
  // The Migrator applies only ids above the ledger's highest and never backfills a gap,
  // so a duplicate or skipped id silently never runs on an existing database.
  assert.deepStrictEqual(
    ids,
    ids.map((_, index) => index + 1)
  );
});
