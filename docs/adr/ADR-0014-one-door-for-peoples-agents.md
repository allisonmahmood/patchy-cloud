# ADR-0014 — One door for people's agents

Each instance offers one MCP server, at `/mcp`, with four fixed tools: `find_patches`, `open_patch`, `read_patch` and `change_patch`. They disclose progressively: an agent finds the company's patches, opens one to see the tools its builder added for agents, then reads or changes through them. There is no MCP server per patch, and no patch's own tools appear in `tools/list`, which is the same for everyone.

This is hard to reverse, because clients store the URL and the tool names, and surprising, because people expect a patch to be its own server.

## Considered options

- **A server per patch.** Rejected: every new patch would need a new connection and a new consent, and a client's tool list would grow with the company.
- **One server whose tool list is every patch's tools.** Rejected: the list would differ per person, couldn't be cached for everyone, and would outgrow some clients' tool limits as the company builds.

## Consequences

One connection reaches every patch a person can open, the four tools are listed identically and cached publicly, and every agent gets the newest door with each deploy, with nothing to install. In exchange, using a patch takes one more hop, `open_patch`, before its first call. Confirmation stays the client's: `read_patch` is marked read-only and `change_patch` destructive, so a client's "always allow" on `change_patch` approves every patch's changes at once.

Decided on the [Patchy MCP map](https://github.com/allisonmahmood/patchy-cloud/issues/730) ([#735](https://github.com/allisonmahmood/patchy-cloud/issues/735)), implemented by [#851](https://github.com/allisonmahmood/patchy-cloud/issues/851).
