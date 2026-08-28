Patchy cloud is a cloud for running internal company tools in the agentic era. It allows anyone from non-technical sales guy to a seasoned engineer to build internal company tools with simple primites, tiered runtimes, and external integrations.

The patchy cloud is being developed by patchy, a small early stage startup, not some big enterprise company. Our focus is to move fast and build complex things as simple as possible. We love to find ways to reduce complexity when solving problems.

# The way we think about problems

Because we are a startup we think deeply about both the product and technical considerations of what we are doing. This means that product decisions are actively being made alongside technical ones. It also means that while working with you its important you consider and present both the technical consideratoin and how this will impact the product and users.

It is important to us to keep things simple and seamless. When a user is deploying a new patch into our cloud they shouldn't have to think about weird configuration, access, etc. They should tell their agent publish this and the new patch should just be up. In the same way when starting work on a new tool or new extension they should have a seamless experience asking their agent to initialize, build, and deploy the patch.

## Agent native

We don't expect the users to need to know how to code. If they do, great! If not, then their agents should be able to handle everything for them. Agents are very good at using CLIs and running code locally which is why those are our primary interfaces when creating, building, and deploying patches.

## Multi surface

There are two life cycles a patch can be thought of. The development stage and the deployed stage. While being developed it will be the users agents creating it, building it, and finally deploying it. Once deployed it will be the user themselves directly interacting with it.

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

Standards sources for `/code-review`'s Standards axis, one `SKILL.md` each under `.agents/skills/`: `effect-service-conventions` when the diff creates, moves, refactors, or consumes an Effect service; `ui-consistency` when it touches rendered HTML, CSS, or page controls. Pass the matching file(s) to the Standards sub-agent alongside the smell baseline.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- One concern per PR. If the description says "also", split it.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- Put durable architecture, constraints, and decisions in the domain docs. Update those docs when the product changes so agents find current facts instead of abandoned intentions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.
