---
name: patchy-postgres
description: Add a company Postgres connection, read its generated relations, write a shaped read-only query, or author local SQL fixtures.
---

# Company Postgres reads

Read `../patchy-loop/SKILL.md` first. Connections are tier 2's: actions reach them through `ctx.connections` and return only the data their handlers authorize, and the page calls those actions. A tier 1 page reaches only its own patch, so declaring a connection on a tier 1 repo is refused with `tier_mismatch`; move the repo to tier 2 first, as `../patchy-loop/SKILL.md` says. Company credentials stay behind Patchy, never in config, source, CLI arguments or agent transcripts. Development uses invented local fixture rows, never production data.

## Declare a connected source

1. Run `pnpm patchy list connections` and choose a connected handle by description. `list connections --all` adds offered integrations and their state, not permission to use a disconnected source. Inspect `pnpm patchy list connections postgres/<handle> --json` for its immutable schema snapshot and `takenAt` before choosing relations, keys and types. A null snapshot means unavailable, not an empty database. An admin connects, reconnects or refreshes schema at `/company/connections`; ask them to use the browser form rather than supply you a connection string.
2. Run `pnpm patchy add postgres/<handle> --as sales` with the chosen handle. For `warehouse`, it inserts `sales: { kind: "postgres", handle: "warehouse" }` into `uses` without changing imports, and generates client, context, fixture stub and this skill. When hand-editing config, you may instead import `postgres` from `patchy/config` and write the equivalent `sales: postgres("warehouse")`; run `pnpm patchy refresh` afterwards.
3. Read `patchy/_generated/index.json`, then the context path for `sales`. Use only the discovered relations and columns it lists. It also names exclusions and relations without a usable primary key. Never invent generated methods or edit a snapshot stamp to clear an error.
4. Fill `fixtures/postgres-warehouse.sql` with invented local `INSERT` statements, matching the stub's schema-qualified, quoted table and column names and source-native types, including modifiers such as `"pg_catalog"."numeric"(8,2)`. For example, only if its header actually lists `"public"."customers" ("id" integer, "name" text)`, use `INSERT INTO "public"."customers" ("id", "name") VALUES (1, 'Local customer');`. Views are synthetic local tables: insert fixture rows into them too. Preserve existing fixtures across refresh and removal.
5. Run `pnpm typecheck` and `pnpm patchy dev --json`. Call actions that read `ctx.connections` through the same host callback path as production. Open both `url` and `colleagueUrl` to check viewer behavior. A missing fixture or unsupported local SQL feature fails locally with its reason, never falling back to production. After changing fixture rows, stop and start dev again. PGlite does not prove production contention or serialization-conflict behavior.

`pnpm patchy add postgres` chooses the sole connected Postgres connection; with several it lists choices from `list connections` and stops. Without `--as`, the alias is the handle with hyphens camel-cased. Prefer an explicit discovered handle for a reproducible command. To look for an existing tool or shared table instead, follow the loop skill's patch discovery chain. No matching patch means none you can use; check `--state retired` before concluding that tool does not exist. Patch state flags do not apply to connections.

## Generated APIs

For an alias `sales`, public-schema relations live at `ctx.connections.sales.customers`; another schema lives at `ctx.connections.sales.analytics.orders`. Use bracket notation for names that need it. The generated context is authoritative for actual paths; `query` is reserved and colliding or unsupported relations are excluded and named. They exist in actions, not on the page client or in a query or mutation. Read `patchy-server` for the handler development boundary.

If the snapshot contains these columns, an action can read:

```ts
const page = await ctx.connections.sales.customers.list({
  eq: { name: "Local customer" },
  select: ["id", "name"],
  orderBy: { column: "id", direction: "asc" },
  limit: 20
});
```

`list({ eq?, range?, orderBy?, select?, limit?, cursor? })` returns `{ ok: true, rows, cursor }`. A range is `{ column, gt?, gte?, lt?, lte? }`; `orderBy` is one `{ column, direction }`. Select only needed fields and use server-side filtering. A keyed relation has `get({ id: 1 })` (use its actual primary-key fields) and `getMany([{ id: 1 }, { id: 2 }])`, returning null for missing rows and preserving input order. Unkeyed relations have no `get` or `getMany`.

Keyed cursors bind connection, relation, snapshot revision, filters and order; reuse them only with the same query. Unkeyed views use bounded offsets, ending at 10,000 rows with `offset_exhausted`. Page until cursor is null, not until a page happens to be short. Views' columns are nullable.

## Shaped SQL when relation reads are insufficient

`ctx.connections.sales.query(sql, params, shape)` executes one read-only statement. Bind values in `params`, never interpolate user input into SQL. State columns explicitly rather than `SELECT *`. For a discovered `invoices` relation whose `amount_cents` is integer money in a single currency, keep the aggregate exact:

```ts
const result = await ctx.connections.sales.query(
  'SELECT COALESCE(SUM("amount_cents"), 0)::text AS "total_cents" FROM "public"."invoices" WHERE "customer_id" = $1',
  [1],
  { total_cents: { kind: "text" } }
);
const totalCents = BigInt(result.rows[0]!.total_cents);
```

Use only relation and column names present in the generated context. PostgreSQL
widens integer sums; casting back to `int` can overflow. Return the sum as text,
not a JavaScript number, and use `BigInt` for exact integer-cent arithmetic.
Keep decimal currency formatting exact, including cents. Convert a bigint back
to a decimal string before a handler result or any JSON boundary.

The result is `{ ok: true, rows }`. Query shapes use literal descriptors; `{ kind: "text", optional: true }` admits null. Defaults and refs are refused. Keep `patchy/config` imports in the config. Missing or duplicate result names and null in a non-optional column fail; extra result columns are dropped. An action that doesn't catch a refusal relays it to the page, still Postgres's: import `isPatchyError` from the relative generated `client.js` there, and `isPatchyError(error, "shape_mismatch")` narrows the shared error's `code`, `message` and `details`. `invalid_query` may include SQLSTATE and position; fix the query instead of hiding the error.

Type mapping matters: int2/int4 are numbers; int8 and numeric are strings, not JavaScript numbers. Floats must be finite. Timestamptz is UTC ISO, date is `YYYY-MM-DD`, timestamp without zone has no timezone, JSON and arrays are `unknown`; int8 and numeric array elements are strings too. Domains use their resolved type. Use the generated context for exclusions rather than guessing conversions.

Calls are constrained reads through the role the admin supplied, not a production sandbox for development. No writes or multiple statements. Bounds: 256 KiB request including parameters, 1,000 rows and 8 MiB result per call, 10-second statement timeout and 15-second service deadline. Every integration call is logged for company admins. Respect `timeout`, `too_large`, `source_unavailable` and access refusals.

`connection_not_connected` needs the admin's connection page. `stale_generated` needs `pnpm patchy refresh`, never a hand-edited revision. A snapshot refresh does not rewrite published versions; their contracts retain their own revision while credentials and access are checked live. `pnpm patchy remove sales` drops the declaration and generated surface but leaves its local fixture.
