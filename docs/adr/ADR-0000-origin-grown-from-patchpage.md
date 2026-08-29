# ADR-0000 — Origin: grown from PatchPage, not speaking for it

- **Status**: Superseded by [ADR-0002](./ADR-0002-api-is-the-contract-package.md), [ADR-0003](./ADR-0003-postgres-only.md) and [ADR-0004](./ADR-0004-cli-contract-for-agents.md) (2026-08-29)
- **Date**: 2026-08-26
- **Contexts**: Repository-wide — it fixes what this repo is, what it is named, and what it may not do, so it lives in the root ADR home.
- **Source**: the split itself; there is no ticket, because the tracker this repo inherited belongs to the project being split from.

_Retired by the Effect v4 port, whose record is the [port map (#54)](https://github.com/allisonmahmood/patchy-cloud/issues/54) and its spec (#68). Decisions 1–3 and 5 still hold as facts about the repo: PatchPage stays separate, nothing here publishes to its channels, everything is `@patchy/*` and `PATCHY_*`, the licence is unresolved. What this ADR framed as "detach the copy" the port finished: the inherited code is gone (Fastify, the `pg` layer, commander, the JSON driver, the reports surface, the operator artefacts), and the repo is now described by what replaced it — the `api` contract package (ADR-0002), Postgres as the only store (ADR-0003), the CLI contract (ADR-0004), and one `CONTEXT.md` per capability package from `CONTEXT-MAP.md`. Decision 4's "kept deliberately" list is no longer a decision, just the toolchain. Patchy Cloud is the only deployment, and the history before the split is provenance, not a description of anything running._

## Context

Patchy Cloud starts as a full-history copy of PatchPage. Every commit before the
split describes PatchPage: its package names, its environment variables, its
release automation, its hosted instance, its issue numbers. Nothing about that
history is being rewritten — it is where the code actually came from.

PatchPage itself credits Postplan, the static HTML draft publishing tool created
by Theo, for the pattern this whole line of work sits on: an agent writes a
single self-contained HTML file, something publishes it, and the agent hands
back a link. That credit belongs at the root of this repo's history too, which
is why it is recorded here.

A copied repository is dangerous in one specific way: it inherits every
credential-shaped and channel-shaped affordance of the original. Release
workflows that push to the original's registry, a CLI whose default origin is
the original's live instance, a package name already taken on npm, a kill switch
wired to the original's infrastructure. Left alone, an ordinary `main` push from
this repo would act on a service it does not own.

## Decision

1. **PatchPage remains a separate product.** It is free and open source, keeps
   its own repository and its own live instance, and continues under its own
   maintenance. This repo is not it. Nothing here speaks for it, represents its
   policies, or documents its behaviour, and a change made here changes nothing
   about it.

2. **This repo publishes nothing to PatchPage's channels.** No infrastructure
   apply against its cloud account, no `patchpage-server` container image, no
   `patchpage` npm package, no release tags on its versioning line, no kill
   switch reaching its instance. The automation that did those things is deleted
   rather than disabled, because a disabled workflow is one edit away from
   firing. The CLI's default origin is `http://localhost:3000` — a local server
   this repo can actually start — and never a production host.

3. **Everything is renamed to its own scope.** Packages are `@patchy/*`. The CLI
   is `@patchy/cli` with the bin name `patchy`, private and unpublished.
   Environment variables are `PATCHY_*`. The product name in prose is "Patchy
   Cloud"; the brand shown on served pages is "Patchy". The `pp_` token prefix
   is the one deliberate exception: it is wire format, not branding, and
   renaming it would invalidate stored credentials for no gain.

4. **The developer-experience layer is kept deliberately.** Turborepo, pnpm,
   Vitest, ESLint, the triage labels, `docs/agents/*`, the `CONTEXT.md` and ADR
   convention, the skill wiring, and the CI and PR-labelling workflows all
   carry over. They are how work gets done here and cost nothing to keep; the
   split is about detaching channels, not about starting from an empty repo.

5. **Public repository, no open-source licence.** The code is readable by
   anyone and licensed to no one: all rights reserved for now. This is not a
   promise to open the licence later, and not a promise to keep it closed —
   it is the absence of a commitment either way, taken because the product is
   pre-launch and the question does not need answering yet. Outside
   contributions are not being accepted.

## Consequences

**The history says PatchPage, and that is correct.** Every commit before the
split, and the messages, issue references, and file names in them, describe the
upstream project. Reading them as statements about Patchy Cloud will mislead;
read them as the provenance they are.

**Inherited ADRs stay valid, but their issue numbers do not resolve here.** The
decisions recorded in ADR-0001 and any later inherited ADR still govern this
code — they describe the trust model the server actually implements. The `#N`
references in them point at PatchPage's tracker, not this repo's. Each inherited
ADR carries a provenance line saying so, plus an amendment note wherever the split
changed something it recorded — the body stays as written, because an ADR is a record
of a decision, not a description of current code.

**Anything that names a PatchPage channel is a bug in this repo.** A default
pointing at its instance, a workflow pushing to its registry, a document
describing its hosted limits or its policies — each is a leftover, not a
feature, and gets removed on sight.

**New work numbers from here.** ADR-0000 is deliberately the lowest number: it
sits under the inherited ADRs and is the thing they should be read against.
