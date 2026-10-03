import { migrations as auth } from "@patchy/auth";
import { migrations as companies } from "@patchy/companies";
import { migrations as companyDatabase } from "@patchy/company-database";
import { migrations as execution } from "@patchy/execution/migrations";
import { migrations as integrations } from "@patchy/integrations";
import { migrations as limits } from "@patchy/limits/migrations";
import { migrations as patches } from "@patchy/patches";
import { migrations as runtime } from "@patchy/runtime";
import type { Migrations } from "@patchy/sql";

/**
 * Each capability's own migrations, in id order: one baseline each, squashed
 * before launch, ordered so foreign keys resolve. A new capability with
 * migrations joins this list.
 */
export const capabilityMigrations: ReadonlyArray<Migrations> = [
  companies,
  auth,
  patches,
  companyDatabase,
  runtime,
  integrations,
  limits,
  execution
];

/**
 * Every capability's migrations as one record. The server applies it before it
 * listens, and the dev runner and the vitest template apply this same record.
 */
export const migrations: Migrations = Object.assign({}, ...capabilityMigrations);
