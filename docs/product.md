# Patchy Cloud

The product, written down where agents read it. The [foundation map](https://github.com/allisonmahmood/patchy-cloud/issues/5), [auth map](https://github.com/allisonmahmood/patchy-cloud/issues/112), [SDK map](https://github.com/allisonmahmood/patchy-cloud/issues/164) and [portal map](https://github.com/allisonmahmood/patchy-cloud/issues/230) record the decisions (the portal's spec is [#247](https://github.com/allisonmahmood/patchy-cloud/issues/247)); the glossaries in each `CONTEXT.md` carry the words, and this file carries the shape.

**Built today:** tier 0 static HTML pages and tier 1 sandboxed browser tools at named company addresses. Static pages publish from an HTML file or a repo; tier 1 tools publish from a repo. Repos have code-first config, a generated typed client, release-bound project skills and a local PGlite dev loop with fixtures. Publish is replay-safe and provisions patch-owned tables and file stores additively into a database per company. Tier 1 reaches those resources, read-only shared tables and stores, and company Postgres connections through the shell broker as the viewer, with mutations and integration calls logged.

Signed-in members find company patches at `/` and open their cards at `/patches/<name>`. Owners manage descriptions, sharing, served versions and the lifecycle from the portal or CLI. Patches stay live or retired indefinitely; deletion starts a 30-day recovery window. Off addresses show colleagues an actor-stamped notice and a route to restore. Admins can manage and reassign every company patch in the portal, but must become its owner to publish. Deactivation and reactivation offer patch selections with dependant and source warnings, committed together with the user's access change.

Agents discover company tools and data sources through `patchy list` and its patch, primitive and connection drill-downs. Description edits pull back into the repo at refresh, dev start and publish. Clerk sign-in, create-or-join, company administration, company/public sharing and machine login, logout and revocation are built. Postgres connections have browser administration, immutable schema snapshots and generated relation clients. Portal, Company, Connections and Your machines share one app shell and component set.

Tier 2 repos publish an HTML artifact and an inspected server artifact. Dev and test instances serve them on the local executor, with patch identity for own-resource callbacks, live viewer authorization for company data and bounded settlement. The patch-repo dev loop uses that same handler engine and callback path, with live server rebinding and a non-admin colleague mount. The fleet controller supports separate local task processes for offline checks and ECS Fargate tasks for production, including spare claims, stopping and drain, crash metering and the patch breaker. Its starting cover holds calls until the company is ready. Production tier 2 admission requires `EXECUTION_PROVIDER=ecs`; a local executor is refused. Shared file stores are readable on both tiers. Narrower sharing, other integrations, billing, source recovery and the remaining company lifecycle remain future work.

## Patches

A **patch** is the unit of what people build and deploy on Patchy Cloud — anything from a static page to a full CRM. A tier 0 page and a CRM are both patches for the same reason: each is one built thing in a company's cloud, stored as one, permissioned as one, provisioned as one, at one address, at one runtime tier. What differs between them is where their code needs to run — never what kind of thing they are.

### What a patch is made of

A patch is a **file tree**. A **patch repo** is its local working copy, initialized by `patchy init` at tier 0, 1 or 2. It contains application source and the single-file build, `patchy.config.ts`, `patchy.json`, managed package pins, generated client and context, project skills and fixtures. Tier 2 adds `server/` handlers beside the page. `patchy.config.ts` holds the name and explicit tier, **defines** the tables and file stores the patch owns, and **declares** the connections, shared tables and shared stores it uses. The CLI executes that config locally into a **manifest**; the server validates the manifest, never executable config.

`patchy.json` records the instance, description, last description-sync timestamp and optional patch id, never credentials. One repo is the working copy of exactly one patch. The first publish without an id creates the patch and writes its id back; later publishes update it. Cloning preserves that target, but only its owner may publish to it. A single HTML file is the simpler tier 0 route with no repo; its CLI cache remembers the published patch. A file-born patch can be adopted by putting its id in a repo's `patchy.json`.

Each version has exactly one tier. The CLI checks the tree and bundle; the server checks the manifest and bundle. Tier is about code, not data: a tier 0 repo may define tables and stores or declare dependencies even though its static page cannot call them. Tables and stores are provisioned with the patch; a declared connection must already be connected and a shared table or store must already be available (see [Primitives](#primitives) and [Integrations](#integrations)).

The **Patchy SDK** is the release-versioned code a patch imports: Core supplies
the generated client, contract, Preact with compat semantics and shell operations;
Primitives supply tables and files; Integrations supply company Postgres;
Helpers are optional reusable modules, with CSV planned next. Everything else
written or copied into the patch is **company code**, maintained by the company.
Dev and publish check page imports, not the dependency list in `package.json`.
An off-SDK import is local `import_refused`, with its importer, allowed entry
points and the company-code rule. This build contract is not containment.
Generation lists the current release's capabilities, where they run and their
limits in "What the SDK gives you" in `patchy-loop`; refresh announces additions
without rewriting company code.

### Who makes one, and how it gets in

A person, or an agent acting for them, publishes through the `patchy` CLI. The SDK and local build loop are what `init` puts in the repo today. A hosted AI builder remains a later route: an agent with the same skills and SDK, working on a sandboxed computer Patchy runs instead of the person's own machine, and producing the same unit.

Ownership: a patch belongs to a **user** in a company. The user holds a machine token per device, every token acts for that user, and replacing a token never changes who owns their patches.

### Versions and publishing

**Publish** creates an immutable **version** and moves the patch's served-version pointer. The working copy stays local; the cloud has no unpublished patch. File publishing sends a tier 0 manifest and one HTML bundle. Each version records its tier, release, manifest version, server-stamped wire version and schema revision. The API accepts tiers 0 and 1 with tables, stores, shared tables, shared stores and resolved Postgres connections, and tier 2 on dev/test instances or production hosts configured with the ECS fleet. Tier 0 obeys the safe-HTML policy; scripted pages run in the sandbox. Tier 2 also stores an inspected server module. Higher tiers are refused. File-mode updates to a patch with cumulative inventory are `has_primitives` and must use its repo. Rollback changes the served pointer without creating a version or changing data, as described under [Updating, retiring, deleting](#updating-retiring-deleting).

A **publish key** identifies one attempt for its owning user. Before sending, the CLI stages the complete request and owner in a key-named file, then atomically installs the nonempty `attempt/` directory as the active recovery slot. The next publish recovers that attempt first, using a current token for the same user. Concurrent CLI processes recover the existing attempt rather than overwriting it; an account switch cannot resend another user's saved content. A killed process leaves either no active attempt or a complete recoverable one. Clearing only the matching key prevents a stale response from removing a newer attempt. Repeating the same request returns the stored response without a new version, even after the instance's release changes; reusing the key with a different payload is a conflict. New publishes require an exact-current CLI release.

### The package and its release

`patchy` is one private npm package containing the CLI, config builders, browser
client and local dev runtime. Its version is the **release**. The instance serves
its immutable tarball and reports its SHA-512 integrity through `GET /api/release`;
public npm distribution remains future work. A repo pins that tarball as one
devDependency, and `pnpm patchy …` runs the pinned copy.

New file publishes require the exact-current CLI; repo publishing and new dev
starts also check the package pin and installed runtime before executing config.
A running dev session is not killed by a release. Release, manifest version,
runtime wire version and schema revision are separate: a release upgrade does
not invalidate a deployed bundle's stable wire. Retiring a wire contract would
be an explicit breaking decision behind the needs-rebuild door, not an automatic
consequence of publishing a new package.

`patchy/config` defines owned tables and file stores and declares shared tables,
shared stores and Postgres connections. Row, insert and update types are inferred from the
config; execution happens in a local child process, producing the existing
manifest rather than sending executable config to the server. The browser client
uses the broker's document-bound port and one `PatchyError`; lost replies never
cause a mutation replay. Repo generation supplies this client surface and the
same shell provides its broker locally and in the cloud. Initialization alone
does not publish a patch.

The tier 2 handler contract is available through `patchy/server`: typed queries,
mutations and actions, config-bound helper contexts, business errors and
serializable descriptors. Generation derives the server-only client's signatures
from type-only server imports. `useQuery` shares local subscription state and
retains its last value through errors. The pinned workerd engine, credential-free
SDK guest, isolated descriptor inspection, process supervisor, private management
listener and supervised local executor are implemented. Runtime now admits and
settles invocations through a private capability gateway in isolated execution
tests and the existing `pnpm dev` instance. An eligible `server.call` executes on
the local executor. Published tier 2 pages use the generated handler client in
the hosted shell. `patchy dev` uses that engine and gateway over local PGlite and fixtures.

### Building a patch

`patchy init [dir] --purpose <text>` starts a patch repo, defaulting to tier 1.
`--tier 0` and `--tier 2` are available. Choose tier 2 for enforced rules, atomic
multi-row writes or server-side work such as combining connection data before
the viewer sees it. Live sync and sequential operations already work on tier 1.
Init authenticates first, names the instance and identity, and lays down config,
application source, the single-file build, typechecking, generated client and
context, project skills and fixtures. It installs the managed packages with
scripts disabled, so an agent starts with `pnpm patchy --help` and `pnpm typecheck`, not
another setup or installation ritual. A second initialization refuses the same
repo. A company without connections gets the core skills and empty declarations.

Tiers 1 and 2 start with `index.html` containing an empty root, `src/main.tsx` and
`src/App.tsx`. Preact and its compat behavior come through `patchy/preact` on
the release's bundled instance. TypeScript and Vite use the same JSX import
source; module preloading is off. The repo includes hooks/import lint and
`helpers/` for company code, not a router, CSS framework, state library or test
runner. Vanilla repos keep working through the framework-free generated client.
Tier 2 adds starter handlers in `server/`, config-bound
`patchy/_generated/server.ts`, the exact `workerd` managed pin and
`patchy-server` alongside `patchy-preact` and `patchy-loop`. The page uses
generated query and mutation calls; workerd runs from its platform package
without a postinstall script. Tier 0 is unchanged. Builders talk through edge
cases and product behavior with the person before building, then typecheck and
exercise the supported runtime.

`patchy.config.ts` defines what the patch owns and declares what it uses.
`patchy.json` records the instance, description, optional patch id and description
sync stamp, never credentials. `init --purpose` writes the initial description
there and the independent purpose into write-once `AGENTS.md`, alongside the
`src/` page and `server/` handler split in words that hold on either tier,
skill paths, runtime-check guidance and the generated-index pointer.
`CLAUDE.md` imports it. The local dev runtime uses real handlers over local data,
never a production-data shortcut.

For tiers 0, 1 and 2, `patchy dev` checks the pin, CLI and runtime against the instance release, then
authenticates a new session as the machine token's user. It refreshes declarations
and pulls the published inventory when the repo has an id. It provisions the same
table/store definitions over PGlite and serves the production shell, sandbox,
CSP and broker. Vite builds the same single-file page artifact as publish;
`src/` rebuilds swap it atomically and reload the shell. Tier 2 `server/` edits
atomically rebind bundle bytes and descriptors without reload, discovering new
modules live. Existing calls and nested calls finish on the old binding.
Subscriptions wake on the new binding, discard crossing results and permanently
end for removed handlers or incompatible arguments. Bad builds keep the last good
page or binding. Config and fixture changes take effect on the next stop/start.

The daemon is detached and idempotent, returning a primary local page URL only when
healthy, with its log path and stop command. Tiers 1 and 2 also return `colleagueUrl`,
a distinct origin for a fixed non-admin viewer sharing the same local data.
`dev status`, `stop`, `logs` and `reset` accept `--json`; `--foreground` stays attached.
State lives under `.patchy/dev/`, scoped to repo and instance; process identity
includes birth time, so a stale PID cannot stop a different process.
Reset stops and wipes disposable local state without changing published resources;
the next start fetches the published inventory again.
Before the first publish every schema change recreates local data. Afterwards,
the published inventory determines additive changes and refusals, not the last
local config; compatible additions preserve rows. `dev.log` records each call's
viewer, handler, outcome and milliseconds, `ctx.log` output and local-only failure
message/stack. Starting with `--json` records full wide events and invocation JSON.
There are no runtime database log rows, PostHog delivery or connection keyring.

`patchy dev` runs the same handler engine and callback path as production.
It does not reproduce production's scheduling, limits or containment. A handler
that spins forever times out, and a health check restarts the dev engine, which
can interrupt other calls in flight. Contract limits still apply; production
operating capacity does not. PGlite is not evidence for hosted `busy` or
`write_conflict` behavior.

From the repo root, `patchy publish` recovers any saved attempt first. For a new
attempt it checks the release, executes config, compares generated declaration
stamps and server module names, checks imports on each graph, builds and typechecks.
All tiers produce one self-contained HTML bundle. Tier 2 also produces one
closed server module with no dynamic imports. The page may import server types,
never server implementations. Stale generation requires `patchy refresh`.
`server/` below tier 2 is `tier_mismatch`; scripts require at least tier 1.
File mode is never a build fallback. Tables and stores do not determine the tier.
The manifest records `handlers` and the SDK entry points found in both graphs.
The server reads the stored server bytes and derives descriptors in a throwaway
process. Disagreement, a top-level throw, an unfinished initializer or an
unresolvable module is `invalid_manifest`. Zero handlers publishes with a warning.
Every JSON success includes `artifacts.html` with SHA-256 and byte count.
Tier 2 adds `artifacts.server` and `handlers: [{ name, kind }]`, sorted by name.

The **publish key** and complete request are saved under `.patchy/publish/` before
sending. A create writes its returned id to `patchy.json` before clearing the
attempt; lost replies and failed id writes recover that same create, before
checking today's release or changed source. Success reports the address, tier,
version, **provisioned** resources and **unused definitions** in text and JSON.
An optional column is additive; a rename provisions a new table and reports the
old one unused, preserving its data. A retype names the object, change and fix
before any DDL. `share` and `delete` without a target use the repo id.
A deleted patch refuses publishing with `patch_deleted` and keeps its id in
`patchy.json`. A retired patch answers `patch_retired`, and a same-company
non-owner receives `not_owner`. These are definitive refusals, never advice to
create another patch. Only a gone patch's 404 asks for the id to be removed.

Owners can retire, delete, restore, roll back and describe patches from the CLI.
Each verb uses the repo id, original file cache or an explicit `--patch <id>`.
Delete confirms interactively or requires `--yes` for agents. Retire, delete
from live and unshare at publish list dependants and require `--force` to break
them; restore lists off sources and requires `--force` to serve with broken reads.
The CLI tells agents to ask their user before forcing.

`patchy list` discovers company patches and connections, then drills into patch
definitions and connection snapshots. It runs anywhere under the saved login
and never reads `patchy.json`; discovery grants no authority. See
[Sharing and finding](#sharing-and-finding) for the discovery chain.
`patchy add postgres/<handle>`, `patchy add shared-table <patchId>/<table>`
or `patchy add shared-store <patchId>/<store> --as <alias>` adds one declaration by
TypeScript AST and generates the client, context, missing fixture stub and skill.
The insertion is a literal declaration, requiring no import changes. An uneditable
expression fails with its exact source line and the exact declaration line to
add manually before refresh, rather than guessing at a rewrite.
`patchy add postgres` selects a sole connected Postgres connection; with several
it lists choices from `list connections` and stops. With none, it names
`/company/connections`.
Connection refusals point to `/company/connections`; an unavailable shared table or store
addition points to `/company`. Restore source access or correct the declaration.
`patchy remove <alias>`
reverses the declaration and generated surface, retaining its fixture.

`patchy refresh` binds the whole change to one release: fetch, reconcile managed
pins with the release and tier, install as needed, re-exec the CLI, generate,
stage and activate. Failure leaves the old managed set intact. The **managed
files** are exactly the `patchy` pin and tier 2's `workerd` pin,
`patchy/_generated/`, `.agents/skills/patchy-*/`, missing fixture stubs, the
lockfile through install and the one `uses` edit for add/remove. Refresh alone
updates managed pins and the generated server module list after init; publish
refuses stale module names with `stale_generated`. Refresh removes stale
generated context files. App source, existing fixtures and write-once agent
instructions belong to the builder.

Generation is authenticated and server-side. It accepts the manifest, current
release, optional patch id, present skills and server module names, and returns
finished files with resolved declaration ids and revision stamps. `patchy/_generated/index.json`
identifies each declaration, alias, stamp, skill and context path; its README says
plainly that deleting `.patchy/` destroys local rows and files. The CLI alone writes
`manifest.json` from config execution. Neither the server nor the CLI may write
arbitrary paths outside the managed roots.

The **global skill** is the door for sign-in, static pages and `init`; inside a repo
the **project skills** govern. Their sole source is `packages/sdk/skills/`:
`patchy-loop`, `patchy-tables` and `patchy-files` are core;
`patchy-preact` is added on tiers 1 and 2; `patchy-server` is added on tier 2.
`patchy-postgres`, `patchy-shared-tables` and `patchy-shared-stores` follow declarations. Refresh
re-fetches every present skill and adds implied ones. Skill presence is sticky,
except that dropping below tier 2 removes `patchy-server` alongside the
`workerd` pin and generated `server.ts`. A different missing skill offer fails
rather than preserving obsolete instructions. Explicit remove may retire a
declaration skill when no declaration of its kind remains.

A **fixture stub** contains metadata and guidance, not company rows or bytes.
The builder fills `fixtures/postgres-<handle>.sql` or `fixtures/shared-<alias>.sql`
with invented local inserts, or `fixtures/shared-<alias>/` with invented files
for the named source store. Refresh creates a missing directory and never
overwrites an existing one. Dev loads shared fixtures at start; edit them and
restart to change a local source. Authority changes are not simulated.
Only metadata and inventory come from the instance.
On tier 1, every readable row is available to every admitted viewer;
UI filters do not create access control. Tier 2 enforces rules in handlers.
A public runtime gets no company data. Project skills teach these boundaries
and the limits of each tier; durable data goes through Patchy.

### Sharing and finding

A published patch is shared with **everyone in the company** by default, or made **public** on purpose, so anyone can open its current version without a login. The owner chooses the scope with `patchy publish [file] --share company|public` or `patchy share`, using the repo id, file cache or explicit `--patch <id>`. A publish without `--share` preserves the scope. Owners and admins can also change a live patch's scope on its portal card. Public tier 1 versions expose no company capabilities, even to a signed-in member. Narrower sharing remains future work, as described under [Identity and access](#access-to-a-patch).

A person finds a patch in the portal or through its shared address. A patch's identity is its **id**, while its **name** is unique within the company. Two sales dashboards need different names, but renaming one never changes which patch it is. See [Addresses](#addresses).

**The portal is built.** Signed out, `/` shows the login door. Signed in, it shows an index grouped Yours and Company, with Retired and deleted behind a toggle, beside one patch's card at `/patches/<name>`. The first of Yours is selected, otherwise the first live patch. An empty company gets instructions for publishing its first patch; an off-only company keeps the toggle and an empty live index. The name leads, with the description's first clause in the index and a distinct document title at most a secondary line on the card. The card shows its address with Open, description and editor, owner and deactivation status, current version and publisher, who can open it, and the first three patches that read its shared tables or stores. Owners and admins edit descriptions, sharing and served versions inline and restore off patches whose current sources are live. The full versions page is at `/patches/<name>/versions`. Retired and deleted cards remain at their names until reclamation. Retire, Delete, off-source Restore and admin-only Reassign have confirmation pages under the card's URL. An inline restore that discovers off sources answers 409 with the restore confirmation and does nothing until acknowledged. `/<company>/<patch>` stays the patch itself. The portal uses Patches' discovery query, limited to the viewer's company, including its public patches. The index has no search or paging.

The portal, Company, Connections and Your machines share one app shell with section navigation, the viewer's name and company, and sign-out. First-party pages use one component set for buttons, fields, fact lists, selectable index rows, tables, notices, headings, pills and confirmation forms. Sign-in, create-or-join, device confirmation and error doors keep the card shell. Portal not-found pages keep the app shell.

**Agent discovery is built.** `patchy list` and its release-bound skills let agents find tools by description, inspect a candidate's tables, stores and reads with `list <patch>`, then check keys and types with `list <patch> <table>` before adding a shared table by canonical patch id. The CLI runs anywhere under the saved login and never reads `patchy.json`. `list` and `list patches` both group rows Yours, Company, then Connections. Patch rows lead with the id, then name, state, owner with `· deactivated` when applicable, current version and the description's first line or `(no description)`. Deleted rows show `deleted · gone in N days` from the server's `purgeAt`.

`--state live|retired|all` defaults to `live` and governs patches at all three levels. Names resolve only non-deleted patches; a pasted URL resolves by its final path segment. A deleted patch needs its id and `--state all` at both detail levels. A resolved patch outside the requested state receives the API's `wrong_state` refusal, exit 2, with guidance such as `retired; pass --state retired`. Only patches the credential can open appear; unknown, foreign, disabled, gone and unopenable references all answer 404. "No match" means "none you can use"; the skills teach checking `--state retired` before concluding a tool does not exist. `--mine` applies only to the top level, and `--all` only to `list connections`, not one connection's detail. Patch flags do not apply to connections; wrong-level flags are local errors.

Patch detail returns cumulative inventory and reads across retained versions, not dependants or version history. Table detail returns column kinds, optionality, explicit defaults including `null`, ref targets, indexes with `unique`, sharing and schema revision, never rows. An unavailable company database yields `inventory: null` and text `Tables: unavailable`, not empty definitions. Shared live tables and stores carry copy-ready `patchy add shared-table <patchId>/<table>` or `patchy add shared-store <patchId>/<store>` hints. Agents branch on `declarable` and `reason`, not the human `hint`; unshared resources name the owner and off sources need restoration. Store reads and dependants use a `store` field, never a `table` field.

`list connections [--all]` lists the company's connections, with offered integrations when requested. Connected entries carry an `add` hint; disconnected ones carry `reason: not_connected` and a `/company/connections` pointer. `list connections <handle>` returns the current immutable snapshot with its revision and `takenAt`. A null snapshot is unavailable, not an empty database. Discovery reads no source rows or credentials.

Every discovery level accepts `--json`. The top level merges `{ patches, connections }` from `GET /api/patches` and `GET /api/connections`; other levels print their wire body without an `ok` wrapper. Agents filter those documents locally. Patch detail includes `descriptionUpdatedAt` for repo synchronization. The patch read query carries live dependant edges for the portal, while agent detail exposes inventory and reads.

### Updating, retiring, deleting

Updating is publishing again. A patch stays live until someone retires or deletes it, or the operator disables it. Visits count successful origin requests; they do not change a patch's lifetime.

A patch is **live**, **retired** or **deleted**. Retire takes a live patch off its address indefinitely and keeps everything. Delete takes a live or retired patch off and starts a fixed **30-day recovery window**. Restore brings a retired patch back live at any time, or a deleted patch before its recovery deadline, at the same address. After the window, the deletion sweep reclaims the patch, its versions, tables, files and names. Names remain reserved until reclamation, and nothing can restore a deleted patch after its recovery deadline.

Recovery applies to deletions made after the lifecycle migration. Earlier deletes were irreversible and had already released their names and resources. The migration finalizes those old deletions and queues their version objects for cleanup; it does not make them restorable or take names back from replacement patches.

A retired or deleted patch denies shared-table and shared-store consumers on their next read. Restore brings consumers back without changing their declarations. Retire, delete from live and a publish that unshares a table or store list live dependants by name and owner and refuse unless the API request carries `force`. Restore similarly warns about retired, deleted or gone sources declared by its current version. **Rollback** moves the served-version pointer to any retained version, creates no version, and leaves data, provisioning, sharing, description and name unchanged. Every version is kept.

Owner machine tokens can call the lifecycle API through `retire`, `delete`, `restore`, `rollback` and `describe`. The service admits owner and same-company admin actors for management, but reassignment to an active company member is admin-only and publish stays owner-only. Every act records its actor, time and latest act label. Each portal form checks its own precondition in the mutation transaction. Stale fields answer 409 with a fresh card naming who did what and nothing changed; invalid descriptions and typed delete-name mismatches answer 422 with the submitted text; member POSTs answer 403 with the read-only card. CLI `--force` accepts reported breakage and `--yes` confirms deletion; both are required when deleting a live source with dependants. Portal confirmations ask for an acknowledgement before breaking dependants or restoring a patch with off sources, and for the patch's typed name on delete. Retire and delete confirmations carry the patch's id, so a form left open after its name passed to another patch refuses with nothing done. Delete states the reclaim date; deleting a retired patch starts the 30-day clock without repeating the dependant warning. Reassign offers a filtered list of active company members, rechecks the target and expected owner on submission, and changes nothing when the current owner is chosen. **Disable** remains the operator's separate take-down, never owner-restorable.

Address notices are built. A retired or deleted patch's address, numbered version URLs and content URL show an active colleague a private, uncached page on the app shell with its state, who took it off, when, and days left from `purgeAt` for a deletion. The owner or an admin gets Restore until the recovery deadline: a button when the current version's sources are live, or a link to review the off sources. Every colleague gets a link to the patch's card. Signed-out readers keep the login door, even for a formerly public patch; another company's member gets 404. Disabled and reclaimed patches answer 404 for everyone. Existing public caches drain within a minute.

### Describing a patch

The backend stores a patch's **description** with its editor and edit time. It accepts at most 500 Unicode code points after whitespace collapse and trimming, with no control characters. The owner can edit it over the API while live or retired; service admin actors can do the same. Publish accepts the manifest description or file metadata description and returns the stored value and stamp. Omitted descriptions preserve the cloud value, and existing patches start empty. Rollback and restore never change it; edits create no version.

The description sync is built. `init --purpose` writes `description` in `patchy.json` and refuses more than 500 normalized Unicode code points. Repo publish requires nonempty text, sends it in the manifest and saves the returned stamp as `descriptionSyncedAt`. At `refresh`, a new `dev` start and fresh `publish`, a newer cloud stamp pulls down the cloud text and prints a notice, including the replaced local text when different. Local edits do not move the stamp; unchanged cloud metadata leaves them alone. Publish sends the pulled text. `describe` updates the cloud and rewrites a targeted repo in one run; `--clear` explicitly empties it. File publish accepts `--description`; omitted, the cloud value stands. Repo mode refuses that flag and points at `patchy.json`. The portal card edits the same cloud description while live or retired, shows its editor and date, and preserves submitted text on validation errors.

Primitive descriptions stay in `patchy.config.ts`. At refresh, dev start and publish, a definition changed since its last generation with byte-identical description triggers a reminder to check the text. The command proceeds, with notices in `warnings` under `--json`. Purpose in `AGENTS.md` is independent of both description sources.

### Patches and other patches

A patch may declare and read another patch's shared table or shared file store in the same company. The declaration names the source patch's stable id and resource, never its address or name; it grants no access of its own. The viewer must be able to open the source and the resource must remain shared. Extending shared rows means defining an owned table keyed by source ids and joining the two reads, not changing the source. Calling another patch's code and extensions that plug into another patch remain promised, not designed.

### What a patch is not

Not a **connection** (a connected source belongs to the company, or in the future a user, and a patch uses it), not a **primitive** (a patch defines its own and declares those it uses), not a **company**, not a **version** (part of a patch), not an **agent** or a skill (those make patches). A patch can own tables and files; it is not itself a table, a connection, or the people using it.

## Runtime tiers

A **tier** is where a patch's code runs, and nothing else. Tier 0 is **static**: no patch code runs anywhere. Tier 1 is **browser**: code runs in the viewer's browser, as the viewer. Tier 2 is **hosted**: the patch also has server-side code Patchy runs for it, while someone has the patch open. Beyond them, and not designed: tier 3 runs with no viewer present — automations, a thing that persists — and tier 4 gives an agent its own computer to work in (the shape Daytona fits). The numbers are the names; the glosses are for context.

### What a tier changes, and what it never changes

A tier changes where code runs, not patch ownership, declarations, versioning or addresses. Company patches use the same sign-in door on every tier. Public sharing is available only below tier 2. Tier 2 publication runs on dev/test instances and production hosts configured with the ECS fleet.

Tiers 0 and 1 can be **public**, open to anyone with the link. A public tier 0 patch is a static page; a public tier 1 patch can run browser code but receives no company capabilities for anyone, including signed-in members. It may still use the shell's route bridge. An authenticated company-data mode of a public patch remains deferred. **Public tier 2 is deferred**: the patch identity grants no anonymous access. `tier2_not_public` refuses public sharing of a served tier 2 version, and a tier 2 publish to a public patch requires explicit `--share company`.

### Tier 0 — static

The published document runs no script, so **the patch cannot watch you**. The [serving guarantees](../packages/serving/CONTEXT.md) distinguish patch content from its first-party shell: a public tier 0 shell needs no script; a public tier 1 shell runs only Patchy's broker, never analytics. A company shell also loads Clerk's headless client and Patchy's external session initializer. Only the current version of a public patch is public; older versions stay behind the company door. Caching is keyed to sharing: a minute at most for the current public version at its address and numbered version URL, never for a doored page. Pages stay open to any agent that may open them, never bot-blocked; an agent reads a company page through its user's signed-in browser, not a machine token. The host knows who opened a company page in order to let them in. The promise is _the patch cannot watch you_, not _nobody knows you were here_.

### Tier 1 — browser

Code runs in the viewer's browser and, on a company version, acts **as the viewer**. It never holds the Clerk session or an integration credential. It can learn the viewer's user and company claims; an admin hint is for presentation, not an extra permission. It reaches the patch's own tables and files, declared shared tables and company integrations through Patchy, which authorizes the call against the loaded version and the viewer's current access. It cannot use the viewer's broader account or admin powers. There is no direct outbound to third-party APIs, credentialed or not — reaching outside systems is what integrations are for.

**A tier 1 patch acts as you, only through Patchy, and never holds your login. What you do inside it can be saved in its own tables, which your colleagues can read, and every write is logged for your company's admins. It reaches outside systems only through your company's integrations.** A public shell runs only Patchy's own shell script, never analytics; company shells also maintain the session.

The shell binds one document, patch and version through a nonce-checked message
channel. Tier 1 content is served on the same host in a sandboxed, opaque-origin
frame; both the response CSP and the iframe allow scripts and printing. The
content has `connect-src 'none'`, and the shell's `frame-src 'self'` contains
frame navigation. The shell validates operation arguments with the same wire
schemas as the server; patch code has no direct runtime HTTP channel.

Every company document on tiers 1 and 2 opens a shell-owned stream at bootstrap.
Publish and rollback announce the served version without reloading the frame or
discarding input. A bottom-centre notice offers Reload; Not now lasts until the
next publish, and Hide collapses it without dismissing. The tier-upgrade state
"Reload to keep saving" cannot be dismissed. Rolling back to the loaded version
clears the notice. Public documents have no company stream.

The shell reconnects after a network cut or host restart, keeping its loaded
version and last subscription values. A reconnecting pill appears after two seconds
and clears only after every desired subscription reaches its reconciliation fence.
Hidden documents suspend after 30 seconds and reconnect on return. Presence is
the open connection, never a heartbeat or stored lease. Retirement, deletion and
session loss stop the document; every reconnect rechecks eligibility and authority.
A stale session token asks the browser to refresh rather than discarding the draft.
Version revocation is undecided in [#425](https://github.com/allisonmahmood/patchy-cloud/issues/425);
the wire reserves its frame, but there is no version-revocation operation or state.

Tier 1 owned and declared shared-table `list` and `get` reads support `.subscribe`
and `useQuery`. A colleague's write updates subscribed results without a reload.
Missing rows remain subscribed at table grain. Errors preserve the last successful
value; restoring or resharing a source lets a refused subscription recover.

Tier 2 server queries support the same `.subscribe` and `useQuery` interfaces.
The host traces callbacks, including refused reads, to the resource owner rather
than the shared alias. Successful runs replace the dependency set even when the
result is unchanged; failed runs retain previous and attempted resources.
A source unshare keeps the last value and reports a recoverable refusal.
Resharing wakes it, including when its first run was refused. Handler failures,
invalid results and a missing loaded handler end only that subscription, keeping
its last value. Publishing does not replace an open document's loaded handlers.
Mutations return their committed revisions; pages render from subscriptions.

Resource writes and patch lifecycle changes commit durable revisions with their
data. Post-commit hints reach other hosts through Postgres; reconciliation checks
revisions every 30 seconds by default and on reconnect, so a missed hint cannot
leave a document permanently stale. Reconnect never replays a mutation.

Unsupported: outbound fetches, external links, popups and `target=_blank`, top
navigation, in-frame downloads, cookies, localStorage, IndexedDB, workers,
camera, microphone and geolocation. Clipboard write is delegated, not clipboard
read; copying must be user-triggered and show a visible failure when refused.
Routes, back/forward and downloads belong to the shell; own-file images use
frame-local blob URLs. Public company-data refusals are errors for patch code
to display, not stopping notices.

Access loss is a first-party notice the patch cannot hide. Session expiry or
account changes are refused before another operation executes, stop the patch,
and require a whole-page reload after sign-in. Already-dispatched work keeps its
original principal; a navigated document receives neither its port nor its replies.
Unanswered operations have an unknown outcome and are never replayed. A stale
shell refreshes once, bypassing its cache; a persistent mismatch stops visibly,
while a retired wire shows the needs-rebuild door. See
[ADR-0010](./adr/ADR-0010-sandboxed-frame-and-broker.md).

The runtime operation path admits `me`, owned-table operations, shared-table
and shared-store reads, owned-file operations and Postgres operations. A company
version returns its active viewer and company; a current public version returns
null for `me` and refuses company data and integration access, even to a signed-in
viewer. Browser sessions, never machine tokens, enter this path; wire and
principal headers bind each request. Mutations and Postgres calls additionally
require the exact shell Origin, and file reads require same-origin fetch metadata.
The runtime records table and file mutations and integration calls before execution.
Default limits include 300 calls per viewer per patch per minute, 32 outstanding
requests and 64 MiB held per frame; the data-operation limits are below.

Each runtime HTTP call, including file-byte requests and refusals, also emits one
server-side [wide event](../packages/analytics/CONTEXT.md) with its outcome,
duration and attributable company, patch, version and viewer ids. Events go to
stdout and, when configured, PostHog. They are unsampled and best effort, separate
from the attributed runtime log and billing records. A lost process can lose its
last events; no request waits for delivery.

The [limits registry](./limits.md) is the source for release contract bounds and
operating defaults. Contract bounds cannot change through production deployment
configuration. Controller code can set and remove company operating overrides,
with the actor, effective values and configuration revision kept in history.
The registry includes the decided tier 2 bounds; their enforcers land with the
features below.

Tier 1 runs only while the viewer has the patch open. It cannot run background work or server-side patch code, but its writes persist: a saved photo or table row remains available to other admitted viewers after the browser closes.

### Tier 2 — hosted

Tier 2 publication is built for dev/test instances and production ECS fleet hosts,
as defined in [ADR-0012](./adr/ADR-0012-credential-free-execution-service.md). The server stores
both artifacts and inspects the server bytes before recording a version.
Its engine, inspection, supervisor, local executor and host invocation lifetime
are built. The host validates handler
arguments and results, authorises callbacks, records invocations and settles
admitted work independently of the browser connection. The supervisor terminates
runaway version processes and unfinished initialisation. The local executor
refuses production construction. Queries with declared company resources retain
one read-only repeatable-read snapshot, with live shared-table access checks.
Resource-free queries retain the same fenced callback lifetime without requiring
a company database. Mutations group owned-table operations and a validated
result into one host-owned serializable transaction, retrying serialization
conflicts up to three times within five seconds. A mutation key makes an explicit
retry after an unknown outcome recover a committed result without duplicate
writes. Actions can transfer file bytes, call company integrations as the viewer
and run sibling queries or mutations under their remaining deadline. The fleet
controller binds one company task, manages spares and drains stopping bindings.
Its local provider runs separate supervisor processes for offline acceptance.
Its ECS provider runs credential-free company tasks in private subnets, with
one workerd process per loaded version. Each task shares its half-vCPU CPU budget
across the supervisor and all loaded processes; process separation does not
promise unchanged sibling latency under CPU contention.

Metering records calls and database-held milliseconds from the first admitted
invocation, independently of best-effort request events. Invocation rows record
host elapsed time, guest-reported time, callbacks, argument and result bytes,
attempts and outcome. Quiet top-level queries instead increment exact UTC-minute
rollups; queries that log or fail and nested queries have invocation rows, never
both records for the same run. Settlement atomically deduplicates each rollup
increment by run id for one hour. A client retry is a new run.
Quiet query replies do not wait for persistence. Settlement retries recoverable
SQL failures, including ambiguous acknowledgements, with the same id for at most
five minutes. Exponential delays start at 100 milliseconds, use jitter and cap at
10 seconds. The budget covers stalled SQL as well as retries and ends before the
deduplication window. Permanent failures and exhausted budgets produce a safe
diagnostic and stop settlement. A host crash or abandoned settlement can lose a
run; a lost acknowledgement can leave an already-counted run. Dedup-id pruning
is separate from the atomic increment, so pruning failures do not replay it.

Database time excludes connection queues and includes a nested call's held
connections in its parent action. Host elapsed time, guest time and database time
include child work; do not sum them across an invocation tree. Callback counts,
bytes and attempts are additive. Request events report observed limit peaks with their effective
configuration revisions and name the highest peak-to-bound ratio in
`closestLimitId`. They are not metering storage.

The metering model records bound seconds, database time and calls; billing decides
what is priced. Binding history now records bound seconds through release or the
provider's observed stop time. Process reports record CPU seconds and peak RSS.
An action's database time includes its nested queries and mutations.

The promise: **A tier 2 patch's server code runs on Patchy's machines,
never on yours. It holds no login and no credential and has no path to the
internet: everything it does goes through Patchy, as you, while you have the
patch open. It reaches outside systems only through your company's integrations,
and every write is logged for your company's admins.**

The patch also has server-side code, and Patchy admits new work **while a viewer has the patch open**. Already-admitted work finishes after departure. The company task is released after thirty minutes with no connected tier 2 documents and no admitted work, including retries, nested calls and cleanup. The line to tier 3 is whether work must start when nobody has the patch open.

The server side is handler-shaped code Patchy runs, with a fixed layout `init` lays down — not an arbitrary app listening on a port. Bringing a whole app is a second runtime with a second set of limits, and is not promised.

Server-side calls use two identities. The **initiating viewer** is the person
whose live session admitted the invocation. The gateway chooses the **effective
principal** for every callback: the patch identity for its own tables and stores,
the viewer for shared resources and company integrations. Own resources inherit
admission; access to company resources is re-checked live. The patch identity is
its id, not its owner's account, so owner deactivation and reassignment do not
change its authority. Guest code cannot select a principal or receive a login,
database credential or object-store credential.

When a patch asks for data the viewer may not reach, the viewer is told plainly that this is their access, not the patch being broken.

The server runtime supports the release-tested `Intl` formatters (including exact
decimal-string number formatting), Web Crypto, `TextEncoder`, `TextDecoder`,
`structuredClone`, `URL`, `URLSearchParams`, `atob`, `btoa` and `BigInt`.
Bundles are single closed modules. Outbound fetch, socket and Node module access,
Node globals, `eval` and `new Function` are refused. Other workerd APIs are
incidental, not a supported contract; the exact list and engine pin live in
ADR-0012.

### Declaring and changing a tier

The tier is explicit in `patchy.config.ts`. Edit it and run `patchy refresh` before publishing a change. The CLI checks both graphs: `server/` requires tier 2, and script cannot claim tier 0. The server independently checks tier 0 against the safe-HTML policy and re-derives tier 2 descriptors from the stored server module. Dev and test instances admit tier 2; production requires fleet execution. Claiming a higher built tier than the code needs is fine, and tier 2 with zero handlers publishes with a warning. A tier 0 repo may provision tables and stores; resources do not make a tier.

To move from tier 1 to 2, set `tier: 2`, create `server/` handlers and refresh.
Refresh adds the exact `workerd` pin, generated `server.ts` and `patchy-server`
skill. The generated client is server-only; typechecking identifies direct
resource calls to move into handlers. A public patch needs `--share company`
on that publish.

To move from tier 2 to 1, set `tier: 1`, remove `server/` and refresh. Refresh
removes those tier 2 managed parts, the one tier-keyed exception to sticky
skills. Typechecking identifies `patchy.server.*` calls to rewrite. There is no
codemod or tier-change command, and refresh never rewrites application source.
Serving a tier 1 version by publish or rollback permits public sharing again.

A **version** has exactly one tier; the patch's tier is the tier of the version it serves. Changing tier means publishing a new version, not moving an existing one in place. Primitives belong to the patch, not its tier, so their data persists across the change. Rollback selects the older version's tier without rolling back cumulative provisioning or sharing flags.

The runtime loads the served tier beside the loaded version at admission.
While a patch serves tier 2, an older lower-tier document gets `me` only;
every other direct operation is `server_required`. The `served` frame makes
the shell show "Reload to keep saving". Rollback to tier 1 reopens tier 1
documents' direct operations. Rollback to the loaded version clears the notice.
A tier 2 client remains server-only after any rollback, with `me` and the route
bridge rather than name-based tables, files, shared resources, connections or
members. Handle redemption, staging and generated downloads belong to their
separate shell-capability tickets.

## Companies

A **company** is the tenant everything on Patchy Cloud hangs off. Every patch and user lives in exactly one company, and nothing inside crosses the company line except a patch someone chose to make public. A company is flat — no sub-tenants — and carries a globally unique **handle** alongside its display name. It owns its Postgres connections; billing, groups and company-wide usage accounting are not built yet.

A company comes to exist on **create-or-join**, after sign-in: a person without an invitation names a company, chooses its handle and becomes its first admin. The company and user are created together; a solo builder is a company of one. The handle is fixed once created, 3–32 lowercase letters, digits or hyphens, with no leading or trailing hyphen and reserved platform names refused. Self-serve billing — put in a card, set when it tops up — is the intended later path, not a step in today's signup.

### Users, admins, groups

A **user** is one individual with one account, in exactly one company. They sign in, and they hold expiring, rotatable tokens on the machines they build patches from — see [Identity and access](#identity-and-access).

An **admin** runs the company's invitations, roles, deactivation, reactivation and Postgres connections. Admins manage descriptions, sharing, served versions, retire, delete, restore and reassignment from the portal. Publish stays owner-only. Groups and group permissions remain future work.

Today `/company` lists users, roles, active/deactivated state and pending invites.
Admins manage invitations, roles, deactivation and reactivation there; members
read the same page without actions. The last active admin cannot be demoted or
deactivated. Reactivation restores sign-in to the same company and data, but
machine tokens revoked by deactivation remain revoked.

A **group** will be a named set of users an admin creates; a user can be in many. "Team", "department", "north-american-sales" are names companies give their groups, not concepts of their own. A group is purely a grant surface — access to patches and connections — never a container that owns anything.

### Ownership and deactivation

A patch belongs to a user. **Deactivation** ends that user's company access on the next request and revokes every machine token while keeping all data; a browser with a Clerk session sees the deactivated page and can still sign out. Reactivation restores access to the same company, but fresh machine tokens are required. Deactivation itself changes no patch's sharing or serving state.

Every patch is company-wide or public today, so a deactivated user's patches keep serving unless the admin retires them, marked **owner deactivated** in the portal and agent discovery. Nobody can publish to them until the owner is reactivated or an admin reassigns them.

The Deactivate and Reactivate links on `/company` lead to the portal's pick pages. Deactivation lists the user's live patches with static badges naming their live dependants, including their own. Retired and deleted patches are visible but cannot be selected. **Keep their patches live** deactivates at once; **Retire selected** and **Retire all** show a confirmation recomputed for the selection. A user with no live patches goes straight to confirmation. The confirmation lists every live dependant outside the selection, regardless of owner, and requires acknowledgement when anything breaks. Deactivation, token revocation and the selected ordinary retirements commit in one transaction or all roll back. The last-active-admin rule applies before both the pick and the submitted act.

Reactivation offers **Keep them retired**, **Restore selected** and **Restore all** for the user's retired patches, however they were retired. Its confirmation warns per patch when its current version reads sources that stay off; a source restored in the same selection counts as intact. Reactivation and the selected restores commit together. Fresh tokens are required, reassigned patches stay with their new owners, and deleted patches stay deleted. Bulk retire and restore exist only in these user flows; later cleanup is per patch from its card.

Personal-connection credentials and the takedown of owner-only patches wait for personal connections and narrower sharing. Deleting a user is a separate, later act: its flow will prompt the admin to reassign the user's patches, and what is not reassigned will go with the user.

### Integrations and connections

Patchy ships the **integration** — today Postgres — as a company-scoped capability. A **connection** is the live, credentialed instance an admin connects for their company. Patches declare connections, not an integration in the abstract, and never receive their credentials. Personal connections and group grants are future extensions of this model; the implemented connect flow and its limits are spelled out under [Integrations](#integrations).

Today admins manage Postgres at `/company/connections`, linked from `/company`;
members read its handles, descriptions, status and discovery/test timestamps.
Connections are company-wide, not per patch. Personal connections and group
grants remain future work.

### Addresses

Every patch has an address at `/<company>/<patch>`, for every tier and sharing scope. A numbered version opens at `/<company>/<patch>/~v/<n>`. A trailing route belongs to the patch at tier 1 and above and is ignored at tier 0; every segment starting with `~` belongs to Patchy. A company handle alone is not a page. The former `/d/*` routes are gone, not redirects; `d` remains a reserved company handle.

A patch's **name** is 3–32 lowercase letters, digits or hyphens, with no leading or trailing hyphen. `patches` and `connections` are reserved. A requested name must be free on create or rename; otherwise publishing returns `name_taken`. File creates without a name normalise the filename and append a suffix on collision. Updates preserve the name unless explicitly renamed. Renaming leaves a 308 redirect until another patch takes the old name. Retire and delete reserve every name until reclamation. The patch's identity remains its id.

Company sharing protects patch content, not address existence. A signed-out request for a retained company patch or an off patch gets the 401 login door; a missing, disabled or reclaimed patch gets 404. Someone probing names can therefore distinguish a retained address from an absent one. This follows the requirement that reclamation leaves no row or name and answers 404 for everyone: a reclaimed address cannot be distinguished from one that never existed.

Only the current public version is public and caches for at most a minute at both its address and its numbered version URL; older versions stay behind the company door. `/~content/<patchId>/<versionId>` is an internal, non-redirecting **content URL**, never the link to share: it serves that version's bytes with that version's tier and content security policy, the same door and sharing-based caching as the address. Tier 0 keeps its script-free `srcdoc` frame with `sandbox=""`; tier 1 frames that content URL with a document nonce and `sandbox="allow-scripts allow-modals"`. Historical pages always render with their own version's tier.

### The operator

The **operator** — Patchy, running the platform — is not a company role and holds no company powers. Its future powers are platform-shaped: company lifecycle, quotas, and moderation — taking a patch off its address, never acting inside the company. None of those surfaces is built; disabling a patch is a SQL statement by hand until that effort is designed. Support means being invited like anyone else; a customer-support role is not designed. **Suspension** will stop a whole company's serving and publishing while keeping its data, including when it runs out of credits and cannot top up. Company deletion by its admin, its recovery window and the eventual release of the handle are future work too.

The operator will use its own login and dashboards, never a company in the product and never the `patchy` CLI.

## Identity and access

Log in once, and every patch you have access to opens when someone sends you its link. That is the whole promise, and everything below serves it. Patchy does not run its own identity system: **Clerk** holds who a person is, their sign-in and their browser session; Patchy holds the company, what each user may reach, and which machines may act as them.

### Signing in

A person signs in with **Google**, **Microsoft**, or a **code sent to their email**, through Clerk's Account Portal. There are no passwords. One Clerk session opens the company's patches and first-party pages, including the portal. A company link opened without a session shows the login door, whose Sign in link returns the person to that patch. A public patch needs no sign-in. Higher-runtime patches will use the same door.

Company **SSO** is future work: Patchy will enable it for a company, and its admin will set up SAML or OIDC against their IdP themselves — Patchy never handles the IdP credentials. SSO will be enforced on the company's verified domain, so everyone at `acme.com` signs in through Acme's IdP and nothing else. SSO is intended as a paid feature; the price is a pricing question, not a design one.

### Getting into a company

There is no Patchy user without a company, but a Clerk session may exist before that membership does. A sign-in with no company behind it lands on **create-or-join**, which names the email it checked: choose **Join** on one of the live invitations for that email, or, without any invitations, create a company with a name and handle. A person on the wrong account can use **Not you? Sign out** rather than accidentally create a company for it.

**Invite** is the default way in: an admin invites an email address with a role, the person signs in, checks the company and chooses **Join**. Joining consumes that invitation and creates the user together, so a user always belongs to exactly one company.

Today Clerk sends the invitation email and Patchy owns the invitation, which
expires after Clerk's default 30 days. The person signs in and chooses **Join**
on create-or-join while the invitation is unexpired; several companies may invite
one address, with at most one pending invite per company, including expired ones.
Expired invitations stay visible on `/company` for admins to revoke or resend;
resend replaces the emailed invitation and renews the 30-day expiry. Failed email
delivery keeps the invitation and tells the admin to resend.

A user is in **exactly one company**, and the rule is hard. An invitation to an email already belonging to any user is refused, and a person who joins one company cannot then consume another company's invitation. Leaving or deleting a company is not offered today.

Later, an admin may verify the company's **domain** — proven by email, never a consumer domain like `gmail.com`, and one domain belonging to one company — after which a work identity on that domain will join it automatically. Invitations will still admit contractors from other domains. Someone with a company of one will need to delete it or add someone else and leave before joining another; its patches will not move with them. Those exits, domain verification and full billing onboarding remain future work. Company merging and multiple memberships for agencies or consultants are not designed.

### Roles

Two roles, **member** and **admin**. Every company member may build and publish. Admins also manage invitations, roles, deactivation, reactivation and company connections, and see owner controls on company patch cards. Groups, domains and SSO remain future work. A company always has at least one active admin, who can neither be demoted nor deactivated. There is no separate builder or viewer role.

### Access to a patch

Sharing decides who may open a live patch. The owner may publish, change sharing, describe, retire, delete, restore or roll back. Same-company admins can perform every act except publish through the portal, including reassignment to an active member. Admin management uses the portal, never machine tokens. Publish stays owner-only for accountability, not protection against admins, who can reassign a patch before publishing. These powers are separate from data access: every admitted company viewer may read and write the patch's defined tables and stores; public versions grant no company-data access. Named-user and group sharing remain future work.

**Admins see every company patch.** The portal shows their management controls and a Reassign confirmation page for live, retired and deleted patches. Reassignment is repeatable and preserves every version's publisher attribution. The company owns what is built in it; future owner-only sharing is not a secret from the company.

Across the company line there is nothing but **public**: a patch is inside the company or it is anyone-with-the-link. Guests — a named outsider with a login — are not a thing Patchy does yet.

Today a published patch is either company-scoped or explicitly public. A public patch's current version opens without a session; older versions and company patches have three outcomes: an active colleague gets the page; a signed-out reader gets a 401 login door with one **Sign in** link rather than a redirect; a signed-in reader from another company gets the same 404 as a missing link, confirming nothing. A signed-in person without a company goes through create-or-join with the patch as the return destination; a deactivated user sees a 403 deactivated page instead of a sign-in loop. The door admits browser sessions, never machine tokens. When owner-only sharing is built, a colleague outside that narrower scope will see "you don't have access to this patch", who owns it, and **request access**; that state is not offered today.

### Machines and tokens

A person's agent works on a machine — their laptop, a server, later a sandbox Patchy runs — and that machine needs to act as them. `patchy login` prints a URL and a short code for the agent to relay; it does not open a browser. The person opens the URL in their own signed-in browser, **checks that the displayed code is the one on their terminal**, and chooses a machine name — "allison's macbook" — before confirming, or denies a login they did not start. The code lasts ten minutes and is confirmed, never typed into a page. Confirmation authorizes the login; the terminal's poll mints the **machine token** once and saves it in the CLI's state dir, outside the project tree by default. An abandoned confirmation mints nothing. Device login is the only machine-login route today; a same-machine browser shortcut may come later.

A machine token is **the user's**, shared by every agent using that machine's saved login — Claude Code now and Codex an hour later use the same credential and name. Re-authenticating offers the old name and replaces the previous key only when the completing poll mints for the same user; until then the old key keeps working. The token is Patchy's own, so publishing does not call Clerk. It expires **90 days** after minting or after **30 idle days**, whichever comes first. Every version records its creating machine token, so the responsible machine remains traceable after revocation; agents sharing that token are not separate identities.

**Your machines** lists a user's live tokens by name, creation, last use and expiry, revokes one or all, and signs the browser out. Deactivating a user revokes every token and ends their company access on the next request, including runtime calls from an open tier 1 patch. `PATCHY_API_TOKEN` already accepts a user-owned token for non-interactive CLI use; a dedicated CI provisioning flow is not offered. Your machines has no create or rename action. There is no company-owned or non-human token kind, so everything published has a human owner. Company-owned tokens for CI that is nobody's come back when someone needs them.

**First publish is login, then publish.** Machine logout forgets its saved login even if revocation cannot complete; it does not sign the browser out. Browser sign-out remains available before company membership and after deactivation. Commands, credential precedence and output are defined in [the CLI contract](./adr/ADR-0004-cli-contract-for-agents.md).

### Who's who

- **Person** — the human. Never an authorization key: names and emails change, the account does not.
- **User** — one person's one account, in exactly one company. The subject of every permission.
- **Agent** — software acting for a user, with that user's machine token. Never a who, always a how; it is indistinguishable from its user except by the token's machine name.
- **Member**, **admin** — the two roles a user has in the company.
- **Owner**: the user a patch belongs to and the only user who publishes its code. Same-company admin actors may perform the other management acts; admitted viewers may write its data.
- **Viewer** — the active signed-in user, company and role that Auth establishes for a first-party page or a company patch's door, without a machine credential. Tier 1 patch code acts within that viewer's permissions. Tier 2 retains the initiating viewer and rechecks their live session and membership for company resources; its own-resource callbacks act as the patch. Public documents have no company runtime authority, even for a signed-in reader.
- **Operator** — Patchy, running the platform. Platform powers only, never a role inside a company, and never the word for whoever drives the CLI — that is the agent, the CLI's primary **driver**.

## Primitives

A patch's **tables** live in its own namespace inside one Postgres database per
company. The first publish introducing tables or file stores provisions that database lazily;
a primitive-free patch does not require one. The manifest defines what one
version uses, while the company's cumulative **inventory** records everything
provisioned for the patch. The owner can fetch that metadata and its schema
revision from `GET /api/patches/:patchId/inventory`; it contains no row data.

Every table and file store carries a required, nonblank **description** as the first
argument of `table(description, columns, options?)` and `files(description)`. It says what
one row or object is, its identifying keys and units. The manifest and cumulative inventory
include it. A publish that defines the primitive replaces its description; omission and rollback
preserve it. A description-only change does not advance the schema revision. A table and file store
cannot have the same name, even after one is omitted; reusing it is `not_additive`.
`patchy list <patch>` exposes the cumulative inventory to agents. On refresh, a new dev start and publish, the CLI reminds agents to
re-check unchanged descriptions when their definitions change.

This **company database** is Patchy's storage for the company's patch resources,
not a Postgres connection to an outside source. Platform records — users, patches,
versions, connections and the runtime log — remain in the platform database.
A durable placement claim makes lazy database creation resumable; bounded direct
pools lease a company connection per operation and refuse exhaustion as `busy`.
Tables occupy stable patch-id namespaces, independent of patch names or versions.
There is no raw SQL surface against this database. Moving a company by dump and
restore with a placement-version change is designed for, not an available tool.

### Tables and rows

Columns have kinds `text`, `integer`, `number`, `boolean`, `timestamp`, `json`
and `ref`, with optional or defaulted values. Defaulted does not mean nullable.
Every row has a server-generated UUIDv7 `id` and database-maintained `createdAt`
and `updatedAt`; patch code cannot supply those fields. Refs are indexed row
identifiers without foreign keys: deleting a target leaves a normal dangling ref.
Names are camelCase and preserve their case.

The operations are `get`, `getMany`, `list`, `insert`, `insertMany`, `update`
and `delete`. A missing `get` is null; `getMany` preserves input order and
returns null for each missing id. `list` uses a named index's leading equality
columns and at most one trailing range, with the row id breaking ties. Its
keyset cursor survives inserts ahead of it but is not a snapshot. The default
index orders by creation time and id, newest first. Pages default to 100 rows,
at most 1,000. Rows are bounded to 1 MiB; batches to 1,000 items and 8 MiB,
and list/getMany results to 8 MiB. Reads bound PostgreSQL's JSON transport
representation before decoding, then check the final wire representation;
transport whitespace can make that first check more conservative.
PostgreSQL's own B-tree limit governs indexed writes: native oversized-key
failures return `too_large`. Publishing a non-unique index adds no separate
size CHECK constraint, so an older bundle may still write wide values that
PostgreSQL can index, including compressible text.

On insert, omitted optional columns become null and omitted defaulted columns
take their defaults. Explicit null on a required or defaulted column is refused.
On update, omitted fields stay unchanged; null clears an optional field.
Unknown and system fields are refused. Updating a missing id is `row_not_found`;
deleting it succeeds idempotently. `insertMany` is all-or-nothing. Writes are
last-write-wins, with no cross-table transaction or mutation replay key.

### Additive publishing

Publish may add tables, file stores, optional or defaulted columns, and non-unique indexes.
New constant defaults fill existing rows; `now` fills existing rows at publish
time and future inserts at their own time. Unique indexes are allowed only
when their table is created: their null and case behavior is Postgres's.
Ordinary index creation blocks writers while it runs.
Preflight conservatively refuses new indexes whose existing uncompressed
key tuples exceed 2,000 bytes, and added columns whose defaults would expand
existing rows beyond the row limit. These refusals are `not_additive`, before
storing bytes. Provisioning locks affected tables and repeats those checks
before any DDL; the preflight estimate is not a runtime write limit.

Retyping, changing optionality, changing or removing defaults, adding a required
column to an existing table, changing an existing index, and adding uniqueness
to an existing table are refused as `not_additive`. Each refusal names the
object, change and fix. The complete diff is checked before storing bytes and
again under the patch lock before any DDL. Publishes serialize as a whole:
platform patch-row lock, company transaction with DDL and inventory, then the
version and active pointer. A failed platform commit can leave compatible
resources behind; retry uses that inventory rather than undoing the resources.

Nothing is physically dropped. Omitted tables, stores, optional/defaulted columns
and indexes remain with their data and are reported as **unused**. A required
column cannot be omitted from a table still defined by the manifest. An omitted
default keeps filling new rows and an omitted unique index keeps enforcing.
A rename is an addition beside an unused old table, reported as:
“`notes` is no longer defined; its data is kept and this version cannot reach it.”
An older open version that still defines `notes` keeps reaching it.

An empty new patch skips company-database access entirely. Updating an existing
patch checks for cumulative inventory even when its current version predates
tables. An unavailable company database is not evidence of empty inventory:
that update refuses rather than risking a file-mode overwrite.

The inventory's schema revision advances when table definitions change structurally,
sharing changes or a store is added, not on description edits, every version or file
write. The inventory's `shared` flag changes only when a publish defines that
table or store with a different flag. Omission and rollback preserve sharing.

### Who reads and writes

An admitted company viewer reads and writes every row and file defined by the
loaded version of the owning patch, acting as themselves, not the patch owner.
There are no per-row, per-user or write scopes; UI filtering is not access control.
Every mutation is attributed in the runtime log before execution; table and file
reads are not logged. A public version grants no company-data access. Older
manifests remain usable after additive changes, including inserts omitting newer
columns. Admins own the audit view, not extra powers inside patch code; today's
log reader is the recent-calls list per connection, not a general mutation browser.

### Shared tables

A table defined with `shared: true` can be declared by another patch in the same
company. `uses` is keyed by local alias; its shared-table entry carries
`{ kind: "sharedTable", patchId, table, id, revision }`. The resolved id is
`<patchId>/<table>` and `revision` stamps the source's cumulative schema revision.
`t.ref("<patchId>/<table>")` carries the resolved source identity as a typed ref;
the shared table must also be declared. Refs do not grant access or enforce a
foreign key.

Publishing resolves the source's inventory, not its active manifest. A missing,
unopenable or unshared source is `patch_not_openable`; an older revision stamp
warns rather than refuses. Patch discovery, client generation and local fixtures consume
that inventory's tables, columns and indexes, never the source's active manifest
or its company rows.

`shared.get`, `shared.getMany` and `shared.list` take the declaration's alias and
provide the owned-table read surface, using the source's indexes and bounds.
There are no shared writes. On every call the viewer must still be able to open
the source and its inventory flag must remain shared; otherwise the whole call
is `access_denied`, even for an empty id list. While authorized, `getMany`
preserves input order, duplicates and nulls for dangling ids.

Omitting a shared table from a source version keeps its identity, definition
and sharing. Unsharing requires defining it with `shared: false`; publish
lists distinct live declaring patches across retained versions and refuses
unless forced. Their next read is denied; their own rows are untouched.
Rolling back the source never changes sharing. Deleting the source and creating
a new patch under its old name never rebinds existing consumers.

To extend shared rows, define an owned table keyed by their ids. Read one side,
fetch the other with `getMany`, then merge explicitly in patch code. A missing
row is null, not a hidden join failure; revoked source access fails the whole
read, not a partial result. There is no server-side join or cross-patch write.

### Files

A **file store** is a named definition in the manifest, provisioned by the same
additive diff as tables. It is not a bucket or a published version. Omission
reports an unused store without deleting its files; an older loaded version
that defines it keeps reaching the same files.

`put` replaces one name, `get` returns its bytes, `list` returns pages of
`{ name, size, contentType, updatedAt }` with a cursor, and `delete` is idempotent.
Names are 1–512 UTF-8 bytes, with `/`-separated nonempty segments and no `.` or
`..` segments. Files are bounded to 20 MiB (`too_large`); list pages default
to 100, at most 1,000, in name order with a literal prefix filter and a keyset
cursor. Metadata pages share the 8 MiB runtime result bound, including the cursor.
Each put writes a fresh immutable object before changing the file-index
pointer; a failed byte write preserves the previous file. Concurrent replacements
and deletion serialize per patch/store/name, so an index row never points at a
partially replaced object. Blob transfers do not hold database locks or company
leases; unrelated names remain independent. Deletion removes the pointer, not the object; unreferenced objects are
swept after a day. Rollback and version cleanup never own stored files.

Bytes live under `files/<patchId>/<store>/<objectId>`, never a version key.
Nothing under that storage prefix is served as a public URL. Runtime retrieval
is authorized live and `no-store`, with the loaded version's store definition
and the viewer's current company access. Raw GET requires same-origin fetch
metadata; PUT requires the exact Origin; both require wire and principal
headers. HTML and SVG stay bytes, never a navigable page. File mutations log
the store and name, not their body; reads are not logged. Frame-local blob URLs
and ownership-transferring ArrayBuffers are available through the browser broker.

On tier 2, every `ctx.files.<store>.list`, `ctx.shared.<alias>.list` and
`stat(name)` metadata entry includes an **authorised file handle**. The host
mints a deterministic 57-character token bound to the viewer, company, consuming
patch, loaded version, source store and exact object. It contains no filename
or clock. Handles returned through `ctx.run` keep the same binding, and their
bytes count against metadata-page and handler-result limits. `t.fileHandle()`
is a result descriptor, not an argument or table column.

The page uses `patchy.files.url(handle)` for a frame-local blob URL and
`patchy.files.download(handle, filename?)` for a shell download, defaulting to
the last segment of the stored file's name, as on tier 1. An explicit filename
must satisfy the file-name rules. `useFileUrl(handle)` from `patchy/preact` returns
`{ url, error }`, removes a stale image on failure and releases its URL on
unmount. Tier 1 keeps its name-based store operations.

A handle authenticates nobody: redemption requires the viewer's signed-in
shell. Patchy checks the MAC, then whether the name still points at the exact
object, then live source access. Replacement or deletion returns `not_found`;
lost access or unsharing returns `access_denied`. If replacement and access loss
coincide, `not_found` wins. Every redemption rechecks authority, including
repeated image requests; redemptions are reads and are not logged.

**The patch's filter** is what its handlers return, not everything they enumerate.
Filtering by viewer is the patch's code. A handle freezes that selection until
the query reruns; redemption does not rerun the filter. To cut off a file when
a record narrows to private, is handed over or is deleted, re-put or delete it.
Handles already selected keep redeeming until then, subject to Patchy's live
access checks. Publishing does not invalidate an eligible open version's
handles. Bytes already displayed or downloaded cannot be recalled.

### Shared file stores

`files(description, { shared: true })` shares a store whole. This publishes read
access to every file in the store, including later additions. There is no prefix
sharing and no shared write operation.

`patchy add shared-store <patchId>/<store> --as <alias>` declares the source.
The manifest records `{ kind: "sharedStore", patchId, store, id, revision }`;
the id is `<patchId>/<store>` and the revision stamps the source inventory.
An older stamp warns at publish, as for shared tables.

Tier 1 uses `patchy.shared.<alias>.list/get/url/download` by file name through
the broker. Tier 2 uses `ctx.shared.<alias>.list/stat` in queries and actions,
and `get` for bytes in actions. A tier 1 tool can read a tier 2 source's store.
The served-tier gate applies to the consumer: an older tier 1 document of a
patch now serving tier 2 gets `server_required`.

Every read, URL request and download rechecks live that the viewer can open the
source and the cumulative store remains shared, otherwise `access_denied`.
Omitting a store and rolling back either patch never change sharing.
Unshare, retire and delete list live dependants and require `force` to break
them. Unsharing advances the store's resource revision and the source's lifecycle
revision. Reshare or restore recovers consumers without changing declarations.
A replacement patch under the old name never takes over the source identity.

## Integrations

Company Postgres connections, discovery, publish binding and constrained runtime
reads are built, with generated relation clients and local fixtures. Other
integrations and personal connections remain planned.

An **integration** is a capability Patchy builds and maintains, the same for every company. Postgres is the first; Salesforce and Gmail are examples of future integrations, not offered connections. A **connection** is the live, credentialed instance of an integration. That distinction was drawn with [Companies](#integrations-and-connections); this section is the layer itself — how a connection comes to exist, how a patch declares and uses one, and what patch code is actually handed.

Integrations sit inside the **primitive** model. **Patch-scoped** primitives — the patch's own tables and file stores — are defined in config and provisioned with the patch. **Company-scoped** primitives — connections and the database those tables live in — are shared infrastructure, never owned by a consuming patch. A table remains patch-owned wherever it physically lives. Connections and shared tables are declared dependencies; omitting a definition does not delete its provisioned resources.

### Company and personal connections

Today Postgres supports **company** connections only: an admin connects a source,
and every active company member may use it through a company-runtime patch that
declares it. There is no per-patch grant. “As the viewer” means Patchy checks
company access and records the user; the source sees the shared role from the
connection string, not a separate database identity for each person.

A company may hold several connections of that integration, each with an
immutable **handle** and an editable description: `postgres/warehouse`,
`postgres/reporting`. Handles are unique per integration per company.

The broader model allows group grants and **personal** connections, but neither
is built. A personal connection would be made by its user, need no admin
enablement, and lose its credential when that account ends; stored patch data
would remain company data. Patchy fixes an integration's supported modes when it
builds it. A future integration supporting both modes would expose distinct
declarations, and a personal connection would need no handle because a user
would hold at most one per integration.

### Connecting Postgres

An admin pastes a connection string in the browser-only connect form, with an
immutable handle (3–32 lowercase letters, digits or hyphens, no leading/trailing
hyphen) and a description. The description explains the source to builders;
it never grants or restricts access. No CLI path accepts the secret.

Only host, port, database, user, password and sslmode are accepted. Patchy requires
TLS with certificate and hostname verification, refuses superusers and roles with
CREATEDB or CREATEROLE, and rejects private, loopback and metadata addresses after
DNS resolution. Every source reconnect resolves and checks again: **the database
must be reachable from the internet over TLS**.

Before connecting, the form states: **Every member can query this database through
any patch that declares it, as the role you supply.** The read-only promise is
**constrained reads through the role you supplied**, not harmless execution of
arbitrary SQL: SELECT can invoke functions with side effects or extensions.
Postgres calls use one extended-protocol statement inside `BEGIN READ ONLY`,
with a 10-second statement timeout and a 15-second service deadline including
queue wait. Each transaction is rolled back and the session reset before reuse;
a timeout destroys the connection. Collection refuses more than 1,000 rows or
8 MiB, never returning a silently partial report. Pools allow four backends per
connection, 64 per process and 60 seconds idle. Rotation, retargeting and
disconnect take effect on the next checkout; in-flight calls may finish within
their deadline.

Connect tests the role and discovers metadata before saving credentials encrypted
under the operator's keyring. Stored secrets never appear on a page or in generated
metadata. Admins can test, rotate credentials on the same endpoint, retarget to a
new host or database with discovery, refresh schema, disconnect, reconnect and edit
the description. Rotation and retargeting preserve identity; disconnect keeps data.
A connection may be deleted only when no stored patch version declares it.

### Discovery and binding

Discovery reads metadata, never company rows: tables (including foreign tables)
and views, column types and nullability, primary and foreign keys, enum labels
and named exclusions, including columns the supplied role cannot select.
Snapshots are bounded to 500 relations with 200 columns each and 8 MiB total.
At most 1,000 enums with 1,000 labels each are retained; columns that exceed those
limits receive named exclusions rather than truncated enum labels. More than
10,000 exclusions refuses discovery. Each successful discovery stores a whole
validated immutable snapshot with a new server-assigned revision;
a failure leaves the previous snapshot current. Snapshots are never deleted in v1.
Discovery is attributed to the admin in the runtime log. Admins see recent calls
on the connection's detail page: identity, patch/version, operation, duration,
outcome, row count and correlation id. Query calls retain up to 8 KiB of SQL text,
never parameters; ordinary relation calls retain no SQL. Failed and denied
attempts with a trusted session and loaded version are recorded too. Unauthenticated
or unresolvable requests cannot be attributed to a company user.

A Postgres declaration carries `{ kind: "postgres", handle, id, revision }`.
Publish verifies that the handle and id name the same connected company
connection (`connection_not_connected`) and that the generated revision equals
the current snapshot (`stale_generated`: “the warehouse schema changed; run
`patchy refresh`”). Checks run before bytes and again while the version is recorded.
Refresh never rewrites an existing version's recorded snapshot; reusing a deleted
handle cannot silently rebind an old declaration.

### Declaring, granting, opening

A patch declares each connection under a local `uses` alias in its config.
`patchy list connections` shows the company's connections and their state; `patchy add` inserts the
declaration and brings its generated client, context, fixture stub and skill.
Publish resolves the handle to a stable connection id and metadata revision.
Neither the alias, the handle nor the declaration is a permission.

Every company patch that declares a connected source can use it as its admitted
viewer without a separate per-patch consent step. A public runtime cannot use
it. Disconnecting the source makes subsequent calls fail `access_denied`, with
the shell's first-party notice; reconnecting retains the connection identity.
The current connect flow is admin-only on `/company/connections`, not a door
that walks ordinary viewers into creating credentials.

**Admin integration grants to the patch identity are deferred.** Tier 2 adds no
connection entitlement: company integrations always re-check the initiating
viewer. An admin cannot grant a patch independent connection access in this release.

Personal connections would add a connect door before opening a patch: a viewer
without the declared personal connection would connect it and return to the
patch. Using that personal connection without per-patch consent is the intended
model, not a flow shipped by today's Postgres integration.

### What patch code sees

The SDK supplies a **typed client**, never raw HTTP access to the source. Patchy
builds and maintains that surface. Credentials stay in Patchy's encrypted store
and are applied server-side; production integration calls are logged with their
patch, connection and acting user.

For a Postgres declaration aliased as `sales`, generation exposes
`patchy.connections.sales.customers` for a public relation and
`patchy.connections.sales.reporting.profit` for another schema. Source names are
preserved, using brackets when needed. `query` and namespace collisions are
excluded and named. The context file names the handle, description, revision,
relations, keys and exclusions. This client is a projection of the source, not
every source feature.

Every relation supports `list({ eq, range, orderBy, select, limit, cursor })`.
Comparable columns accept equality, one column may have a range, and one order
column is followed by the primary key as a tie breaker. SQL always names and
quotes selected columns, never `SELECT *`. Keyed relations use cursors bound to
the connection, relation, revision, filters and order; unkeyed relations use
offsets bounded at 10,000, then `offset_exhausted`. Pages default to 100, at most
1,000. Only a usable primary key adds `get({ pk })` and `getMany([...])`; missing
rows are null, with input order preserved. View columns are nullable.

One type mapping determines generation, SQL projection and validation. Small
integers and finite floats become numbers; int8 and numeric become strings,
never rounded doubles. Text-like values, UUIDs and enums become strings.
Timestamptz is UTC ISO at full precision, date is `YYYY-MM-DD`, and timestamp
without time zone is `YYYY-MM-DDTHH:MM:SS.ffffff` without an offset. JSON and
arrays are unknown, though int8 and numeric array elements stay strings; domains
resolve to their base types. Unsupported columns and locally unrepresentable
relations are excluded and named.

`query(sql, params, shape)` is the explicit **escape hatch**. Shapes use the
table column language, without refs or defaults: missing columns, duplicate
result names and required nulls fail `shape_mismatch`; extra columns are dropped.
Integer shapes require safe integers; cast int8 and numeric explicitly rather
than relying on rounding. Source SQL errors include their message, SQLSTATE and
position in `invalid_query`. Generated method error unions carry typed details,
and `isPatchyError(error, code)` narrows them; TypeScript cannot promise exhaustive
throws. All reads project through the revision the loaded version names, even
after an admin refreshes discovery. Live credentials and access are checked
separately; a dropped or incompatible column fails the old call rather than
silently changing its contract.

There is no bring-your-own source: no generic REST escape hatch and no "connect an MCP server". A company that needs an integration Patchy has not shipped requests it, and Patchy builds it. Admitting third-party integration authors would be a separate later decision; today's `patchy list connections --all` discovers the capabilities Patchy already offers.

### Development

Patch development uses local fixtures, not live source rows or production credentials.
The **dev binding** supplies the same Postgres execution dependency without
loading the keyring or runtime log. One PGlite database per connection under
`.patchy/dev/` is shared by its aliases, with source-native types: numeric filters
and ordering remain numeric, not string comparisons. Numeric precision and scale,
character length and timestamp precision carry over; a domain's own modifiers do not.

Agent-authored rows come from `fixtures/postgres-<handle>.sql`, loaded on the
privileged initialization path and validated. A missing fixture names the file
to write. The generated stub lists tables and columns; views are synthetic tables
whose rows do not recompute. A relation the local source cannot represent is
excluded from both surfaces and named. Raw SQL using a feature PGlite lacks
fails locally with its reason. Fixtures establish operation parity, not production
data, privilege or volume guarantees. `patchy dev` composes that binding with the
same runtime dispatcher and generated client. Shared-table declarations load
`fixtures/shared-<alias>.sql` into a local copy of the source's generated inventory
definition. Every declared fixture is required; generation never silently
replaces a missing file during a dev start.

The local environment runs as the machine token's user over recreated company
resources, even when the deployed patch is public; it is not an authenticated
company-data mode for the public patch. PGlite has one exclusive connection:
fixtures exercise the real operations but cannot reproduce multi-session lock
waits, lost updates or publish-versus-writer races. Those are exercised separately
against real Postgres in CI, not promised by the local dev loop.

### The edges

A tier 2 invocation acts as the patch for its own tables and files, and as the initiating viewer for shared tables, shared stores, company connections and members. The latter require live viewer reauthorization; patch identity does not grant shared-connection access. Patch-owned shared tables and stores provide read-only access across declaring patches; company-owned tables and broader composition remain undesigned.
