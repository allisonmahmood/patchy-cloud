# Publishing

The path agents use to publish and manage patches for a user, through the `patchy` CLI and its bundled skill. An agent is the primary driver, with the same command contract available to a person at a terminal; the product's built unit is defined in [Patches](../patches/CONTEXT.md).

## Language

**Publishing**:
The flow from a local file to a live patch and a link announced with its [sharing scope](../patches/CONTEXT.md). It includes choosing the instance and establishing which user's publishing key the machine holds.
_Avoid_: deployment, posting

**Instance**:
The Patchy Cloud deployment or local development server a command targets, identified by its API URL. Credentials and cached patches belong to exactly one instance; target selection follows [ADR-0004](../../docs/adr/ADR-0004-cli-contract-for-agents.md).
_Avoid_: the server (ambiguous with the hosting codebase), host, backend, your own instance (there is one deployment; the rest are dev instances)

**Dev env**:
The local instance information a running dev loop makes available to the CLI: its URL and seeded publishing key. It makes a worktree target its own instance unless the driver explicitly chooses another.
_Avoid_: dotenv, the env file

**Exit-code ladder**:
The contract an agent branches on: 0 success, 1 locally fixable, 2 refused by the instance, 3 no usable answer, 130 interrupted. The complete output and failure contract lives in [ADR-0004](../../docs/adr/ADR-0004-cli-contract-for-agents.md).
_Avoid_: error code (ambiguous with the wire's `code`), status (ambiguous with HTTP and with the probe)

**State dir**:
The home for the CLI's remembered instance choice, credentials, pending login, patch cache and default style. Shared per user by default, it can be isolated for a development check.
_Avoid_: config directory, dotfiles

**Default style**:
The user-level style preference captured during onboarding and kept in the state dir; it applies whenever a project does not declare its own house style.
_Avoid_: house style (a project's own style, which overrides it), theme, template

**Login handoff**:
The URL, code and next command that `patchy login` returns for an agent to relay to the person confirming the machine in their own browser. The agent never opens that browser; it completes the pending login after the person's answer.
_Avoid_: prompt, browser login

**Sign-in**:
The person's act of entering a browser [session](../auth/CONTEXT.md) with Google, Microsoft or an emailed code. It enables company-page reading and device-login confirmation, independently of whether the machine holds a publishing key.
_Avoid_: authentication (in user-facing copy), publishing key (a machine's credential, not a browser session)

**Driver**:
Whoever is running the CLI — an agent first, a developer touching the cloud directly second. The word is deliberately not _operator_, which is Patchy running the platform ([Companies](../companies/CONTEXT.md)).
_Avoid_: operator, user (ambiguous with the account the driver acts as)

**Agent**:
Software acting for a user, with that user's machine token: the CLI's primary driver. Never a who, always a how — it is indistinguishable from its user except by the machine name on the token, and it holds no identity of its own.
_Avoid_: bot, service account, agent identity

**Onboarding**:
The optional, user-requested first-time setup conversation — establish where to publish, capture a default style, then publish the welcome patch. With no publishing key, the login handoff comes before publishing.
_Avoid_: signup, registration, setup wizard

**Setup prompt**:
The copy-paste request a person gives their agent to install the skill, complete onboarding and publish the welcome patch. It authorizes that first-time setup explicitly; installing the skill alone runs nothing.
_Avoid_: install snippet (older internal name), install command (only one of its parts)

**Publishing key**:
The user-facing name for the [machine token](../auth/CONTEXT.md), not a second kind of credential. Copy addressed to the person says publishing key; the domain and wire use machine token.
_Avoid_: token (in user-facing copy), password, account

**Patch cache**:
The per-instance record linking a local file to the patch it produced, so republishing the same file updates that patch instead of creating a new one, and sharing or deleting by file finds that patch. A deleted patch is forgotten.
_Avoid_: upload history, manifest

**Onboarding probe**:
The local-only report of publishing state for the resolved instance — `status --json` — that lets onboarding skip settled questions and choose login-then-publish only when no key is available. It reaches no instance and reports the same credential precedence publishing uses, so it is a setup aid, never a per-session check or proof that a key still works.
_Avoid_: health check, status check, doctor, preflight
