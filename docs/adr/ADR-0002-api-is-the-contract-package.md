# ADR-0002 — `api` is the contract package

- **Status**: Accepted
- **Date**: 2026-08-29
- **Contexts**: Hosting (`apps/server`) and Publishing (`packages/cli`) — the decision is about what sits between them, so it lives in the root ADR home.
- **Source**: Effect v4 port spec (#68) §1 and §9; build ticket #71, which supersedes #35.

## Context

The server and CLI need one written HTTP contract. Hand-written response bodies,
client types and test stubs would otherwise be independent copies, with no
guarantee that an agent's command reads what the server sends.

Effect's `HttpApi` declares the endpoint schemas and derives the client from
them. The boundary decision is where that definition belongs: in the server,
in the shared kernel, or in a package both consumers depend on.

## Decision

The wire contract is its own package, `@patchy/api`, beside neither context.

1. **One schema per wire shape, and only there.** Every body the server accepts
   or sends on `/api/*` is a `Schema.Class` (or, for refusals, a plain
   `Schema.Struct`) in `packages/api/src/schemas.ts`. The server encodes its
   responses and decodes its request bodies through them; the CLI decodes what it
   reads through them; `docs/API.md` is rendered from them and a test fails when
   the file drifts. A shape that exists in one place cannot disagree with itself.
2. **The `HttpApi` lives with the schemas.** `PatchyApi` — two groups, `auth`
   and `patches`, the bearer middleware _definition_, the derived
   `HttpApiClient` — is the whole of the package. It imports only `@patchy/core`
   and Effect, and no server or CLI code. Each capability package implements its
   own group; none defines one.
3. **Refusals are wire data, not internal errors.** A failure is
   `{ ok: false, error }`, with a `code` and supporting fields where a client
   needs to branch. They are plain structs, never `Schema.TaggedError`:
   a `_tag` would add an internal field to the wire. The CLI maps HTTP status
   to its exit-code ladder and interprets domain codes where a command needs them.
4. **The wire uses the domain's vocabulary.** Patch routes use `/api/patches/*`
   and `patchId`; identity names the user, company, role and machine.
   Publishing and sharing report the patch's `scope`; `publicUrl` is the link,
   not a promise of anonymous access.

## Consequences

**Neither context owns the vocabulary the other has to speak.** In the hosting
context it would have been a server implementation detail the CLI happened to
import; in `core` it would have made the shared kernel depend on Effect's HTTP
modules for the sake of a CLI that only needs to decode JSON. As a package of its
own it is a thing both sides are held to, and the place a third consumer — a
future web surface, a test harness — starts from.

**The reference is a build product.** `docs/API.md` is rendered by a small
renderer in `packages/api` from `OpenApi.fromApi(PatchyApi)` and checked by a
test, so it can only be as wrong as the schemas. Route prose lives as OpenAPI
description annotations on the endpoints, which is where an agent reading the
`HttpApi` finds it too.

**`--json` is uniform.** Command success is one stdout document; `whoami`,
`upload`, `share` and `delete` expose the wire shape. Failure is one stderr
document containing `{ ok: false, error, kind }`. The full CLI contract,
including parse failures and login's receipts, is [ADR-0004](./ADR-0004-cli-contract-for-agents.md).

## Alternatives considered

- **Schemas in `apps/server`, imported by the CLI.** Rejected: it couples the
  publishing context to the hosting codebase's module layout and makes the CLI
  bundle reach into a server package.
- **Schemas in `packages/core`.** Rejected: `core` is the safe-HTML policy and
  id primitives; the `HttpApi` and its middleware definition are not kernel
  material, and `core` should stay importable without Effect's HTTP modules.
- **Hand-written `docs/API.md`.** Rejected: it is the third copy the decision
  exists to remove.
