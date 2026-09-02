# Publishing

The `@patchy/cli` package and its bundled skill — the tool agents use to put pages up. An agent is the primary driver and the CLI's output is its interface, so every message is written to be read by an agent first and what an agent sees is a written contract ([ADR-0004](../../docs/adr/ADR-0004-cli-contract-for-agents.md)). Humans are not excluded: developers touching the cloud directly do drive it, so the human conveniences (completions, the wizard) stay, as long as they never change what an agent sees. The CLI's word for the thing it publishes is _patch_, same as the wire and the [Patches](../patches/CONTEXT.md) glossary; _draft_ is retired.

## Language

**Instance**:
The Patchy Cloud server patches are published to, identified by its API URL: the deployment, or the `pnpm dev` instance of a checkout. The CLI bakes in no address for the deployment; the URL is always supplied by whoever is publishing — a flag, the dev env, the environment, or saved config, in that order — and the built-in fallback is only a server running locally from this repo. A token and a cached patch each belong to exactly one instance. Resolved once per command by the `Instance` service, which also remembers its **source**.
_Avoid_: the server (ambiguous with the hosting codebase), host, backend, your own instance (there is one deployment; the rest are dev instances)

**Dev env**:
The `.local/dev/env` a `pnpm dev` writes in a worktree — the instance URL and the seeded token. Found by walking up from the working directory and ranked above `PATCHY_API_URL`, so a checkout with a running dev instance publishes to it with nothing set and can never publish somewhere remote by accident.
_Avoid_: dotenv, the env file

**Exit-code ladder**:
The contract an agent branches on: 0 ok, 1 `local` (fixable without the network), 2 `rejected` (the instance answered and said no), 3 `unreachable` (no usable answer), 130 interrupted, nothing else. Every failure is a `CliError` whose **kind** names its rung; the kind also rides in the `--json` failure document.
_Avoid_: error code (ambiguous with the wire's `code`), status (ambiguous with HTTP and with the probe)

**Auto-mint**:
The publishing flow's act of requesting a self-service token from the target instance when it holds no token for that instance, announcing the mint as it happens. Never silent, and never triggered while any token is configured — a rejected token is an error, not a reason to mint again. Retires with login: the login handoff takes its place in the flow.
_Avoid_: anonymous upload (retired), silent fallback, registration

**State dir**:
The per-user directory where the CLI keeps everything it remembers between runs: instance choice, credentials, the patch cache, and the default style.
_Avoid_: config directory, dotfiles

**Default style**:
The user-level style preference captured during onboarding and kept in the state dir; it applies whenever a project does not declare its own house style.
_Avoid_: house style (a project's own style, which overrides it), theme, template

**Mint announcement**:
The line the publishing flow prints when auto-mint fires: which instance, where the token was saved, and how to keep an existing identity instead. It is the signal an agent relays to the user, and the lazy cue to suggest onboarding.
_Avoid_: warning (it reports success, not a problem)

**Login handoff**:
What replaces the mint announcement once login lands: the URL and code the CLI prints (as JSON under `--json`) for the agent to relay to the person, then waits on. The one moment in publishing that needs a human; the agent never opens a browser on someone's desktop.
_Avoid_: prompt, browser login

**Driver**:
Whoever is running the CLI — an agent first, a developer touching the cloud directly second. The word is deliberately not _operator_, which is Patchy running the platform ([Companies](../companies/CONTEXT.md)).
_Avoid_: operator, user (ambiguous with the account the driver acts as)

**Agent**:
Software acting for a user, with that user's machine token: the CLI's primary driver. Never a who, always a how — it is indistinguishable from its user except by the machine name on the token, and it holds no identity of its own.
_Avoid_: bot, service account, agent identity

**Onboarding**:
The agent-led first-time setup conversation — establish which instance to publish to, one question capturing the default style, then publish the welcome patch. Hosting is never assumed: with nothing configured there is nowhere to publish yet, so the instance is asked for or read from local state before anything is uploaded. Asked for by the user, or suggested after a mint announcement; always optional.
_Avoid_: signup, registration, setup wizard

**Setup prompt**:
The copy-paste block in the README that a user hands their agent to get started: install the skill, run onboarding through to the welcome patch, and establish the "publish this with patchy" habit. Its onboarding sentence is the sole primary trigger — installing the skill runs nothing by itself. Written to be readable by the human pasting it, so it doubles as a plain description of what they are authorizing.
_Avoid_: install snippet (older internal name), install command (only one of its parts)

**Publishing key**:
What an auth token — today's self-service token, tomorrow's machine token — is called in front of the user: "your publishing key, saved on this machine". _Token_, _instance_, and _mint_ stay out of user-facing copy except on the operator-token path, where operator vocabulary is correct.
_Avoid_: token (in user-facing copy), password, account

**Patch cache**:
The per-instance record linking a local file to the patch it produced, so republishing the same file updates that patch instead of creating a new one, and deleting by file finds the patch to take down. A deleted patch is forgotten.
_Avoid_: draft cache
_Avoid_: upload history, manifest

**Onboarding probe**:
The local-only report of what publishing state this machine already holds for the resolved instance — `status --json`. Onboarding reads it once to skip questions it can already answer; it reaches no instance, and it answers rather than passing or failing, so it is never a per-session check.
_Avoid_: health check, status check, doctor, preflight
