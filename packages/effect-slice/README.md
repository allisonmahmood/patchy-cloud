# Effect 4 vertical slice (PROTOTYPE)

Throwaway code answering issue #55: does Effect 4 RC carry this codebase's
shapes, and what do the harness patterns look like? Nothing here ships; the
port PRs copy the patterns, not the files.

- `src/api.ts` — the `packages/api` shape: wire schemas, bearer middleware, `HttpApi`.
- `src/auth/`, `src/patches/` — two "capability packages", each owning migrations and queries.
- `src/sql.ts` — `@effect/sql-pg` layer + `Migrator.fromRecord` over both packages' migrations.
- `src/server.ts` — `HttpApi` handlers for `/api/me`, plain `HttpRouter` route for `/d/:draftId`, one global middleware.
- `src/cli.ts` — `whoami` on `effect/unstable/cli`, calling the derived `HttpApiClient`.
- `src/slice.test.ts` — the copyable test patterns.
- `scripts/` — esbuild bundle + the packed-CLI e2e core (real server, real Postgres, bundled CLI).

## Gotchas the port must carry (details on #55)

- **esbuild**: `@effect/platform-node`'s `NodeServices` pulls in CJS `undici`, which `require()`s node builtins. ESM output needs the `createRequire` banner in `scripts/build-cli.mjs`. `FetchHttpClient` does not avoid it.
- **Migrator**: use `Migrator.make({})` from `effect/unstable/sql`, not `PgMigrator.layer` (it wants `ChildProcessSpawner`/`FileSystem`/`Path` for `pg_dump`). Ids are one global integer sequence across packages; duplicates fail. All pending steps run in one transaction under `LOCK TABLE … ACCESS EXCLUSIVE`; the ledger is `migration_id integer`, not today's TEXT ids. Today's multi-statement DDL strings run unchanged through `sql.unsafe`.
- **CLI**: Effect's defaults are agent-hostile — failures log to stdout with a stack, `--version` prints `name vX`, and `--wizard`/`--completions`/`--log-level` come free. `src/cli.ts` shows the three overrides: `CliError.UserError` for every actionable failure, `CliOutput.layer` with a one-line `formatError`/bare `formatVersion`, `CliConfig.layer({ builtIns: [Help, Version] })`.
- **401 body**: keep `{ ok: false, error }` — a `Schema.TaggedError` puts `_tag` on the wire. The middleware error is a plain `Schema.Struct` with `HttpApiSchema.status(401)`.
- **Errors**: keep `SqlError` in the channel and catch it where the policy lives (best-effort visit); `SchemaError` on a row decode is a bug → `Effect.die`.
- **One consumer → module.** `Patches` is a service here to show the shape; per the port map a capability with one consumer stays a module until a second appears.
