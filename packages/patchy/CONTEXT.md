# Publishing

The path agents use to build, publish and manage patches for a user through the `patchy` package and the instance's SDK distribution. This glossary owns both sides' language; the built unit is defined in [Patches](../patches/CONTEXT.md).

## Language

**Publishing**:
The flow from a static file or patch repo to a live patch and a link announced with its [sharing scope](../patches/CONTEXT.md). It includes choosing the instance and establishing which user's publishing key the machine holds.
_Avoid_: deployment, posting

**Instance**:
The Patchy Cloud deployment or local development server a command targets, identified by its API URL. A patch repo is bound to one instance, as are credentials and cached patches; target selection follows [ADR-0004](../../docs/adr/ADR-0004-cli-contract-for-agents.md).
_Avoid_: the server (ambiguous with the hosting codebase), host, backend, your own instance (there is one deployment; the rest are dev instances)

**Dev env**:
The local instance information a running dev loop makes available to the CLI: its URL and seeded publishing key. It offers a worktree's local target without changing a patch repo's instance binding.
_Avoid_: dotenv, the env file

**Exit-code ladder**:
The contract an agent branches on: 0 success, 1 locally fixable, 2 refused by the instance, 3 no usable answer, 130 interrupted. The complete output and failure contract lives in [ADR-0004](../../docs/adr/ADR-0004-cli-contract-for-agents.md).
_Avoid_: error code (ambiguous with the wire's `code`), status (ambiguous with HTTP and with the probe)

**State dir**:
The user-level home for the CLI's remembered instance choice, credentials, pending login, file-mode pending publish, patch cache and default style. Repo-local state is separate and travels with its patch repo.
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
The file-mode, per-instance record linking a local HTML file to its patch for republishing, sharing and deletion. Repo identity belongs to the [Patch repo](../patches/CONTEXT.md), not this cache.
_Avoid_: upload history, manifest

**Pending publish**:
A complete publish attempt whose outcome or local application remains unsettled, retaining its original content, owner and patch identity even when a repo moves. Concurrent invocations recover the same attempt only for its original owner, and settling it preserves the repo's instance binding.
_Avoid_: queued publish, upload history

**Description sync**:
The reconciliation of a patch repo's description with cloud edits, using the last synchronized timestamp rather than remembered text. A newer cloud edit replaces local text with a notice; otherwise local edits remain authoritative for the next publish. The build purpose and primitive descriptions are independent. [ADR-0004](../../docs/adr/ADR-0004-cli-contract-for-agents.md) owns the command and file contract.
_Avoid_: last synced text, purpose sync, generated description

**Publish key**:
See **Publish key** in [Patches](../patches/CONTEXT.md), distinct from the machine's publishing key.
_Avoid_: publishing key, token

**Release**:
The exact version shared by Patchy's CLI, config builders, browser client and dev runtime. An instance accepts only its current release for new publishing and dev starts; unresolved publishes remain recoverable and deployed versions keep their own wire contract.
_Avoid_: wire version, patch version

**Server bundle**:
The single closed module built from a tier 2 version's handler code and stored beside its browser HTML. Its hash and handler descriptors identify the server artifact in the manifest; it is distinct from the generated server module list.
_Avoid_: page bundle, manifest, hosted instance

**Environment**:
Where a patch runs: the cloud as its viewer, or the local dev runtime as the machine's user or a non-admin colleague. Both expose the same declared capabilities; local data comes from fixtures, never copied company rows.
_Avoid_: instance (the target cloud), dev env (the CLI's local-instance discovery record)

**Dev runtime**:
The patch repo's local execution of real capabilities over disposable data, under the cloud's operation contract. Tier 2 uses the production handler engine and callback path with live server rebinding. Its primary viewer is the machine token's user; tiers 1 and 2 also expose a colleague mount. Its schema baseline is the published inventory once the patch exists; its declarations use synthetic [Fixtures](../integrations/CONTEXT.md), never production rows. Production scheduling, operating capacity and containment are not reproduced.
_Avoid_: mock backend, emulator, dev env

**Colleague mount**:
A second local dev URL at a distinct origin, bound to a fixed non-admin viewer in the machine user's company. It shares the primary mount's data and subscriptions so builders can exercise multi-viewer behavior without another login.
_Avoid_: impersonation, second company, second dev runtime

**Managed files**:
The release-bound parts of a patch repo maintained by Patchy's commands rather than its builder: managed pins, generated client and metadata, and project skills. Fixture stubs are managed only until created, and declaration commands own only their targeted config edit.
_Avoid_: scaffold (these parts continue to be maintained), all project files

**Patchy SDK**:
The release-versioned code a patch imports from Patchy, grouped Core, Primitives,
Integrations and Helpers. It is the code Patchy maintains and supports.
_Avoid_: allowlist, standard library

**Core**:
The SDK's generated client, contract, UI foundation and shell capabilities,
including generated-file downloads separate from stored-file access.
The client stays framework-free; the UI foundation is Preact with compat semantics.

**Helper**:
An optional SDK module for a common pattern, bundled into the patch that imports it,
such as `patchy/csv` for CSV text. A helper update reaches stored code after refresh,
rebuild and publish.
_Avoid_: utility, plugin, extension

**Company code**:
Code a builder writes or copies into a patch instead of importing from the SDK.
The company maintains it; it still obeys the sandbox and bundle limits.
_Avoid_: vendored package, third-party code

**Managed pin**:
A release-selected dependency maintained by refresh rather than the builder:
the exact content-digest `patchy` tarball URL, plus an exact `workerd` version
only on tier 2. Builder-owned toolchain ranges are not managed pins.
_Avoid_: toolchain pin, overrides

**Compat semantics**:
The Preact behavior installed by `patchy/preact` before rendering, including
compat components and input `onChange` handling, on the same bundled instance
as hooks and signals. Transitions are synchronous; this is not React's scheduler.
_Avoid_: React runtime, direct Preact dependency

**Global skill**:
The agent instructions for entering Patchy: choosing an instance, signing the machine in, discovering company tools and data sources, publishing a static file or starting a patch repo. Inside a patch repo, its project skills govern building.
_Avoid_: project skill, template

**Project skill**:
A release-bound set of agent instructions for building within one patch repo, supplied by the instance for its core capabilities or declared connections and shared tables.
_Avoid_: global skill, copied tutorial

**Discovery**:
The agent's view of its company's patches, their tables, stores and reads, and company connections. It includes only what the credential can open and identifies which sources can be declared; finding a source grants no access.
_Avoid_: search, inspect, marketplace

**Fixture stub**:
The initial, metadata-only guide for a declaration's local fixture, ready for the builder to fill with invented rows. Once present it belongs to the builder, including after that declaration is removed.
_Avoid_: production sample, seed dump

**Onboarding probe**:
The local-only report of publishing state for the resolved instance — `status --json` — that lets onboarding skip settled questions and choose login-then-publish only when no key is available. It reaches no instance and reports the same credential precedence publishing uses, so it is a setup aid, never a per-session check or proof that a key still works.
_Avoid_: health check, status check, doctor, preflight
