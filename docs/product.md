# Patchy Cloud

The product, written down where agents read it. The [foundation map](https://github.com/allisonmahmood/patchy-cloud/issues/5), [auth map](https://github.com/allisonmahmood/patchy-cloud/issues/112) and [SDK map](https://github.com/allisonmahmood/patchy-cloud/issues/164) record the decisions; the glossaries in each `CONTEXT.md` carry the words, and this file carries the shape.

**Built today:** tier 0 static HTML pages and tier 1 sandboxed browser tools at named company addresses. Static pages publish from an HTML file or a repo; tier 1 tools publish from a repo. Repos have code-first config, a generated typed client, release-bound project skills and a local PGlite dev loop with fixtures. Publish is replay-safe and provisions patch-owned tables and file stores additively into a database per company. Tier 1 reaches those resources, read-only shared tables and company Postgres connections through the shell broker as the viewer, with mutations and integration calls logged. Postgres includes browser-only connection administration, immutable schema snapshots and generated relation clients. Clerk sign-in, create-or-join, company administration, user ownership, company/public sharing and machine login, logout and revocation are built. Hosted runtimes and patch identity, the portal, narrower sharing, other integrations, billing and the remaining company lifecycle are not.

## Patches

A **patch** is the unit of what people build and deploy on Patchy Cloud — anything from a static page to a full CRM. A tier 0 page and a CRM are both patches for the same reason: each is one built thing in a company's cloud, stored as one, permissioned as one, provisioned as one, at one address, at one runtime tier. What differs between them is where their code needs to run — never what kind of thing they are.

### What a patch is made of

A patch is a **file tree**. A **patch repo** is its local working copy, initialized by `patchy init` at tier 0 or tier 1. It contains application source and the single-file build, `patchy.config.ts`, `patchy.json`, the pinned `patchy` package, generated client and context, project skills and fixtures. `patchy.config.ts` holds the name and explicit tier, **defines** the tables and file stores the patch owns, and **declares** the connections and shared tables it uses. The CLI executes that config locally into a **manifest**; the server validates the manifest, never executable config.

`patchy.json` records the instance and an optional patch id, never the builder's credentials. One repo is the working copy of exactly one patch: the first publish without an id creates the patch and writes its id back; later publishes update it. Cloning the repo preserves that target, but only its owner may publish to it. A single HTML file is the simpler tier 0 route, with no repo; its CLI cache remembers the published patch. A file-born patch can be adopted by putting its id in a repo's `patchy.json`.

Each version has exactly one tier. The CLI checks the tree and bundle; the server checks the manifest and bundle. Tier is about code, not data: a tier 0 repo may define tables and stores or declare dependencies even though its static page cannot call them. Tables and stores are provisioned with the patch; a declared connection must already be connected and a shared table must already be available (see [Primitives](#primitives) and [Integrations](#integrations)).

### Who makes one, and how it gets in

A person, or an agent acting for them, publishes through the `patchy` CLI. The SDK and local build loop are what `init` puts in the repo today. A hosted AI builder remains a later route: an agent with the same skills and SDK, working on a sandboxed computer Patchy runs instead of the person's own machine, and producing the same unit.

Ownership: a patch belongs to a **user** in a company. The user holds a machine token per device, every token acts for that user, and replacing a token never changes who owns their patches.

### Versions and publishing

**Publish** is the act; each new publish is an immutable **version**, and the patch serves the version its pointer names. There is no working copy in the cloud and no unpublished patch — the working copy is local, and the act that creates a patch is the act that makes it live. `patchy publish <file>` synthesises a tier 0 **manifest** and sends one HTML **bundle**. Each version records its tier, release, manifest version, server-stamped wire version and schema revision. The publish API accepts tier 0 and tier 1 manifests with table and file-store definitions, shared-table declarations and resolved Postgres connections. Tier 0 obeys the safe-HTML policy; tier 1 bundles are stored raw and served in the sandbox. Tiers 2 and above remain refused. File-mode publishing onto a patch with cumulative inventory is refused with `has_primitives`; that patch must be published from its repo. Moving the pointer back through rollback is future work.

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

`patchy/config` defines owned tables and file stores and declares shared tables
and Postgres connections. Row, insert and update types are inferred from the
config; execution happens in a local child process, producing the existing
manifest rather than sending executable config to the server. The browser client
uses the broker's document-bound port and one `PatchyError`; lost replies never
cause a mutation replay. Repo generation supplies this client surface and the
same shell provides its broker locally and in the cloud. Initialization alone
does not publish a patch.

### Building a patch

`patchy init [dir] --purpose <text>` starts a patch repo, defaulting to tier 1
(`--tier 0` is available). It authenticates first, names the instance and identity,
and lays down config, application source, the single-file build, typechecking,
generated client and context, project skills and fixtures. It installs the pinned
package, so an agent starts with `pnpm patchy --help` and `pnpm typecheck`, not
another setup or installation ritual. A second initialization refuses the same
repo. A company without connections gets the core skills and empty declarations.

`patchy.config.ts` defines what the patch owns and declares what it uses.
`patchy.json` records the instance and optional patch id, never personal credentials.
Write-once `AGENTS.md` records purpose, layout, skill paths, “test with `patchy dev`”
and the generated-index pointer; `CLAUDE.md` imports it. The local dev runtime
uses real handlers over local data, never a production-data shortcut.

`patchy dev` checks the pin, CLI and runtime against the instance release, then
authenticates a new session as the machine token's user. It refreshes declarations
and pulls the published inventory when the repo has an id. It provisions the same
table/store definitions over PGlite and serves the production shell, sandbox,
CSP and broker. Vite builds the same single-file artifact as publish; a completed
build replaces the bundle atomically and reloads the whole shell at its current
route. Config and fixture changes take effect on the next stop/start.

The daemon is detached and idempotent, returning one local page URL only when
healthy, with its log path and stop command. `dev status`, `stop`, `logs` and
`reset` also accept `--json`; `--foreground` stays attached with logs.
State lives under `.patchy/dev/`, scoped to repo and instance; process identity
includes birth time, so a stale PID cannot stop a different process.
Reset stops and wipes disposable local state without changing published resources;
the next start fetches the published inventory again.
Before the first publish every schema change recreates local data. Afterwards,
the published inventory determines additive changes and refusals, not the last
local config; compatible additions preserve rows. Dev calls are not logged,
and neither the connection keyring nor the runtime log store is loaded.

From the repo root, `patchy publish` recovers any saved attempt first. For a new
attempt it checks the release, executes config, compares generated declaration
identities and revision stamps, typechecks, builds one self-contained HTML bundle
and checks the evident tier. Stale declarations require `patchy refresh` before
building; a bundle over 10 MiB names its largest contributors. `server/` is tier 2
and refused; scripts require at least tier 1. File mode is never a build fallback.
Tier 0 and tier 1 repos can define tables and stores and declare shared tables
and Postgres connections.

The **publish key** and complete request are saved under `.patchy/publish/` before
sending. A create writes its returned id to `patchy.json` before clearing the
attempt; lost replies and failed id writes recover that same create, before
checking today's release or changed source. Success reports the address, tier,
version, **provisioned** resources and **unused definitions** in text and JSON.
An optional column is additive; a rename provisions a new table and reports the
old one unused, preserving its data. A retype names the object, change and fix
before any DDL. `share` and `delete` without a target use the repo id. A deleted
patch refuses updates; removing `patch` from `patchy.json` explicitly starts a new one.

The **catalog** shows connected company connections and shared tables the caller
can open, with copy-ready `add` and `uses` lines. `--all` includes offered
integrations and their state. It grants no authority. `patchy add postgres/<handle>`
or `patchy add shared-table <patchId>/<table>` adds one aliased declaration by
TypeScript AST and generates the client, context, missing fixture stub and skill.
The insertion is a literal declaration, requiring no import changes. An uneditable
expression fails with its exact source line and the exact declaration line to
add manually before refresh, rather than guessing at a rewrite.
Connection refusals point to `/company/connections`; an unavailable shared-table
addition points to `/company`. Restore source access or correct the declaration.
`patchy remove <alias>`
reverses the declaration and generated surface, retaining its fixture.

`patchy refresh` binds the whole change to one release: fetch, update pin and install
if changed, re-exec the new CLI, execute config, generate, stage and activate.
Failure leaves the old managed set intact. The **managed files** are exactly the
pin, `patchy/_generated/`, `.agents/skills/patchy-*/`, missing fixture stubs,
the lockfile through install and the one `uses` edit for add/remove. App source,
existing fixtures and the write-once agent instructions belong to the builder.

Generation is authenticated and server-side. It accepts the manifest, current
release, optional patch id and present skills, and returns finished files with
resolved declaration ids and revision stamps. `patchy/_generated/index.json`
identifies each declaration, alias, stamp, skill and context path; its README says
plainly that deleting `.patchy/` destroys local rows and files. The CLI alone writes
`manifest.json` from config execution. Neither the server nor the CLI may write
arbitrary paths outside the managed roots.

The **global skill** is the door for sign-in, static pages and `init`; inside a repo
the **project skills** govern. Their sole source is `packages/sdk/skills/`:
`patchy-loop`, `patchy-tables` and `patchy-files` are core;
`patchy-postgres` and `patchy-shared-tables` follow declarations. Refresh re-fetches
every present skill and adds implied ones: presence is sticky, and a missing offer
fails rather than preserving obsolete instructions. Explicit remove may retire a
declaration skill when no declaration of its kind remains.

A **fixture stub** contains metadata and guidance, not company rows. The builder
fills `fixtures/postgres-<handle>.sql` or `fixtures/shared-<alias>.sql` with invented
local inserts. Existing files are never overwritten. Only metadata and inventory
come from the instance; development never copies production rows or bytes.
Every readable row in a company runtime is available to every admitted viewer;
UI filters do not create access control. A public runtime gets no company data.
Project skills teach this boundary and the tier 1 limits: no outbound access or
client storage; durable data goes through Patchy.

### Sharing and finding

A published patch is shared with **everyone in the company** by default, or made **public** on purpose: anyone with the link, without a login. Its owner chooses either scope with `patchy publish [file] --share company|public`. In a repo, `patchy share company|public` uses the id in `patchy.json`; file mode accepts `patchy share <file> company|public`, and `--patch <id>` selects a patch explicitly. A publish without `--share` preserves an existing patch's scope. Only the owner changes sharing. A current public tier 1 version exposes no company capabilities, even to a signed-in member. Narrower scopes — the owner plus named users, or one group — remain future work; who may open, change or use a patch is spelled out under [Identity and access](#access-to-a-patch).

The future way to find a patch is a portal of everything you have access to; today a person shares its address. A patch's identity is its **id**, while its **name** is unique within the company. Two sales dashboards need different names, but renaming one never changes which patch it is (see [Addresses](#addresses)).

### Updating, retiring, deleting

Updating is publishing again. Today each publish gives the patch 90 days of retention; a visit in its final 30 days moves expiry to 30 days out, never shorter and never reviving an expired patch. Revoking or replacing a machine token does not stop those top-ups. Expiry stops serving and updates, then the sweep removes the patch and its content. Today's owner **delete** stops serving immediately, with no restore action; its stored content remains until expiry and the sweep.

The intended company model removes automatic expiry in [the expiry-removal effort](https://github.com/allisonmahmood/patchy-cloud/issues/93). Its two exits will be **retire**, which takes a patch off its address and keeps it restorable by its owner, and **delete**, which removes it for good after a recovery window. Retirement and the recovery window are not built yet.

### Patches and other patches

A patch may declare and read another patch's **shared table** in the same company. The declaration names the source patch's stable id and table, never its address or name; it grants no access of its own. The viewer must be able to open the source and the table must remain shared. Extending those rows means defining an owned table keyed by source ids and joining the two reads, not changing the source. Calling another patch's code and **extensions** that plug into another patch remain promised, not designed.

### What a patch is not

Not a **connection** (a connected source belongs to the company, or in the future a user, and a patch uses it), not a **primitive** (a patch defines its own and declares those it uses), not a **company**, not a **version** (part of a patch), not an **agent** or a skill (those make patches). A patch can own tables and files; it is not itself a table, a connection, or the people using it.

## Runtime tiers

A **tier** is where a patch's code runs, and nothing else. Tier 0 is **static**: no patch code runs anywhere. Tier 1 is **browser**: code runs in the viewer's browser, as the viewer. Tier 2 is **hosted**: the patch also has server-side code Patchy runs for it, while someone has the patch open. Beyond them, and not designed: tier 3 runs with no viewer present — automations, a thing that persists — and tier 4 gives an agent its own computer to work in (the shape Daytona fits). The numbers are the names; the glosses are for context.

### What a tier changes, and what it never changes

A tier changes where code runs. It never changes ownership, sharing scopes, what a patch may define or declare, or its publishing, versioning and address model. A person opening a company patch signs in once and lands back on it; that door is the same for a tier 0 page and a tier 1 tool, and sits in front of the page, not inside it. Hosted runtimes are still to come.

Either built tier can be **public** — anyone with the link, no login. A public tier 0 patch is a static page; a public tier 1 patch can run browser code but receives no company capabilities for anyone, including signed-in members. It may still use the shell's route bridge. An authenticated company-data mode of a public patch is a separate future decision. The proposed tier 2 public model would use the patch's own identity; neither tier 2 nor that identity is built.

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

The runtime operation path admits `me`, seven owned-table operations, three
shared-table reads, four file operations and four Postgres operations. A company
version returns its active viewer and company; a current public version returns
null for `me` and refuses company data and integration access, even to a signed-in
viewer. Browser sessions, never machine tokens, enter this path; wire and
principal headers bind each request. Mutations and Postgres calls additionally
require the exact shell Origin, and file reads require same-origin fetch metadata.
The runtime records table and file mutations and integration calls before execution.
Default limits include 300 calls per viewer per patch per minute, 32 outstanding
requests and 64 MiB held per frame; the data-operation limits are below.

Tier 1 runs only while the viewer has the patch open. It cannot run background work or server-side patch code, but its writes persist: a saved photo or table row remains available to other admitted viewers after the browser closes.

### Tier 2 — hosted

This tier and its patch identity are proposed, not supported by today's runtime.

The patch also has server-side code, and Patchy runs it **while a viewer has the patch open**: it starts when someone asks, serves requests and live connections to every open client (two people with the same patch open can be kept in sync), and stops when nobody is looking. It costs nothing when nobody has it open. The line to tier 3 is the question a builder can answer: _does this need to happen when nobody has it open?_ If yes, it is not tier 2.

The server side is handler-shaped code Patchy runs, with a fixed layout `init` lays down — not an arbitrary app listening on a port. Bringing a whole app is a second runtime with a second set of limits, and is not promised.

Server-side code has two identities available. Company data and integrations are reached **as the viewer** by default, exactly as at tier 1. The patch's own primitives are reached as the **patch identity**: a principal of its own, accountable to the patch's owner (reassignable, so a patch outlives its owner's account), starting with nothing but the patch's own primitives and gaining a shared integration only when a company admin grants it. Neither identity ever sees a raw credential; credentials stay behind Patchy at every tier. As at tier 1, nothing leaves except through Patchy.

When a patch asks for data the viewer may not reach, the viewer is told plainly that this is their access, not the patch being broken.

### Declaring and changing a tier

The tier is an explicit field in `patchy.config.ts`, written by `init`. The CLI checks the tree and built HTML: `server/` requires tier 2 and is refused today, and a bundle with script cannot claim tier 0. The server independently checks the submitted bundle: tier 0 must pass the safe-HTML policy, tier 1 runs only in the sandbox, and tier 2 and above are refused. Claiming a higher built tier than the code needs is fine. A tier 0 repo may provision tables and stores; resources do not make a tier.

A **version** has exactly one tier; the patch's tier is the tier of the version it serves. Changing tier means publishing a new version, not moving an existing one in place. Primitives belong to the patch, not its tier, so their data persists across the change. Future rollback will select the older version's tier without rolling back cumulative provisioning or sharing flags.

## Companies

A **company** is the tenant everything on Patchy Cloud hangs off. Every patch and user lives in exactly one company, and nothing inside crosses the company line except a patch someone chose to make public. A company is flat — no sub-tenants — and carries a globally unique **handle** alongside its display name. It owns its Postgres connections; billing, groups and company-wide usage accounting are not built yet.

A company comes to exist on **create-or-join**, after sign-in: a person without an invitation names a company, chooses its handle and becomes its first admin. The company and user are created together; a solo builder is a company of one. The handle is fixed once created, 3–32 lowercase letters, digits or hyphens, with no leading or trailing hyphen and reserved platform names refused. Self-serve billing — put in a card, set when it tops up — is the intended later path, not a step in today's signup.

### Users, admins, groups

A **user** is one individual with one account, in exactly one company. They sign in, and they hold expiring, rotatable tokens on the machines they build patches from — see [Identity and access](#identity-and-access).

An **admin** is a user with the role that runs the company. Today that means invitations, roles, deactivation, reactivation and company Postgres connections; creating groups, setting their permissions and reassigning a patch's owner are future powers.

Today `/company` lists users, roles, active/deactivated state and pending invites.
Admins manage invitations, roles, deactivation and reactivation there; members
read the same page without actions. The last active admin cannot be demoted or
deactivated. Reactivation restores sign-in to the same company and data, but
machine tokens revoked by deactivation remain revoked.

A **group** will be a named set of users an admin creates; a user can be in many. "Team", "department", "north-american-sales" are names companies give their groups, not concepts of their own. A group is purely a grant surface — access to patches and connections — never a container that owns anything.

### Ownership and deactivation

A patch belongs to a user. Today **deactivation** ends that user's company access on the next request and revokes every machine token while keeping all data; a browser with a Clerk session sees the deactivated page and can still sign out. Reactivation restores access to the same company, but fresh machine tokens are required. Deactivation does not currently change a patch's sharing or serving state.

In the intended company lifecycle, deactivation will also wipe personal-connection credentials and take down patches only that user could reach: owner-only patches and their provisioned primitives enter the same kept-but-off state as retire. Patches shared to a group or company-wide stay up; managing those is what admins are for. That remaining lifecycle work belongs with [expiry removal](https://github.com/allisonmahmood/patchy-cloud/issues/93), personal connections and narrower sharing. Deleting a user is a separate, later act: its flow will prompt the admin to reassign the user's patches, and what is not reassigned will go with the user.

### Integrations and connections

Patchy ships the **integration** — today Postgres — as a company-scoped capability. A **connection** is the live, credentialed instance an admin connects for their company. Patches declare connections, not an integration in the abstract, and never receive their credentials. Personal connections and group grants are future extensions of this model; the implemented connect flow and its limits are spelled out under [Integrations](#integrations).

Today admins manage Postgres at `/company/connections`, linked from `/company`;
members read its handles, descriptions, status and discovery/test timestamps.
Connections are company-wide, not per patch. Personal connections and group
grants remain future work.

### Addresses

Every patch has an address at `/<company>/<patch>`, for every tier and sharing scope. A numbered version opens at `/<company>/<patch>/~v/<n>`. A trailing route belongs to the patch at tier 1 and above and is ignored at tier 0; every segment starting with `~` belongs to Patchy. A company handle alone is not a page. The former `/d/*` routes are gone, not redirects; `d` remains a reserved company handle.

A patch's **name** follows the company handle's grammar: 3–32 lowercase letters, digits or hyphens, no leading or trailing hyphen. Names share one per-company namespace, alongside future user and group handles. An explicit manifest name or file-mode `--name` must be free on create and rename alike (`name_taken`); without `--name`, file publishing normalises the filename and adds `-2`, `-3`, and so on when needed. Republishing a file preserves its name unless explicitly renamed. Renaming leaves a 308 redirect from the old name until another patch takes it; that claim removes the former redirect for good. Deleting a patch frees all its names. The patch's identity remains its id, never its name.

Only the current public version is public and caches for at most a minute at both its address and its numbered version URL; older versions stay behind the company door. `/~content/<patchId>/<versionId>` is an internal, non-redirecting **content URL**, never the link to share: it serves that version's bytes with that version's tier and content security policy, the same door and sharing-based caching as the address. Tier 0 keeps its script-free `srcdoc` frame with `sandbox=""`; tier 1 frames that content URL with a document nonce and `sandbox="allow-scripts allow-modals"`. Historical pages always render with their own version's tier.

### The operator

The **operator** — Patchy, running the platform — is not a company role and holds no company powers. Its future powers are platform-shaped: company lifecycle, quotas, and moderation — taking a patch off its address, never acting inside the company. None of those surfaces is built; disabling a patch is a SQL statement by hand until that effort is designed. Support means being invited like anyone else; a customer-support role is not designed. **Suspension** will stop a whole company's serving and publishing while keeping its data, including when it runs out of credits and cannot top up. Company deletion by its admin, its recovery window and the eventual release of the handle are future work too.

The operator will use its own login and dashboards, never a company in the product and never the `patchy` CLI.

## Identity and access

Log in once, and every patch you have access to opens when someone sends you its link. That is the whole promise, and everything below serves it. Patchy does not run its own identity system: **Clerk** holds who a person is, their sign-in and their browser session; Patchy holds the company, what each user may reach, and which machines may act as them.

### Signing in

A person signs in with **Google**, **Microsoft**, or a **code sent to their email**, through Clerk's Account Portal. There are no passwords — every other route gives Patchy nothing to protect and no reset flow to run. One Clerk session opens the company's patches and first-party pages: a company link opened without a session shows the login door, whose Sign in link returns the person to that patch. A public patch needs no sign-in. The future portal and higher-runtime patches use the same door.

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

Two: **member** and **admin**. **Everyone in a company builds** — a member publishes patches with no gate and no permission to ask, because that is the point of the product. Today admin adds invitations, role changes, deactivation, reactivation and company connections; groups, domain and SSO and patch reassignment will come with those features. A company always has at least one active admin, who can neither be demoted nor deactivated. There is no builder role and no viewer role; if a company ever wants "can't publish", that is a setting to add, not a third role.

### Access to a patch

Who may **open** a patch is its sharing scope: today the whole company or, by explicit choice, anyone with the link. Who may **change the patch itself** is its **owner** alone: publish a version, change sharing or delete. There are no editors, and admin status grants no extra patch-management permission. This is separate from using its data: every admitted company viewer can read and write all its defined tables and file stores; a current public version grants no company-data access. Owner-plus-named-users and group sharing, rollback, retirement and admin reassignment remain future work; when two people work on one patch, the owner publishes their shared local work.

**Admins will see everything.** The intended admin view includes every patch in the company, owner-only ones included, with the ability to manage it or reassign its owner. That view and reassignment are not offered today. The company owns what is built in it; future owner-only sharing is not a secret from the company. Making that more nuanced is a later decision.

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
- **Owner** — the one user a patch belongs to; the only one who changes its published code, sharing or lifecycle, not the only one who writes its data.
- **Viewer** — the active signed-in user, company and role that Auth establishes for a first-party page or a company patch's door, without a machine credential. Tier 1 patch code acts within that viewer's permissions; a public runtime has no such acting identity, even for a signed-in reader.
- **Operator** — Patchy, running the platform. Platform powers only, never a role inside a company, and never the word for whoever drives the CLI — that is the agent, the CLI's primary **driver**.

## Primitives

A patch's **tables** live in its own namespace inside one Postgres database per
company. The first publish introducing tables or file stores provisions that database lazily;
a primitive-free patch does not require one. The manifest defines what one
version uses, while the company's cumulative **inventory** records everything
provisioned for the patch. The owner can fetch that metadata and its schema
revision from `GET /api/patches/:patchId/inventory`; it contains no row data.

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

The inventory's **schema revision** advances only when its table definitions
change or a store is added, not on every version or file write. The inventory's `shared` flag changes only when
a publish defines that table with a different flag; omission does not revoke
sharing and rolling back a version will not restore it.

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
warns rather than refuses. Catalog, client generation and local fixtures consume
that inventory's tables, columns and indexes, never the source's active manifest
or its company rows.

`shared.get`, `shared.getMany` and `shared.list` take the declaration's alias and
provide the owned-table read surface, using the source's indexes and bounds.
There are no shared writes. On every call the viewer must still be able to open
the source and its inventory flag must remain shared; otherwise the whole call
is `access_denied`, even for an empty id list. While authorized, `getMany`
preserves input order, duplicates and nulls for dangling ids.

Omitting a shared table from a source version keeps its identity, definition
and sharing. Unsharing requires defining it with `shared: false`, and publish
reports the number of distinct live declaring patches, including declarations
in retained versions. Their next read is denied; their own rows are untouched.
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
`patchy catalog` shows what the company has connected; `patchy add` inserts the
declaration and brings its generated client, context, fixture stub and skill.
Publish resolves the handle to a stable connection id and metadata revision.
Neither the alias, the handle nor the declaration is a permission.

Every company patch that declares a connected source can use it as its admitted
viewer without a separate per-patch consent step. A public runtime cannot use
it. Disconnecting the source makes subsequent calls fail `access_denied`, with
the shell's first-party notice; reconnecting retains the connection identity.
The current connect flow is admin-only on `/company/connections`, not a door
that walks ordinary viewers into creating credentials.

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
arrays are unknown; domains resolve to their base types. Unsupported columns
and locally unrepresentable relations are excluded and named.

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

There is no bring-your-own source: no generic REST escape hatch and no "connect an MCP server". A company that needs an integration Patchy has not shipped requests it, and Patchy builds it. Opening the integration catalog to third-party authors would be a separate later decision; today's `patchy catalog` discovers the capabilities Patchy already offers.

### Development

Patch development uses local fixtures, not live source rows or production credentials.
The **dev binding** supplies the same Postgres execution dependency without
loading the keyring or runtime log. One PGlite database per connection under
`.patchy/dev/` is shared by its aliases, with source-native types: numeric filters
and ordering remain numeric, not string comparisons.

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

A tier 2 patch's own **patch identity** against a shared connection is sketched under [Runtime tiers](#tier-2--hosted); its mechanics are settled when tier 2 is designed. Patch-owned shared tables already provide read-only access across declaring patches; company-owned tables and broader composition remain undesigned.
