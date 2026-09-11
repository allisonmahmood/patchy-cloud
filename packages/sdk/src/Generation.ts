// @effect-diagnostics nodeBuiltinImport:off — Node's file-URL conversion locates packaged release skills.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fileURLToPath } from "node:url";
import {
  Catalog,
  CURRENT_RELEASE,
  Generated,
  GenerateRequest,
  MANIFEST_VERSION,
  isManagedOutputPath,
  type TableDefinition
} from "@patchy/api";
import { ConnectionStore, Postgres } from "@patchy/integrations";
import { Patches } from "@patchy/patches";
import { generateClient } from "./generateClient.js";

export class ReleaseMismatch extends Schema.TaggedError<ReleaseMismatch>()("SdkReleaseMismatch", {
  release: Schema.String
}) {
  readonly code = "release_mismatch" as const;
  override get message() {
    return `Release ${this.release} does not match ${CURRENT_RELEASE}. Run: patchy refresh`;
  }
}
export class UnsupportedManifestVersion extends Schema.TaggedError<UnsupportedManifestVersion>()(
  "UnsupportedManifestVersion",
  { version: Schema.Int }
) {
  readonly code = "invalid_manifest" as const;
  override get message() {
    return `Generation refused: manifest version ${this.version} is not supported.`;
  }
}
export class UnknownProjectSkill extends Schema.TaggedError<UnknownProjectSkill>()(
  "UnknownProjectSkill",
  { skill: Schema.String.check(Schema.isMaxLength(128)) }
) {
  readonly code = "invalid_manifest" as const;
  override get message() {
    return `Generation refused: present skill ${JSON.stringify(this.skill)} is not offered by this release.`;
  }
}
export class UnsafeGeneratedPath extends Schema.TaggedError<UnsafeGeneratedPath>()(
  "UnsafeGeneratedPath",
  { path: Schema.String }
) {
  readonly code = "invalid_manifest" as const;
  override get message() {
    return "Generation refused: an output path is outside the managed project set.";
  }
}
export class ConnectionNotConnected extends Schema.TaggedError<ConnectionNotConnected>()(
  "SdkConnectionNotConnected",
  {
    handle: Schema.String
  }
) {
  readonly code = "connection_not_connected" as const;
  override get message() {
    return `Postgres connection ${this.handle} is not connected. Ask an administrator at /company/connections.`;
  }
}
export class PatchNotOpenable extends Schema.TaggedError<PatchNotOpenable>()(
  "SdkPatchNotOpenable",
  {
    patchId: Schema.String,
    table: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {
  readonly code = "patch_not_openable" as const;
  override get message() {
    return `Patch or shared table ${this.patchId}${this.table === undefined ? "" : `/${this.table}`} is not openable. Ask its owner or an administrator at /company.`;
  }
}
export type GenerationRefused =
  | ReleaseMismatch
  | UnsupportedManifestVersion
  | UnknownProjectSkill
  | UnsafeGeneratedPath
  | ConnectionNotConnected
  | PatchNotOpenable;
export class GenerationUnavailable extends Schema.TaggedError<GenerationUnavailable>()(
  "GenerationUnavailable",
  {
    cause: Schema.Defect()
  }
) {
  override get message() {
    return "Project generation metadata or release files are unavailable.";
  }
}
export class Generation extends Context.Service<
  Generation,
  {
    readonly catalog: (
      companyId: string,
      all: boolean
    ) => Effect.Effect<typeof Catalog.Type, GenerationUnavailable>;
    readonly generate: (
      companyId: string,
      request: typeof GenerateRequest.Type
    ) => Effect.Effect<typeof Generated.Type, GenerationRefused | GenerationUnavailable>;
  }
>()("@patchy/sdk/Generation") {}

const coreSkills = ["patchy-loop", "patchy-tables", "patchy-files"];
const knownSkills = [...coreSkills, "patchy-postgres", "patchy-shared-tables"];
const root = "patchy/_generated";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const isPatchNotOpenable = Schema.is(PatchNotOpenable);
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const columnType = (
  column: (typeof TableDefinition.Type)["columns"][string],
  patchId: string
): string => {
  const base =
    column.kind === "integer" || column.kind === "number"
      ? "number"
      : column.kind === "boolean"
        ? "boolean"
        : column.kind === "json"
          ? "unknown"
          : column.kind === "ref"
            ? `Id<${JSON.stringify(`${patchId}/${column.table}`)}>`
            : "string";
  return `${base}${column.optional ? " | null" : ""}`;
};
const sharedClient = (source: Patches.SharedTable): string => {
  const indexes = { ...source.definition.indexes };
  for (const [name, column] of Object.entries(source.definition.columns)) {
    if (column.kind === "ref" && !Object.hasOwn(indexes, name)) indexes[name] = { columns: [name] };
  }
  return `import { createSharedTable } from "patchy/client";
import type { Call } from "patchy/client";
import type { Id } from "patchy/config";
export interface Row {
  readonly id: Id<${JSON.stringify(source.id)}>;
  readonly createdAt: string;
  readonly updatedAt: string;
${Object.entries(source.definition.columns)
  .map(
    ([name, column]) =>
      `  readonly [${JSON.stringify(name)}]: ${columnType(column, source.patchId)};`
  )
  .join("\n")}
}
type Indexes = ${JSON.stringify(indexes)};
export function createClient(alias: string, call: Call) { return createSharedTable<Row, Indexes>(alias, call); }
`;
};
const definitionContext = (title: string, definition: unknown) =>
  `# ${title}\n\nThis is generated metadata, never business rows. Edit patchy.config.ts for owned definitions, then run patchy refresh.\n\n\`\`\`json\n${json(definition)}\`\`\`\n`;

export const make = Effect.gen(function* () {
  const connections = yield* ConnectionStore.ConnectionStore;
  const patches = yield* Patches.Patches;
  const fs = yield* FileSystem.FileSystem;
  const catalog = Effect.fn("Generation.catalog")(function* (companyId: string, all: boolean) {
    const connected = yield* connections
      .list(companyId)
      .pipe(Effect.mapError((cause) => new GenerationUnavailable({ cause })));
    const sharedTables = yield* patches
      .sharedTables(companyId)
      .pipe(Effect.mapError((cause) => new GenerationUnavailable({ cause })));
    return {
      connections: connected
        .filter((entry) => all || entry.status === "connected")
        .map(({ id, handle, integration, description, status }) => ({
          id,
          handle,
          integration,
          description,
          status
        })),
      sharedTables,
      ...(all
        ? {
            offered: [
              {
                integration: "postgres" as const,
                connected: connected.some((entry) => entry.status === "connected")
              }
            ]
          }
        : {})
    } satisfies typeof Catalog.Type;
  });
  const generate = Effect.fn("Generation.generate")(function* (
    companyId: string,
    request: typeof GenerateRequest.Type
  ) {
    if (request.release !== CURRENT_RELEASE || request.manifest.release !== CURRENT_RELEASE)
      return yield* new ReleaseMismatch({
        release: request.release !== CURRENT_RELEASE ? request.release : request.manifest.release
      });
    if (request.manifest.manifestVersion !== MANIFEST_VERSION)
      return yield* new UnsupportedManifestVersion({ version: request.manifest.manifestVersion });
    const skills = new Set([...coreSkills, ...request.skills]);
    for (const skill of skills) {
      if (!knownSkills.includes(skill))
        return yield* new UnknownProjectSkill({ skill: skill.slice(0, 128) });
    }
    if (request.patchId !== undefined) {
      const existing = yield* patches
        .find(request.patchId)
        .pipe(Effect.mapError((cause) => new GenerationUnavailable({ cause })));
      if (Option.isNone(existing) || existing.value.patch.companyId !== companyId)
        return yield* new PatchNotOpenable({ patchId: request.patchId });
    }
    const files = new Map<string, string>();
    const uses: Array<
      (typeof Generated.Type)["uses"][number] & {
        declaration: (typeof GenerateRequest.Type)["manifest"]["uses"][string];
        skill: string;
        context: string;
        client: string;
        fixture: string;
      }
    > = [];
    const declarations: Array<{
      kind: "table" | "files";
      name: string;
      definition: unknown;
      skill: string;
      context: string;
    }> = [];
    const shared: Record<string, string> = Object.create(null);
    const factories: Record<string, string> = Object.create(null);
    const available = Object.values(request.manifest.uses).some(
      (entry) => entry.kind === "postgres"
    )
      ? yield* connections
          .list(companyId)
          .pipe(Effect.mapError((cause) => new GenerationUnavailable({ cause })))
      : [];
    for (const [alias, declaration] of Object.entries(request.manifest.uses)) {
      const context = `${root}/context/${alias}.md`;
      const client = `${root}/uses/${alias}.ts`;
      if (declaration.kind === "postgres") {
        const connection = available.find(
          (entry) => entry.handle === declaration.handle && entry.status === "connected"
        );
        if (connection === undefined)
          return yield* new ConnectionNotConnected({ handle: declaration.handle });
        const resolved = {
          kind: "postgres" as const,
          handle: connection.handle,
          id: connection.id,
          revision: connection.metadataRevision
        };
        const snapshot = yield* connections
          .snapshot(companyId, resolved.id, resolved.revision)
          .pipe(Effect.mapError((cause) => new GenerationUnavailable({ cause })));
        const output = Postgres.postgres.generate(
          { ...resolved, description: connection.description },
          snapshot
        );
        const fixture = `fixtures/postgres-${connection.handle}.sql`;
        files.set(client, output.client);
        files.set(context, output.context);
        files.set(fixture, output.fixture);
        factories[alias] = `./uses/${alias}.js`;
        skills.add("patchy-postgres");
        uses.push({
          alias,
          id: resolved.id,
          revision: resolved.revision,
          declaration: resolved,
          skill: ".agents/skills/patchy-postgres/SKILL.md",
          context,
          client,
          fixture
        });
      } else {
        const source = yield* patches
          .sharedTable(declaration.patchId, declaration.table, companyId)
          .pipe(
            Effect.catchTags({
              PatchNotOpenable: (cause) =>
                Effect.fail(
                  new PatchNotOpenable({
                    patchId: declaration.patchId,
                    table: declaration.table,
                    cause
                  })
                )
            }),
            Effect.mapError((cause) =>
              isPatchNotOpenable(cause) ? cause : new GenerationUnavailable({ cause })
            )
          );
        const fixture = `fixtures/shared-${alias}.sql`;
        const resolved = { ...declaration, id: source.id, revision: source.schemaRevision };
        files.set(client, sharedClient(source));
        files.set(
          context,
          definitionContext(`Shared table ${alias}`, { ...source, fixture }) +
            "\nRead-only: get, getMany and indexed list. Sharing and source access are checked live.\n"
        );
        files.set(
          fixture,
          `-- Agent-authored synthetic rows for ${source.id}; no production rows are fetched.\n-- Local table: ${quote(`p_${source.patchId}`)}.${quote(source.table)}\n-- System columns: id text, createdAt timestamptz, updatedAt timestamptz.\n${Object.entries(
            source.definition.columns
          )
            .map(
              ([name, column]) =>
                `-- ${quote(name)}: ${column.kind}${column.optional ? " nullable" : " required"}${Object.hasOwn(column, "default") ? ` default ${JSON.stringify(column.default)}` : ""}`
            )
            .join("\n")}\n-- Write INSERT statements into the quoted local table above.\n`
        );
        shared[alias] = `./uses/${alias}.js`;
        skills.add("patchy-shared-tables");
        uses.push({
          alias,
          id: source.id,
          revision: source.schemaRevision,
          declaration: resolved,
          skill: ".agents/skills/patchy-shared-tables/SKILL.md",
          context,
          client,
          fixture
        });
      }
    }
    for (const [name, definition] of Object.entries(request.manifest.tables)) {
      const context = `${root}/context/table-${name}.md`;
      files.set(context, definitionContext(`Owned table ${name}`, definition));
      declarations.push({
        kind: "table",
        name,
        definition,
        skill: ".agents/skills/patchy-tables/SKILL.md",
        context
      });
    }
    for (const [name, definition] of Object.entries(request.manifest.files)) {
      const context = `${root}/context/files-${name}.md`;
      files.set(context, definitionContext(`File store ${name}`, definition));
      declarations.push({
        kind: "files",
        name,
        definition,
        skill: ".agents/skills/patchy-files/SKILL.md",
        context
      });
    }
    const skillFiles = [];
    for (const name of [...skills].sort()) {
      const path = `.agents/skills/${name}/SKILL.md`;
      const contents = yield* fs
        .readFileString(fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)))
        .pipe(Effect.mapError((cause) => new GenerationUnavailable({ cause })));
      files.set(path, contents);
      skillFiles.push({ name, path });
    }
    files.set(`${root}/client.ts`, generateClient({ shared, connections: factories }));
    files.set(
      `${root}/README.md`,
      "# Generated Patchy files\n\nDo not edit this directory. Edit patchy.config.ts, then run patchy refresh. Import patchy from ./client.js; index.json lists definitions, declarations, revision stamps, skills and contexts. manifest.json is written locally by the CLI, never by the server.\n\nInstall already ran during patchy init. Test with patchy dev. Fixtures contain synthetic local data only. Deleting .patchy/ destroys local rows and files; it does not delete company data.\n"
    );
    files.set(
      `${root}/index.json`,
      json({
        release: CURRENT_RELEASE,
        manifestVersion: MANIFEST_VERSION,
        ...(request.patchId ? { patchId: request.patchId } : {}),
        declarations,
        uses,
        skills: skillFiles
      })
    );
    for (const path of files.keys()) {
      if (!isManagedOutputPath(path)) return yield* new UnsafeGeneratedPath({ path });
    }
    return {
      ok: true as const,
      files: [...files].map(([path, contents]) => ({ path, contents })),
      uses: uses.map(({ alias, id, revision }) => ({ alias, id, revision }))
    };
  });
  return Generation.of({ catalog, generate });
});
export const layer = Layer.effect(Generation, make);
