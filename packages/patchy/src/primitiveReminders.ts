// @effect-diagnostics nodeBuiltinImport:off
// Node's structural comparison ignores object key order while preserving array order.
import { isDeepStrictEqual } from "node:util";
import { Manifest } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { LocalError } from "./CliError.js";
import * as Output from "./Output.js";

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

type Definition =
  (typeof Manifest.Type)["tables"][string] | (typeof Manifest.Type)["files"][string];

const canonical = (definition: Definition): Definition =>
  "columns" in definition
    ? {
        ...definition,
        shared: definition.shared ?? false,
        columns: Object.fromEntries(
          Object.entries(definition.columns).map(([name, column]) => [
            name,
            { ...column, optional: column.optional ?? false }
          ])
        ),
        indexes: Object.fromEntries(
          Object.entries(definition.indexes).map(([name, index]) => [
            name,
            { ...index, unique: index.unique ?? false }
          ])
        )
      }
    : definition;

/** Compare executed definitions with the previous generation, before replacing it. */
export const primitiveReminders = Effect.fn("primitiveReminders")(function* (
  root: string,
  manifest: typeof Manifest.Type
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, "patchy/_generated/manifest.json");
  const text = yield* fs.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              new LocalError({ message: "Could not read the last generated manifest.", cause })
            )
    })
  );
  if (text === undefined) return [];
  const previous = yield* decodeManifest(text).pipe(
    Effect.mapError(
      (cause) =>
        new LocalError({
          message:
            "The last generated manifest is invalid. Run patchy refresh after correcting it.",
          cause
        })
    )
  );
  const warnings: string[] = [];
  for (const kind of ["tables", "files"] as const) {
    for (const [name, definition] of Object.entries(manifest[kind])) {
      const before = previous[kind][name];
      if (
        before !== undefined &&
        before.description === definition.description &&
        !isDeepStrictEqual(canonical(before), canonical(definition))
      ) {
        warnings.push(
          `${kind === "tables" ? "Table" : "Store"} \`${name}\` changed since its last generation; check that its description still holds: '${definition.description}'`
        );
      }
    }
  }
  yield* Output.rememberWarnings(warnings);
  return warnings;
});
