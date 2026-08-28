# ADR-0002 — `api` is the contract package

- **Status**: Accepted
- **Date**: 2026-08-29
- **Contexts**: Hosting (`apps/server`) and Publishing (`packages/cli`) — the decision is about what sits between them, so it lives in the root ADR home.
- **Source**: Effect v4 port spec (#68) §1 and §9; build ticket #71, which supersedes #35.

## Context

Until #71 the HTTP API had no written shape. Request and response bodies were
whatever `apps/server/src/app.ts` happened to send; the CLI re-typed the ones it
read by hand, and its test stubs re-typed them a third time. Nothing checked that
the three agreed, `--json` existed on one command, and there was no reference an
agent could read before calling a route.

The port moves the server onto Effect's `HttpApi`, which wants every route's
schemas up front, and the CLI onto a client derived from the same definition.
That raises the question of where those schemas live. The two candidates inside
the existing map were the hosting context (the server "owns" its API) and the
shared kernel `packages/core` (both sides import it).

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
3. **Refusals keep today's bodies.** A failure is `{ ok: false, error }` plus a
   `code` and a number on the ones a client branches on, with today's status
   codes. They are plain structs, never `Schema.TaggedError`: a `_tag` would be a
   new field on the wire, and the CLI's exit-code ladder keys off status, not
   body.
4. **The wire says `patch`.** Paths are `/api/patches/*` and fields are
   `patchId`, `patches`, `live_patch_quota_exceeded`, from the package's first
   commit. Tables and code keep `draft` until the `patches` package ports them,
   so agents see one wire break rather than two.

## Consequences

**Neither context owns the vocabulary the other has to speak.** In the hosting
context it would have been a server implementation detail the CLI happened to
import; in `core` it would have made the shared kernel depend on Effect's HTTP
modules for the sake of a CLI that only needs to decode JSON. As a package of its
own it is a thing both sides are held to, and the place a third consumer — a
future web surface, a test harness — starts from.

**Fastify is an adapter until the router ports.** `apps/server/src/wire.ts` is
the interim seam: `decodeBody` and `sendWire` at every route boundary, no
handler rewritten, no `runPromise`. The `serving` and `patches` tickets replace
it with `HttpApiBuilder` groups and delete it.

**The reference is a build product.** `docs/API.md` is rendered by a small
renderer in `packages/api` from `OpenApi.fromApi(PatchyApi)` and pinned by a
test, so it can only be as wrong as the schemas. Route prose lives as OpenAPI
description annotations on the endpoints, which is where an agent reading the
`HttpApi` finds it too.

**`--json` is uniform.** Every CLI command prints one stdout document on
success — for `whoami` and `upload`, exactly the wire shape — and
`{ ok: false, error }` on stderr on failure. The `kind` field and the exit-code
ladder arrive with the `cli` port.

## Alternatives considered

- **Schemas in `apps/server`, imported by the CLI.** Rejected: it couples the
  publishing context to the hosting codebase's module layout and makes the CLI
  bundle reach into a server package.
- **Schemas in `packages/core`.** Rejected: `core` is the safe-HTML policy and
  id primitives; the `HttpApi` and its middleware definition are not kernel
  material, and `core` should stay importable without Effect's HTTP modules.
- **Hand-written `docs/API.md`.** Rejected: it is the third copy the decision
  exists to remove.
