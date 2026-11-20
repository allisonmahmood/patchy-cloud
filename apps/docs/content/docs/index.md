---
title: What Patchy is
description: A cloud for a company's own tools, built by its people and their agents.
---

Patchy Cloud is a cloud for the tools a company builds for itself. People in the company build **patches**, anything from a single page to a full CRM, and publish them into the company's cloud. Colleagues open a patch at its address in their browser, signed in once.

Anyone in the company can build one: a person who writes code, or a person whose agent writes it for them. An agent on the person's computer does the building through the `patchy` command line tool (the CLI): it starts the patch, runs it locally, and publishes it when the person is happy with it.

Patchy Cloud runs at `https://cloud.patchyhq.com`.

## The pieces

**Patches.** A patch is one built thing at one address, such as `cloud.patchyhq.com/acme/expenses`. It belongs to one person, its owner, who is the only one who publishes it. It keeps every version it was published as, and runs at one **tier**: in the viewer's browser (tier 1), or with server code that Patchy runs (tier 2). In the portal a tier 1 patch is a **page** and a tier 2 patch is a **tool**. See [Patches and tiers](/docs/patches-and-tiers).

**Companies.** Every person is a user in exactly one company, as a **member** or an **admin**. A patch is open to its whole company by default; its owner can narrow it to teams, make a page public, or share it with a named **guest** at another company. See [Sharing and access](/docs/sharing-and-access).

**Data.** A patch owns its own **tables** and **file stores**, which Patchy creates when the patch is published. A tool can also read tables and file stores other patches share, and the company's member directory. See [Primitives](/docs/primitives).

**Integrations.** An admin connects the company's outside systems once: Postgres, PostHog, Pidgeon, Attio, Email (IMAP) and GitHub. A tool's server code then reads them, and for Pidgeon sends email, through Patchy, without ever holding their credentials. See [Integrations](/docs/integrations).

**Agents.** Agents meet Patchy in two places. A **builder agent** makes and publishes patches through the CLI. A **worker agent**, such as a person's Claude or Codex, uses published tools through **Patchy MCP**, as that person. See [Agents and MCP](/docs/agents-and-mcp).

## What it does not do

- Patchy runs code only while someone is using it: a viewer with the patch open, or their agent calling it. Schedules, webhooks, inbound routes and other work with nobody there are not built.
- A tool reaches outside systems only through the company's integrations. Patch code has no network access of its own, and there is no way to connect an integration Patchy doesn't offer. A person or their agent can ask for one with `patchy request`.
- Desktop Chromium-based browsers and Firefox are supported. Safari is untested, and phones are outside this release.

## Where to go next

- [Getting started](/docs/getting-started): get into a company, set up a computer, and publish a first page.
- [The CLI](/docs/cli): the commands people and agents use most.
- [Limits](/docs/limits): what a patch can do before Patchy refuses.
- [Security and data](/docs/security-and-data): who can open what, and what a patch can reach.
