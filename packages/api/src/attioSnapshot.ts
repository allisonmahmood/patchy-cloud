/**
 * What Patchy keeps about one Attio workspace when it connects: the workspace, the key's scopes,
 * and the shape of its objects and lists, their attributes and the active options of each select
 * and status. Never a record, an entry or a member.
 *
 * Patch code names objects, lists and attributes by their `slug` (Attio's `api_slug`) and options
 * by their title. Ids are kept beside every slug so a call that finds a name gone can say what it
 * became.
 */
import * as Schema from "effect/Schema";
import { registry } from "@patchy/limits/registry";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Id = Text(64);
const Slug = Text(256);
const Title = Text(1024);
const most = <S extends Schema.Top>(item: S, limit: keyof typeof registry, what: string) =>
  Schema.Array(item).check(
    Schema.makeFilter(
      (items: ReadonlyArray<unknown>) =>
        items.length <= registry[limit].default ||
        `An Attio snapshot keeps at most ${registry[limit].default} ${what}.`
    )
  );

/** Attio's attribute types, each of which Patchy reads. One of another type is excluded. */
export const attioAttributeTypes = [
  "text",
  "number",
  "rating",
  "checkbox",
  "currency",
  "date",
  "timestamp",
  "select",
  "status",
  "email-address",
  "domain",
  "phone-number",
  "personal-name",
  "location",
  "record-reference",
  "actor-reference",
  "interaction"
] as const;
export const AttioAttributeType = Schema.Literals(attioAttributeTypes);
export type AttioAttributeType = typeof AttioAttributeType.Type;

/** An object, by its id and the slug it had when discovery read it. */
export const AttioObjectRef = Schema.Struct({ id: Id, slug: Slug });

export const AttioAttribute = Schema.Struct({
  id: Id,
  slug: Slug,
  title: Title,
  type: AttioAttributeType,
  multiselect: Schema.Boolean,
  /** A record reference's allowed targets, among the snapshot's objects. */
  targets: Schema.optionalKey(Schema.Array(AttioObjectRef)),
  /**
   * A select's or status's active options by title, in Attio's order: a status's is its pipeline
   * order. Hints only: Attio checks titles itself.
   */
  options: Schema.optionalKey(most(Title, "attio.discovery.options", "options per attribute")),
  /** A select or status whose options discovery skipped to keep within its budget. */
  optionsSkipped: Schema.optionalKey(Schema.Literal(true))
});
export type AttioAttribute = typeof AttioAttribute.Type;

const attributes = most(
  AttioAttribute,
  "attio.discovery.attributes",
  "attributes per object or list"
);

export const AttioObject = Schema.Struct({ id: Id, slug: Slug, name: Title, attributes });
export type AttioObject = typeof AttioObject.Type;

/** A list, whose entries each belong to a record of one of its parent objects. */
export const AttioList = Schema.Struct({
  id: Id,
  slug: Slug,
  name: Title,
  parents: Schema.Array(AttioObjectRef),
  attributes
});
export type AttioList = typeof AttioList.Type;

/**
 * Something discovery found and left out, named so the connection page and the context say why:
 * an `archived` attribute, an object or list with `no_slug`, an attribute of an
 * `unsupported_type`, or a list whose parent objects aren't in the snapshot (`no_parent`).
 */
export const AttioExclusion = Schema.Struct({
  kind: Schema.Literals(["object", "list", "attribute"]),
  /** The object or list an attribute belongs to: the two are named apart, so a slug may be both. */
  in: Schema.optionalKey(Schema.Struct({ kind: Schema.Literals(["object", "list"]), slug: Slug })),
  /** Its slug, or its name when it has none. */
  name: Title,
  reason: Schema.Literals(["archived", "no_slug", "unsupported_type", "no_parent"])
});
export type AttioExclusion = typeof AttioExclusion.Type;

export const AttioSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  workspace: Schema.Struct({ id: Id, name: Title, slug: Slug }),
  /** The key's scopes as Attio named them, every one a read scope. */
  scopes: Schema.Array(Text(128)),
  objects: most(AttioObject, "attio.discovery.objects", "objects"),
  lists: most(AttioList, "attio.discovery.lists", "lists"),
  excluded: Schema.Array(AttioExclusion)
});
export type AttioSnapshot = typeof AttioSnapshot.Type;
