---
name: patchy-posthog
description: Add a company PostHog connection, read its discovered events and properties, or write a named, shaped, read-only HogQL query.
---

# Company PostHog reads

Read `../patchy-loop/SKILL.md` first. A PostHog connection reads one PostHog Cloud project's events and people through a personal API key an admin connected. Patchy builds every request, so a patch can only send read queries. On tier 1, every row a query returns is available to whoever can open the patch, including anything events carry, such as emails or user ids; hiding a column in the UI does not protect it. Tier 2 reaches PostHog through `ctx.connections` in actions and returns only what its handlers authorize. The key stays behind Patchy, never in config, source, CLI arguments or agent transcripts.

## Declare a connected project

1. Run `pnpm patchy list connections` and choose a connected `posthog/<handle>` by description. Inspect `pnpm patchy list connections posthog/<handle> --json` for its events, event properties and person properties, with types and descriptions, and its `takenAt`. A null snapshot means unavailable, not an empty project. An admin connects, reconnects or refreshes events at `/company/connections`; ask them to use the browser form rather than supply you a key.
2. Run `pnpm patchy add posthog/<handle> --as analytics`. For `product`, it inserts `analytics: { kind: "posthog", handle: "product" }` into `uses` and generates the client, context and this skill. When hand-editing config, you may instead import `posthog` from `patchy/config` and write `analytics: posthog("product")`; run `pnpm patchy refresh` afterwards.
3. Read `patchy/_generated/index.json`, then the context path for `analytics`. Its events and properties are hints from the last discovery, not a fence: a query may name anything the project has, and new events appear in the context after an admin refreshes the connection and you run `pnpm patchy refresh`.

There is no fixture. This release's `patchy dev` refuses PostHog calls with `source_unavailable`; build the query against the context, then check it in the published patch.

## Querying

`patchy.connections.analytics.query({ name, query, values, shape })` runs one HogQL query as the viewer and returns `{ ok: true, rows }`. On tier 2 the same call is `ctx.connections.analytics.query(...)` in an action, never in a query or mutation handler or on the page.

```ts
import { patchy } from "../patchy/_generated/client.js";

const result = await patchy.connections.analytics.query({
  name: "dailyPageviews",
  query:
    "SELECT toStartOfDay(timestamp) AS day, count() AS views FROM events WHERE event = {event} AND timestamp >= now() - INTERVAL {days} DAY GROUP BY day ORDER BY day LIMIT 100",
  values: { event: "$pageview", days: 30 },
  shape: { day: { kind: "timestamp" }, views: { kind: "integer" } }
});
```

- **HogQL** is PostHog's SQL, ClickHouse-flavoured: tables such as `events` and `persons`, functions such as `count()`, `uniq(...)`, `toStartOfDay(...)` and `now()`. Read an event property as `properties.<name>`, and a person property on events as `person.properties.<name>`. Quote names that are not plain identifiers with backticks.
- **`name`** is required: letters, digits, `_`, `.`, `:` or `-`, starting with a letter, at most 100 characters. It labels the call in the connection's recent calls and in PostHog's own query log, so name what the query is for.
- **`values`** fills `{placeholders}` with constants: strings, finite numbers, booleans, null, or arrays of those. They are values, never table or column names, so pass user input only through `values`, never into the query text. Placeholder names are letters, digits and `_`.
- **`shape`** uses the raw-query descriptors `text`, `integer`, `number`, `boolean`, `timestamp` and `json`, with `optional: true` for nullability. Missing or duplicate columns, a type the kind can't hold and null in a non-optional column fail with `shape_mismatch`, whose `details` name the column, the reason and PostHog's type. Extra columns are dropped. Use `as` aliases so result names match the shape.
- **Types.** `String`, `UUID`, enums and `Date` are text. `Int8` to `UInt32` are integer or number. `Int64` and `UInt64`, such as `count()`, are numbers only while they are safe integers; larger values fail, so cast with `toString(...)` and declare text. `Float32` and `Float64` are number. `Bool`, and comparisons' `UInt8` 0 or 1, are boolean. `DateTime` and `DateTime64` are timestamp, returned as UTC with six fractional digits and `Z`. Arrays, maps and tuples are `json`, with any 64-bit integers inside them still safe. `Decimal` and 128- or 256-bit integers fail wherever they appear, even inside an array, map or tuple, and so do types Patchy doesn't map; cast them with `toString(...)` or `toFloat64(...)`.

## Bounds and refusals

- At most 1,000 rows and 8 MiB per call, a 256 KiB request, and a 15-second service deadline bounded by the action's remaining time. PostHog returns 100 rows unless the query has its own `LIMIT`; a result PostHog cut short fails with `too_large`, so add a `LIMIT` of at most 1,000 or aggregate.
- `invalid_query` carries PostHog's message in `details.message`, with no SQLSTATE; fix the query rather than hiding the error. Narrow a caught error with `isPatchyError(error, "invalid_query", "posthog")`, imported from the relative generated `client.js`; narrowing on the code alone types Postgres's details.
- PostHog's rate, query budget and concurrency limits fail with `source_rate_limited`, with `retryAfter` only when PostHog sent one. Patchy never retries a query; don't loop on it. `busy` means Patchy's own per-project slots stayed full and nothing was sent.
- `source_unavailable` covers an unreachable PostHog and a key or project that stopped working; the latter needs an admin at `/company/connections`.
- Every call, with its name and query text but never its values or rows, appears in the connection's recent calls for company admins.

`connection_not_connected` needs the admin's connection page. `stale_generated` needs `pnpm patchy refresh`, never a hand-edited revision. `pnpm patchy remove analytics` drops the declaration and its generated surface.
