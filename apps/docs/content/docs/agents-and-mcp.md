---
title: Agents and MCP
description: How builder agents make patches through the CLI, and how people's own agents use tools through Patchy MCP.
---

An agent is software acting for a person. It is never someone of its own: everything it does, it does as its person, with their access. Agents reach Patchy in two ways, each with its own credential, and neither credential opens the other's way in.

|                          | Builder agent                 | Worker agent                                    |
| ------------------------ | ----------------------------- | ----------------------------------------------- |
| What it does             | Makes and publishes patches   | Uses published tools                            |
| How it reaches Patchy    | The `patchy` CLI              | Patchy MCP, at `https://cloud.patchyhq.com/mcp` |
| Its credential           | The computer's publishing key | An agent connection, made through consent       |
| Listed on Your agents as | A computer                    | An app                                          |

## Builder agents

A builder agent, such as Claude Code or Codex on a person's computer, works through the CLI with that computer's publishing key. The setup line, `Set up Patchy using https://cloud.patchyhq.com/llms.txt`, installs the CLI and Patchy's **global skill**: the agent's instructions for signing in, publishing a page, finding company tools and data, and starting a patch repo. Inside a patch repo, **project skills** generated for that repo's tier and declarations teach the rest: its tables and files, its handlers and each connection it uses.

The CLI is built to be driven by an agent: every command takes `--json`, and its exit code says who has to act (see [The CLI](/docs/cli)). A builder agent can also read a published patch's log with `patchy logs`, so it can fix a tool someone reports broken without the log being pasted to it.

## Patchy MCP

**Patchy MCP** lets a person's own agent find, read and change their company's tier 2 tools, as them, through one connection. The person connects once; a new tool needs nothing new.

Its door, `https://cloud.patchyhq.com/mcp`, has five fixed tools:

- `find_patches` lists the live patches the person can open, those with agent tools first.
- `open_patch` shows one patch and its agent tools.
- `read_patch` runs one of a patch's read tools.
- `change_patch` runs one of its change tools, with a change key.
- `tell_patchy` sends Patchy's team a request or feedback about Patchy, as the person.

An agent reaches only a patch's **agent area**: the tools its builder wrote for agents. Nothing else in a patch is reachable, not its page, its other handlers, or its tables, files and connections directly. Tier 1 patches have no agent area.

### What it can do

An agent can do in a patch only what its person can, only through the tools the patch's builder made for agents, and only while the company allows agents. It gets the same sharing, the same handler rules, the same limits and the same log as its person's page, and every change it makes is logged as the person "via" the agent, as in "Jordan Lee via Claude".

The client decides whether to ask before a change. `read_patch` is marked read-only and `change_patch` destructive, and the clients Patchy checks ask before every change by default.

Files don't cross Patchy MCP: there are no uploads or file handles. Patchy doesn't push changes to agents; they poll. Work with no person behind it waits for tier 3, which is not built.

### Turning it on and connecting

**Agent access** is a company switch at Settings › Agent access. It starts off, and only an admin turns it on. While it is off, every tool call is refused, naming the admins, and no new agent can connect; turning it back on lets the same connections work again.

Each person connects their own agent from **Connect an app** on Your agents. For example:

```sh
# Claude Code, then /mcp inside it to sign in
claude mcp add --transport http patchy https://cloud.patchyhq.com/mcp

# Codex
codex mcp add patchy --url https://cloud.patchyhq.com/mcp
codex mcp login patchy
```

In Claude, Patchy is a custom connector at the same address; ChatGPT connects the same way where its plan allows one. Clients that need dynamic client registration, such as Cursor and Gemini CLI, can't connect yet.

Connecting opens a consent page in the person's signed-in browser, every time, which says what the agent will be able to do and who is signed in. **Allow** makes an agent connection; **Deny** records nothing.

### When a connection ends

A connection lasts until its person disconnects it on Your agents, it goes 30 days without a call, or the person is deactivated. **Disconnect everything** on Your agents ends every agent connection and publishing key at once. An ended connection gets an "invalid token" answer, and the client offers to reconnect. Reactivating a person restores no connection.

## Building an agent area

A tier 2 patch's agent area is its `agent/` folder, beside `server/`. Every export of `agent/*.ts` is an agent tool, named after its export, and must be a query, mutation or action with a description:

```ts
// agent/deals.ts
export { listDeals } from "../server/deals.js";
```

Re-exporting a page's handler, as above, makes it a tool with the same arguments and rules. A tool of its own can hold agents to stricter rules, such as requiring fields the page leaves optional.

- A **read** is a query, or an action declared `readOnly: true`, which Patchy holds to reading. Anything else is a **change**.
- A tool's description and argument schema are all an agent knows about it; each description is up to 2,000 characters, and one patch's tools fit in 60 KiB.
- `ctx.agent` is `{ name }`, the client name the person approved, or null for a page's call. It is a label, never proof, and a patch can use it to tag or limit agent work.
- A **change key** keeps a retried change from applying twice. It belongs to one agent connection and one patch, and lasts 24 hours. Retrying a mutation that already committed returns its original result and writes nothing, and a retry after the patch was published in between is refused. An action that started is not run again under the same key, so one that timed out may have partly happened: the agent reads first, then retries with a new key.
- By default each person has 300 calls a minute per patch and 16 in flight, and a read's result is capped at 100,000 characters, so a large read needs paging and bulk work needs a tool that takes a list. See [Limits](/docs/limits).

`pnpm patchy dev agent` lists the tools as an agent sees them, and `pnpm patchy dev agent <tool> '<json>'` calls one against the local dev runtime, as an agent would. A publish with agent tools lists them as reads and changes, and warns while the company's agent access is off.
