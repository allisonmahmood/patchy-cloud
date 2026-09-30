# patchy

One package for [Patchy Cloud](https://github.com/allisonmahmood/patchy-cloud): the `patchy` CLI, config builders, browser client and local dev runtime. It publishes static HTML files and tier 0, 1 and 2 repos. Tier 2 publication runs on dev and test instances; production admission requires the fleet executor. Every publish carries a machine token. New patches default to company scope; tiers 0 and 1 can be shared publicly, but tier 2 cannot.

An agent is the primary driver, so the CLI promises a contract an agent can branch on without reading prose: an [exit code that says who has to act](#exit-codes), `--json` on every command, and one resolution of which instance is being targeted. The contract is [ADR-0004](../../docs/adr/ADR-0004-cli-contract-for-agents.md).

The CLI talks to whichever instance you point it at — Patchy Cloud, or the `pnpm dev` instance of a checkout — and falls back to `http://localhost:3000`, a server running from this repo on your own machine.

## Run it

Requires Node.js 22.22.0 or newer. The package is private and not published to a registry. Fetch your intended instance's unauthenticated `GET /api/release`, download its exact `package.tarball` URL as `patchy.tgz`, and verify the downloaded bytes against the SHA-512 `package.integrity` before installing:

```sh
npm install --global --ignore-scripts ./patchy.tgz
patchy login --api-url https://pages.example.com
```

Contributors working in this checkout can instead run `pnpm --filter patchy build`. It puts an executable at `packages/patchy/dist/index.js` and packs the release tarball. Symlink that executable as `patchy` into a directory on your `PATH`; adding `dist` alone exposes `index.js`, not `patchy`. Alternatively, replace `patchy` in the commands below and in login's returned `next` command with `node /absolute/path/to/packages/patchy/dist/index.js`.

The package bundles its runtime dependencies and installs offline without running install scripts. Inside a patch repo it is pinned as one exact devDependency; `pnpm patchy` runs that copy. `GET /api/release` reports the tarball URL and SHA-512 integrity. See [ADR-0011](../../docs/adr/ADR-0011-one-package-one-release.md) for the release and stable-wire boundary.

The URL is `/sdk/patchy-<release>-<digest>.tgz`, with the full SHA-256 of the
tarball as its digest. Old advertised URLs remain available. If the same
version is rebuilt with different bytes, refresh changes the URL and installs
those bytes rather than reusing the previous package.

First run is `patchy login`, then `patchy publish ./plan.html`. A person at a real
terminal confirms in their browser while login waits. An agent receives a URL,
code and next command, relays them to the person, and runs that next command
after the handoff; it never opens a browser. Publishing the same file again
updates the same patch. Inside a `pnpm dev` worktree, the seeded key works
without a login, and a saved login takes precedence over that seed.

## Config and browser client

Public subpaths are explicit: `patchy/config` and `patchy/dev` for tooling,
`patchy/client` for the generated browser client, `patchy/server` for handler
contracts, and `patchy/preact`, `patchy/preact/jsx-runtime` and
`patchy/preact/jsx-dev-runtime` for pages.
Package exports are not all page entry points.

### Bundled UI runtime

`patchy/preact` supplies Preact with compat semantics, hooks and signals. It
bundles exact Preact 10.29.8, `@preact/signals` 2.11.2 and
`@preact/signals-core` 1.14.4. Do not add direct Preact dependencies or
`pnpm.overrides`. Compat initializes before rendering through any of the three
entries. In DEV the SDK initializes debugging against that same instance;
patch code never imports `preact/debug`.

Import UI functions from `patchy/preact`, for example `render`, `useState`,
`useSignal`, `signal`, `computed`, `memo` and `forwardRef`. Set TypeScript's
`jsx: "react-jsx"` and `jsxImportSource: "patchy/preact"` and Vite's
`oxc.jsx.importSource: "patchy/preact"` when writing TSX. Compat transitions
are synchronous; there is no React scheduler.

Tiers 1 and 2 start with `src/main.tsx` and `src/App.tsx`, an empty HTML root, and
matching JSX settings. `pnpm lint` checks hooks, including `useQuery`, and refuses
React or direct Preact imports. No router, CSS framework, state library or test
runner is installed. Tier 0 is unchanged. Vanilla repos still use the
framework-free generated client; refresh never replaces application source.
The starter shows pending reads and saves, ignores an initial read after unmount,
and prevents writes while the initial read or a save is pending.
`useQuery(read, args)` and `read.subscribe(args, listener)` support tier 1 owned
and declared shared-table `list` and `get` in both local dev and hosted pages.
For example, `useQuery(client.tables.notes.list, {})` returns
`{ status, data, error, loading }`; render `data?.rows` and display `error` without
discarding the last successful value. A missing `get` stays subscribed and
updates when that row appears. Unsubscribe with the function returned by `.subscribe`.
The shared registry canonicalizes arguments and has a one-second remount grace.
Reconnect catches up to durable revision fences without replaying writes; the
shell's reconnecting pill stays visible until catch-up completes.

Dev and publish check the page graph, not `package.json`. Runtime imports may
use `patchy/preact`, its two JSX runtimes, `patchy/csv` and the relative generated
client. CSV is a reserved entry point until its helper ticket ships. The generated
client uses `patchy/client` internally and re-exports `isPatchyError` for pages.
Tooling and type-only imports do not enter the page graph. An off-SDK import,
including one hidden by an alias or removed by tree shaking, is local exit 1,
`import_refused`. Its message names the package, importer and allowed entries,
then states: "anything else, write or copy into your patch as your company's own
code". It points to "What the SDK gives you" in `patchy-loop`. The import check
is a build contract, not a security boundary.
CSS imports, including nested stylesheets, obey the same package rule. Relative
or root-absolute paths cannot bypass it by naming an installed dependency.
Imports from `server/` are type-only. Vite's injected module-preload helper is
tooling; importing it directly from page source is still refused.

Contributors can run `pnpm --filter patchy build` followed by
`pnpm test:packed-preact-e2e`. It installs the real release with pnpm, checks
the installed UI tree and JSX types, exercises optimized dev and the single-file
production bundle in Chromium, and installs a same-version repack through a new
digest URL.

### Tier 2 contract

`patchy/server` exports engine-neutral `query`, `mutation`, `action`,
`HandlerError` and `t`. The SDK generates config-bound builders and helper
context types in `patchy/_generated/server.ts`, plus a server-only client whose
handler signatures come from type-only server imports. Runtime callables resolve
lazily, so renaming an export in an existing module does not require regeneration.
Refresh discovers module names from one-level `server/*.ts` filenames and sends
them separately from manifest handler descriptors. Adding, removing or renaming
a module needs refresh. It never loads or bundles those sources; unfinished
handler code does not block generation. Nested modules, invalid names and
symbolic links are refused locally.
Declared business errors retain their `source: "handler"`, code and details across
HTTP and broker transports; similarly shaped successful data remains data.
The client retries a lost query reply once with its original arguments. The shell
supplies the loaded version's inspected handler kinds at bootstrap, so the page
never imports server implementations to decide whether retry is safe. Missing or
invalid kind metadata disables retry. Actions and delivered refusals are never
automatically retried.

`t` adds objects, arrays, enums, nullable values, full rows, result-only file
handles and action-argument uploads. Optional argument keys may be absent;
optional columns remain nullable. Defaults and refs are table-only. Queries
cannot write, mutations cannot reach shared data, connections, file bytes or
`ctx.run`, and actions can call only sibling queries and mutations.
Server-side shared reads return promises, without browser subscription methods
or query stores.

Generated server queries expose `.subscribe(args, onSnapshot)` and work with
`useQuery(handler, args)` through the same document stream as tier 1 tables.
Mutations and actions cannot subscribe. The framework-free registry shares
canonical arguments and retains subscriptions across a one-second remount grace;
hidden suspension and reconnection use the shell's existing stream machinery.
`useQuery` observes the registry through the bundled Preact external-store hook.
It ignores stale frames and preserves the last value through recoverable and
permanent errors. Refusals inside a handler recover on restore or reshare,
including an initial access failure. `handler_failed`, invalid results and
removed handlers end only their subscription; new consumers and reconnects do
not restart an ended subscription while it remains mounted.

The CLI's server build wraps discovered modules with `createGuest`, the wire-1
entry exported by `patchy/server`. It derives descriptors from actual handler
exports, builds kind-specific contexts and sends operations through an
invocation-bound RPC stub. It receives no callback credential. File bytes stay
binary; host refusals and declared business errors retain their structured replies.
SDK query-shape validation preserves its own `invalid_request` refusals without
trusting arbitrary handler-created `PatchyError` objects.

Queries, mutations and actions run through the pinned local executor in tests and the
source checkout's existing `pnpm dev` cloud server for eligible `server.call`
requests. See [the development guide](../../docs/DEVELOPMENT.md).
A query with declared data resources shares one read-only `REPEATABLE READ`
company snapshot across its callbacks, with a 3-second deadline. Resource-free
queries need no company database lease and report an empty watermark and zero
database-held time.
Shared-table authority is still checked live on every callback. File reads in
queries are `list` and `stat`, returning metadata without handles. Actions have
60 seconds, plain-byte file operations, declared connections with a 15-second
per-call limit, and typed nested queries or mutations under the parent's remaining
deadline. Actions have no transaction of their own.

Mutations use one host-owned `SERIALIZABLE` transaction, with up to three
whole-handler attempts inside a 5-second deadline. Exhausted serialization
conflicts return `write_conflict`, not `busy`. Results are at most 64 KiB and
are validated before commit. Every call gets a fresh mutation key from the
stream's server clock. An `unknown_outcome` error offers `retry()` with the
same key and captured arguments; a repeat returns the committed result.
A new call is not that retry and can duplicate a write. Actions are never replayed.

Tier 2 publication builds and uploads both HTML and server artifacts, then the
instance re-derives handler descriptors from stored bytes before recording the
version. It runs on the local executor in dev and test instances. Production
hosting requires the fleet executor. Query subscriptions use that same hosted
runtime. `patchy dev` uses the supervised production handler engine and callback
gateway, with live server rebinding and a separate non-admin colleague URL.
The `patchy-server` skill documents handler behavior and registry limits.
Authorised handles and staged upload adoption remain reserved contracts.

### Config

```ts
import { defineConfig, table, t, files, postgres, sharedTable } from "patchy/config";

export default defineConfig({
  name: "team-notes",
  tier: 1,
  tables: {
    notes: table(
      "One team note per id; parent identifies another note.",
      {
        title: t.text(),
        body: t.text().optional(),
        done: t.boolean().default(false),
        created: t.timestamp().default("now"),
        parent: t.ref("notes").optional()
      },
      { indexes: { byDone: ["done"] }, shared: true }
    )
  },
  files: { attachments: files("Note attachments keyed by note id and filename.") },
  uses: {
    sales: postgres("warehouse"),
    contacts: sharedTable("abcdefghijkl", "contacts")
  }
});
```

`table(description, columns, options?)` and `files(description, options?)` require a
nonblank description. Say what one row or object represents, its identifying
keys, and units where relevant, such as integer cents or elapsed seconds.
Config execution refuses missing or blank descriptions and a name shared by a
table and a file store. CLI commands report these failures as `invalid_manifest`.
Descriptions are config-owned metadata: publishing a definition replaces its
description, omission keeps it, and rollback leaves it unchanged. A
description-only publish does not advance the schema revision.

`Row<typeof config, "notes">`, `Insert<typeof config, "notes">` and
`Update<typeof config, "notes">` infer the owned table contract. Rows include
branded `id`, `createdAt` and `updatedAt`; writes cannot supply system columns.
Optional columns accept null. Defaulted columns may be omitted on insert but do
not accept null; updates are partial. Other kinds are `integer`, `number` and
`json` (read as `unknown`). Refs are branded row ids, not foreign keys.

`executeConfig(path)` from `patchy/config` runs the config in a child
process and returns a validated manifest. It requires the sibling generated
`patchy/_generated/index.json`, even when `uses` is empty. Each stamp records
`alias`, resolved `id`, `revision`, and its resolved `declaration` (including
`kind` and the authored handle or source patch/table/store). Missing, duplicate,
removed or rebound declarations fail locally with `stale_generated`; run
`patchy refresh`. The server never executes config. The CLI's generation path
executes without resolution, then stamps the instance's returned ids and revisions.
Config files use
Node's native TypeScript loader, including explicit `.ts` extensions for local
TypeScript imports.

The tier 1 browser entrypoint exposes owned tables and file stores, read-only shared
tables and stores, generated connections, `me()` and `route`. It uses the hosted shell's
document-bound port; patch frames must not fetch the runtime directly. HTTP and
port transport constructors remain internal, not public client exports. All
runtime failures use `PatchyError` and `isPatchyError(error, code)`; a lost reply
is `unknown_outcome`, never an automatic replay.
Limit refusals may also carry `scope`, `limitId`, `value` and `retryAfter`.
`value` is the enforced bound from the [limits registry](../../docs/limits.md);
`retryAfter` is a delay in seconds and appears only when retrying is safe.

On a company patch, every viewer who can open it can read and write all its own
tables and files; there are no row rules or separate write scopes. Shared tables
and stores are read-only and Postgres integrations perform constrained reads as the role
the admin supplied. A public tier 1 patch gets no company capability for anyone:
`me()` returns null and data calls fail `not_available_on_public`, even for members.
The route bridge still works. The frame has no direct outbound fetch, client
storage, popups, workers or device access.

Owned tables expose `get`, `getMany`, `list`, `insert`, atomic `insertMany`,
`update` and idempotent `delete`; shared tables expose only the three reads.
`get` returns null when missing; `getMany` preserves input order with nulls for
missing rows, while revoked shared access fails the entire call. `list` returns
`{ rows, cursor }`, uses a declared index for filtering and keyset pagination,
and defaults to the built-in `(createdAt, id)` index newest first. A missing-row
update fails `row_not_found`. Table and file mutations and integration calls are
logged for company admins in the cloud, not in local dev.

`client.route.get(): Promise<string>` reads the patch-relative path, including
the initial deep link. `client.route.set(path): Promise<null>` asks the shell to
push a new path without navigating the frame. Paths start with `/` and must not
contain a query, fragment, traversal or another origin. The initial link and
back/forward report routes percent-decoded. A set first reports the path as
requested; the shell's route event right after it settles an encoded request
such as `set("/caf%C3%A9")` on `/café`. Routing works on both company and public
patches. `client.route.subscribe(listener)` returns an
unsubscribe function; listeners receive the initial route, acknowledged sets
and browser back/forward changes. Notifications are asynchronous; unsubscribe
and `client.close()` stop them, including notifications queued before cleanup.

File `url(name)` returns a cached frame-local blob URL, never a public object URL.
`client.files.attachments.download(name): Promise<null>` instead asks the outer
shell to start a browser download; resolution acknowledges that request, not
that the user saved the file. File operations on public patches reject with
`not_available_on_public`, which application code can catch without ending the
shell session.

Share a whole store with `files("Source documents", { shared: true })`. Sharing
publishes read access to every file in that store. Add it with
`patchy add shared-store <patchId>/<store> --as assets`. Tier 1 pages use
`client.shared.assets.list/get/url/download` by filename. Tier 2 queries use
`ctx.shared.assets.list/stat`; actions also use `get` for bytes. A tier 1 consumer
can read a tier 2 source. The consumer's served-tier gate still applies.

Every shared read, URL request and download checks that the source is openable
and its store is still shared, including cached bytes. Unsharing, retiring or
deleting a source refuses while live consumers depend on it unless forced.
Forced changes deny the next read; resharing or restoring the source recovers
access. Omission and rollback never change source sharing. A replacement patch
under the old name does not rebind the declaration.

`put(name, bytes, { contentType })` transfers ownership when given an
`ArrayBuffer` or a `Uint8Array` covering its entire `ArrayBuffer`: sending it
detaches the caller's buffer, even if the operation later fails. Copy it first
if it must remain usable. A subview is copied into an isolated buffer containing
only its selected bytes; unrelated backing bytes remain attached and are never
sent. A `Blob` is read into a new buffer for transfer, leaving the blob usable.

The internal generated `client.ts` template imports the config's **type** and
`manifest.json`'s **value**. The package's browser graph has no Node, Effect or
PGlite runtime. The same tier 1 shell supplies the broker in the cloud and
`patchy/dev`; the latter composes real handlers over local PGlite and fixtures.

## Commands

### Discovery

`patchy list` runs anywhere with the saved login and normal instance overrides.
It is not a repo command and never reads `patchy.json`, even inside a patch repo.
Use the pinned `pnpm patchy` there; pass `--api-url` when discovery should target
an instance other than the normally resolved one.

| command                                | behaviour                                                                                                                                             | `--json` success                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `patchy list` or `patchy list patches` | Lists patches grouped Yours, Company, then Connections. Both forms include connections.                                                               | `{ patches, connections }`, merged from `GET /api/patches` and `GET /api/connections`.                              |
| `patchy list <patch>`                  | Prints the patch row, full description, cumulative Tables and Stores, then Reads across retained versions, with declaration hints or refusal reasons. | Patch detail wire body with `inventory` and `reads`.                                                                |
| `patchy list <patch> <primitive>`      | Describes one table or file store, never rows or file contents.                                                                                       | Primitive detail wire body with `kind`, `name`, `description`, `shared`, `schemaRevision`, `columns` and `indexes`. |
| `patchy list connections [--all]`      | Lists company connections and their state; `--all` also shows offered integrations.                                                                   | Connections wire body `{ connections, offered? }`.                                                                  |
| `patchy list connections <handle>`     | Prints the current immutable schema snapshot with its revision and `takenAt`.                                                                         | Connection detail wire body `{ handle, description, status, snapshot }`.                                            |

Every level accepts `--json`; success has no added `ok` wrapper. Filter JSON
locally when choosing candidates by description. Flags apply only at these levels:

- `--state live|retired|all` defaults to `live`. It filters patches at the top
  level and governs patch resolution at both detail levels. `all` includes
  deleted patches not yet reclaimed, including those past `purgeAt` awaiting the sweep.
- `--mine` applies only to `list` and `list patches`, restricting their patches.
- `--all` applies only to `list connections`, not one connection's detail.
  Patch flags do not apply to connections. A flag at the wrong level is a
  local error, exit 1.

Patch rows lead with the canonical id, then name, state, owner, current version
such as `v7`, and the description's first line or `(no description)`. Deactivated
owners carry `· deactivated`; deleted patches show `deleted · gone in N days`
from the server's `purgeAt`. A null inventory prints `Tables: unavailable`,
not an empty inventory. A null connection snapshot is unavailable, not an empty
database. Table detail includes each column's kind, optionality, explicit default
including `null`, ref target, indexes with `unique`, sharing and schema revision.

Find candidates with `list`, inspect their tables, stores and reads with
`list <patch>`, then inspect a resource with `list <patch> <table-or-store>`.
Choose only entries marked `declarable: true` and carry the canonical patch id
into `patchy add shared-table <patchId>/<table>` or
`patchy add shared-store <patchId>/<store>`. Unshared entries name the owner;
retired or deleted sources must be restored.
Agents branch on `declarable` and `reason`, not the human `hint`.

Names and canonical ids are accepted; a pasted URL resolves by its final path
segment. Names resolve only non-deleted patches. A deleted patch needs its id
and `--state all` at both detail levels. A resolved patch outside the requested
state is the API's `wrong_state` refusal, exit 2: a retired patch says
`retired; pass --state retired`, a deleted patch says
`deleted; pass --state all`, and a live patch needs `--state live` or `all`.
In JSON, `wrong_state` carries the actual `state` beside `code`.
Only patches the credential can open appear. "No match" means "none you can use";
check `list --state retired` before concluding a tool does not exist.

### Patch repo commands

Use the instance-installed CLI outside a repo and the pinned `pnpm patchy` inside.
The private package is not available as `npx patchy@latest` yet; use the
instance's release tarball as described above.

| command                                                                                                                                                                 | behaviour                                                                                                                                                                                                                         | `--json` success                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `patchy init [dir] [--tier 0\|1\|2] [--purpose <text>]`                                                                                                                 | Authenticates first, prints instance and identity, installs the release and generates a new repo. Tier 1 is the default; tier 2 adds handlers and its managed engine pin. An initialized target is refused.                       | `{ ok, dir, release, tier, generated, skills, installed }`                                                  |
| `patchy refresh`                                                                                                                                                        | Reconciles managed pins and generated files with the release and tier as one transaction, installing and re-executing a new CLI as needed.                                                                                        | `{ ok, release: { from, to }, changed: { pin, generated, skills, fixtures }, addedCapabilities, warnings }` |
| `patchy add postgres/<handle> [--as <alias>]`, `patchy add shared-table <patchId>/<table> [--as <alias>]` or `patchy add shared-store <patchId>/<store> [--as <alias>]` | Inserts one literal declaration into `uses` by TypeScript AST without changing imports, then generates client, context, missing fixture and skill. An uneditable block names its source line and the declaration to add manually. | `{ ok, alias, declaration, generated, skills, addedCapabilities, warnings }`                                |
| `patchy remove <alias>`                                                                                                                                                 | Reverses the declaration and generated output; removes an unused declaration skill. Leaves the fixture and says so.                                                                                                               | `{ ok, alias, removed, addedCapabilities, warnings }`                                                       |

`patchy add postgres` selects the sole connected Postgres connection; with several
it lists copy-ready choices from `list connections` and stops. With none, it names `/company/connections`.
The default Postgres alias camel-cases the handle's hyphens; a shared table or
store alias defaults to its resource name. `--as` overrides the default.

Initialization requires an empty or new target directory and an existing parent.
Without `--purpose`, it asks only at an interactive human terminal; agent, JSON
and non-terminal invocations must supply the flag:

```sh
patchy init ./team-notes --tier 1 --purpose "Track our team's notes" --json
# Inside ./team-notes:
pnpm patchy list connections
pnpm patchy add postgres/warehouse --as sales
pnpm patchy refresh --json
pnpm typecheck
pnpm patchy remove sales --json
```

Use tier 1 by default. Choose tier 2 when the tool needs enforced rules, atomic
multi-row writes or server-side work. Live sync and sequential operations are
already available on tier 1. To start on tier 2:

```sh
patchy init ./team-approvals --tier 2 --purpose "Approve team requests with enforced rules" --json
```

Tier 2 adds a starter handler module in `server/`, config-bound builders in
`patchy/_generated/server.ts`, and `patchy-server` alongside `patchy-preact` and
`patchy-loop`. Its page uses generated server query and mutation calls.
The release's exact `workerd` pin installs with scripts disabled; execution
spawns its platform package's binary, not a postinstall-created wrapper.

Use actual connection handles from `list connections`; inspect one with
`list connections <handle>`. Shared-table targets come from the discovery
chain above, using the response's canonical patch id.
Connection setup and reconnection belong to an admin's browser at
`/company/connections`; no CLI command accepts a
connection string. A shared source must be openable; restore its access with its
owner or correct the declaration. With no publishing key, non-interactive init
exits 1 with `Run: patchy login` before laying down files. A company with no
connections still gets the core skills and empty `uses`.

The generated repo includes:

```text
patchy.config.ts              definitions and uses declarations
patchy.json                   instance, patch description and sync stamp; optional patch id
package.json, pnpm-lock.yaml   managed pins; install already ran with scripts disabled
index.html, src/main.tsx, src/App.tsx  tiers 1 and 2 Preact page
server/                       tier 2 starter handlers
vite.config.ts, tsconfig.json  single-file build, JSX settings, typechecking
eslint.config.js              tiers 1 and 2 import and hooks lint
helpers/                      company-owned helpers
AGENTS.md, CLAUDE.md            purpose, layout, skills, index; @AGENTS.md
patchy/_generated/             README, index, client, manifest, context; server.ts on tier 2
.agents/skills/patchy-*/       core, page, tier-driven and declaration-driven skills
fixtures/                     postgres-<handle>.sql, shared-<alias>.sql or shared-<alias>/README.md
.gitignore                    excludes .patchy/, node_modules/, dist/
```

`AGENTS.md` is written once, says install already ran, points at the generated
index, and describes the `src/` page and `server/` handler split for either tier.
It points to the release-bound `patchy-loop` skill for how to exercise the
configured tier, so refresh can update that workflow without rewriting `AGENTS.md`.
The repo typechecks without added setup, and `pnpm patchy --help` runs its pinned
copy. This release supports `pnpm patchy dev` for tiers 0 and 1. Exercise tier 2
handlers by publishing to a development instance with invented data.

To move between tiers, edit `tier` in `patchy.config.ts`, then run `pnpm patchy refresh`.

- Moving to tier 2 adds the `workerd` pin, generated `server.ts` and
  `patchy-server` skill. Create `server/` handlers and run `pnpm typecheck`;
  its errors identify the direct resource calls to move out of the page.
  Publish with `--share company` if the patch is public.
- Moving to tier 1 removes those managed parts. Remove `server/`, refresh and
  run `pnpm typecheck`; its errors identify every `patchy.server.*` call to
  rewrite. Handler-enforced rules and cross-call transactions do not carry over.
  Serving a tier 1 version through publish or rollback permits public sharing
  again; local config alone does not.

Refresh does not migrate source, rewrite agent instructions or change the
patch id. Existing patch data stays in place in either direction.

`init --purpose` writes the initial description to `patchy.json` and the purpose
to `AGENTS.md`. They are independent after initialization. Descriptions are one
paragraph, at most 500 Unicode code points after trimming and collapsing
whitespace, with no control characters. An overlong purpose reports its count
and the bound; the interactive prompt asks again.

`patchy.json` is `{ instance, patch?, description, descriptionSyncedAt? }`.
Edit `description` there, front-loading what the tool does. Repo publish requires
nonempty text and reports `invalid_manifest` if it is missing or invalid.
The manifest carries that text; a successful publish records the returned
`descriptionUpdatedAt` as `descriptionSyncedAt`.

At `refresh`, a new `dev` start and `publish`, a newer cloud description stamp
pulls the cloud text into `patchy.json` and records the stamp. The notice says
"The description was changed in the portal to '…'; check it" and quotes the
replaced local text when different. Publish sends the pulled text. A local edit
does not change the stamp, so it is kept unless the cloud has changed too.

Those three commands also compare executed table and store definitions against
`patchy/_generated/manifest.json`. A changed definition with byte-identical
description produces a reminder to check that text. New definitions and changes
to both definition and description do not. Writing an omitted boolean default
as `false` does not change the definition. Notices do not block the command;
JSON includes them in `warnings`, including in the failure document if a later
step fails. Text mode prints those notices before the error.

Managed generation writes are exactly the `patchy` package pin and tier 2's
`workerd` pin, `patchy/_generated/`, `.agents/skills/patchy-*/`, missing fixture
stubs, the lockfile through install, and one `uses` edit for add/remove.
Refresh alone updates the pins and generated server module list after init;
dev and publish do not repair them. It removes stale generated context files.
The CLI writes `manifest.json` from local config execution; the server never
returns that file. Server paths are checked against the managed roots. Existing
fixtures, app source and agent instructions are not overwritten.
Deleting `.patchy/` destroys local rows and files.
Generation returns typed declaration metadata for the local runtime alongside
the managed files; full snapshots are not written into `patchy/_generated/`.
Description sync separately updates `patchy.json`; the pulled text remains
there if a later generation or build step fails, with its notice in the failure.

Refresh fetches one release, reconciles the pins with the release and tier,
installs as needed, re-execs that CLI before generation, then stages and
activates the set. Failure leaves the old managed set intact. Skills are sticky:
refresh re-fetches every present skill and adds any the config implies.
`patchy-server` is the sole tier-keyed exception, removed below tier 2.
A different present skill no longer offered by the release fails refresh.
Edit definitions, declarations and invented fixtures; never hand-edit generated
clients, stamps or project skills. Module additions, removals and renames need
refresh before publishing; a stale module list is `stale_generated`.
`changed.pin` in refresh's JSON is true when either managed pin changes,
including adding or removing `workerd`; rollback restores both pins and their
installation if the transaction fails.

Refresh announces new SDK capabilities in text and `addedCapabilities` in JSON,
including where each runs and its limits. Entries have
`{ id, group, name, entrypoints, runs, limits }`. Generation stores the release
catalogue in `patchy/_generated/index.json` and renders it into `patchy-loop`,
grouped Core, Primitives, Integrations and Helpers. An older repo without this
inventory receives the current catalogue once; repeating refresh returns `[]`.
The `patchy-preact` project skill is included on tiers 1 and 2.

### Builder-owned toolchain

Vite, `vite-plugin-singlefile`, TypeScript and `@types/*` belong to the builder.
Init writes caret ranges; refresh never edits those keys or adds overrides.
`workerd` is the only other managed pin, present exactly on tier 2.
`GET /api/release` reports `toolchain`, with a `testedAgainst` version and
`accepted` range for each scaffold dependency.

Dev and publish inspect the Vite and single-file plugin they actually load,
including a plugin resolved from a shared config. An unsupported version exits
1 with `kind: "local"` and `code: "toolchain_unsupported"`, naming the loaded
version, accepted range and upgrade command. For this release:

```sh
pnpm add --save-dev 'vite@^8.3.0' 'vite-plugin-singlefile@^2.3.3'
```

Refresh reports required upgrades in text and JSON `warnings`, but leaves
the upgrade to the builder. `release_mismatch` still checks the Patchy pin,
CLI and runtime; toolchain support is a separate check.

Version checks run inside Vite's normal build lifecycle, preserving its
`NODE_ENV` initialization and `.env` precedence. Dev retains the builder's
logging configuration. Publish suppresses native progress output and keeps
warnings and errors off the CLI's JSON stdout.

### `patchy dev [--foreground]`

Start this repo's local runtime, detached and idempotent. Exit 0 means the
runtime and first single-file build are healthy; output contains the local
page URL, `colleagueUrl` for tiers 1 and 2, log path and `pnpm patchy dev stop --api-url ...` command, using the
repo's pinned CLI. A second start finds the same daemon without authenticating
or checking a newer release. Start and status report the session's saved
release and full `/api/me` identity, not the current login or a newer release.

New starts resolve a key, check the pin/CLI/installed runtime release, then
authenticate `/api/me` and bind the viewer to the machine token's user. They pull
published inventory if `patchy.json` has an id and regenerate declarations. The production shell,
CSP, sandbox, broker and runtime admission are reused without Clerk or the
production runtime log store. The primary URL uses the machine token's user;
the colleague URL has a distinct origin and a fixed non-admin viewer in the
same company. Both mounts share local tables, files, fixtures and subscriptions.
Tier 0 adds only the trusted local reload script and its polling endpoint to its
shell CSP and has no colleague URL. No connection keyring is loaded.

`patchy dev` runs the same handler engine and callback path as production.
It does not reproduce production's scheduling, limits or containment. A handler
that spins forever times out, and a health check restarts the dev engine, which
can interrupt other calls in flight. Contract limits (including result sizes,
deadlines and registry limits) still apply; production operating capacity does
not. Local PGlite results are not evidence for hosted `busy` or `write_conflict`
behavior.

`dev.log` records each settled call's viewer, handler, outcome and milliseconds,
plus `ctx.log` output. Handler failures include their original message and stack
locally; browsers still receive the normal redacted error. A daemon started with
`--json` writes full wide-event JSON and invocation records to the log. There are
no runtime database log rows or PostHog delivery.

Vite runs in build-watch mode, not as an unrestricted dev server. A successful
`src/` rebuild atomically swaps the single-file page and reloads the whole shell.
A `server/` edit rebuilds and atomically rebinds its bundle and descriptors without
reloading the browser. New modules are discovered automatically; `dev.log` tells
you to run `patchy refresh` for their types. In-flight calls and their nested calls
finish on their original binding. Existing subscriptions rerun on the new one,
discarding results that cross the swap; removed handlers or incompatible arguments
end that subscription permanently. Failed builds keep the last good binding or
page and log the error. Config and fixture changes need `dev stop` followed by `dev`.

| command             | behaviour                                                                                      | `--json` success                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `dev`, `dev status` | Start or inspect; status exits 1 with `not_running` unless healthy.                            | `{ ok, healthy: true, url, colleagueUrl?, logPath, stop, pid, release, identity, warnings }` |
| `dev stop`          | Stop this repo and instance, keeping local data. Stale process identities are never signalled. | `{ ok, healthy: false, reset: false }`                                                       |
| `dev logs`          | Print the dev log.                                                                             | `{ ok, log, text }`                                                                          |
| `dev reset`         | Stop and wipe disposable local state. Published resources are unchanged; run `dev` afterwards. | `{ ok, healthy: false, reset: true }`                                                        |

`--foreground` waits and streams logs; Ctrl-C stops a session it started.
Joining an existing session leaves it running on interruption. Under `--json`
only the readiness document is printed; use `dev logs --json` to read logs.

Local state lives in `.patchy/dev/<instance-hash>/`, including the daemon
record with its release and authenticated identity, log, PGlite data and
filesystem content. Incomplete or malformed daemon records are refused and
left untouched; they are never filled in from the current login. Process birth
time prevents a stale record from signalling a reused PID. Before the first publish,
every schema change recreates local rows/files. After publishing, the inventory
is the baseline: compatible additions preserve rows, and a forbidden retype
returns the same `not_additive` message as publish. A conflicting unpublished
local-only definition may be recreated; it never becomes the baseline.
Fresh or reset state fetches and materialises that full inventory before applying the current
manifest. Omitted published columns and indexes remain in the local schema,
including unique constraints; omission does not relax writes.

Each Postgres declaration needs `fixtures/postgres-<handle>.sql`; aliases of
one connection share its PGlite. Shared tables need `fixtures/shared-<alias>.sql`
and use cumulative source definitions, including retained ref targets whose
declaration was omitted from the source's current manifest. Missing files fail naming the
file, rather than silently generating an empty replacement. Invent the fixture
rows; dev fetches metadata only, never production rows, bytes or credentials.
Tier 2 handlers read these fixtures through `ctx.shared` and `ctx.connections`
using the same callback operations as hosted execution.

Shared stores need `fixtures/shared-<alias>/`. Refresh creates a missing
directory with a README naming the source store; it leaves an existing directory
untouched, even if its README was removed. Put invented files in it. Dev loads
bytes recursively at startup, keeps relative filenames, and skips the directory's
README. Dev infers content types from extensions, ignoring case: `svg`, `png`,
`jpg`, `jpeg`, `gif`, `webp`, `pdf`, `txt`, `csv`, `json` and `html`. Other extensions
or no extension use `application/octet-stream`; bytes are not inspected or changed.
Each start clears and reloads that source store, so deleting a fixture file removes
it from the next session. Edit fixtures and restart dev to change a source locally.
Dev does not simulate source authority changes.

### `patchy login [--complete [code]] [--wait <seconds>]`

Log this machine in to the resolved instance. Start sends this machine's
hostname as the name hint, plus the saved login key's id on re-login.
An agent rerun with a pending login polls once rather than creating another code: it returns
`pending`, `logged_in`, or the instance's terminal refusal, not a new handoff.
The original URL and code remain valid until answered or expired.
`--api-url <url>` also saves the instance choice. The returned `next` retains
that flag, since a worktree's dev env or `PATCHY_API_URL` outranks saved config.
Keep the flag on later publishes when overriding those sources.

```sh
patchy login --api-url https://pages.example.com --json
# Relay verificationUrl and userCode, then run next with --json added:
patchy login --complete XXXX-XXXX --api-url 'https://pages.example.com' --json
# Continue only when status is "logged_in"; then check the publishing identity:
patchy whoami --api-url https://pages.example.com --json
patchy publish ./plan.html --api-url https://pages.example.com --json
```

Use the returned code, not the placeholder. The person opens the URL in their
own browser, signs in with Google, Microsoft or an emailed code if needed,
and checks the email on create-or-join if this is their first sign-in. They
join an invited company or, with no invitation, create one with a name and
handle, then return to the confirmation page. If the email is wrong, use
**Not you? Sign out** instead of creating a company under the wrong account.
They check the code, company and email, name the machine, and confirm;
**Deny** cancels a login they did not request or no longer want.

The poll mints the publishing key after confirmation; the CLI saves it locally
and never prints it. It works for 90 days or 30 idle days, whichever comes
first; revoke it on **Your machines** at `/machines`. Re-login with a saved
login key for the same user inherits its name and replaces it when the terminal
completes, without changing ownership of any patches. Keys from `auth set`,
the environment or the dev seed are not named as predecessors.

Before publishing, `whoami` verifies which user, company and machine the
credential chain actually selects. In particular, `PATCHY_API_TOKEN` still
overrides a successful saved login; resolve an unintended override before publishing.

Login blocks only when stdin is a terminal, `--json` is absent, and none of
`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CURSOR_AGENT`, `CODEX_SANDBOX`,
`CODEX_SANDBOX_NETWORK_DISABLED`, `GEMINI_CLI`, `OPENCODE`, `CLINE_ACTIVE`,
`AI_AGENT` or `CI` is set. That human path prints the handoff and waits until
the person answers or the code expires. On a new login, every other path prints
the handoff and why it did not wait, then exits 0. An agent relays both the URL
and code, never opens a browser, and follows `next`.

`--complete` uses the pending login; an optional code must match it or the
command exits 1 (`local`), naming the live code. Pass the code as a separate
argument (`--complete XXXX-XXXX`, not `--complete=XXXX-XXXX`).
Polling follows the returned interval, adding five seconds on `slow_down`.
`--wait` bounds polling, including in-flight responses (default 60 seconds);
`--wait 0` instead waits for one poll's answer. An unanswered request at the
deadline is exit 3 (`unreachable`), not a fabricated `pending` answer; the local
login record is retained for the same completion command. A real pending answer
followed by exhaustion of the wait budget is exit 0 and can be resumed with `next`.
Denied, expired and unknown are instance answers, exit 2 (`rejected`); the CLI
polls even if the local expiry has passed. Completion saves the key and machine,
clears the pending login, and prints the user/company receipt returned with the
key. No further identity request is needed. Once a complete response arrives,
the CLI finishes saving it even if local persistence runs past the wait deadline.

When `PATCHY_API_TOKEN` is non-empty, successful login also prints “Login saved. PATCHY_API_TOKEN is still set and takes precedence over this login.” The JSON completion result includes this notice in `warnings` (an empty array without an override).

Under `--json`, exactly one success document is written:

| result        | document                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handoff       | `{ ok, status: "awaiting_confirmation", verificationUrl, verificationUrlBare, userCode, expiresAt, interval, next, agentNextSteps, notWaitingBecause }` |
| Still waiting | `{ ok, status: "pending", userCode, expiresAt, next, agentNextSteps }`                                                                                  |
| Complete      | `{ ok, status: "logged_in", instanceUrl, company: { handle, name }, user: { email }, machine: { id, name }, credentialsPath, warnings }`                |

`next` is `patchy login --complete <userCode>`, retaining a shell-quoted
`--api-url` when the instance was selected by flag. It does not include `--json`;
append that flag when resuming to receive one of the JSON status documents above.
`agentNextSteps` tells the agent to show the person the URL and code, leave the
browser to them, and run `next`. Neither the publishing key nor the private
device code is in these documents.

### `patchy logout`

Forget the resolved instance's stored credential and pending login first,
then revoke only the key just deleted through `POST /api/logout`. A 401 means
it is already invalid and counts as success. An unreachable instance cannot
undo the local logout: exit 0, with this warning:

> Logged out on this machine. The key could not be revoked; it expires on its own after 30 idle days, or revoke it now on Your machines.

Logout removes only local stored credentials. Inside a worktree it says
_This worktree's dev instance still publishes with its seeded key_;
`whoami` then names the seeded machine again. With `PATCHY_API_TOKEN` set it
warns that the publishing key from the environment is not its to remove. Neither
that key nor the seed is sent for courtesy revocation. Logout does not sign
the browser out; use **Sign out** on **Your machines** for that.

`--json` prints `{ ok, instanceUrl, revoked, warnings }`. `revoked` is true
when the deleted key was revoked or already invalid; it is false if no
stored key existed or revocation could not be completed. Warnings are in
the document, never on stderr.

### `patchy auth set [--token-stdin] [--api-url <url>]`

Save a machine token you already hold (`source: "auth-set"`), rather than starting a login. The [instance resolution order](#environment-variables) applies, including the dev env. Saving a key for one instance leaves other instances untouched. By default, `auth set` requires a terminal and reads the key from a non-echoing prompt. Pass `--api-url` to also save that base URL. Ordinary first-run publishing uses `patchy login`; this command remains for existing keys, including the dev seed and packed automation.

```sh
patchy auth set --api-url https://pages.example.com
```

For automation that already has a key, the packed workflow saves it through
stdin without putting the token in an argument or output:

<!-- patchy-packed-cli-e2e:start -->

```sh
set +x
: "${PATCHY_SETUP_URL:?Set PATCHY_SETUP_URL to your Patchy Cloud instance}"
: "${PATCHY_SETUP_TOKEN:?Set PATCHY_SETUP_TOKEN to a machine token you already hold}"
printf '%s' "$PATCHY_SETUP_TOKEN" | patchy auth set --token-stdin --api-url "$PATCHY_SETUP_URL"
```

<!-- patchy-packed-cli-e2e:end -->

### `patchy whoami [--api-url <url>]`

Verify the configured credentials against the instance. Prints the user, company, role and machine.

```sh
patchy whoami
# User: Patchy Dev (dev@patchy.local)
# Company: Patchy Dev (patchy-dev)
# Role: admin
# Machine: Dev Machine (tok_dev)
```

`--json` returns `Identity` directly, with no `ok` wrapper:
`{ user: { id, email, name }, company: { id, handle, name }, role, machine: { id, name } }`.
The machine id is its token id. With no key, this command exits 1 (`local`),
`Run: patchy login`; a rejected key is exit 2.

### `patchy status [--api-url <url>]`

Report what the publishing state looks like on this machine for the resolved instance. It is strictly local — it never contacts the instance it names — and it exits `0` whether or not anything is configured, so it answers rather than checks. JSON is its only output format, with or without `--json`.

```sh
patchy status
# {
#   "instanceUrl": "https://pages.example.com",
#   "instanceSource": "config",
#   "hasToken": true,
#   "tokenSource": "login",
#   "stateDir": "/home/you/.patchy",
#   "hasDefaultStyle": false,
#   "cliVersion": "0.0.1"
# }
```

`instanceSource` names what selected the URL: `flag`, `dev-env`, `env`, `config`, or `default`. `hasToken` walks the same credential chain as every authenticated command: `PATCHY_API_TOKEN`, stored credential for this instance, then the dev seed. `tokenSource` is `login` or `auth-set` for the selected saved key, or `null` for an environment/dev-env key, an older entry without provenance, or no usable key. The token itself is never printed.

Credentials the probe cannot read — a file in the previous single-instance format,
malformed JSON, an unreadable file, or an invalid entry for this instance — are
reported as `hasToken: false` rather than raised as an error. An environment key
still wins without reading that file. Otherwise, the commands that spend a key
fail closed on it: follow their local-state error rather than repeatedly trying
login or publishing. The probe leaves stored credentials untouched.

This is a picture of local availability, not proof that the instance will accept
a key. Use `whoami` for that. A false result also does not prove no key exists:
one may be in a file the probe could not read.

### `patchy validate <file>`

Validate an HTML file locally without publishing. Exits non-zero if validation fails; prints warnings otherwise.

```sh
patchy validate ./plan.html
```

### `patchy publish [file] [--name <name>] [--share company|public] [--patch <patch-id>] [--new] [--description <text>] [--force] [--api-url <url>]`

First recover the pending publish in this mode's instance-scoped attempt directory. Otherwise check the executing CLI release against `GET /api/release`, validate the file, and publish it with a tier 0 manifest and empty `tables`, `files` and `uses`. File mode never reads `patchy.json`. On success it prints the address, patch ID, tier, version number, provisioned and unused resources, and sharing scope. The JSON response includes `name`, `address`, `scope: "company" | "public"`, `tier`, `schemaRevision`, `provisioned`, `unused` and `warnings`. `publicUrl` equals `address`; the scope, not that field name, controls who may read it.

Without a file, run from the patch repo root. The config supplies its name and
tier; `patchy.json` supplies its instance, description and optional patch id.
A different effective `--api-url`, dev env or `PATCHY_API_URL` fails locally with
`instance_mismatch`, naming both URLs before any HTTP request. Correct the
override rather than removing the patch id or rebinding the repo.
`--share` works in either mode; `--name`, `--patch` and `--new` are file-only.
File publishing accepts `--description <text>`; omitted, the cloud description
stands. Repo mode refuses that flag and points at `patchy.json`.
`--force` accepts an unshare that breaks live dependants. Without it, the instance
returns `has_dependants` with their names and owners. Ask the person you are
working for before forcing.

Repo publish first recovers `.patchy/publish/<instance-hash>/attempt/<key-hash>.json`.
Otherwise it checks the exact pin, executing CLI and installed runtime against
the instance release; executes config; checks generated declarations and server
module names; builds with the repo's Vite toolchain; checks both import graphs;
runs `tsc --noEmit`; and checks the evident tier. Stale generation fails locally
with `stale_generated` before the build; run `patchy refresh`.
Leftover files or external resource dependencies fail loudly. Bundle inspection checks
resource completeness: embed resources, inline scripts and styles, and remove
CSS `@import`. It does not duplicate core's tier 0 safe-HTML policy or restrict
hyperlinks: fragment, relative and external anchors have the same acceptance in
both tiers, while the runtime sandbox still governs navigation.
The local HTML cap is 512 KiB at tier 0 and 10 MiB at tiers 1 and 2; either excess
is `too_large`, with a largest-contributor report. `server/` below tier 2 remains
`tier_mismatch`; scripts require at least tier 1. A failed repo build never falls
back to a static file.

Tier 2 bundles `server/` into one closed module with no dynamic imports.
The server graph allows `patchy/server`, `patchy/csv` when available, generated
server helpers and company code. The page imports server modules only as types.
`handlers` and `sdkImports` are recorded in the manifest. The instance inspects
the stored server bytes in a throwaway process; descriptor disagreement, a
top-level throw, an unresolved import or an unfinished initializer is
`invalid_manifest`, exit 2. Local descriptor failures are exit 1. Zero handlers
publishes with a warning.

Every publish JSON success includes `artifacts.html: { sha256, bytes }`.
Tier 2 adds `artifacts.server: { sha256, bytes }` and
`handlers: [{ name, kind }]`, sorted by name. Recovery persists both bodies.

The complete request, owner and local notices are persisted in an atomically
selected attempt directory before sending; recovery retains those notices.
Creates and updates apply the returned patch id and
description sync stamp to `patchy.json`, preserving the stored instance and its spelling. A conflicting
existing patch id or a late instance edit refuses local application and retains
the attempt. A moved repo recovers at its current root, even if its tree or
release changed. Preserve `.patchy/publish/` until recovery succeeds; replacement
credentials must belong to the original user. Restore an unintended target edit
before retrying recovery; a result never rebinds the repo.
Each successful invocation publishes or recovers exactly one version.

```sh
patchy publish ./plan.html
# Publishing to https://pages.example.com (target came from the saved config).
# Published patch
# URL: https://pages.example.com/acme/plan
# Scope: company (signed-in colleagues in your company)
# Patch ID: k7f2m9x1a3b8
# Tier: 0
# Version: 1
# Provisioned tables: none.
# Provisioned columns: none.
# Provisioned indexes: none.
# Provisioned stores: none.
# Unused tables: none.
# Unused columns: none.
# Unused indexes: none.
# Unused stores: none.
```

Credential selection is deterministic: `PATCHY_API_TOKEN` wins, then the token stored for the resolved instance, then the token seeded beside a dev-env URL. A login therefore outranks the seed. With no key, publish exits 1 (`local`), `Run: patchy login`. A rejected credential is reported as-is; the CLI never starts a login or obtains a replacement on your behalf.

Publishing a previously seen file updates the same patch. `--patch <patch-id>` is update-only for a live patch owned by your user, through any of that user's machine tokens. A same-company non-owner receives `not_owner`; a retired or deleted target receives `patch_retired` or `patch_deleted`. These definitive refusals preserve the repo's patch id. Restore the patch or arrange reassignment before publishing; only a gone target requires intentionally creating another patch.

Every patch has an address at `/<company>/<name>` and numbered versions at `/<company>/<name>/~v/<n>`. Set or rename it with `--name quarterly-plan`: 3–32 lowercase letters, digits or hyphens, no leading or trailing hyphen. An explicit collision is `name_taken`; `patches` and `connections` are reserved names. Without `--name`, a create normalises the filename, falls back to `patch` when unusable, and adds `-2`, `-3`, and so on on collision. Republishing keeps its name unless explicitly renamed. The old name redirects with 308 until another patch takes it. Retire and delete reserve the patch's names until the deletion sweep reclaims it.

Before sending, the CLI authenticates the publishing key and saves the whole request, a fresh `publishKey`, the owning user ID, the original file path and cache application context in its instance-scoped state directory. The next `publish` authenticates again and recovers that attempt **before** checking today's file, cache, flags or release. A replacement token for the same owner can recover it; a different user is refused locally without sending the saved content or deleting the attempt. A successful replay updates the original file's cache and exits without another version, even if you passed a different file or `--new`.

Recovery accepts retained receipts from before description or artifact metadata was added.
It validates the receipt before applying its patch identity and clearing the
attempt. Under `--json`, the retained fields are preserved without inventing
`description`, `descriptionUpdatedAt` or `artifacts`. Fresh publishes require
all three fields from the instance.

Authentication failures, throttling, quota refusals, lost replies, server failures and failed cache writes keep the attempt recoverable. A definitive refusal clears it so you can correct the input or target state and start a fresh attempt. The complete [definitive-refusal clearing list in ADR-0004](../../docs/adr/ADR-0004-cli-contract-for-agents.md#definitive-publish-refusals) includes ownership and lifecycle refusals. Keep the state directory and sign in as the original owner when recovering; never discard an attempt merely because its result is unknown.

Concurrent invocations through the same instance and state directory resend the same persisted attempt rather than replacing it or refusing contention. Each authenticates the attempt's original owner before sending, including an invocation that loses the race to create it. Killing a process leaves the attempt available for recovery. A response clears only its matching publish key, so a stale response cannot remove a newer attempt.
If the selected attempt settles before a competing invocation can read it, that
invocation exits locally asking to run publish again rather than sending its own
unselected payload.

The executing CLI must match the instance release exactly. A local mismatch exits 1 with `kind: "local"` and `code: "release_mismatch"`; an instance mismatch exits 2 with `kind: "rejected"`. Install the package from `GET /api/release`, or run `patchy refresh` inside a repo. Repo publishing admits tier 0, 1 and 2 with declared resources; tier 2 production admission requires fleet execution. New local dev starts check the same release; a running session survives upgrades.

File publishing onto a patch with cumulative table or store inventory is still
`has_primitives` (422, exit 2, `rejected`), even if its current version omits
those definitions. Publish that patch from its repo, now supported by this CLI.
For `patch_not_openable`, correct the shared-table declaration or restore source
access. For `connection_not_connected`, an admin reconnects at
`/company/connections`; `stale_generated` requires `pnpm patchy refresh`.
Connection secrets belong only in the admin's browser connect/rotate form,
never CLI arguments or an agent transcript.

Without `--share`, a new patch defaults to `company` and an update preserves the patch's current scope. An explicit `--share company` or `--share public` sets it in either direction while publishing the new version:

```sh
patchy publish ./plan.html --share public --json
patchy publish ./plan.html                 # updates content, stays public
patchy publish ./plan.html --share company # updates content, takes it back inside
```

### `patchy share <file> <company|public>` or `patchy share --patch <patch-id> <company|public>`

Change an existing patch's sharing without publishing a version. Name the file it was published from to use the CLI's per-instance cache, or pass `--patch <patch-id>`; one or the other, not both. Only the owner user can change sharing, through any of their machine tokens. Company membership or an admin role alone does not grant that right.

From a published repo, `patchy share company|public` uses `patchy.json` without
a file or `--patch`. An unpublished repo is a local refusal.
`patchy share --share company|public` selects the same scope explicitly.

Sharing a served tier 2 version publicly is `tier2_not_public`, exit 2, through
both the CLI and portal. The instance reads the served version, not local config.
Publishing tier 2 to a public patch requires `patchy publish --share company`.
To roll a public patch back to tier 2, change its scope to company first.
While tier 2 is served, older tier 1 pages get only `me`; other direct operations
are `server_required` until rollback serves tier 1 again. Tier 2 pages always
use their handlers, even after rollback.

```sh
patchy share ./plan.html public
# Changed patch sharing
# URL: https://pages.example.com/acme/plan
# Scope: public (anyone with the link)
# Patch ID: k7f2m9x1a3b8

patchy share --patch k7f2m9x1a3b8 company --json
# {"ok":true,"patchId":"k7f2m9x1a3b8","scope":"company","publicUrl":"https://pages.example.com/acme/plan"}
```

Share uses the same credential chain as publish. With no key it exits 1 (`local`), `Run: patchy login`; a missing cached file target is also `local`. A same-company non-owner receives `not_owner`, a non-live patch receives `wrong_state`, and a foreign or gone patch answers 404. Each is `rejected`, exit 2.

Only the current version of a public patch is public; older versions stay behind the company door. Read company pages through the user's signed-in browser. The current public version has `Cache-Control: public, max-age=60` at both `/<company>/<name>` and `/<company>/<name>/~v/<current n>`. Older versions, and all versions after changing to company, have origin responses of `private, no-store` and answer 401 to a cookie-free fetch. A previously cached public copy may remain reachable for up to 60 seconds; already downloaded copies cannot be recalled.

### Lifecycle and description commands

All commands below accept `--json`. Omit the target in a published repo to use
its `patchy.json` id, pass the original HTML file to use its per-instance cache,
or pass `--patch <id>`. A file and `--patch` conflict. An unpublished repo is a
local refusal. These acts never create patches.

| command                                                                        | behaviour                                                                                                                                       | `--json` success                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `patchy retire [file] [--patch <id>] [--force]`                                | Retire a live owned patch indefinitely, preserving everything.                                                                                  | `{ ok, patchId, state: "retired", retiredAt }`          |
| `patchy delete [file] [--patch <id>] [--yes] [--force]`                        | Delete from live or retired for a fixed 30-day recovery window. Confirm interactively or pass `--yes`; non-interactive calls without it exit 1. | `{ ok, patchId, state: "deleted", deletedAt, purgeAt }` |
| `patchy restore [file] [--patch <id>] [--force]`                               | Bring a retired or deleted patch back live at its existing address before `purgeAt`.                                                            | `{ ok, patchId, state: "live" }`                        |
| `patchy rollback <n> [file] [--patch <id>]`                                    | Serve retained version `n` of a live patch. Tables, files, sharing, description and name do not move.                                           | `{ ok, patchId, currentVersion, address }`              |
| `patchy describe "<text>" [--patch <id>]` or `patchy describe <file> "<text>"` | Set the description while live or retired; repo mode rewrites `patchy.json` in the same run.                                                    | `{ ok, patchId, description, descriptionUpdatedAt }`    |
| `patchy describe [file] --clear [--patch <id>]`                                | Clear the cloud description, rather than passing empty or whitespace-only text. A cleared repo description must be filled before publishing.    | Same description response.                              |

Retire and delete from live refuse with `has_dependants` unless forced; delete
from retired needs no dependant acknowledgement. Restore refuses with
`sources_off` when its current version reads retired, deleted or gone sources.
Both refusals print the full list and end with "Ask the person you are working
for before forcing." `--yes` confirms deletion; it does not accept dependant
breakage. `--force` accepts breakage; it does not confirm deletion.

Refusals are `rejected`, exit 2. The failure document preserves `code` and the
applicable `dependants`, `sources`, `state`, `owner` or `purgeAt` fields.
`wrong_state` reports the current state; `version_unavailable` refuses a missing
rollback version. `not_owner` names the owner and asks for reassignment, never a
new patch. Publishing off patches returns `patch_retired` or `patch_deleted`,
with restoration or admin guidance. Restore past `purgeAt` is `patch_deleted`.

A successful delete forgets matching file-cache entries only after the response.
It keeps the repo id and reserves every name until reclamation. Restore a deleted
file patch by id because its cache entry is gone. A still-fresh public cache may
serve for up to 60 seconds; downloaded copies cannot be recalled.

## Exit codes

The code says who has to act, so an agent can branch on it without reading the message:

| code | kind          | meaning                                | examples                                                                                                    |
| ---- | ------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0    | ok            | the command's act succeeded            | login handoff or still pending; logout even if courtesy revocation fails                                    |
| 1    | `local`       | correct the call, files or local state | bad args, file missing, HTML fails validation, no key, foreign login code, malformed state                  |
| 2    | `rejected`    | the instance returned a refusal        | rejected key, missing target, quota/rate limit, decoded `busy`/`source_unavailable`, terminal login refusal |
| 3    | `unreachable` | no usable answer from the instance     | DNS/connect/timeout, an unmodelled 5xx, a body the CLI could not read                                       |
| 130  | interrupted   | SIGINT or SIGTERM                      |                                                                                                             |

A decoded wire refusal is `rejected`, including the API's declared 503 `busy`
and `source_unavailable` responses. Other 4xx responses are rejected; transport
failures, unmodelled 5xx and unreadable bodies are unreachable. A bug in the CLI
is `Unexpected error: <message>`, exit 1; add `--log-level debug` for the stack.
Text diagnostics can include multiple repair or validation lines. Branch on the
exit code and optional domain code, not prose or its line count.

Examples of login's terminal refusals (all exit 2):

- `The login was denied in the browser. Nothing was saved. Run: patchy login`
- `The login expired before it was confirmed (codes last ten minutes). Run: patchy login`
- `No login is pending for code XXXX-XXXX on <instance>; it may already have been reported. Run: patchy login`

`patchy login --complete --wait 0` answering `pending` is exit 0.
After logout outside a worktree, with no environment key, `patchy whoami`
is exit 1 with `Run: patchy login`. A failed courtesy revocation is only a
warning after the local logout succeeds, never exit 3.

## Global flags

Every command takes these, before or after the subcommand:

- `--api-url <url>` — the highest-precedence instance override; for repo commands it must match the authoritative stored instance. See [precedence](#environment-variables).
- `--json` prints one result document on stdout. Command success shapes are documented above; `auth set` prints `{ "ok": true, "instanceUrl" }`, `validate` prints `{ "ok": true, "warnings" }`, and `whoami`, `publish`, `share`, `retire`, `delete`, `restore`, `rollback` and `describe` print the API shapes in [`docs/API.md`](../../docs/API.md). Publish and share include `scope`. `status` prints JSON either way.

A failure is `{ ok: false, error, kind, code?, state?, owner?, dependants?, sources?, purgeAt?, warnings? }`
on stderr, ordinarily with empty stdout and the exit code for `kind`. Lifecycle
refusals retain the affected owner, patch state, dependant/source lists or reclaim
date. Notices discovered before a later failure remain in `warnings`; success
warnings stay in the stdout document. There is no separate JSON-mode warning output.

Branch on `kind`/exit first, then `code`. Codes preserve wire refusals and identify
local checks, including repo validation, `invalid_description`, and dev's
`not_additive` and `not_running`. Local checks are exit 1, `local`; the same code
on a wire refusal is exit 2, `rejected`. Meanings and remedies are in the
[local-code contract](../../docs/adr/ADR-0004-cli-contract-for-agents.md#local-repo-refusal-codes).
Other local failures may have no code; terminal login refusals currently use
`kind` and `error` without a code.

Argument parse failures can print usage on stdout before the error, as
ADR-0004 records. Check the exit code before parsing stdout as a success document.

## Command flags

- `--complete [code]` — on `login`, finish the pending device login; an optional code must match the saved one.
- `--wait <seconds>` — on `login --complete`, poll for up to this long (default 60); zero polls once and returns immediately if still pending.
- `--token-stdin` — on `auth set`, read exactly one non-empty token from redirected stdin. This is the explicit automation path and is rejected when stdin is a terminal.
- `--name <name>` — on file-mode `publish`, set or rename the patch; repo mode uses `patchy.config.ts`.
- `--share company|public` — on `publish`, explicitly set who may read the patch. Without it, creates default to company and updates preserve scope.
- `--new` — on `publish`, always create a new patch with a server-generated ID instead of updating the one previously published from this path. It cannot be combined with `--patch`.
- `--patch <patch-id>` — on `publish`, update a specific existing patch. This is update-only and never creates a new patch. It cannot be combined with `--new`.
- `--patch <patch-id>`: on `share`, `retire`, `delete`, `restore`, `rollback` and `describe`, name the patch instead of using the repo id or file cache. It cannot be combined with a file argument.
- `--force`: on `retire`, `delete`, `restore` and `publish`, accept the reported dependant/source breakage. Ask the person you are working for first.
- `--yes`: on `delete`, confirm deletion without an interactive prompt. Required for agent, JSON and non-terminal calls; it does not imply `--force`.
- `--clear`: on `describe`, remove the description instead of supplying text.
- `--description <text>`: on file-mode `publish`, set the description. Repo mode refuses the flag and points at `patchy.json`.
- `--tier 0|1` — on `init`, the new repo's declared tier; default 1.
- `--purpose <text>` — on `init`, required for agent, JSON and non-terminal invocations; asked at an interactive human terminal otherwise.
- `--as <alias>`: on `add`, override the default camelCased Postgres handle or shared table/store name.
- `--state live|retired|all` filters top-level patches and governs patch resolution at both detail levels of `list`; the default is `live`.
- `--mine` restricts patches to yours on `list` and `list patches` only.
- `--all` includes offered integrations and their state on `list connections` only, not connection detail.
- `--foreground` — on `dev`, wait and stream logs after readiness; interruption stops only a session this invocation started.

## Environment variables

- `PATCHY_API_URL` — API base URL. Overrides saved CLI config; overridden by `--api-url` and by a dev env. An effective override must match a repo's stored instance. Default outside repo mode: `http://localhost:3000`.
- `PATCHY_API_TOKEN`: machine token used by authenticated commands, including discovery, repo preparation, publishing and lifecycle management. It overrides every other token; `auth set` does not read it, and `logout` does not remove or revoke it. No configured key means a local error naming `patchy login`.
- `PATCHY_STATE_DIR` — directory for the CLI's config, credentials, pending logins, patch cache and default style. Default: `~/.patchy`.

Setting any of these to the empty string means the same thing as leaving it unset.

For `list`, `init` and file-oriented commands, the instance is resolved once per command,
in this order: `--api-url`, then the nearest upward `.local/dev/env` that `pnpm dev`
writes in a worktree, then `PATCHY_API_URL`, then saved `config.json`, then the
default.

Repo commands (`refresh`, `add`, `remove`, `dev` and its subcommands,
no-file `publish`, untargeted lifecycle/description/sharing commands and private generation) treat the
instance in `patchy.json` as authoritative. The effective override follows
`--api-url` > dev env > `PATCHY_API_URL`; if present it must match the stored URL
after normalization, otherwise `instance_mismatch` refuses before any HTTP
request. Only the effective override is compared: ignored lower-precedence
settings cannot cause a mismatch. With no override, the repo instance has source
`project` and wins over saved config and the default. A matching override keeps
its usual URL source and credential behavior; publishing never rewrites the
stored instance. `list`, `init` and file mode do not read this repo binding.

The dev seed is available only when the URL source is `dev-env`. An explicit
`--api-url` selects `flag` even for the same URL: use a stored credential or
`PATCHY_API_TOKEN` then, rather than expecting the dev-env token to follow the flag.

## State

The CLI stores state under `~/.patchy` (or `PATCHY_STATE_DIR`):

- `config.json` — the saved API base URL.
- `credentials.json` — saved machine tokens, keyed by instance, with `source: "login"` or `"auth-set"`. A login entry also carries `machine: { id, name }`. On Unix, every save creates or repairs this file to owner-only (`0600`) permissions.
- `device-login.json` — one pending login per instance: private device code, user code, both verification URLs, polling interval and expiry. Owner-only (`0600`); cleared for that instance on completion or logout.
- `publish/<instance-hash>/attempt/<key-hash>.json` — the pending publish request, original owner ID and application target, without a machine credential. Both hashes are SHA-256: the resolved API URL and publish key respectively. The owner-only payload (`0600`) is written with `wx` in a private directory (`0700`), then the complete directory atomically claims the attempt slot. An occupied slot is read and replayed, never overwritten. Settlement unlinks only that key's file and removes only an empty slot, so a stale response cannot clear a newer attempt. Repo mode uses the same layout under the repo's `.patchy/` without needing the global state directory.
- `patches.json` — the patch cache, keyed by instance and then by absolute file path, so later publishes from the same path update the same patch and `share` or `delete` can find it from the path. A successful `delete` drops every entry that pointed at the patch.
- `style.md` — the default style, owned and written by the agent skill. The CLI never reads its contents; `status` reports only whether it exists.

Credentials, pending logins and the patch cache are keyed by the resolved API base URL after trimming whitespace and trailing slashes. The remaining string must match exactly: different schemes, hosts or ports are separate entries by design.

```jsonc
// credentials.json
{ "hosts": { "https://pages.example.com": { "token": "…", "updatedAt": "…", "source": "login", "machine": { "id": "tok_…", "name": "Work laptop" } } } }
// device-login.json
{ "hosts": { "https://pages.example.com": { "deviceCode": "…", "userCode": "XXXX-XXXX", "verificationUrl": "https://pages.example.com/login/device?code=XXXX-XXXX", "verificationUrlBare": "https://pages.example.com/login/device", "interval": 5, "expiresAt": "…" } } }
// patches.json
{ "hosts": { "https://pages.example.com": { "files": { "/abs/plan.html": { "patchId": "…", "publicUrl": "…", "latestVersionNumber": 3, "updatedAt": "…" } } } } }
```

A token saved for one instance is never sent to another, and a patch ID cached for one instance is never replayed against another. Files written by an older CLI in the previous single-instance format are not migrated: the CLI stops with an error naming the file, so a token that still controls live patches is never discarded silently. Copy anything you need out of the old file, then delete it. A patch cache still named `drafts.json`, from before _patch_ replaced _draft_, is refused the same way: rename it to `patches.json` to keep updating the patches it remembers, or delete it.

## Agent skill

The package bundles the global skill at `skills/patchy/SKILL.md`: what Patchy is,
sign-in, safe static-file publishing and the `patchy init` door for building a
tool. Inside a patch repo, its project skills govern. The instance generates
those from `packages/sdk`: core loop/tables/files skills at init, Preact guidance
on tiers 1 and 2, and Postgres, shared-table and shared-store skills added by declarations.
Refresh them through the CLI, not by editing the generated copies.

## Security

Report vulnerabilities privately by following the [security policy](https://github.com/allisonmahmood/patchy-cloud/blob/main/SECURITY.md).

## License

All rights reserved for now. See [LICENSE](https://github.com/allisonmahmood/patchy-cloud/blob/main/LICENSE).
