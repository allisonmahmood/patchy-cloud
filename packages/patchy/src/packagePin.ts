import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import ts from "typescript";

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ devDependencies: Schema.Record(Schema.String, Schema.String) })
  )
);

/** Read the release from a managed archive pin, retaining unknown pins for diagnostics. */
export function releaseFromPin(pin: string) {
  return /(?:^|\/)patchy-([^/?#]+?)(?:-[a-f0-9]{64})?\.tgz(?:[?#].*)?$/.exec(pin)?.[1] ?? pin;
}

/**
 * pnpm 11 locks a tarball it finds already in its store without an integrity, then refuses that
 * entry on the next install; pnpm 12 refuses it before running any script. Give the entry for this
 * exact URL the integrity the instance reported, leaving every other byte of the lockfile alone.
 * pnpm quotes URLs YAML would misread, such as an IPv6 host, so each quoting is matched.
 */
export function withTarballIntegrity(lockfile: string, tarball: string, integrity: string) {
  const forms = ["", "'", '"'].map((quote) => `${quote}${tarball}${quote}`);
  return lockfile
    .split("\n")
    .map((line) => {
      const form = forms.find((url) => line.trim() === `resolution: {tarball: ${url}}`);
      return form === undefined
        ? line
        : line.replace(
            `resolution: {tarball: ${form}}`,
            `resolution: {integrity: ${integrity}, tarball: ${form}}`
          );
    })
    .join("\n");
}

/**
 * The line of a failed pnpm install worth relaying: its first `ERR_PNPM_` line, or its first line.
 * URLs lose credentials, queries and fragments, and the line is bounded, because a registry or
 * tarball URL can carry a token.
 */
export function installFailureReason(output: string) {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const reason = lines.find((line) => line.includes("ERR_PNPM_")) ?? lines[0];
  return reason
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(
      /\b(https?:\/\/)([^\s'"<>]+)/g,
      (_, scheme: string, rest: string) =>
        scheme + rest.replace(/^[^/@]*@/, "").replace(/[?#].*$/, "")
    )
    .slice(0, 300);
}

/** Edit one managed dependency without rewriting author-owned fields or formatting. */
export function patchPackagePin(
  source: string,
  name: "patchy" | "workerd",
  expected: string | undefined,
  replacementLiteral: string | undefined
) {
  const decoded = decode(source);
  if (Option.isNone(decoded) || decoded.value.devDependencies[name] !== expected) return undefined;
  const file = ts.parseJsonText("package.json", source);
  const statement = file.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return undefined;
  const root = statement.expression;
  if (!ts.isObjectLiteralExpression(root)) return undefined;
  const dependencies = root.properties
    .filter(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        ts.isStringLiteral(property.name) &&
        property.name.text === "devDependencies"
    )
    .at(-1)?.initializer;
  if (!dependencies || !ts.isObjectLiteralExpression(dependencies)) return undefined;
  const matches = dependencies.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.name) &&
      property.name.text === name
  );
  // Removing an effective duplicate would expose an older unmanaged value.
  if (matches.length > 1) return undefined;
  const property = matches[0];
  if (!property) {
    if (replacementLiteral === undefined) return { contents: source, previousLiteral: undefined };
    const opening = dependencies.getStart(file) + 1;
    const first = dependencies.properties[0];
    const start = first?.getStart(file) ?? opening;
    const separator = first ? `,${source.slice(opening, start)}` : "";
    return {
      contents:
        source.slice(0, start) +
        `${JSON.stringify(name)}: ${replacementLiteral}${separator}` +
        source.slice(start),
      previousLiteral: undefined
    };
  }
  const node = property.initializer;
  if (!ts.isStringLiteral(node)) return undefined;
  const previousLiteral = source.slice(node.getStart(file), node.end);
  if (replacementLiteral !== undefined) {
    return {
      contents: source.slice(0, node.getStart(file)) + replacementLiteral + source.slice(node.end),
      previousLiteral
    };
  }
  const index = dependencies.properties.indexOf(property);
  const previous = dependencies.properties[index - 1];
  const next = dependencies.properties[index + 1];
  const start = previous ? previous.end : property.getStart(file);
  const end = !previous && next ? next.getStart(file) : property.end;
  return { contents: source.slice(0, start) + source.slice(end), previousLiteral };
}
