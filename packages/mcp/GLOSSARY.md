# Patchy MCP

How a person's own agent uses their company's patches: one door, four fixed tools and change keys. It acts through [Auth](../auth/GLOSSARY.md)'s agent connections, finds patches through [Patches](../patches/GLOSSARY.md), calls the agent tools [Publishing](../patchy/GLOSSARY.md) builds through [Runtime](../runtime/GLOSSARY.md), and needs [Companies](../companies/GLOSSARY.md)' agent access on. Not built yet: `docs/product.md` › Patchy MCP is the spec, and this package is born beside these words.

## Language

**Patchy MCP**:
The one MCP server an instance offers at `/mcp`, through which worker agents find, read and change their company's patches as their person. Everyone connects to the same door with the same four tools, so a new patch needs no new connection.
_Avoid_: a patch's MCP server (a patch has none), connector (a client's word for its side), per-patch server

**Worker agent**:
A person's MCP client, such as Claude or Codex, using published patches through their agent connection: the worker pipeline's agent. It acts as its person and is told apart from them only by the client name they approved.
_Avoid_: worker (workerd's word), bot, agent user, builder agent (the CLI's)

**Catalogue call**:
A `find_patches` or `open_patch` call, which reads what patches and their agent areas declare and never starts a patch.
_Avoid_: discovery (the CLI's `patchy list`), read

**Change key**:
The name a worker agent gives one intended change, so retrying it never applies it twice: a mutation's retry returns its first result, and an action's key never runs again. It belongs to one agent connection and patch for 24 hours; a mutation's change key becomes its mutation key.
_Avoid_: idempotency token, mutation key (Runtime's, which a change key maps onto)
