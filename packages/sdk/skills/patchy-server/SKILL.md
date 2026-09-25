---
name: patchy-server
description: Write, run and debug tier 2 server handlers in server/ (queries, mutations, actions), their context, HandlerError, the import rule and the two-viewer dev loop. Read before touching server/.
---

<!-- PROTOTYPE for #314 -->

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
- **mutation**: reads and writes the patch's tables inside one transaction per invocation. Every table call joins it; it commits only after the handler returned and its result validated, and rolls back on a `HandlerError`, any other throw, an invalid result or the deadline, so a row written before a throw is gone. On a serialization conflict Patchy runs the whole handler again (up to three times), so a mutation must be safe to run twice; keep effects inside the tables.
- **action**: for effects outside the transactional domain: its table calls run one by one with no transaction and no retry. Connections, files and calling other handlers are not available yet.

## Shapes: `t` for arguments and results

`t.text()`, `t.integer()`, `t.number()`, `t.boolean()`, `t.timestamp()`, `t.json()` and `t.ref("<table>")` as in tables, plus `t.object({ ... })`, `t.array(inner)`, `t.enum(["a", "b"])`, `t.nullable(inner)` and `t.row("<table>")` (a full row of an owned table). `args` must be a `t.object`. `.optional()` on a field means the key may be omitted; use `t.nullable` for an explicit null. `.default()` is table-only and refused here. Unknown argument fields are refused.

## The context

- `ctx.viewer`: `{ user: { id, name, email }, company: { id, handle, name }, admin }`, never null. Own tables are reached as the patch; there is no API to pick an identity.
- `ctx.tables.<name>`: the same client as the browser's (`get`, `getMany`, `list`, and in a mutation or action `insert`, `insertMany`, `update`, `delete`), with the same bounds and refusals (`row_not_found`, `unique_violation`, `too_large`).
- `ctx.log(message, details?)`: up to 100 lines per invocation, printed by `pnpm patchy dev logs` locally and kept in the runtime log in the cloud. Never log secrets.
- Not in this release: `ctx.shared`, `ctx.files`, `ctx.connections`, `ctx.run`.

## Errors

Throw `new HandlerError(code, details?)` for a failure the caller should branch on; list the codes in `errors: [...]`. On the client it arrives as a thrown `HandlerError` and `isHandlerError(error, "empty_title")` narrows it. Any other throw is Patchy's refusal `handler_failed` with a correlation id; the message and stack stay in the log and never reach the browser. A handler that runs past its deadline (10 s locally) is `handler_timeout`. Patchy's own refusals (`access_denied`, `invalid_request`, `unknown_outcome`, ...) are `PatchyError`s as in tier 1 and are never `HandlerError`s.

## The import rule

Bare imports in `server/` resolve only to `patchy` and `patchy/*`; in `src/` also to `preact` and `@preact/signals`. Anything else fails the build with `Import of "<name>" in <file> is not available on this release ... copy it into src/ or ask Patchy for the capability`. The check runs on both bundles and follows imports through your own helper files. Copy the code you need into the repo, or ask the person you are working for to request the capability from Patchy.

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

Types come from `server/` itself: renaming an export or changing `args` breaks the client at typecheck, with no regeneration. Adding or removing a file under `server/` needs `pnpm patchy refresh`. There is no `.subscribe` and no `useQuery` in this release; read again after a mutation.

## Running locally

`pnpm patchy dev --json` starts the local runtime with the same loader Worker and workerd binary as production over local PGlite data. It prints two URLs: `url` opens the patch as you (the publishing key's user) and `colleagueUrl` opens it as a second, fixture colleague in the same company. Open both to check that `ctx.viewer` and the logged attribution differ. Editing a file under `server/` rebuilds the server bundle and rebinds it; calls already in flight finish on the old bundle. `pnpm patchy dev logs` shows `ctx.log` lines, refusals and build failures.

`pnpm patchy publish` builds both artifacts, runs the import check on both, derives the handler descriptors by loading the server bundle in the engine and sends them in the manifest; the instance loads the bundle again and refuses a manifest that disagrees. A module whose top level throws or never finishes initialising is refused at publish.
