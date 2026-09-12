# ADR-0011 — Latest-only tooling, a stable wire contract

- **Status**: Accepted
- **Date**: 2026-09-11
- **Contexts**: Publishing and SDK distribution
- **Source**: [SDK spec #193 §7](https://github.com/allisonmahmood/patchy-cloud/issues/193), [#203](https://github.com/allisonmahmood/patchy-cloud/issues/203)

The CLI, config builders, browser client and dev runtime ship as one npm package,
`patchy`, at one exact version: the **release**. Separate packages would allow a
repo to execute one config language, generate another client and run a third
runtime. One pinned devDependency makes that mismatch a refused state rather
than a compatibility matrix. The package lives in `packages/patchy`; the
executable is `patchy`.

The package stays private until launch. An instance distributes its packed bytes
at unauthenticated, immutable `GET /sdk/patchy-<release>.tgz` and reports their
SHA-512 integrity at `GET /api/release`. The package version names the artifact;
manifest and wire versions are separate constants, checked at build time against
the API contract. Release metadata must describe the actual artifact, never a
configured version with unrelated bytes or a placeholder integrity.

Four versions have separate meanings: the release is the tooling package;
`manifestVersion` describes persisted definitions; `wireVersion` selects the
runtime operation contract; schema revision describes a patch's cumulative
inventory. Publish stamps the wire version on the server, never from an uploaded
claim. Readers for persisted manifest versions remain available. Retiring a wire
is a separate breaking-change decision with a needs-rebuild door, not a package
upgrade silently taking old patches down.

`patchy/config` is a pure builder surface. The CLI executes a config in a child
process and validates its serializable manifest; the server never executes
uploaded config. Owned row types are inferred from the config, while declarations
use generated schemas and revision stamps. The generated client imports the
config's type and the manifest's value, so config execution and Node dependencies
stay outside the browser graph.

`patchy/client` contains neither Node nor PGlite. It uses the document-bound
broker port in cloud and local environments, exposes one `PatchyError`, and never
replays a mutation. A dispatched request with a lost reply has `unknown_outcome`:
retrying it could duplicate a write. HTTP is a test adapter, not permission for a
patch frame to fetch the runtime directly. `patchy/dev` is the Node entrypoint
composing local PGlite resources and fixtures with the production shell and dispatcher.
PGlite is packed as a bundled dependency so its WASM/data and worker imports
remain intact; installing the release needs neither registry access nor scripts.

New publishes and dev starts require the pin, executing CLI and loaded runtime,
where present, to equal the instance's current release. A mismatch names both
releases and `patchy refresh`. A saved publish is recovered before this check;
upgrading cannot erase its key or change its owner. Running dev sessions and
already deployed bundles are not invalidated by a release: deployed bundles use
the stable, versioned runtime wire rather than an exact-current SDK check.
