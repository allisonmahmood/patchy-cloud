import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parseTree, type ParseError } from "jsonc-parser";

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ devDependencies: Schema.Struct({ patchy: Schema.String }) })
  )
);

/** Replace only the effective pin literal; refuse a changed pin or unfinished author edit. */
export function patchPackagePin(source: string, expected: string, replacementLiteral: string) {
  const decoded = decode(source);
  if (Option.isNone(decoded) || decoded.value.devDependencies.patchy !== expected) return undefined;
  const errors: ParseError[] = [];
  let node = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length) return undefined;
  for (const key of ["devDependencies", "patchy"]) {
    if (node?.type !== "object") return undefined;
    // JSON.parse uses the last duplicate key, including escaped spellings of the same name.
    node = node.children?.filter((property) => property.children?.[0]?.value === key).at(-1)
      ?.children?.[1];
  }
  if (node?.type !== "string") return undefined;
  const start = node.offset;
  const end = start + node.length;
  return {
    contents: source.slice(0, start) + replacementLiteral + source.slice(end),
    previousLiteral: source.slice(start, end)
  };
}
