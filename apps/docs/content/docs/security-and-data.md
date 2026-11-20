---
title: Security and data
description: Who can open a patch, what a patch and an agent can reach, how companies and patches are kept apart, and what a person controls.
---

## Who can open a patch

A patch opens only for its audience, the company, some of its teams or anyone with the link, and for guests it was shared with by name. Patchy checks on every request. Someone who loses access loses it on their next request: a page they have open has its calls refused and its live updates stop, though work they started just before may still finish. A reader from another company who isn't a guest, or a colleague outside the patch's teams, gets the same "not found" as a missing address, so a link confirms nothing to them. A signed-out reader of a patch that isn't public gets the sign-in page whether or not it would open for them: sharing hides what a patch holds, not that its address is taken. [Sharing and access](/docs/sharing-and-access) has the details.

Only a tier 1 page can be public, and only its current version. A public page reaches no data, loads no analytics and carries no session for anyone outside its company.

## Signing in and credentials

- **No passwords.** People sign in with Google, Microsoft or a code sent to their email.
- **Computers** get a publishing key through a login the person confirms in their own signed-in browser, checking that it shows the same code as the terminal. A key acts as its person, lasts 90 days or until it goes 30 days unused, and never opens a patch's page.
- **Agents** connect through a consent page the person answers in their own browser, every time. An agent's tool calls go through only while the company's agent access is on, and its connection ends after 30 days without a call.
- **Your agents**, in the portal, lists every computer and agent acting as the person, when each was last used, and disconnects any of them. **Disconnect everything** ends them all at once.
- **Deactivating** a user ends their access and every credential they hold on their next request.

## What a patch can reach

Patchy makes these promises for each tier:

> **A tier 1 patch acts as you, only through Patchy, and never holds your login. What you do inside it can be saved in its own tables, which your colleagues can read, and every write is logged for your company's admins. It reaches nothing outside its own patch.**

> **A tier 2 patch's server code runs on Patchy's machines, never on yours. It holds no login and no credential and has no path to the internet: everything it does goes through Patchy, as you, while you have the patch open or your agent is calling it. It reaches outside systems only through your company's integrations, and every write is logged for your company's admins.**

A tier 1 page runs in a sandboxed frame with no network access, no cookies or browser storage, and no way to open other windows. A tier 2 patch's handlers act as the patch for its own tables and files, and as the viewer for everything else, with the viewer's access checked again on each call.

When a patch asks for data the viewer may not reach, the viewer is told plainly that this is their access, not the patch being broken.

## What an agent can do

> **Your agent can do in a patch only what you can, only through the tools its builder made for agents, and only while your company allows agents. Every change it makes is logged as you, via that agent.**

An agent gets no rights its person lacks, and reaches only the tools a patch's builder wrote for agents, never a patch's page, its other handlers, or its data directly. An admin turns agent access on and off for the whole company. [Agents and MCP](/docs/agents-and-mcp) has the details.

## Company connections

An admin connects each outside system in the browser. Its credential is stored encrypted and applied by Patchy on the server: it never appears on a page, in generated files or in patch code, and no CLI command accepts one.

A connection reads as the credential the admin supplied, so everyone who can open a patch that declares it reads what that credential reaches through the patch. Each connect page says so before it saves anything. An admin can limit which teams build with a connection, block guests from patches that use it, pause it and disconnect it, and sees each connection's latest calls from the patches they can open. [Integrations](/docs/integrations) lists what each one can reach.

## Keeping companies and patches apart

- **Companies.** Each user belongs to exactly one company, and a company's patches stay inside it unless someone shares one publicly or with a named guest. A guest opens only the patch shared with them, as themselves, never as an admin.
- **Server code.** Each company's tier 2 handlers run in an isolated environment that runs no other company's code. Once released, that environment is stopped and never reused.
- **Data.** A company's patch tables live in a database of the company's own, each patch's in a namespace of its own. A patch reads another patch's data only through tables and file stores that patch shares, read-only, and only while the viewer can open the source.
- **Pages.** Each tier 1 page runs in a sandboxed frame on an origin of its own, apart from Patchy's pages and the session.

## Records

- **Writes and calls.** Table and file writes and every integration call are recorded before they run. A tier 2 patch's log shows its mutations, its actions and the queries that log or fail: who made each, through which agent, and how it ended. Its owner and the company's admins read it while they can open the patch. It is not a full record of who read what: a page's query that succeeds without logging gets no entry of its own.
- **Opens.** Patchy keeps each person's record of the patches they open so their own Home can put their usual ones first. Nobody else, owner or admin, sees it.
- **Patchy's own analytics.** Patchy reports its product events, such as a publish, a join or a share, by ids and states, never names, email addresses, URLs or page content. Its request diagnostics carry the ids of the person and the patch on each company page opened.

## Your data

- **Deleting a patch** takes it off at once and starts a 30-day recovery window; after it, Patchy reclaims its versions, tables, files and names for good.
- **A patch repo's files** are kept with each version published from it, and anyone in the company who can open the patch can copy them. Secrets don't belong in a repo, and `.env` files are never sent.
- **Closing a company** is done by hand for now, as the terms set out: an admin emails Patchy. Patchy may help with an export but does not promise one, so a company keeps its own copies. After the agreement ends, when an admin asks, Patchy deletes the company's content within 60 days.
- **Terms changes** are accepted by each person for themselves, on their next page in a browser.

## Terms, privacy and reporting a vulnerability

- [Terms](https://patchyhq.com/cloud/terms)
- [Privacy notice](https://patchyhq.com/cloud/privacy)
- [Security policy](https://github.com/allisonmahmood/patchy-cloud/security/policy): report a vulnerability privately through GitHub's private vulnerability reporting, not a public issue.
