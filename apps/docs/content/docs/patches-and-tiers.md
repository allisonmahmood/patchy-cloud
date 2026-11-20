---
title: Patches and tiers
description: What a patch is, how its versions and lifecycle work, and what each runtime tier runs and reaches.
---

## Patches

A **patch** is the unit people build and publish on Patchy Cloud, anything from a single page to a full CRM. Each is one built thing in a company's cloud: stored as one, permissioned as one, at one address, at one runtime tier. Patches differ in where their code runs, not in what kind of thing they are.

A patch comes from one of two places:

- **A single HTML file**, published as a tier 1 page. It runs its own inline script, carries every resource it uses, and reaches no tables, files or connections.
- **A patch repo**, started by `patchy init` at tier 1 or 2. Its `patchy.config.ts` holds the patch's name and tier and defines the tables and file stores the patch owns. On tier 2 it also declares the connections, shared tables, shared stores and member directory its handlers use.

A patch belongs to one user in the company, its **owner**, who is the only one who publishes to it. An admin can reassign it to another active member.

## Versions

**Publishing** creates a **version**, an immutable copy of the patch, and serves it at once to everyone the patch is shared with. There is no unpublished patch in the cloud: the working copy stays on the builder's computer.

A version from a repo also keeps the repo it was built from: every file except what `.gitignore` excludes, never `.env` files, `.git` or `node_modules`, up to 2,000 files and 10 MiB. Anyone in the company who can open the patch can copy that repo with `patchy pull <patch>`, so a colleague, or the owner on a new computer, can work on it. Only the owner publishes from the copy, and secrets never belong in a repo.

**Rollback** serves any earlier version again without making a new one. Tables, files, sharing, the description and the name stay as they are.

Tables and file stores belong to the patch, not to a version or a tier, so their data stays through every publish, rollback and tier change.

## Addresses and names

Every patch has an address, `/<company>/<patch>`, such as `cloud.patchyhq.com/acme/expenses`. A numbered version opens at `/<company>/<patch>/~v/<n>`. Path segments after the patch's name belong to the patch; segments starting with `~` belong to Patchy.

A name is 3 to 32 lowercase letters, digits or hyphens, unique in its company. Renaming leaves a redirect from the old name until another patch takes it. A patch's identity is its id, so renaming never changes which patch it is.

Each patch also has a **description** of up to 500 characters, saying what it does. Its repo keeps the description in `patchy.json`; edits made in the portal come back into the repo at the next refresh, dev start or publish.

## Retire, delete and restore

A patch is **live**, **retired** or **deleted**:

- **Retire** takes a live patch off its address indefinitely and keeps everything.
- **Delete** takes a patch off and starts a 30-day recovery window.
- **Restore** brings a retired patch back at any time, or a deleted one inside its window, at the same address.

After the 30 days, Patchy reclaims the deleted patch: its versions, tables, files and names. Nothing restores it after that. The owner and the company's admins can retire, delete and restore; colleagues who visit a retired or deleted patch's address see who took it off and when.

## Runtime tiers

A tier is where a patch's code runs. It changes nothing about ownership, versions or addresses. Each version has exactly one tier, set explicitly in `patchy.config.ts`; the patch's tier is the tier of the version it serves.

### Tier 1: the browser

All of a tier 1 patch's code runs in the viewer's browser, in a sandboxed frame, as the viewer. It never holds the viewer's login or any credential.

It reaches only its own patch:

- its own tables and files, through Patchy, which checks every call against the viewer's current access
- who the viewer is, through `me()`
- the page's own routes

It has no server code and no outbound network. Other patches' shared tables and stores, the member directory and company connections are refused from the browser as `server_required`.

Reads of its own tables can be live, so one viewer's write updates every other open copy without a reload. Every row of its tables is readable by whoever can open the patch, and its rules are advisory: a viewer can make the same writes from the browser's developer tools. Direct writes are last-write-wins.

A tier 1 patch can be shared **public**, open to anyone with the link. A public patch runs its browser code and reaches no data: `me()` answers null and its tables and files are unavailable.

Tier 1 code runs only while someone has the patch open. Its writes persist after the browser closes.

### Tier 2: hosted handlers

Tier 2 adds server code: **query**, **mutation** and **action** handlers exported from `server/*.ts`. The page calls these handlers instead of its tables. With the `notes` table from [Primitives](/docs/primitives), a mutation that marks a note done, and refuses one that is missing or already done, looks like this:

```ts
// server/notes.ts
import type { Id } from "patchy/config";
import { HandlerError, mutation, t } from "../patchy/_generated/server.js";

export const finish = mutation({
  args: { id: t.text() },
  result: t.row("notes"),
  errors: ["missing", "already_done"],
  handler: async (ctx, args) => {
    const id = args.id as Id<"notes">;
    const note = await ctx.tables.notes.get(id);
    if (note === null) throw new HandlerError("missing");
    if (note.done) throw new HandlerError("already_done", { since: note.updatedAt });
    return ctx.tables.notes.update(id, { done: true });
  }
});
```

The page calls it as `patchy.server.notes.finish({ id })`, from a typed client generated for the repo.

Handlers run on Patchy's machines in credential-free processes, while someone has the patch open or their agent is calling it. They hold no login and no credential and have no path to the internet; everything they do goes through Patchy.

- A **query** reads under one read-only snapshot, and a page can keep it live.
- A **mutation** groups its reads and writes of the patch's own tables into one transaction. A conflicting write runs the whole handler again, up to three attempts.
- An **action** does work outside one transaction: file bytes, company connections, and calls to other queries and mutations.

Queries have 3 seconds, mutations 5 and actions 60.

Beyond the patch's own tables and files, handlers reach:

- other patches' shared tables and shared file stores, read-only
- the company's member directory, read-only
- company connections: Postgres, PostHog, Attio, Email (IMAP) and GitHub, each read-only, and Pidgeon, which reads an inbox's email and, when its connection allows, sends it

Calls on the patch's own tables and files act as the patch. Calls on shared sources, the member directory and connections act as the viewer, and the viewer's access is checked again on each one.

Tools in a tier 2 repo's `agent/` folder are what people's own agents call, as them, through Patchy MCP. Tier 1 has no agent tools.

A tier 2 patch is shared with its company or its teams; it cannot be public.

### Choosing a tier

Tier 1 is the smaller thing to build, and live updates between viewers already work there. Tier 2 is for rules that must hold, writes that must be atomic, such as several rows at once or a total that several people change, and anything outside the patch: connections, shared sources and the member directory.

### Changing tier

Changing a patch's tier means editing `tier` in `patchy.config.ts`, running `patchy refresh` and publishing a new version. A version's tier never changes in place, and the patch keeps its id and its data.

### Tiers 3 and 4

Neither is built.

- **Tier 3** would start work with no viewer present: inbound HTTP routes, webhooks, schedules and unattended automations.
- **Tier 4** would be a sandboxed computer for agents.
