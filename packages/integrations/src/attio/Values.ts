/**
 * Attio's answers as patch code reads them, and the check every call makes of the schema it
 * decodes against. Attio answers each attribute as an array of items carrying metadata and
 * history; Patchy keeps each item's value as `@patchy/api/attio-types` says, drops the rest, and
 * decodes nothing until the workspace's current attributes are shown to match the snapshot's.
 */
import type {
  AttioAttribute,
  AttioAttributeType,
  AttioEntry,
  AttioMember,
  AttioRecord,
  AttioValue
} from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { ShapeMismatch } from "./Errors.js";

/** The object or list a call reads, as errors name it. */
export type Where = { readonly object: string } | { readonly list: string };
/** An object or list from the snapshot: what the call decodes against. */
export interface Container {
  readonly where: Where;
  readonly attributes: ReadonlyArray<AttioAttribute>;
}

// ---------- Attio's answers, as far as Patchy reads them ----------

const Items = Schema.Record(Schema.String, Schema.Array(Schema.Unknown));
const RawRecord = Schema.Struct({
  id: Schema.Struct({ record_id: Schema.String }),
  created_at: Schema.String,
  web_url: Schema.String,
  values: Items
});
const RawEntry = Schema.Struct({
  id: Schema.Struct({ entry_id: Schema.String }),
  parent_record_id: Schema.String,
  parent_object: Schema.String,
  created_at: Schema.String,
  entry_values: Items
});
const RawAttribute = Schema.Struct({
  id: Schema.Struct({ attribute_id: Schema.String }),
  api_slug: Schema.NullOr(Schema.String),
  type: Schema.String,
  is_multiselect: Schema.Boolean,
  is_archived: Schema.Boolean,
  config: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        record_reference: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              allowed_object_ids: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
            })
          )
        )
      })
    )
  )
});
export type RawAttribute = typeof RawAttribute.Type;
const RawOption = Schema.Struct({ title: Schema.String, is_archived: Schema.Boolean });
const RawMember = Schema.Struct({
  id: Schema.Struct({ workspace_member_id: Schema.String }),
  first_name: Schema.NullOr(Schema.String),
  last_name: Schema.NullOr(Schema.String),
  email_address: Schema.String,
  access_level: Schema.String
});
const data = <S extends Schema.Top>(schema: S) => Schema.Struct({ data: schema });

/** Attio's answer through `schema`; unreadable is `undefined`, which callers refuse. */
const reader = <A>(schema: Schema.Decoder<A>) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (body: unknown): A | undefined => Option.getOrUndefined(decode(body));
};
export const answers = {
  records: reader(data(Schema.Array(RawRecord))),
  record: reader(data(RawRecord)),
  entries: reader(data(Schema.Array(RawEntry))),
  entry: reader(data(RawEntry)),
  attributes: reader(data(Schema.Array(RawAttribute))),
  options: reader(data(Schema.Array(RawOption))),
  members: reader(data(Schema.Array(RawMember)))
};
export type RawRecord = typeof RawRecord.Type;
export type RawEntry = typeof RawEntry.Type;

// ---------- one value, by the type table ----------

type One = Exclude<typeof AttioValue.Type, null | ReadonlyArray<unknown>>;
type Item = Readonly<Record<string, unknown>>;
type Read = (item: Item) => One | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
/** A field Attio may leave null; `undefined` when it's neither. */
const part = (value: unknown): string | null | undefined =>
  value === null || value === undefined ? null : text(value);
const actor = (type: unknown, id: unknown) => {
  const kind = text(type);
  const which = part(id);
  return kind === undefined || which === undefined ? undefined : { type: kind, id: which };
};
const fields = <const K extends string>(item: Item, keys: Readonly<Record<K, string>>) => {
  const out = {} as Record<K, string | null>;
  for (const [key, field] of Object.entries(keys) as Array<[K, string]>) {
    const value = part(item[field]);
    if (value === undefined) return undefined;
    out[key] = value;
  }
  return out;
};

const reads: { readonly [T in AttioAttributeType]: Read } = {
  text: (item) => text(item.value),
  number: (item) => finite(item.value),
  rating: (item) => finite(item.value),
  checkbox: (item) => (typeof item.value === "boolean" ? item.value : undefined),
  currency: (item) => {
    const amount = finite(item.currency_value);
    const currency = part(item.currency_code);
    return amount === undefined || currency === undefined ? undefined : { amount, currency };
  },
  date: (item) => text(item.value),
  timestamp: (item) => text(item.value),
  select: (item) => (Predicate.isObject(item.option) ? text(item.option.title) : undefined),
  status: (item) => (Predicate.isObject(item.status) ? text(item.status.title) : undefined),
  "email-address": (item) => text(item.email_address),
  domain: (item) => text(item.domain),
  "phone-number": (item) => text(item.phone_number),
  "personal-name": (item) =>
    fields(item, { first: "first_name", last: "last_name", full: "full_name" }),
  location: (item) =>
    fields(item, {
      line1: "line_1",
      line2: "line_2",
      line3: "line_3",
      line4: "line_4",
      locality: "locality",
      region: "region",
      postcode: "postcode",
      countryCode: "country_code",
      latitude: "latitude",
      longitude: "longitude"
    }),
  "record-reference": (item) => {
    const object = text(item.target_object);
    const id = text(item.target_record_id);
    // A record's id is Attio's UUID, as the wire says; anything else isn't one.
    return object === undefined || id === undefined || !UUID.test(id) ? undefined : { object, id };
  },
  "actor-reference": (item) => actor(item.referenced_actor_type, item.referenced_actor_id),
  interaction: (item) => {
    const type = text(item.interaction_type);
    const at = text(item.interacted_at);
    const owner =
      item.owner_actor === null || item.owner_actor === undefined
        ? null
        : Predicate.isObject(item.owner_actor)
          ? actor(item.owner_actor.type, item.owner_actor.id)
          : undefined;
    return type === undefined || at === undefined || owner === undefined
      ? undefined
      : { type, at, owner };
  }
};

/** Whether a plain value is empty: no value, or a multiselect with none. */
export const isEmpty = (value: typeof AttioValue.Type): boolean =>
  value === null || (Array.isArray(value) && value.length === 0);

const assign = (target: Record<string, typeof AttioValue.Type>, key: string, value: unknown) =>
  // A slug such as `__proto__` is a key like any other.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  });

/**
 * Every snapshot attribute's value from Attio's items, keyed by slug, and nothing else. A
 * reference names an object the snapshot knows by that slug, and a single attribute holds one
 * item at most; anything else fails `shape_mismatch` naming the attribute.
 */
export const values = Effect.fnUntraced(function* (
  container: Container,
  raw: Readonly<Record<string, ReadonlyArray<unknown>>>
) {
  const out: Record<string, typeof AttioValue.Type> = {};
  for (const attribute of container.attributes) {
    const fail = (reason: "missing" | "value" | "target") =>
      new ShapeMismatch({ ...container.where, attribute: attribute.slug, reason });
    const items = Object.hasOwn(raw, attribute.slug) ? raw[attribute.slug] : undefined;
    // Attio sends every attribute that isn't archived: one it left out is gone.
    if (items === undefined) return yield* fail("missing");
    const read = reads[attribute.type];
    const decoded: One[] = [];
    for (const item of items) {
      const value = Predicate.isObject(item) ? read(item) : undefined;
      if (value === undefined) return yield* fail("value");
      if (
        attribute.type === "record-reference" &&
        Predicate.isObject(value) &&
        "object" in value &&
        !(attribute.targets ?? []).some((target) => target.slug === value.object)
      )
        return yield* fail("target");
      decoded.push(value);
    }
    if (attribute.multiselect) assign(out, attribute.slug, decoded);
    else if (decoded.length > 1) return yield* fail("value");
    // An unset checkbox reads, filters and sorts as false.
    else assign(out, attribute.slug, decoded[0] ?? (attribute.type === "checkbox" ? false : null));
  }
  return out;
});

export const record = (container: Container, raw: RawRecord) =>
  Effect.map(values(container, raw.values), (decoded): typeof AttioRecord.Type => ({
    id: raw.id.record_id,
    url: raw.web_url,
    createdAt: raw.created_at,
    values: decoded
  }));

/** An entry, which must be on a record of one of the list's parent objects in the snapshot. */
export const entry = Effect.fnUntraced(function* (
  container: Container & { readonly parents: ReadonlyArray<{ readonly slug: string }> },
  raw: RawEntry
) {
  if (!container.parents.some((parent) => parent.slug === raw.parent_object))
    return yield* new ShapeMismatch({ ...container.where, reason: "parent" });
  const decoded = yield* values(container, raw.entry_values);
  return {
    id: raw.id.entry_id,
    parent: { object: raw.parent_object, id: raw.parent_record_id },
    createdAt: raw.created_at,
    values: decoded
  } satisfies typeof AttioEntry.Type;
});

export const member = (raw: typeof RawMember.Type): typeof AttioMember.Type => ({
  id: raw.id.workspace_member_id,
  name: [raw.first_name, raw.last_name].filter((name) => name !== null && name !== "").join(" "),
  email: raw.email_address,
  active: raw.access_level !== "suspended"
});

// ---------- the call's schema check ----------

/** What the check found current, which `null` filters build from. */
export interface Current {
  /** A record reference's allowed target object ids now, by the attribute's slug. */
  readonly targets: ReadonlyMap<string, ReadonlyArray<string>>;
}

/**
 * The workspace's current attributes for the object or list, archived ones included, against the
 * snapshot's. Each snapshot attribute must still be there under its slug, with its type, its
 * cardinality and, for a reference, every snapshot target among those it allows. Another
 * attribute that took a slug since reads under it if its type and cardinality match. A slug gone
 * whose id now has another says what it was renamed to.
 */
export const check = Effect.fnUntraced(function* (
  container: Container,
  current: ReadonlyArray<RawAttribute>
) {
  const live = new Map<string, RawAttribute>();
  const archived = new Set<string>();
  const byId = new Map<string, RawAttribute>();
  for (const attribute of current) {
    byId.set(attribute.id.attribute_id, attribute);
    if (attribute.api_slug === null) continue;
    if (attribute.is_archived) archived.add(attribute.api_slug);
    else live.set(attribute.api_slug, attribute);
  }
  const targets = new Map<string, ReadonlyArray<string>>();
  for (const attribute of container.attributes) {
    const fail = (
      reason: "missing" | "archived" | "renamed" | "type" | "multiselect" | "targets",
      renamedTo?: string
    ) =>
      new ShapeMismatch({
        ...container.where,
        attribute: attribute.slug,
        reason,
        ...(renamedTo === undefined ? {} : { renamedTo })
      });
    const found = live.get(attribute.slug);
    if (found === undefined) {
      const same = byId.get(attribute.id);
      if (same !== undefined && same.is_archived) return yield* fail("archived");
      if (same !== undefined && same.api_slug !== null && same.api_slug !== attribute.slug)
        return yield* fail("renamed", same.api_slug);
      return yield* fail(archived.has(attribute.slug) ? "archived" : "missing");
    }
    if (found.type !== attribute.type) return yield* fail("type");
    if (found.is_multiselect !== attribute.multiselect) return yield* fail("multiselect");
    if (attribute.type === "record-reference") {
      const allowed = found.config?.record_reference?.allowed_object_ids ?? [];
      if (!(attribute.targets ?? []).every((target) => allowed.includes(target.id)))
        return yield* fail("targets");
      targets.set(attribute.slug, allowed);
    }
  }
  return { targets } satisfies Current;
});

/** Active option or status titles, from Attio's answer. */
export const titles = (options: ReadonlyArray<typeof RawOption.Type>) =>
  options.filter((option) => !option.is_archived).map((option) => option.title);
