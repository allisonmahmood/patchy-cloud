import { DeclarationMetadata, Identity, Manifest, PatchInventory } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Api from "./Api.js";
import { LocalError } from "./CliError.js";
import { executeConfig } from "./executeConfig.js";
import { ManagedProject, isProjectChanged, presentSkills, safePath } from "./ManagedProject.js";
import * as Project from "./Project.js";
import { RELEASE } from "./release.js";

export const Prepared = Schema.Struct({
  manifest: Manifest,
  identity: Identity,
  patchId: Schema.String,
  baseline: Schema.optionalKey(PatchInventory),
  metadata: DeclarationMetadata
});
export type Prepared = typeof Prepared.Type;

export class FixtureMissing extends Schema.TaggedError<FixtureMissing>()("DevFixtureMissing", {
  path: Schema.String
}) {
  override get message() {
    return `Write the required fixture at ${this.path}.`;
  }
}

const decodeManifest = Schema.decodeUnknownEffect(Manifest);
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Manifest));
const io = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new LocalError({
        message: isProjectChanged(cause) ? cause.message : `${operation} failed.`,
        cause
      })
  });

/** Only authenticated metadata crosses from the instance; fixtures remain author-owned. */
export const prepare = Effect.fn("DevPreparation.prepare")(function* (
  root: string,
  token: Redacted.Redacted
) {
  const fs = yield* FileSystem.FileSystem;
  const client = yield* Api.client(token);
  const identity = yield* client
    .me()
    .pipe(Effect.catch((error) => Api.classify(error, "Authentication failed.")));
  const repo = yield* Project.readRepo(root);
  const baseline =
    repo.patch === undefined
      ? undefined
      : yield* client
          .inventory({ params: { patchId: repo.patch } })
          .pipe(
            Effect.catch((error) => Api.classify(error, "Could not read the published inventory."))
          );
  return yield* Effect.acquireUseRelease(
    io("Begin project transaction", () => ManagedProject.begin(root)),
    (transaction) =>
      Effect.gen(function* () {
        const configPath = yield* io("Read config path", () => safePath(root, "patchy.config.ts"));
        const source = yield* fs.readFileString(configPath);
        const unresolved = yield* io("Execute config", () =>
          executeConfig(configPath, { resolve: false, source })
        );
        for (const [alias, declaration] of Object.entries(unresolved.uses)) {
          const relative =
            declaration.kind === "postgres"
              ? `fixtures/postgres-${declaration.handle}.sql`
              : `fixtures/shared-${alias}.sql`;
          const fixture = yield* io("Read fixture path", () => safePath(root, relative));
          if (!(yield* fs.exists(fixture))) return yield* new FixtureMissing({ path: relative });
          const info = yield* fs.stat(fixture);
          if (info.type !== "File") return yield* new FixtureMissing({ path: relative });
        }
        const skills = yield* io("Read project skills", () => presentSkills(root));
        const generated = yield* client
          .generate({
            payload: {
              release: RELEASE,
              manifest: unresolved,
              skills,
              ...(repo.patch === undefined ? {} : { patchId: repo.patch })
            }
          })
          .pipe(Effect.catch((error) => Api.classify(error, "Generation failed.")));
        const uses: Record<string, (typeof Manifest.Type)["uses"][string]> = Object.create(null);
        const stamps = new Map(generated.uses.map((stamp) => [stamp.alias, stamp]));
        if (
          stamps.size !== generated.uses.length ||
          stamps.size !== Object.keys(unresolved.uses).length
        )
          return yield* new LocalError({
            message: "Generation returned an inconsistent declaration set."
          });
        for (const [alias, declaration] of Object.entries(unresolved.uses)) {
          const stamp = stamps.get(alias);
          if (stamp === undefined)
            return yield* new LocalError({ message: `Generation returned no stamp for ${alias}.` });
          uses[alias] = { ...declaration, id: stamp.id, revision: stamp.revision };
        }
        const manifest = yield* decodeManifest({ ...unresolved, uses });
        const metadata = generated.metadata;
        if (
          Object.keys(metadata.postgres).length + Object.keys(metadata.shared).length !==
          stamps.size
        )
          return yield* new LocalError({
            message: "Generation returned inconsistent declaration metadata."
          });
        for (const [alias, declaration] of Object.entries(uses)) {
          const actual =
            declaration.kind === "postgres"
              ? metadata.postgres[alias]?.declaration
              : metadata.shared[alias]?.declaration;
          if (
            actual === undefined ||
            actual.kind !== declaration.kind ||
            actual.id !== declaration.id ||
            actual.revision !== declaration.revision ||
            (actual.kind === "postgres" &&
              declaration.kind === "postgres" &&
              actual.handle !== declaration.handle) ||
            (actual.kind === "sharedTable" &&
              declaration.kind === "sharedTable" &&
              (actual.patchId !== declaration.patchId || actual.table !== declaration.table))
          )
            return yield* new LocalError({
              message: `Generation returned inconsistent metadata for ${alias}.`
            });
        }
        yield* io("Activate generated files", () =>
          transaction.activate(
            generated.files.filter((file) => !file.path.startsWith("fixtures/")),
            encodeManifest(manifest),
            [],
            { before: source, after: source }
          )
        ).pipe(Effect.uninterruptible);
        const resolved = yield* io("Execute resolved config", () => executeConfig(configPath));
        return {
          manifest: resolved,
          identity,
          patchId: repo.patch ?? "localdev0000",
          ...(baseline === undefined ? {} : { baseline }),
          metadata
        } satisfies Prepared;
      }),
    (transaction, exit) =>
      io("Restore project transaction", () => transaction.finish(Exit.isSuccess(exit))).pipe(
        Effect.orDie
      )
  );
});
