---
name: effect-service-conventions
description: Review spec for Effect services in this repo's Effect v4 port.
disable-model-invocation: true
metadata:
  internal: "true"
---

# Effect service review

Review changed TypeScript and directly affected call sites for the conventions below. Apply them when a change creates, moves, refactors, or consumes an Effect service in `apps/server` or the capability packages (`packages/api`, `auth`, `companies`, `patches`, `serving`, `content-store`, `sql`, `cli`, `core`). Do not demand unrelated repository-wide cleanup. Treat these conventions as authoritative when older code differs.

The server, packages and CLI run on Effect 4. These rules bind their services and consumers. Skip anything the linter or `@effect/language-service` already enforces.

## Imports and module namespaces

- Import Effect library modules from their subpaths as namespaces, for example `import * as Effect from "effect/Effect"` and `import * as Layer from "effect/Layer"`. Flag consolidated named imports from `"effect"` in touched Effect service code.
- At a service boundary, import the local service module as a namespace and use its public module shape: `PatchStore.PatchStore`, `PatchStore.make`, and `PatchStore.layer`. Flag aliases such as `import { layer as patchStoreLayer }` that erase the module namespace.
- Namespace imports are not a blanket rule. Keep named imports for whole packages such as `@patchy/api` (wire schemas, the `HttpApi`, the client), and for modules used only for a pure helper, error, schema, config value, or standalone type. Do not request `import type * as Api`.
- A package subpath that is itself a service module may use a namespace import when callers access its service/tag, `make`, or `layer` members.
- When a barrel exposes an entire service module, prefer `export * as PatchStore from "./patchStore.ts"` so consumers can use `PatchStore.PatchStore` and `PatchStore.layer`. Do not individually rename `make` and `layer` exports to simulate a namespace.

## Service definition

- Use the canonical single-file order: imports, error/schema declarations, the `Context.Service` tag with its inline interface, `make`, then `layer`.
- Keep a service's schemas/errors, `Context.Service` tag, construction, and layer in one canonical module when they form one implementation.
- Define the service interface inline in the `Context.Service` declaration. Do not retain a standalone `FooShape` or `FooServiceShape` interface/type.
- Refer to the inferred service interface as `Foo["Service"]`, including in mechanically updated routes, CLI commands, tests, and integration harnesses.
- Export a real `make` when the module owns construction. Do not create `make = Effect.succeed(...)` solely to force `Layer.effect`.
- Export the canonical layer as `export const layer = Layer...`. `Layer.effect` is not required: use `Layer.succeed`, `Layer.scoped`, or another appropriate constructor when that matches the implementation.
- In a concrete implementation module already named for the implementation, use plain `make` and `layer` (for example `FilesystemBlobStore.ts` and `AzureBlobStore.ts`).
- Keep implementation-specific names when an abstract port module contains one of several possible implementations, for example `makeAzureBlobStore` and `layerAzure` in `BlobStore.ts`.

## Dependency acquisition and runtime boundaries

- Production service construction must acquire Effect service dependencies from the environment with `yield* Foo.Foo`, and its `make`/`layer` types must expose those requirements. Flag factories or constructors that accept `Foo["Service"]` (or a plain object whose methods return `Effect`) when that value is an implementation dependency owned by the service. Passing service instances explicitly is acceptable in tests and integration harnesses; passing pure configuration, immutable domain values, or deliberate callback strategies is not service injection.
- Do not hide dependencies in module globals, closures over singleton services, or `Layer.succeed` implementations that call runtime-backed or imperative APIs. Trace helpers used by a supposedly synchronous layer far enough to verify that asynchronous services are represented in the Effect environment.
- `ManagedRuntime.make`, `runPromise`, and `runPromiseExit` belong at explicit application/framework boundaries: the server and CLI entrypoints and development/test runners. Flag their use in domain services, repositories, persistence implementations, and service constructors.
- Do not create per-feature managed runtimes to smuggle the same owned resource into multiple consumers. Compose the resource once in an application-owned layer/runtime and provide its context to integration runtimes.
- When acquisition can fail but a caller must retain fallback behavior, keep the failure typed in Effect rather than bypassing the layer through an imperative runtime. Model unavailability in service operations or with an explicit optional-service layer so downstream recovery remains visible and testable.
- During review, search touched code and affected call sites for service-instance parameters, `Layer.succeed`, `ManagedRuntime.make`, and `.runPromise`/`.runPromiseExit`. Verify that each occurrence is a legitimate test seam, pure value injection, or application boundary, not fake dependency injection or a hidden runtime.

## Errors and predicates

- Define service failures with `Schema.TaggedErrorClass` and structured attributes. Derive `message` from those attributes rather than storing an unstructured message as the only data.
- `Schema.Defect()` is not a substitute for modeling a generic error: its tag, fields, or both must identify the failure structurally, and its `message` must not merely stringify an opaque cause. A semantically precise error tag may preserve a real `cause` without inventing a redundant singleton field when no additional variable context exists; still retain any real path, resource, request, or entity context available at the wrapping site.
- Capture stable, serializable domain context such as the operation or stage, resource/path or entity identifier, and normalized category/status. Map failures where that context is known instead of wrapping an entire multi-step pipeline in one generic error. Do not add a `detail` field that merely copies `cause.message` and then use it to construct the wrapper message.
- Keep direct error attributes and log annotations safe and bounded. Do not copy raw wire payloads, command arguments or output, signed URLs, credentials, query strings, fragments, selectors, or arbitrary defect text into `detail`, `reason`, `message`, or a parallel log payload. Preserve the exact underlying value only as `cause`; expose normalized categories plus lengths/counts and safe URL protocol/hostname diagnostics where useful. Logging a sanitized error must not reintroduce a removed legacy `detail` or serialized `cause` field beside it.
- When translating or wrapping a real failure, preserve the immediate underlying error itself as `cause` alongside the structural fields so the complete error chain and stack remain available. If every construction wraps a failure, `cause` should be required; make it optional only when the same error can legitimately originate without an underlying failure.
- At a translation boundary, pass through an already structured domain error when it is part of the declared target error channel. Wrap only unknown or genuinely lower-level failures. A static factory or mapper may perform this classification when it is reused and keeps the policy next to the target error type.
- Derive the wrapper's `message` exclusively from its stable structural attributes, never from `cause`, `cause.message`, or a stringified defect. Do not replace the immediate error with only `error.cause`, erase a structured upstream error into a string, or manufacture an `Error` merely to populate `cause`. Pure validation/domain errors created without an underlying failure do not need a cause.
- Do not encode the same distinction twice with both a specific error tag and a single-value `operation`, `reason`, `kind`, or `phase` literal. Choose one coherent model: use distinct error classes and omit the redundant discriminator when callers or messages treat the failures as genuinely different, or use one service-level error with a multi-value operation discriminator and a generic message derived from that operation when the failures share the same semantics.
- Treat an error message exposed through an HTTP response, `--json` CLI output, persisted state, a served page, or another caller-visible boundary as behavior. Preserve those messages during a structural refactor. Existing distinct caller-visible messages are evidence that the failures should normally remain distinct error tags without redundant singleton discriminators, rather than being collapsed into a generic operation error.
- Split semantically distinct failures into separate error classes when a `reason`, `kind`, `phase`, or similar discriminator is used to choose the user-facing message or drive caller control flow. A discriminator used only for internal diagnostics may remain a field.
- Use `Schema.Union` of error classes when a shared schema, predicate, or helper type is useful.
- Export direct schema predicates such as `export const isFoo = Schema.is(Foo)`. Flag a private `Schema.is` constant wrapped by a redundant function with the same signature.
- Do not introduce a large `switch` or lookup table in an error's `message` getter to model failures that deserve separate error classes.
- Catch statically known tagged failures with `Effect.catchTags({ ... })`, including when handling only one tag. Do not use `catchIf` with a schema predicate merely to recover one or more known `_tag` variants, and do not use `catchTag`. `Effect.catch` is appropriate when the entire error channel is intentionally handled; `catchIf` remains appropriate for genuinely structural predicates such as inspecting an underlying platform error code.
- Do not add a helper whose only behavior is `(...args) => new SomeError({ ...args })`, including curried aliases used once with `mapError`. Construct the error at the failure boundary so its attributes and cause remain visible. Keep a mapper only when it performs real normalization, passes through existing domain errors, or adds reusable context/control flow.
- When a reusable error-to-error translation clearly belongs to the target error type, prefer a descriptive static factory on that error class over a detached production-side switch. Do not force a static method for one-off inline mappings.

## File layout and migrations

- When a service's tag and its layer live in separate files, combine them into one module per service in the owning capability package.
- Delete the old service/layer files. Do not leave compatibility re-export shims. Mechanically update every consumer, including routes, CLI commands, tests, and integration harnesses, to the canonical path.
- Do not flag genuinely separate implementation/adapter modules merely because they remain in an implementation-oriented directory.
- Avoid substantive route or CLI redesign in service-cleanup PRs. Mechanical import, layer, and `Service["Service"]` updates are expected when required to remove obsolete paths or shapes.

## Port shapes settled by #54

These are decided; a diff that improvises a different shape is a finding.

- `/api/*` is one `HttpApi` defined in `packages/api` (wire schemas, the API, the derived client) and consumed by the CLI. Serving owns `/`, `/d/*` and `/healthz`; Auth mounts session pages and Companies' page renderers through plain `HttpRouter` routes. Map domain errors onto declared `HttpApiError` responses at the handler; do not let an untyped failure decide a status code.
- Persistence is `@effect/sql-pg` with `SqlSchema` and `sql.withTransaction`, Postgres only, row decoding through Schema in one module. Schema changes go through Effect's `Migrator`.
- Tests use `@effect/vitest` (`it.effect`, `it.layer`), `HttpApiTest` for API routes, `NodeHttpServer.layerTest` for raw-socket cases, `TestClock` for the clock, and `Scope` for manual close pairs. Inject faults with an alternate layer.
- Read configuration through Effect `Config` per capability, with `Redacted` for secrets.
- A capability with one consumer stays a module. Flag a new package, service, or layer introduced before a second consumer exists.

## Change discipline

- Preserve useful comments, invariants, and specification documentation while moving code.
- Do not add large tests solely to prove a mechanical refactor. Update existing tests and imports as needed.
- If backend behavior changes, require focused tests. Use test implementations/layers for external services only; do not mock out core business logic.
- Do not require `Layer.effect`, universal namespace imports, generic `make`/`layer` names for abstract-port implementations, separate error classes for diagnostic-only fields, or new tests for import-only changes.

## Reporting

Report only concrete violations introduced or retained in the change's scope. Anchor each finding to the smallest line range, cite the rule above, and state the expected fix. With no findings, report "No Effect service findings" on one line.
