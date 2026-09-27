---
name: patchy-shared-stores
description: Declare another patch's shared file store, read its files from server functions, lay down local sample files, or diagnose unsharing and access refusals.
---

<!-- PROTOTYPE for #315 -->

# Shared file stores

Read `../patchy-loop/SKILL.md` and `../patchy-server/SKILL.md` first. A source patch shares a whole file store with its company; your tier 2 patch declares it by alias and reads it from server functions. You never write to it. Build with invented local sample files, never copies of company files.

## Find and declare

1. `pnpm patchy list --json`, then `pnpm patchy list <patch> --json`: stores show `shared` and `declarable`, with the add hint. `pnpm patchy list <patch> <store> --json` shows its description and revision. Branch on `declarable` and `reason` (`not_shared`: ask the named owner; `source_off`: the source is retired or deleted).
2. `pnpm patchy add shared-store <patchId>/<store> --as contracts`. It adds `contracts: { kind: "sharedStore", patchId, store }` to `uses`, generates the server client and context, and lays down `fixtures/shared-contracts/` with two sample files once (refresh never recreates the directory).
3. Put invented local samples in `fixtures/shared-contracts/`, named like the source's files (read the context file and the source's description for its naming convention). `patchy dev` loads them into a local copy of the store at start; a name already there is never overwritten. After adding samples, stop and start dev.

## Read

In a query or an action:

```ts
export const contracts = query({
  args: t.object({}),
  result: t.array(t.object({ name: t.text(), contentType: t.text(), handle: t.fileHandle() })),
  handler: async (ctx) =>
    (await ctx.shared.contracts.list({ limit: 100 })).files.map(
      ({ name, contentType, handle }) => ({
        name,
        contentType,
        handle
      })
    )
});
```

- `list({ prefix?, limit?, cursor? })` returns `{ files, cursor }` (100 per page, at most 1,000; follow `cursor` until null); `stat(name)` returns an entry or null; `get(name)` returns `{ entry, bytes }` or null, in an action only. There are no writes.
- Entries carry handles minted for your patch and viewer; the page redeems them with `patchy.files.url` / `useFileUrl` / `patchy.files.download` as for your own files.
- A subscribed query re-runs when the source writes the store, and when the source's owner shares, unshares, retires, deletes or restores it.

## Access

Every read and every redemption checks, live, that the viewer can open the source and that the store is still shared. When it is not, the read is refused with `access_denied`: an uncaught refusal fails your query with `access_denied`, the page's `useQuery` shows it as `error`, and handles from the store stop redeeming. Your patch's own tables and files are unaffected, and the page stays open. When the owner shares the store again, the same declaration works again with no change on your side, and handles minted before keep working as long as their file was not replaced.

The declaration's revision records the source you generated against; publishing warns when the source moved on, and `pnpm patchy refresh` updates it. Omitting the store from the source's config or rolling the source back never changes sharing; only the source's owner does, by publishing it with `shared` false, which is refused while declaring patches exist unless forced.

`pnpm patchy remove contracts` drops the declaration and generated files and leaves `fixtures/shared-contracts/`.
