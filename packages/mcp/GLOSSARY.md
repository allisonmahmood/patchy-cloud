# Patchy MCP

How a person's own agent uses their company's patches: one door, four fixed tools and change keys. It acts through [Auth](../auth/GLOSSARY.md)'s agent connections, finds patches through [Patches](../patches/GLOSSARY.md), calls the agent tools [Publishing](../patchy/GLOSSARY.md) builds through [Runtime](../runtime/GLOSSARY.md), and needs [Companies](../companies/GLOSSARY.md)' agent access on. `docs/product.md` › Patchy MCP is the spec. Built so far: the door's revisions, request trust, bearer and limits; each tool refuses as not built until its own ticket lands.

## Language

**Patchy MCP**:
The one MCP server an instance offers at `/mcp`, through which worker agents find, read and change their company's patches as their person. Everyone connects to the same door with the same four tools, so a new patch needs no new connection.
_Avoid_: a patch's MCP server (a patch has none), connector (a client's word for its side), per-patch server

**Worker agent**:
A person's MCP client, such as Claude or Codex, using published patches through their agent connection: the worker pipeline's agent. It acts as its person and is told apart from them only by the client name they approved.
_Avoid_: worker (workerd's word), bot, agent user, builder agent (the CLI's)

**Door**:
The one endpoint, `/mcp`, and what it checks before a tool runs: its `Host` and `Origin`, the `work` bearer, the body cap, the revision and the person's requests a minute. Authority comes only from the bearer, never a cookie or where a client runs.
_Avoid_: gateway, proxy, endpoint (for the whole of it)

**Era**:
Which kind of MCP revision a request speaks. **Modern** (2026-07-28) carries its version, capabilities and client in every request's `_meta`, with no handshake; **legacy** (2025-11-25, 2025-06-18) opens with `initialize`. The door serves both statelessly on one endpoint and keeps no session.
_Avoid_: protocol mode, session (there is none)

**Catalogue call**:
A `find_patches` or `open_patch` call, which reads what patches and their agent areas declare and never starts a patch.
_Avoid_: discovery (the CLI's `patchy list`), read

**Change key**:
The name a worker agent gives one intended change, so retrying it never applies it twice: a mutation's retry returns its first result, and an action's key never runs again. It belongs to one agent connection and patch for 24 hours; a mutation's change key becomes its mutation key.
_Avoid_: idempotency token, mutation key (Runtime's, which a change key maps onto)
