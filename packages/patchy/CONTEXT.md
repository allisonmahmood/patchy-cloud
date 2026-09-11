# Publishing

The path agents use to build, publish and manage patches for a user through the `patchy` CLI, its global skill and release-bound project skills. An agent is the primary driver, with the same command contract available to a person at a terminal; the product's built unit is defined in [Patches](../patches/CONTEXT.md).

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
The home for the CLI's remembered instance choice, credentials, pending login, pending publish, patch cache and default style. Shared per user by default, it can be isolated for a development check.
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

**Pending publish**:
A complete publish attempt whose outcome or local application is not yet settled, shared by concurrent invocations for one instance and owning user. Its original publish key, content and file or repo identity remain the recovery target, and only credentials for that same owner may resend it. A create is settled locally only once its returned patch identity has been recorded.
_Avoid_: queued publish, upload history

**Publish key**:
The identity of one publish attempt, letting the instance return the first result when that same attempt is sent again. It is not the machine's [publishing key](#language), which authenticates the caller.
_Avoid_: publishing key, token

**Release**:
The exact version shared by Patchy's CLI, config builders, browser client and dev runtime. An instance accepts only its current release for new publishing and dev starts; unresolved publishes remain recoverable and deployed versions keep their own wire contract.
_Avoid_: wire version, patch version

**Environment**:
Where a patch runs: the cloud as its viewer, or the local dev runtime as the machine's user. Both expose the same declared capabilities; local data comes from fixtures, never copied company rows.
_Avoid_: instance (the target cloud), dev env (the CLI's local-instance discovery record)

**Dev runtime**:
The local execution of a patch's declared capabilities over disposable local data, under the same contract as the cloud runtime. It belongs to the patch repo, not the cloud's own development instance.
_Avoid_: mock backend, emulator, dev env

**Managed files**:
The release-bound parts of a patch repo maintained by Patchy's commands rather than its builder: the package pin, generated client and metadata, project skills, and missing fixture stubs. The lockfile follows installation; adding or removing a declaration also owns one edit to its `uses` object.
_Avoid_: scaffold (these parts continue to be maintained), all project files

**Global skill**:
The agent instructions for entering Patchy: choosing an instance, signing the machine in, publishing a static file or starting a patch repo. Inside a patch repo, its project skills govern building.
_Avoid_: project skill, template

**Project skill**:
A release-bound set of agent instructions for building within one patch repo, supplied by the instance for its core capabilities or declared connections and shared tables.
_Avoid_: global skill, copied tutorial

**Catalog**:
The instance's view of the company's connected capabilities and the shared tables the caller can open, with declarations the builder can add to a patch. It describes availability, never grants access.
_Avoid_: marketplace, connection inventory (the cumulative schema inventory is a different concept)

**Fixture stub**:
The initial, metadata-only guide for a declaration's local fixture, ready for the builder to fill with invented rows. Once present it belongs to the builder, including after that declaration is removed.
_Avoid_: production sample, seed dump

**Onboarding probe**:
The local-only report of publishing state for the resolved instance — `status --json` — that lets onboarding skip settled questions and choose login-then-publish only when no key is available. It reaches no instance and reports the same credential precedence publishing uses, so it is a setup aid, never a per-session check or proof that a key still works.
_Avoid_: health check, status check, doctor, preflight
