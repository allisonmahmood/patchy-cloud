import { parseExpression } from "@babel/parser";
import type { Node, ObjectExpression, ObjectProperty } from "@babel/types";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isMap, isNode, isScalar, parseDocument } from "yaml";

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

const workerdBuild = [
  "# Patchy runs workerd's binary itself; its install script is not needed.",
  "allowBuilds:",
  "  workerd: false",
  ""
];
const named = (node: unknown, name: string) => isScalar(node) && node.value === name;
/** pnpm's build keys are package names, optionally with a version: `workerd@1.2.3`. */
const choosesWorkerd = (node: unknown) =>
  isScalar(node) && typeof node.value === "string" && /^workerd(@|$)/.test(node.value);
/** Where a parsed node sits in its source: `[start, valueEnd, nodeEnd]`. */
const rangeOf = (node: unknown) => (isNode(node) ? (node.range ?? undefined) : undefined);

/**
 * A repo's pnpm-workspace.yaml with workerd's build script declined. pnpm 12 fails `install`,
 * `add` and `remove` when it ignores a build script, and Patchy runs workerd's platform binary
 * directly. YAML decides which key is `allowBuilds`, quoted or not, and whether it already names
 * workerd; the entry is spliced into the source, so every other byte stays the repo's. A choice
 * the repo made for workerd is kept, and a file pnpm would refuse anyway is left to the repo.
 */
export function withWorkerdBuildDeclined(source: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const splice = (at: number, text: string, end = at) =>
    `${source.slice(0, at)}${text}${source.slice(end)}`;
  const document = parseDocument(source);
  const root = document.contents;
  if (document.errors.length > 0 || (root !== null && !isMap(root))) return source;
  const setting = root?.items.find((pair) => named(pair.key, "allowBuilds"));
  if (setting === undefined)
    return root?.flow
      ? source
      : `${source}${source === "" || source.endsWith("\n") ? "" : eol}${workerdBuild.join(eol)}`;
  const value = setting.value;
  if (isMap(value)) {
    if (value.items.some((pair) => choosesWorkerd(pair.key))) return source;
    const entry = rangeOf(value.items[0]?.key);
    const whole = rangeOf(value);
    if (value.flow) {
      if (entry) return splice(entry[0], "workerd: false, ");
      return whole ? splice(whole[0], "{ workerd: false }", whole[1]) : source;
    }
    if (!entry) return source;
    // Its own line, indented like the mapping's first entry.
    const line = source.lastIndexOf("\n", entry[0] - 1) + 1;
    return splice(line, `${source.slice(line, entry[0])}workerd: false${eol}`);
  }
  if (isScalar(value) && value.value === null) {
    const whole = rangeOf(value);
    if (whole && value.source !== "") return splice(whole[0], "{ workerd: false }", whole[1]);
    const key = rangeOf(setting.key);
    if (!key) return source;
    const end = source.indexOf(eol, key[1]);
    return splice(end === -1 ? source.length : end, `${eol}  workerd: false`);
  }
  return source;
}

/**
 * Control characters go; URLs lose credentials, queries and fragments, which can carry a token. A
 * URL runs to the next ASCII whitespace, so quotes or other spaces inside one cannot end it early.
 */
const redact = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(
      /\b(https?:\/\/)([^ \t\n\r\f\v]+)/gi,
      (_, scheme: string, rest: string) =>
        scheme + rest.replace(/^[^/?#]*@/, "").replace(/[?#].*$/s, "")
    );

/**
 * Why a failed pnpm install failed, worth relaying. pnpm 11 prints an `ERR_PNPM_` line; pnpm 12,
 * run with `NO_GRAPHICS`, narrates a report: `Diagnostic severity:`, a `Caused by:` line per cause,
 * unwrapped, and its code on a `diagnostic code:` line. Falls back to the first line. Each part is
 * redacted, the whole bounded.
 */
export function installFailureReason(output: string) {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const narrated = lines.some((line) => line.startsWith("Diagnostic severity:"));
  const causes = lines.flatMap((line) => /^Caused by:\s*(.+)$/.exec(line)?.slice(1) ?? []);
  const code = lines.flatMap((line) => /^diagnostic code:\s*(\S+)/.exec(line)?.slice(1) ?? []);
  const parts =
    narrated && causes.length > 0
      ? [...code.slice(0, 1), ...causes]
      : [lines.find((line) => line.includes("ERR_PNPM_")) ?? lines[0]];
  const defined = parts.filter((part) => part !== undefined);
  return defined.length === 0 ? undefined : defined.map(redact).join(": ").slice(0, 300);
}

/** A parsed node's source offsets; Babel records them on every node it parses. */
const span = (node: Node) => ({ start: node.start!, end: node.end! });

/** The object's properties whose JSON key is `key`. */
const keyed = (object: ObjectExpression, key: string) =>
  object.properties.filter(
    (property): property is ObjectProperty =>
      property.type === "ObjectProperty" &&
      property.key.type === "StringLiteral" &&
      property.key.value === key
  );

/** Edit one managed dependency without rewriting author-owned fields or formatting. */
export function patchPackagePin(
  source: string,
  name: "patchy" | "workerd",
  expected: string | undefined,
  replacementLiteral: string | undefined
) {
  const decoded = decode(source);
  if (Option.isNone(decoded) || decoded.value.devDependencies[name] !== expected) return undefined;
  // Valid JSON is a JavaScript expression. Recovery tolerates what JSON allows and JavaScript
  // refuses, such as a repeated "__proto__" key.
  const root = parseExpression(source, { errorRecovery: true });
  if (root.type !== "ObjectExpression") return undefined;
  const dependencies = keyed(root, "devDependencies").at(-1)?.value;
  if (dependencies?.type !== "ObjectExpression") return undefined;
  const matches = keyed(dependencies, name);
  // Removing an effective duplicate would expose an older unmanaged value.
  if (matches.length > 1) return undefined;
  const property = matches[0];
  if (!property) {
    if (replacementLiteral === undefined) return { contents: source, previousLiteral: undefined };
    const opening = span(dependencies).start + 1;
    const first = dependencies.properties[0];
    const start = first ? span(first).start : opening;
    const separator = first ? `,${source.slice(opening, start)}` : "";
    return {
      contents:
        source.slice(0, start) +
        `${JSON.stringify(name)}: ${replacementLiteral}${separator}` +
        source.slice(start),
      previousLiteral: undefined
    };
  }
  const node = property.value;
  if (node.type !== "StringLiteral") return undefined;
  const literal = span(node);
  const previousLiteral = source.slice(literal.start, literal.end);
  if (replacementLiteral !== undefined) {
    return {
      contents: source.slice(0, literal.start) + replacementLiteral + source.slice(literal.end),
      previousLiteral
    };
  }
  const index = dependencies.properties.indexOf(property);
  const previous = dependencies.properties[index - 1];
  const next = dependencies.properties[index + 1];
  const start = previous ? span(previous).end : span(property).start;
  const end = !previous && next ? span(next).start : span(property).end;
  return { contents: source.slice(0, start) + source.slice(end), previousLiteral };
}
