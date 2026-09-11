---
name: patchy-postgres
description: Add a company Postgres connection, read its generated relations, write a shaped read-only query, or author local SQL fixtures.
---

# Company Postgres reads

Read `../patchy-loop/SKILL.md` first. Every readable row is available to whoever can open the patch; hiding a column in the UI does not protect it. Tier 1 has no outbound access or client storage. Company credentials stay behind Patchy, never in config, source, CLI arguments or agent transcripts. Development uses invented local fixture rows, never production data.

## Declare a connected source

1. Run `pnpm patchy catalog` and choose a connected handle. `--all` shows what is offered and its state, not permission to use a disconnected source. An admin connects, reconnects or refreshes schema at `/company/connections`; ask them to use the browser form rather than supply you a connection string.
2. Run `pnpm patchy add postgres/warehouse --as sales`, substituting the catalog's handle. It inserts `sales: { kind: "postgres", handle: "warehouse" }` into `uses` without changing imports, and generates client, context, fixture stub and this skill. When hand-editing config, you may instead import `postgres` from `patchy/config` and write the equivalent `sales: postgres("warehouse")`; run `pnpm patchy refresh` afterwards.
3. Read `patchy/_generated/index.json`, then the context path for `sales`. Use only the discovered relations and columns it lists. It also names exclusions and relations without a usable primary key. Never invent generated methods or edit a snapshot stamp to clear an error.
4. Fill `fixtures/postgres-warehouse.sql` with invented local `INSERT` statements, matching the stub's schema-qualified, quoted table and column names and source-native types. For example, only if its header actually lists `"public"."customers" ("id" integer, "name" text)`, use `INSERT INTO "public"."customers" ("id", "name") VALUES (1, 'Local customer');`. Views are synthetic local tables: insert fixture rows into them too. Preserve existing fixtures across refresh and removal.
5. Typecheck, then exercise reads through the local dev shell when its runtime is available. This release generates the files; it does not yet run `patchy dev`. A missing fixture or an unsupported local SQL feature must fail locally with its reason, not fall back to production.

`pnpm patchy add postgres` chooses the sole connected Postgres connection; with several it lists choices and stops. Without `--as`, the alias is the handle with hyphens camel-cased. Prefer the catalog's explicit handle when recording a reproducible command.

## Generated APIs

For an alias `sales`, public-schema relations live at `patchy.connections.sales.customers`; another schema lives at `patchy.connections.sales.analytics.orders`. Use bracket notation for names that need it. The generated context is authoritative for actual paths; `query` is reserved and colliding or unsupported relations are excluded and named.

If the snapshot contains these columns, application code can read:

```ts
import { patchy } from "../patchy/_generated/client.js";

const page = await patchy.connections.sales.customers.list({
  eq: { name: "Local customer" },
  select: ["id", "name"],
  orderBy: { column: "id", direction: "asc" },
  limit: 20
});
```

`list({ eq?, range?, orderBy?, select?, limit?, cursor? })` returns `{ ok: true, rows, cursor }`. A range is `{ column, gt?, gte?, lt?, lte? }`; `orderBy` is one `{ column, direction }`. Select only needed fields and use server-side filtering. A keyed relation has `get({ id: 1 })` (use its actual primary-key fields) and `getMany([{ id: 1 }, { id: 2 }])`, returning null for missing rows and preserving input order. Unkeyed relations have no `get` or `getMany`.

Keyed cursors bind connection, relation, snapshot revision, filters and order; reuse them only with the same query. Unkeyed views use bounded offsets, ending at 10,000 rows with `offset_exhausted`. Page until cursor is null, not until a page happens to be short. Views' columns are nullable.

## Shaped SQL when relation reads are insufficient

`patchy.connections.sales.query(sql, params, shape)` executes one read-only statement. Bind values in `params`, never interpolate user input into SQL. State columns explicitly rather than `SELECT *`:

```ts
import { t } from "patchy/config";

const result = await patchy.connections.sales.query(
  'SELECT "name" FROM "public"."customers" WHERE "id" = $1',
  [1],
  { name: t.text() }
);
```

The result is `{ ok: true, rows }`. Shape kinds use the column language; `.optional()` admits null, but `.default()` and `t.ref()` are refused. Missing or duplicate result names and null in a non-optional column fail; extra result columns are dropped. `isPatchyError(error, "shape_mismatch")` from `patchy/client` narrows the shared error's `code`, `message` and `details`. `invalid_query` may include SQLSTATE and position; fix the query instead of hiding the error.

Type mapping matters: int2/int4 are numbers; int8 and numeric are strings, not JavaScript numbers. Floats must be finite. Timestamptz is UTC ISO, date is `YYYY-MM-DD`, timestamp without zone has no timezone, JSON and arrays are `unknown`. Domains use their resolved type. Use the generated context for exclusions rather than guessing conversions.

Calls are constrained reads through the role the admin supplied, not a production sandbox for development. No writes or multiple statements. Bounds: 256 KiB request including parameters, 1,000 rows and 8 MiB result per call, 10-second statement timeout and 15-second service deadline. Every integration call is logged for company admins. Respect `timeout`, `too_large`, `source_unavailable` and access refusals.

`connection_not_connected` needs the admin's connection page. `stale_generated` needs `pnpm patchy refresh`, never a hand-edited revision. A snapshot refresh does not rewrite published versions; their contracts retain their own revision while credentials and access are checked live. `pnpm patchy remove sales` drops the declaration and generated surface but leaves its local fixture.
