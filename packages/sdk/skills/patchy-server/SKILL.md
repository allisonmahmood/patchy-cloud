---
name: patchy-server
description: Write, run and debug tier 2 server handlers in server/ (queries, mutations, actions), their context, HandlerError, the import rule and the two-viewer dev loop. Read before touching server/.
---

<!-- PROTOTYPE for #314 -->
<!-- PROTOTYPE for #315: files, handles, uploads, shared stores, connections in actions, useQuery. -->

# Server handlers (tier 2)

Read `../patchy-loop/SKILL.md` first. A tier 2 patch has two artifacts: the HTML bundle from `src/` that runs in the browser frame, and the server bundle from `server/` that runs on Patchy's execution engine. The browser never runs server code and server code never runs in the browser. Handlers reach the patch's tables through Patchy as the viewer, hold no login and no credential, and have no path to the internet: `fetch` from a handler is refused.

## Files and names

Every `server/<file>.ts` exports handlers and nothing else. The name on the wire and on the client is `<file>.<export>`: `server/notes.ts` exporting `add` is `patchy.server.notes.add(args)`. One level deep, no subdirectories. An export that is not a handler fails the build with `server/ export <file>.<name> is not a handler`; put helpers in a non-exported function or a file outside `server/` that you import.

Import the builders from the generated module, never from `patchy/server` directly, so `ctx.tables` is typed from `patchy.config.ts`:

```ts
import { query, mutation, t, HandlerError } from "../patchy/_generated/server.js";

export const list = query({
  args: t.object({ done: t.boolean().optional() }),
  result: t.array(t.row("notes")),
  handler: async (ctx, { done }) =>
    (
      await ctx.tables.notes.list({
        limit: 100,
        ...(done === undefined ? {} : { index: "byDone", eq: { done } })
      })
    ).rows
});

export const add = mutation({
  args: t.object({ title: t.text() }),
  result: t.row("notes"),
  errors: ["empty_title"],
  handler: async (ctx, { title }) => {
    if (title.trim() === "") throw new HandlerError("empty_title");
    ctx.log("adding a note", { by: ctx.viewer.user.email });
    return ctx.tables.notes.insert({ title: title.trim() });
  }
});
```

`args` and `result` are required; the build refuses a declaration without them. Arguments are validated against `args` before the handler runs (a Patchy refusal `invalid_request` to the caller) and the result against `result` after it (a mismatch is the handler's fault, reported as `handler_failed`).

## The three kinds

- **query**: reads the patch's tables; no writes. `ctx.tables` is read-only in TypeScript and the engine refuses a write from a query at the wire (`access_denied`), so the types are not the enforcement.
- **mutation**: reads and writes the patch's tables inside one transaction per invocation. Every table call joins it; it commits only after the handler returned and its result validated, and rolls back on a `HandlerError`, any other throw, an invalid result or the deadline, so a row written before a throw is gone. A mutation may execute up to three times within one call: on a serialization conflict the attempt is rolled back and the whole handler runs again. Aborted attempts leave no database writes; only the successful attempt commits, and a handler that catches a table error and returns anyway still does not commit. Keep effects within the tables; external effects belong in actions. Logs may repeat. Past three attempts the call fails with `source_unavailable`.
- **action**: for effects outside the transactional domain: its table calls run one by one with no transaction and no retry. File bytes, file writes and company Postgres live here.

## Shapes: `t` for arguments and results

`t.text()`, `t.integer()`, `t.number()`, `t.boolean()`, `t.timestamp()`, `t.json()` and `t.ref("<table>")` as in tables, plus `t.object({ ... })`, `t.array(inner)`, `t.enum(["a", "b"])`, `t.nullable(inner)`, `t.row("<table>")` (a full row of an owned table), `t.fileHandle()` (results only) and `t.upload()` (action arguments only; see Files). `args` must be a `t.object`. `.optional()` on a field means the key may be omitted; use `t.nullable` for an explicit null. `.default()` is table-only and refused here. Unknown argument fields are refused. Arguments and results are readonly in TypeScript: `t.array` is `readonly T[]` and `t.object` fields are `readonly`, on the client and in the handler, so copy before you sort or change one (`[...rows].sort(...)`, `{ ...row, title }`).

## The context

- `ctx.viewer`: `{ user: { id, name, email }, company: { id, handle, name }, admin }`, never null. Own tables are reached as the patch; shared tables and connections as the viewer, checked per call; there is no API to pick an identity.
- `ctx.tables.<name>`: the same client as the browser's (`get`, `getMany`, `list`, and in a mutation or action `insert`, `insertMany`, `update`, `delete`), with the same bounds and refusals (`row_not_found`, `unique_violation`, `too_large`).
- `ctx.shared.<alias>`: a declared shared table, read-only (`get`, `getMany`, `list`), in a query or an action. Declare it with `pnpm patchy add shared-table <patchId>/<table> --as <alias>` (see `../patchy-shared-tables/SKILL.md`); the local runtime reads its `fixtures/shared-<alias>.sql` rows.
- `ctx.shared.<alias>` for a declared shared file store: `list`, `stat` in a query or an action, `get` in an action (see Files and `../patchy-shared-stores/SKILL.md`).
- `ctx.files.<store>`: the stores `patchy.config.ts` defines (see Files).
- `ctx.connections.<alias>`: a declared company Postgres connection with the generated client (`query` and the relations' `list`, `get`, `getMany`), in an action only. Declare it with `pnpm patchy add postgres/<handle> --as <alias>` (see `../patchy-postgres/SKILL.md`); the bounds are the connection's (read-only, 1,000 rows, 10-second statements). A query cannot subscribe to it: call the action when the page needs fresh figures.
- `ctx.run.<module>.<handler>(args)`: in an action only, runs a sibling query or mutation of this patch under the action's remaining deadline; each mutation is its own transaction; a `HandlerError` the sibling throws is rethrown to you.
- `ctx.log(message, details?)`: up to 100 lines per invocation, printed by `pnpm patchy dev logs` locally and kept in the runtime log in the cloud. Never log secrets.
  | Reaches | query | mutation | action |
  | -------------------------------- | -------- | -------- | ------ |
  | `ctx.tables` reads | yes | yes | yes |
  | `ctx.tables` writes | no | yes | yes |
  | `ctx.shared` reads (list, stat) | yes | no | yes |
  | `ctx.files` list, stat | yes | no | yes |
  | file bytes (`get`), `put`, `delete` | no | no | yes |
  | `ctx.connections` | no | no | yes |
  | `ctx.run` | no | no | yes |
  | one transaction, retried | snapshot | yes | no |

The types leave the refused cells out of the context, and the host refuses them at the wire too (`access_denied`).

## Files

What the page sees is what handlers return. A page names no file and has no file operations of its own: a handler selects files and returns each one's `handle`, and the page redeems that handle for exactly those bytes. Filtering by viewer is your code; Patchy only checks that the viewer can reach the store at all.

```ts
import { query, action, t, HandlerError } from "../patchy/_generated/server.js";

const file = t.object({
  name: t.text(),
  size: t.number(),
  contentType: t.text(),
  handle: t.fileHandle()
});

export const attachments = query({
  args: t.object({ dealId: t.text() }),
  result: t.array(file),
  handler: async (ctx, { dealId }) =>
    (await ctx.files.attachments.list({ prefix: `${dealId}/` })).files.map(
      ({ name, size, contentType, handle }) => ({ name, size, contentType, handle })
    )
});

export const attach = action({
  args: t.object({ dealId: t.text(), file: t.upload(), name: t.text() }),
  result: file,
  errors: ["too_large", "not_a_pdf"],
  handler: async (ctx, args) => {
    if (args.file.size > 5_000_000) throw new HandlerError("too_large"); // measured by Patchy
    if (args.file.contentType !== "application/pdf") throw new HandlerError("not_a_pdf"); // a claim
    const entry = await ctx.files.attachments.put(`${args.dealId}/${args.name}`, args.file);
    return {
      name: args.name,
      size: entry.size,
      contentType: entry.contentType,
      handle: entry.handle
    };
  }
});
```

- `ctx.files.<store>.list({ prefix?, limit?, cursor? })` returns `{ files, cursor }`, names ascending, 100 per page by default and at most 1,000; pass `cursor` until it is null. `stat(name)` returns one entry or null. Every entry is `{ name, size, contentType, updatedAt, handle }`.
- In an action: `get(name)` returns `{ entry, bytes }` or null; `put(name, upload | bytes, { contentType? })` points the name at new bytes and returns the new entry; `delete(name)` returns whether a file was there. Plain `Uint8Array` bytes need `{ contentType }`, which lets an action generate an export and return its handle.
- An Upload comes from the page (`patchy.files.stage`) as a `t.upload()` argument. In the action, `size` is Patchy's measurement and `contentType` is the page's claim, not proof: check both before `put`. An Upload is adopted once, by one `put`; a second use, or another viewer's Upload, is refused with `not_found`.
- A handle is bound to this viewer, this patch and this published version, and to the exact bytes: after `put` replaces the name or `delete` removes it, older handles answer `not_found`. Return handles only in results typed `t.fileHandle()`; never accept one as an argument or keep one in a table. A handle freezes your selection until the query re-runs: a subscribed query re-runs on every write to the store and returns fresh handles.
- `put` then a mutation is not atomic. If the mutation after an adopted `put` fails, the file stays in the store: return what happened (for example `{ stored, recorded: false }`) and let the page present the partial outcome and a retry; never report plain success or plain failure.
- Bytes enter the isolate only in an action (`get`, or `put` of generated bytes). Files are at most 20 MiB.

## Company Postgres from an action

```ts
export const finance = action({
  args: t.object({ company: t.text() }),
  result: t.object({ invoiced: t.integer(), paid: t.integer() }),
  handler: async (ctx, { company }) => {
    const { rows } = await ctx.connections.finance.query(
      'SELECT coalesce(sum("amount_cents"), 0)::int AS "invoiced" FROM "public"."invoices" WHERE "company_name" = $1',
      [company],
      { invoiced: t.integer() }
    );
    return { invoiced: rows[0]!.invoiced, paid: 0 };
  }
});
```

The alias's generated client is `../patchy-postgres/SKILL.md`'s, reached through `ctx.connections` instead of `patchy.connections`. Call the action from the page when it needs the figures; it is not a query, so it cannot be subscribed.

## Errors

Throw `new HandlerError(code, details?)` for a failure the caller should branch on; list the codes in `errors: [...]`. On the client it arrives as a thrown `HandlerError` and `isHandlerError(error, "empty_title")` narrows it. Any other throw is Patchy's refusal `handler_failed` with a correlation id; the message and stack stay in the log and never reach the browser. A handler that runs past its deadline (10 s locally) is `handler_timeout`. Patchy's own refusals (`access_denied`, `invalid_request`, `unknown_outcome`, ...) are `PatchyError`s as in tier 1 and are never `HandlerError`s.

## The import rule

Bare imports in `server/` resolve only to `patchy` and `patchy/*`; in `src/` also to `preact`, `@preact/signals` and any packages `../patchy-preact/SKILL.md` lists for this repo. Anything else fails the build with `Import of "<name>" in <file> is not available on this release ... copy it into src/ or ask Patchy for the capability`. The check runs on both bundles and follows imports through your own helper files. Copy the code you need into the repo, or ask the person you are working for to request the capability from Patchy.

## Calling from the browser

```ts
import { patchy, isHandlerError } from "../patchy/_generated/client.js";

const notes = await patchy.server.notes.list({});
try {
  await patchy.server.notes.add({ title });
} catch (error) {
  if (isHandlerError(error, "empty_title")) showValidation();
  else throw error;
}
```

Types come from `server/` itself: renaming an export or changing `args` breaks the client at typecheck, with no regeneration. Adding or removing a file under `server/` needs `pnpm patchy refresh`.

## Live queries: `.subscribe`

A query can be subscribed instead of called. Patchy re-runs it as the viewer whenever a commit touches a table or file store its last run read (yours, or a shared one's owner writing it, sharing it or unsharing it), and hands you the whole result each time it changed. In Preact use `useQuery` from `patchy/preact` (see `../patchy-preact/SKILL.md`); without it:

```ts
const stop = patchy.server.notes.list.subscribe({}, (notes) => render(notes), {
  onError: (error) => showError(error), // a HandlerError from a re-run, or the refusal that ended it
  onStatus: (status) => showStatus(status) // "up-to-date", "resyncing" (keep showing data), "suspended", "stopped"
});
// later
stop();
```

- Render the whole result every time; it is not a diff. Coalescing skips intermediate writes, and two subscriptions update independently, so a count and a list can briefly disagree; return related values from one query when a screen needs them to agree.
- A list with `limit` is a window, not the table: a write outside the window does not change the result.
- Only queries have `.subscribe`; subscribing a mutation or an action is refused. Company Postgres data never wakes a subscription: `ctx.connections` is action-only.
- Call `stop()` when the view goes away. Subscribing again to the same handler and arguments within a second reuses the live subscription.
- A refusal inside the query (a shared source unshared or retired: `access_denied`) reaches `onError` and the subscription stays: when access returns, the next result arrives. Show the error instead of the old data while it stands.
- A document hidden for 30 seconds releases its subscriptions; when it is visible again each one re-runs (`resyncing`, then the fresh result).
- In `pnpm patchy dev`, editing `server/` re-runs live subscriptions on the new bundle.

## Running locally

`pnpm patchy dev --json` starts the local runtime with the same loader Worker and workerd binary as production over local PGlite data. It prints two URLs: `url` opens the patch as you (the publishing key's user) and `colleagueUrl` opens it as a second, fixture colleague in the same company. Open both to check that `ctx.viewer` and the logged attribution differ. Editing a file under `server/` rebuilds the server bundle and rebinds it; calls already in flight finish on the old bundle. `pnpm patchy dev logs` shows `ctx.log` lines, refusals and build failures.

`pnpm patchy publish` builds both artifacts, runs the import check on both, derives the handler descriptors by loading the server bundle in the engine and sends them in the manifest; the instance loads the bundle again and refuses a manifest that disagrees. A module whose top level throws or never finishes initialising is refused at publish.
