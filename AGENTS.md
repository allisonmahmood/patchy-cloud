Patchy cloud is a cloud for running internal company tools in the agentic era. It allows anyone from non-technical sales guy to a seasoned engineer to build internal company tools with simple primites, tiered runtimes, and external integrations.

The patchy cloud is being developed by patchy, a small early stage startup, not some big enterprise company. Our focus is to move fast and build complex things as simple as possible. We love to find ways to reduce complexity when solving problems.

# The way we think about problems

Because we are a startup we think deeply about both the product and technical considerations of what we are doing. This means that product decisions are actively being made alongside technical ones. It also means that while working with you its important you consider and present both the technical consideratoin and how this will impact the product and users.

It is important to us to keep things simple and seamless. When a user is deploying a new patch into our cloud they shouldn't have to think about weird configuration, access, etc. They should tell their agent publish this and the new patch should just be up. In the same way when starting work on a new tool or new extension they should have a seamless experience asking their agent to initialize, build, and deploy the patch.

## Agent native

We don't expect the users to need to know how to code. If they do, great! If not, then their agents should be able to handle everything for them. Agents are very good at using CLIs and running code locally which is why those are our primary interfaces when creating, building, and deploying patches.

## Multi surface

There are two life cycles a patch can be thought of. The development stage and the deployed stage. While being developed it will be the users agents creating it, building it, and finally deploying it. Once deployed it will be the user themselves directly interacting with it.

## Long term vision

The patchy cloud is not this yet, but i think here you will benefit from me explaining a bit of the future. currently we are rebuilding what used to be patch page. this means that in the patchy cloud there is a single primitive we serve the user. a static page. after we get all the migration and other things done, here is how we can think about the long term vission.

There will be four main tiers of runtimes.

- Tier 0 is static page no execution local or server side. It can fetch data from integrations and other sources, but it basically has no javascript locally or code running server side.
- Tier 1 is then where we get "local execution" essentially in the users browser. aka client side now can do things. again it can connect to integrations, now it can actually execute and do more things, but there is no server side execution for a patch with a tier 1 runtime.
- Tier 2 is where you get server side execution. this is where lot of modern saas apps live. you have all your integrations and other primitives. a tier 2 patch has a thing on the server side (probably some kind of lambda function or something, we haven't gotten to the point of deciding that yet) as well as client side.
- Tier 3 runtime of a patch is then the final state where we can have things happen fully server side. could be some kind of automations that persist, etc.
- And then eventually a tier 4 which is a sandbox for agents, but that's months out.

We will also have many primitives. Like if a patch needs a place to store files we will have a primitive for that, if it needs its own tables in a database we will have primitives for that. If it wants to use one of the integrations a company has connected like say gmail or salesforce, we will have primitives for that that patches can use to build full fledged internal company tools

## Final note from Patchy

We like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

# The tech

## Agent skills

Review notes belong in PR comments, not in the working tree.

### Issue tracker

Issues live in the `allisonmahmood/patchy-cloud` GitHub repo, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context — a root `CONTEXT-MAP.md` pointing at one `CONTEXT.md` per context (hosting server, CLI publisher). See `docs/agents/domain.md`.

### Review specs

Standards sources for `/code-review`'s Standards axis, one `SKILL.md` each under `.agents/skills/`: `effect-service-conventions` when the diff creates, moves, refactors, or consumes an Effect service; `ui-consistency` when it touches rendered HTML or CSS. Pass the matching file(s) to the Standards sub-agent.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- One concern per PR. If the description says "also", split it.

### Effect RC bumps

Effect 4 is pinned at one release candidate through the pnpm `catalog:` in `pnpm-workspace.yaml`. Dependabot's `effect` group opens one PR per RC and `.github/workflows/pr-labels.yml` labels it `effect-rc-bump`. To finish one of those PRs:

1. Check out the branch and run `pnpm install`, then read `node_modules/effect/MIGRATION.md` and the Effect changelog between the two RCs.
2. Fix what the RC broke and commit onto the Dependabot branch until `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
3. Keep `main` green: merge only on green CI. If the RC is unusable, close the PR and say why on the port map (#54).

Drop the group, the label and this section once `effect@4.0.0` is stable.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- Put durable architecture, constraints, and decisions in the domain docs. Update those docs when the product changes so agents find current facts instead of abandoned intentions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.
