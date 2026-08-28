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
