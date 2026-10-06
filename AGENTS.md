Patchy cloud is a cloud for running internal company tools in the agentic era. It allows anyone from non-technical sales guy to a seasoned engineer to build internal company tools with simple primites, tiered runtimes, and external integrations.

The patchy cloud is being developed by patchy, a small early stage startup, not some big enterprise company. Our focus is to move fast and build complex things as simple as possible. We love to find ways to reduce complexity when solving problems.

# The way we think about problems

Because we are a startup we think deeply about both the product and technical considerations of what we are doing. This means that product decisions are actively being made alongside technical ones. It also means that while working with you its important you consider and present both the technical consideratoin and how this will impact the product and users.

It is important to us to keep things simple and seamless. When a user is deploying a new patch into our cloud they shouldn't have to think about weird configuration, access, etc. They should tell their agent publish this and the new patch should just be up. In the same way when starting work on a new tool or new extension they should have a seamless experience asking their agent to initialize, build, and deploy the patch.

## Agent native

We don't expect the users to need to know how to code. If they do, great! If not, then their agents should be able to handle everything for them. Agents are very good at using CLIs and running code locally which is why those are our primary interfaces when creating, building, and deploying patches.

## Multi surface

There are two life cycles a patch can be thought of. The development stage and the deployed stage. While being developed it will be the users agents creating it, building it, and finally deploying it. Once deployed it will be the user themselves directly interacting with it.

## Runtime tiers

Patchy implements tier 0 static pages, tier 1 sandboxed browser tools and tier 2 request-scoped server handlers. `docs/product.md` records the built contracts and the pending acceptance and deployment work.

- Tier 0 is a static page with no patch execution, browser or server. A tier 0 repo may provision resources, but its page cannot call them.
- Tier 1 runs patch code in a sandboxed browser frame. It acts as the viewer through Patchy for tables, files and declared integrations; it has no outbound fetch or hosted patch code.
- Tier 2 runs query, mutation and action handlers in credential-free workerd processes while a viewer has the patch open. Mutations are atomic; the page calls handlers instead of resources directly. The ECS fleet, its production infrastructure (`apps/infra`) and the deploy workflow are built; the first deploy is not.
- Tier 3 is next: execution without a viewer, including inbound routes, webhooks, schedules and unattended automation. It is not built.
- Tier 4, a sandbox for agents, remains future work.

Tables and files are patch-owned. Both scripted tiers support live queries, read-only shared tables and stores, the member directory, company Postgres connections and a two-viewer local dev loop. More integrations, including Gmail and Salesforce, remain future work.

## Final note from Patchy

We like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

# The tech

## Where to look

One line each; only the things you would not find by reading the tree.

- `docs/product.md` — the product's shape: patches, tiers, companies, identity, integrations. Read it before designing anything user-facing.
- `CONTEXT-MAP.md` and each package's `CONTEXT.md` — the vocabulary. Use their words; see `docs/agents/domain.md`.
- `pnpm dev`, `pnpm dev up [scenario]`, `pnpm dev shot <person> <path>`, `pnpm dev down` — this worktree's instance, where people sign in as dev personas without accounts; `up` adds a scenario's people, a logged-in CLI and an agent workspace, and `shot` captures a page as one person. `scenarios/README.md` says what each scenario holds.
- `docs/DEVELOPMENT.md` — the checks, the local instance, seeing a page as a person, Clerk mode, and what to exercise for each kind of change. Read before starting a local instance or calling a change ready.
- `docs/OPERATIONS.md` — running the server outside `pnpm dev`, its configuration, the execution fleet and the spike deploy.
- `packages/sql/README.md` — how migrations and row decoding work.
- `docs/adr/ADR-0004-cli-contract-for-agents.md` — the CLI's exit codes and `--json` contract; keep it when touching `packages/patchy`.
- `docs/SKILL_DISTRIBUTION.md` — global skill wiring, the lock hash, and release-bound project skills sourced from `packages/sdk/skills`; read before changing either skill surface.

## Agent skills

Review notes belong in PR comments, not in the working tree.

### Issue tracker

Issues live in the `allisonmahmood/patchy-cloud` GitHub repo, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context — the root `CONTEXT-MAP.md` names the product's contexts, the shared kernel and the infrastructure packages, and links their glossaries. A context's `CONTEXT.md` is written before the code where its package does not exist yet. `docs/product.md` is the product's shape. See `docs/agents/domain.md`.

## Hit every surface

The most common defect here is a change that lands on the path you tested and is missing everywhere else it is mirrored. Before calling work done, walk this list and say which entries applied:

- **The wire contract.** A request, response or route in `packages/api` follows through to the server handler, the CLI command and its `--json` shape, and `docs/API.md` (`pnpm --filter @patchy/api render-docs`; a test fails when it is stale). Runtime operation schemas also validate the shell broker's inputs; update both shell and server consumers. The api package is the source; the rest mirror it.
- **The CLI.** A new or changed command, flag or exit code follows through to `packages/patchy/README.md`, the contract in ADR-0004, and the global `patchy` skill for sign-in, file publishing and init. Repo workflows and capability operations follow through to the project skills under `packages/sdk/skills`, served by generation. When the global skill's `SKILL.md` changes, refresh its hash in `skills-lock.json` (`sha256sum skills/patchy/SKILL.md`); a test fails when it is stale.
- **The dev loop.** A change to the runner under `scripts/dev`, its seed, or how the CLI finds a local instance follows through to `docs/DEVELOPMENT.md`, the `patchy-dev-loop` skill, and the vitest Postgres template that applies the same seed rows.
- **Vocabulary and product shape.** A new or renamed concept follows through to the owning `CONTEXT.md` glossary, `CONTEXT-MAP.md` when a context gains or loses a package, and `docs/product.md` when the product's shape moved. An ADR the change contradicts is updated or deleted, never left standing.
- **Migrations.** A capability's migrations live in its `src/migrations.ts`; `apps/server/src/migrations.ts` composes them for the server, the dev runner and the vitest template. Allocate ids in landing order: the migrator only applies ids above its ledger's highest id and never backfills gaps, and the record's test fails on a duplicate or skipped id.
- **Company resources.** Read [ADR-0009](docs/adr/ADR-0009-one-postgres-database-per-company.md) before adding a company-database caller. Provisioning/reclamation take the platform row lock before `withPatchLock`; keep primitive-free patches off that path. Runtime files use company-only per-name index locks, with blob I/O outside leases and liveness supplied by Runtime.
- **Served pages.** What a reader receives, including the portal's index, cards, confirmation and user pick pages, runs through the `ui-consistency` spec. What HTML is accepted or rejected lands as fixtures under `packages/core/fixtures`, which the policy tests and `pnpm seed:dev` both read.
- **Reverse states.** If you add a way in, add the way out and the way to see it. An invite needs revoke, deactivation needs reactivation, a machine token needs revoke. A one-way door is a bug.
- **The repo layout.** Adding, renaming or removing a package follows through to the README's layout list, and to Where to look above if it is a doc an agent needs.

### Review specs

Standards sources for `/code-review`'s Standards axis, one `SKILL.md` each under `.agents/skills/`: `effect-service-conventions` when the diff creates, moves, refactors, or consumes an Effect service; `ui-consistency` when it touches rendered HTML or CSS. Pass the matching file(s) to the Standards sub-agent.

When reading PR feedback, inspect review bodies and inline review comments as well as the conversation comments; Grok sometimes posts its findings on the Reviews tab.

## Effect

The server, packages and CLI run on Effect 4, pinned through the pnpm `catalog:` in `pnpm-workspace.yaml`. HTTP, HttpApi, SQL and CLI come from `effect/http`, `effect/http-api`, `effect/sql` and `effect/cli`; Effect marks those `@stability unstable`, so a minor release can break them. Everything below binds all of them; the port that got them here is recorded on the port map (#54).

Before writing Effect code, read `node_modules/effect/AGENTS.md` — how Effect wants to be written (`Effect.gen`, `Effect.fn`, services, layers), with worked examples under `node_modules/effect/ai-docs/`. Effect's `MIGRATION.md` is not shipped in the package; it lives upstream at <https://github.com/Effect-TS/effect/blob/main/MIGRATION.md>.

### Service conventions

`.agents/skills/effect-service-conventions/SKILL.md` is the source of truth and the review spec; the gist:

- One file per service, in this order: errors and schemas, the `Context.Service` tag with its interface inline, `make`, `layer`. Refer to the interface as `Foo["Service"]`.
- Namespace imports at service boundaries: `import * as Effect from "effect/Effect"`, `PatchStore.PatchStore` / `PatchStore.layer`. Named imports stay for whole packages such as `@patchy/api` and for pure helpers, errors, schemas and types.
- Failures are `Schema.TaggedError` with structured fields; `message` derives from those fields, the underlying error rides as `cause`. Catch known tags with `Effect.catchTags`. Wire bodies keep their current shape (a 401 is `{ ok: false, error }`, no `_tag` on the wire).
- Dependencies come from the environment (`yield* Foo.Foo`), never as constructor arguments. `runPromise` and `ManagedRuntime` belong only at the server and CLI entrypoints.
- A capability with one consumer stays a module; a second consumer earns the package.

### Packages by capability

`CONTEXT-MAP.md` is the map (decided on [#56](https://github.com/allisonmahmood/patchy-cloud/issues/56)). Each capability owns its migrations and its `HttpApi` group; `apps/server` is wiring plus the API guard.

### Tests

`pnpm check` runs format, lint, typecheck, the infrastructure synth and the offline tests while you work; run `pnpm verify` (CI's suites except live Clerk) before calling a change ready. `pnpm test` is offline (including the fetch guard); `pnpm test:clerk` runs the live Backend-API and Playwright tiers with real development keys and run-scoped cleanup. Read `docs/DEVELOPMENT.md` before running them: they create Clerk users and send invitation mail.

`@effect/vitest`: `it.layer` shares one migrated Postgres per block, `it.effect` for each case, `HttpApiTest.groups` for API routes, `NodeHttpServer.layerTest` when the test needs what a real socket sees, `TestClock` for the clock, `Scope` for anything that must be closed. Inject faults with an alternate layer, not a mock. Copy an existing suite in the package you are in; `packages/patches` and `packages/serving` show the `it.layer` shape over a migrated database.

### Guardrails

`@effect/language-service` diagnostics fail `pnpm typecheck` (rule set in `tsconfig.base.json`, every rule an error; `effect-language-service patch` runs from `prepare`). Tests are typechecked too, through `tsconfig.test.json`, which keeps the correctness rules and drops the style ones. A Node API with no Effect equivalent is allowed per file with `// @effect-diagnostics <rule>:off` and a reason. `pnpm lint` runs the repo's own rules from `eslint/`: namespace imports for Effect and service modules, no manual runtimes in tests, no Schema compiles in function bodies. `/code-review` loads the service review spec above whenever a diff touches an Effect service.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- One concern per PR. If the description says "also", split it.

## Deploying

Production releases only through the Deploy workflow (`docs/OPERATIONS.md` › Deploying). When you are asked to deploy, every release first gets its What's new entry, so the people using Patchy hear what changed:

1. **Gather.** `git fetch origin`, take the newest release's `through` in `packages/core/src/whatsNew.ts`, and list what merged since: `git log --first-parent --format='%h %s' <through>..origin/main`. The previous release's own `docs(whats-new)` PR is always first; leave it out. Read each other PR with `gh pr view`. Done when you know what every PR in the range changes for someone using Patchy.
2. **Write** the next release at the top of `releases`, following the rules in that file's header comment. Done when every PR in the range lands in a change, a behind-the-scenes line, or is test and tooling churn. When it is all churn, write no release and skip to step 4; the next release picks up from the same `through`.
3. **Land it.** Being asked to deploy is asking for this PR: `docs(whats-new): <what the release says, briefly>`, its body listing each change beside its PRs. Merge it once checks are green.
4. **Release.** `gh workflow run deploy.yml --ref main`, then hand the person the run link to approve in the `production` environment, with the release's changes. Done when the run succeeds.

Anything merged after `through` ships with this deploy unannounced and goes in the next release. A rollback needs no entry: the older commit carries its own list.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- Put durable architecture, constraints, and decisions in the domain docs. Update those docs when the product changes so agents find current facts instead of abandoned intentions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.
