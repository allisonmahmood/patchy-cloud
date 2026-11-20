---
title: Integrations
description: The company systems a tool can reach, how an admin connects them, and what a patch can do through each.
---

An **integration** is a capability Patchy builds and maintains for reaching an outside system, the same for every company. A **connection** is one live, credentialed instance of it that an admin sets up for the company, such as `postgres/warehouse` or `pidgeon/support`. Patchy offers six integrations: Postgres, PostHog, Pidgeon, Attio, Email (IMAP) and GitHub.

## How connections work

- **An admin connects it in the browser**, at Settings › Integrations, with its credential and a handle: 3 to 32 lowercase letters, digits or hyphens, unique for that integration. No CLI command takes a credential, and patch code never sees one.
- **A tier 2 patch declares it.** In the patch repo, `pnpm patchy add postgres/warehouse --as sales` adds the declaration and generates a typed client, its context and a project skill for the agent. Tier 1 patches can't declare connections.
- **Actions call it.** A tier 2 action reaches the connection through `ctx.connections`, and the page calls the action. Patch code calls the typed operations Patchy defines for each integration and never talks to the outside system directly.
- **It acts as the viewer.** Patchy checks that the viewer can open the patch, and that the patch's owner may build with the connection, on every call, and records who made it. The outside system sees the connection's own credential, not each person.
- **Everyone who can open the patch uses it.** Every member who can open a patch that declares a connection reads what the connection reaches, through that patch's handlers. An admin can let only some teams build with a connection, and can **block guests**, which closes every patch using it to guests from other companies.
- **Admins see the calls.** Each connection's page lists its latest calls: when, from which patch and version, as whom, how long, and the outcome.

`patchy list connections` shows the company's connections and their state; `patchy list connections postgres/warehouse` shows what a connection holds, such as its tables or folders, without reading its data. An admin can **pause** a connection, which stops patches reading it and keeps its credential, and **disconnect** it once no version of any patch declares it.

While a tool is built, `patchy dev` reads PostHog, Pidgeon, Attio, Email (IMAP) and GitHub through the real connection, as the person whose computer it is, and each such read shows on the connection's page. Writes are never sent from `patchy dev`: Pidgeon's sends and replies are simulated and printed instead. Postgres reads invented local rows the builder writes as fixtures.

## Postgres

A company's own Postgres database, reachable from the internet over TLS. The admin supplies a role; Patchy refuses superusers and roles that can create databases or roles.

A patch reads through generated relation clients, `list`, `get` and `getMany`, or a `query(sql, params, shape)` escape hatch for one read-only SQL statement with bound parameters. Every call runs inside a read-only transaction with a 10-second statement timeout, and answers at most 1,000 rows and 8 MiB.

```ts
const page = await ctx.connections.sales.customers.list({
  eq: { name: "Acme Ltd" },
  select: ["id", "name"],
  orderBy: { column: "id", direction: "asc" },
  limit: 20
});
```

Every member can query the database through any patch that declares it, as the role the admin supplied.

## PostHog

One PostHog Cloud project, in the US or EU region, read-only. The admin pastes a personal API key limited to that project. A patch runs named HogQL queries, filling placeholders with values rather than splicing them into the query text, and gets typed rows back, at most 1,000 rows a call. Every member reads the project's events and people through patches that use it, and events may carry emails or user ids.

## Pidgeon

[Pidgeon](https://pidgeon.ai) gives software real email inboxes. One Pidgeon connection is one inbox, such as `support@…`, with **Read** or **Read and send** access. A patch lists and reads its threads and messages, searches them and reads its labels; with send access, it also replies, sends, and changes a thread's status and labels, as the person using the patch. Each send carries a key the patch keeps for that email, so a retried send never goes out twice. Each connection sends at most 200 emails a UTC day.

The key an admin makes in Pidgeon reaches the whole Pidgeon account. Patchy keeps patches to the one inbox on every call, and cutting Patchy off means revoking the key in Pidgeon.

## Attio

One Attio workspace, read-only, through a workspace access token with Read access and no write scope; Patchy refuses a key that can write. A patch reads the workspace's records, list entries and members through a client typed from the workspace's objects and lists. Nothing a patch does can change Attio, and Attio's own member permissions don't carry over: every member reads everything the token reads through patches that use it.

## Email (IMAP)

One mailbox login on a mail host, such as `imap/invoices`, read-only. The mailbox must speak IMAP over TLS 1.2 or later, present a certificate from a public authority, take a username and password (or an app password), and be reachable from the internet without an IP allowlist. Accounts that need Google or Microsoft sign-in don't qualify.

A patch lists folders, scans a folder from a checkpoint it stores, lists and searches messages, reads up to 25 messages at a time, and saves attachments into its own file stores. Reading never marks mail as read, and nothing sends, moves, flags or deletes mail. Every member reads the whole mailbox through patches that use it, so a shared or dedicated mailbox fits better than a person's own.

## GitHub

Repositories on one GitHub account, read through Patchy's GitHub App. An owner of the account installs the App and chooses which repositories it may read; a Patchy admin then connects repositories GitHub shows them administering. A patch reads repositories, workflows, CI runs and their jobs, job logs, a commit's check runs, and pull requests with their files and reviews. Commit history, file contents, issues, releases and comments are not read yet. Nothing a patch does can change GitHub, and CI logs can hold secrets a workflow printed.

## What isn't offered

There is no generic REST connection, no way to bring an integration of your own and no connection to an outside MCP server. Personal connections, made by one person for themselves, are not built either, and Gmail and Salesforce are future integrations. `patchy request` tells Patchy's team which integration a company needs.
