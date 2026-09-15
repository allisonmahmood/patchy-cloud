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

const sameDefinition = (before: Definition, after: Definition): boolean => {
  if (isDeepStrictEqual(before, after)) return true;
  if (!("columns" in before) || !("columns" in after)) return false;
  if ((before.shared ?? false) !== (after.shared ?? false)) return false;
  if (Object.keys(before.columns).length !== Object.keys(after.columns).length) return false;
  for (const [name, column] of Object.entries(before.columns)) {
    const next = after.columns[name];
    if (next === undefined) return false;
    if (isDeepStrictEqual(column, next)) continue;
    if ((column.optional ?? false) !== (next.optional ?? false)) return false;
    if (!isDeepStrictEqual({ ...column, optional: false }, { ...next, optional: false }))
      return false;
  }
  if (Object.keys(before.indexes).length !== Object.keys(after.indexes).length) return false;
  for (const [name, index] of Object.entries(before.indexes)) {
    const next = after.indexes[name];
    if (
      next === undefined ||
      (index.unique ?? false) !== (next.unique ?? false) ||
      !isDeepStrictEqual(index.columns, next.columns)
    )
      return false;
  }
  return true;
};

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
        !sameDefinition(before, definition)
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
