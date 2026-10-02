# ADR-0011 — Latest-only tooling, a stable wire contract

- **Status**: Accepted
- **Date**: 2026-09-11
- **Contexts**: Publishing and SDK distribution
- **Source**: [SDK spec #193 §7](https://github.com/allisonmahmood/patchy-cloud/issues/193), [#203](https://github.com/allisonmahmood/patchy-cloud/issues/203), [bundled SDK #386](https://github.com/allisonmahmood/patchy-cloud/issues/386)

The CLI, config builders, browser client, bundled Preact and dev runtime ship as
one npm package, `patchy`, at one exact version: the **release**. Separate
packages would allow a repo to execute one config language, generate another
client and run a third runtime. One pinned devDependency makes that mismatch a
refused state rather than a compatibility matrix. The package lives in
`packages/patchy`; the executable is `patchy`.

The package stays private until launch. An instance distributes its packed bytes
at unauthenticated, immutable `GET /sdk/patchy-<release>-<digest>.tgz` and reports
their SHA-512 integrity at `GET /api/release`. The digest is the tarball's full
lowercase SHA-256. A rebuild with the same version and different bytes gets a
different URL, so pnpm installs the new bytes when refresh rewrites the pin.
Before advertising a release the instance validates its local archive and saves
those bytes in the durable content store, replacing any damaged stored copy.
Previously advertised URLs remain retrievable across deployments. Build and copy
steps keep only the current digest archive and `release.json`; local build outputs
are not a retention store. Startup does not read historical archives. Downloads
verify their digest, so a corrupt historical archive fails its own request without
blocking the current release. Manifest and wire versions are separate constants,
checked at build time against the API contract. Release metadata must describe
the actual artifact, never a configured version with unrelated bytes or a
placeholder integrity.

Four versions have separate meanings: the release is the tooling package;
`manifestVersion` describes persisted definitions; `wireVersion` selects the
runtime operation contract; schema revision describes a patch's cumulative
inventory. Publish stamps the wire version on the server, never from an uploaded
claim. Readers for persisted manifest versions remain available. Retiring a wire
is a separate breaking-change decision with a needs-rebuild door, not a package
upgrade silently taking old patches down.

For tier 2, wire 1 also fixes the private guest protocol and workerd compatibility
date, `2026-09-24`, with Node compatibility explicitly disabled. Both the internal
`packages/execution` dependency and tier 2 patch repos pin `workerd` to
`1.20260924.1`. Each published version retains its
server bytes, descriptors and server-stamped wire version. Loading and inspection
use that wire's guest protocol and compatibility date, never the latest tooling
release's settings. The engine and inspection share these constants; see
[ADR-0012](./ADR-0012-credential-free-execution-service.md).

`patchy/config` is a pure builder surface. The CLI executes a config in a child
process and validates its serializable manifest; the server never executes
uploaded config. Owned row types are inferred from the config, while declarations
use generated schemas and revision stamps. The generated client imports the
config's type and the manifest's value, so config execution and Node dependencies
stay outside the browser graph.

`patchy/client` contains neither Node nor PGlite. It uses the document-bound
broker port in cloud and local environments and exposes one `PatchyError`.
Tier 1 writes are never replayed. The tier 2 client retries a lost query reply
once. A mutation's `unknown_outcome` offers explicit `retry()` with its original
mutation key and captured arguments; actions are never replayed. HTTP is a
test adapter, not permission for a patch frame to fetch the runtime directly.
`patchy/dev` is the Node entrypoint composing local PGlite resources and fixtures
with the production shell, dispatcher and supervised workerd executor.
PGlite is packed as a bundled dependency so its WASM/data and worker imports
remain intact. SDK bytes come from the instance; the patch repo's workerd and
builder-owned toolchain dependencies are installed with lifecycle scripts disabled.

`patchy/preact` exports the UI API with compat semantics, hooks and signals.
`patchy/preact/jsx-runtime` and `patchy/preact/jsx-dev-runtime` support
`jsxImportSource: "patchy/preact"`. Every entry initializes the same compat
instance before rendering. In DEV, the SDK also initializes `preact/debug`
against that instance; patch code does not import debugging support.
Preact 10.29.8, `@preact/signals` 2.11.3 and `@preact/signals-core` 1.14.4 are
exact bundled dependencies, not patch dependencies or overrides. They remain
real packages inside the tarball so the optimizer, JSX runtimes, hooks and
signals resolve one shared instance, including its types and licenses.

Exports name individual entries, never a `patchy/*` wildcard. Config and local
dev remain tooling entries; the generated client and Preact entries are for the
page. `patchy/server` ships the handler builders and guest entry for hosted code;
`patchy/csv` ships CSV parsing and stringification for either graph. The graph
import checks run independently on the page and server publication graphs.

Managed package pins are `patchy` on every tier and `workerd` on tier 2.
Changing tier plus `refresh` adds or removes the workerd pin and generated
server helpers without rewriting authored page or handler code.
Vite, `vite-plugin-singlefile`, TypeScript and `@types/*` belong to the builder.
The scaffold supplies caret ranges and the release reports tested versions and
accepted ranges. Dev and publish refuse unsupported loaded Vite and plugin
versions with `toolchain_unsupported` and an upgrade command. Refresh reports a
required upgrade in its warnings without editing those dependencies.

New publishes and dev starts require the pin, executing CLI and loaded runtime,
where present, to equal the instance's current release. A mismatch names both
releases and `patchy refresh`. A saved publish is recovered before this check;
upgrading cannot erase its key or change its owner. Running dev sessions and
already deployed bundles are not invalidated by a release: deployed bundles use
the stable, versioned runtime wire rather than an exact-current SDK check.
