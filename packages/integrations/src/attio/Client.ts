import type { AttioAttribute, AttioSnapshot } from "@patchy/api";
import * as Schema from "effect/Schema";

/**
 * The generated client for one Attio snapshot: a description of each object and list that
 * `patchy/client`'s types turn into typed values and filters, and the factory the host supplies a
 * transport to. Slugs are keys verbatim, quoted when they aren't identifiers; options and targets
 * are literal types, options as hints beside any other title.
 */

/** A string as a TypeScript literal. */
const literal = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const key = (slug: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(slug) ? slug : literal(slug));
const union = (values: ReadonlyArray<string>) =>
  values.length === 0 ? "never" : values.map((value) => literal(value)).join(" | ");

const attribute = (item: AttioAttribute) => {
  const parts = [`readonly type: ${literal(item.type)}`];
  if (item.multiselect) parts.push("readonly multiselect: true");
  // A select or status whose options weren't read has no hints: any title type-checks.
  if (item.options !== undefined && item.optionsSkipped !== true)
    parts.push(`readonly options: ${union(item.options)}`);
  if (item.targets !== undefined)
    parts.push(`readonly targets: ${union(item.targets.map((target) => target.slug))}`);
  return `readonly ${key(item.slug)}: { ${parts.join("; ")} };`;
};
/** A type literal of `lines`, its closing brace at `indent`. */
const block = (lines: ReadonlyArray<string>, indent: string) =>
  lines.length === 0
    ? "{}"
    : `{\n${lines.map((line) => `${indent}  ${line}`).join("\n")}\n${indent}}`;
const attributes = (items: ReadonlyArray<AttioAttribute>, indent: string) =>
  block(items.map(attribute), indent);

export const client = (
  snapshot: AttioSnapshot
) => `// Generated from an immutable Attio snapshot. Tier 2 handlers type ctx.connections with it; the host supplies the transport.
// Patchy builds every Attio request from these typed arguments and reads only: nothing here can
// name a path, write filter JSON or change anything in Attio.
import { createAttioClient } from "patchy/client";
import type { AttioClient, AttioEntry, AttioRecord, AttioValues, BoundaryError as ClientBoundaryError, Call, Errors } from "patchy/client";
export type { AttioActor as Actor, AttioCurrency as Currency, AttioInteraction as Interaction, AttioLocation as Location, AttioLocationMatch as LocationMatch, AttioMember as Member, AttioPersonalName as PersonalName, AttioRecordRef as RecordRef, ErrorCode, ErrorDetails, Errors } from "patchy/client";
/** Each object's attributes, by slug, as the snapshot saw them. */
export type Objects = ${block(
  snapshot.objects.map(
    (object) => `readonly ${key(object.slug)}: ${attributes(object.attributes, "  ")};`
  ),
  ""
)};
/** Each list's parent objects and its own attributes, by slug. */
export type Lists = ${block(
  snapshot.lists.map(
    (list) =>
      `readonly ${key(list.slug)}: ${block(
        [
          `readonly parents: ${union(list.parents.map((parent) => parent.slug))};`,
          `readonly attributes: ${attributes(list.attributes, "    ")};`
        ],
        "  "
      )};`
  ),
  ""
)};
/** A record of each object, by slug: \`Records["deals"]\`. */
export type Records = { readonly [S in keyof Objects]: AttioRecord<AttioValues<Objects[S]>> };
/** An entry of each list, by slug. */
export type Entries = {
  readonly [S in keyof Lists]: AttioEntry<Lists[S]["parents"], AttioValues<Lists[S]["attributes"]>>;
};
export type BoundaryError = ClientBoundaryError | Errors<"connection_not_declared">;
// These unions describe known Patchy refusals, not checked or exhaustive TypeScript throws.
// Attio's own details: narrow a caught error with isPatchyError(error, code, "attio").
export type ReadError =
  | BoundaryError
  | Errors<"invalid_cursor" | "invalid_query" | "shape_mismatch" | "not_found" | "source_rate_limited", \`attio.\${string}\`>;
export type Client = AttioClient<Objects, Lists>;
export function createClient(connection: string, call: Call): Client {
  return createAttioClient<Objects, Lists>(connection, call);
}
`;
