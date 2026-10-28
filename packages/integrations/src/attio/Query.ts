/**
 * Attio's query for a patch's call, built from its typed arguments and the snapshot. Every
 * argument is checked here, against the attribute it names and the type table, before Attio sees
 * anything: an unknown slug, an operator a type doesn't take, a value of the wrong kind or a
 * date-only timestamp is refused `invalid_request`. The encodings are the probe's (#964), each
 * proven exact on a real workspace by the live tier.
 *
 * `null` on a select, status or reference names "no value" by excluding every value it could hold
 * now: its current options or targets, read in the call's check. A value added between that read
 * and the query would escape, so every row is checked empty on those attributes afterwards.
 */
import {
  attioReads,
  type AttioAttribute,
  type AttioEqValue,
  type AttioList,
  type AttioObject
} from "@patchy/api";
import { attioTypes } from "@patchy/api/attio-types";
import { canonicalArgs } from "@patchy/api/canonical-args";
import { sha256 } from "@patchy/core";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { InvalidCursor, InvalidRequest } from "./Errors.js";
import type { Container, Current, Where } from "./Values.js";

type Json = typeof Schema.Json.Type;
/** The arguments `listRecords` and `listEntries` share. */
type Filters = Omit<typeof attioReads.listRecords.input.Type, "object">;
type Parent = NonNullable<(typeof attioReads.listEntries.input.Type)["parent"]>;
type Operator = "eq" | "contains" | "range" | "orderBy" | "parent";

/** `limit` when a call leaves it out. */
export const DEFAULT_LIMIT = 100;
/** Attio refuses an `$in` of more than 100 values. */
const IN_MAX = 100;
/** Attio's actor types, every one of which `null` on an actor reference excludes. */
const ACTOR_TYPES = ["workspace-member", "api-token", "system"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A full ISO timestamp: a date alone Attio refuses in a range, and can't match exactly. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** `{ [key]: value }`, with a slug such as `__proto__` as an ordinary key. */
const field = (key: string, value: Json): Json => {
  const out: Record<string, Json> = {};
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  return out;
};
const not = (predicate: Json): Json => ({ $not: predicate });
const all = (predicates: ReadonlyArray<Json>): Json | undefined =>
  predicates.length === 0
    ? undefined
    : predicates.length === 1
      ? predicates[0]
      : { $and: [...predicates] };
const any = (predicates: ReadonlyArray<Json>): Json =>
  predicates.length === 1 ? predicates[0]! : { $or: [...predicates] };
const chunks = <A>(items: ReadonlyArray<A>, size: number): A[][] => {
  const out: A[][] = [];
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size));
  return out;
};

/** What a call may refuse with, named by where it is and which attribute and operator. */
const refuse = (
  where: Where,
  reason: InvalidRequest["reason"],
  operator?: Operator,
  attribute?: string
) =>
  new InvalidRequest({
    ...where,
    reason,
    ...(operator === undefined ? {} : { operator }),
    ...(attribute === undefined ? {} : { attribute })
  });

/** The snapshot's attribute by slug, or the refusal naming it. */
const attributeOf = (container: Container, slug: string, operator: Operator) => {
  const found = container.attributes.find((attribute) => attribute.slug === slug);
  return found === undefined
    ? Effect.fail(refuse(container.where, "unknown", operator, slug))
    : Effect.succeed(found);
};
const supports = (
  container: Container,
  attribute: AttioAttribute,
  operator: Operator,
  capability: keyof (typeof attioTypes)[keyof typeof attioTypes]
) =>
  attioTypes[attribute.type][capability]
    ? Effect.void
    : Effect.fail(refuse(container.where, "unsupported", operator, attribute.slug));

// ---------- eq, one value ----------

const isRef = (value: AttioEqValue): value is { readonly object: string; readonly id: string } =>
  Predicate.isObject(value) && "object" in value && "id" in value;

/**
 * One value's predicate on the attribute. A record reference's is grouped by object, so `eq`'s
 * any-of can send one `$in` per object; every other type's is a whole predicate.
 */
const one = Effect.fnUntraced(function* (
  container: Container,
  attribute: AttioAttribute,
  value: AttioEqValue
) {
  const wrong = refuse(container.where, "value", "eq", attribute.slug);
  const slug = attribute.slug;
  const string = typeof value === "string" ? value : undefined;
  switch (attribute.type) {
    case "text":
    case "select":
    case "status":
      // Text matches case-insensitively, Attio's way; a title is exact and case-sensitive.
      if (string === undefined) return yield* wrong;
      return field(slug, string);
    case "email-address":
      if (string === undefined) return yield* wrong;
      return field(slug, { email_address: string });
    case "domain":
      if (string === undefined) return yield* wrong;
      return field(slug, { domain: string });
    case "phone-number":
      if (string === undefined) return yield* wrong;
      return field(slug, { phone_number: string });
    case "personal-name":
      if (string === undefined) return yield* wrong;
      return field(slug, { full_name: string });
    case "number":
    case "rating":
      if (typeof value !== "number") return yield* wrong;
      return field(slug, value);
    case "currency":
      if (typeof value !== "number") return yield* wrong;
      return field(slug, { currency_value: value });
    case "checkbox":
      // `false` matches unset too, as Attio filters it.
      if (typeof value !== "boolean") return yield* wrong;
      return field(slug, value);
    case "date":
      if (string === undefined || !DATE.test(string)) return yield* wrong;
      return field(slug, string);
    case "timestamp":
      if (string === undefined) return yield* wrong;
      if (!TIMESTAMP.test(string)) return yield* refuse(container.where, "timestamp", "eq", slug);
      return field(slug, string);
    case "actor-reference":
      // A workspace member, by id.
      if (string === undefined || !UUID.test(string)) return yield* wrong;
      return field(slug, {
        referenced_actor_type: "workspace-member",
        referenced_actor_id: string.toLowerCase()
      });
    case "location": {
      if (!Predicate.isObject(value) || isRef(value)) return yield* wrong;
      const parts: Record<string, Json> = {};
      for (const [key, name] of [
        ["locality", "locality"],
        ["region", "region"],
        ["postcode", "postcode"],
        ["countryCode", "country_code"]
      ] as const)
        if (typeof value[key] === "string") parts[name] = value[key];
      if (Object.keys(parts).length === 0) return yield* wrong;
      return field(slug, parts);
    }
    case "record-reference": {
      const target = yield* reference(container, attribute, value, "eq");
      return field(slug, { target_object: target.object, target_record_id: target.id });
    }
    case "interaction":
      return yield* refuse(container.where, "unsupported", "eq", slug);
  }
});

/** A record a reference names: `{ object, id }`, or a bare id when the attribute has one target. */
const reference = Effect.fnUntraced(function* (
  container: Container,
  attribute: AttioAttribute,
  value: AttioEqValue,
  operator: Operator
) {
  const targets = attribute.targets ?? [];
  if (typeof value === "string" && UUID.test(value)) {
    if (targets.length !== 1)
      return yield* refuse(container.where, "target", operator, attribute.slug);
    return { object: targets[0]!.slug, id: value.toLowerCase() };
  }
  if (!isRef(value)) return yield* refuse(container.where, "value", operator, attribute.slug);
  if (!targets.some((target) => target.slug === value.object))
    return yield* refuse(container.where, "target", operator, attribute.slug);
  return { object: value.object, id: value.id.toLowerCase() };
});

/** `eq` for one attribute: a value, any of several, or `null`. */
const eq = Effect.fnUntraced(function* (
  container: Container,
  attribute: AttioAttribute,
  value: AttioEqValue | ReadonlyArray<AttioEqValue>
) {
  if (!Array.isArray(value)) return yield* one(container, attribute, value as AttioEqValue);
  yield* supports(container, attribute, "eq", "anyOf");
  const values: ReadonlyArray<AttioEqValue> = value;
  if (attribute.type === "text") {
    if (values.some((item) => typeof item !== "string"))
      return yield* refuse(container.where, "value", "eq", attribute.slug);
    return field(attribute.slug, { $in: [...(values as ReadonlyArray<string>)] });
  }
  if (attribute.type === "record-reference") {
    // Grouped by object: Attio honours the object beside `$in`, so another's id matches nothing.
    const byObject = new Map<string, string[]>();
    for (const item of values) {
      const target = yield* reference(container, attribute, item, "eq");
      byObject.set(target.object, [...(byObject.get(target.object) ?? []), target.id]);
    }
    return any(
      [...byObject].map(([object, ids]) =>
        field(attribute.slug, { target_object: object, target_record_id: { $in: ids } })
      )
    );
  }
  const predicates: Json[] = [];
  for (const item of values) predicates.push(yield* one(container, attribute, item));
  return any(predicates);
});

// ---------- null: no value ----------

/** What `null` on an attribute needs before its predicate can be built. */
export type Empty =
  /** Built now. */
  | { readonly kind: "now"; readonly predicates: ReadonlyArray<Json> }
  /** Excludes every current option or status: the call reads them first. */
  | { readonly kind: "options" }
  /** Excludes every current target object: the call's check gives them. */
  | { readonly kind: "targets" };

const below = (slug: string, inner: (bound: Json) => Json, pivot: Json): ReadonlyArray<Json> => [
  // A value is either at least the pivot or below it: excluding both leaves no value.
  not(field(slug, inner({ $gte: pivot }))),
  not(field(slug, inner({ $lt: pivot })))
];
const direct = (bound: Json) => bound;

const empty = (attribute: AttioAttribute): Empty => {
  const slug = attribute.slug;
  const now = (predicates: ReadonlyArray<Json>): Empty => ({ kind: "now", predicates });
  switch (attribute.type) {
    case "text":
      return now([not(field(slug, { $contains: "" }))]);
    case "number":
    case "rating":
      return now(below(slug, direct, 0));
    case "currency":
      return now(below(slug, (bound) => ({ currency_value: bound }), 0));
    case "date":
      return now(below(slug, direct, "2000-01-01"));
    case "timestamp":
      return now(below(slug, direct, "2000-01-01T00:00:00.000000000Z"));
    case "email-address":
      return now([not(field(slug, { email_address: { $contains: "" } }))]);
    case "domain":
    case "personal-name":
      return now([not(field(slug, { $not_empty: true }))]);
    case "phone-number":
      return now([not(field(slug, { country_code: { $not_empty: true } }))]);
    case "actor-reference":
      return now(ACTOR_TYPES.map((type) => not(field(slug, { referenced_actor_type: type }))));
    case "interaction":
      return now([not(field(slug, { owner_member_id: { $not_empty: true } }))]);
    case "select":
    case "status":
      return { kind: "options" };
    case "record-reference":
      return { kind: "targets" };
    // The type table refuses these before they get here.
    case "checkbox":
    case "location":
      return now([]);
  }
};

// ---------- the plan ----------

/** What the cursor binds besides the offset: the call it pages through. */
export interface Binding {
  readonly connectionId: string;
  readonly operation: string;
  readonly revision: number;
}

/** A list call checked against the snapshot: everything but what `null` needs from the check. */
export interface Plan {
  readonly container: Container;
  /** The predicates built now, ANDed. */
  readonly filters: ReadonlyArray<Json>;
  /** Attributes asked for `null`: every row read is checked empty on them. */
  readonly empty: ReadonlyArray<AttioAttribute>;
  /** Of those, the selects and statuses whose current options the call reads first. */
  readonly options: ReadonlyArray<AttioAttribute>;
  /** Of those, the references whose current targets the check gives. */
  readonly references: ReadonlyArray<AttioAttribute>;
  readonly sorts: ReadonlyArray<Json>;
  readonly limit: number;
  readonly offset: number;
  /** What a cursor from this call carries, so one from another call is refused. */
  readonly binding: string;
}

const encodeCursor = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ v: Schema.Literal(1), offset: Schema.Int, binding: Schema.String })
  )
);
const decodeCursor = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      v: Schema.Literal(1),
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      binding: Schema.String
    })
  ),
  { onExcessProperty: "error" }
);
/** The cursor for the page at `offset` of the call `binding` names. */
export const cursor = (binding: string, offset: number): string =>
  Buffer.from(encodeCursor({ v: 1, offset, binding }), "utf8").toString("base64url");
const offsetOf = Effect.fnUntraced(function* (value: string | undefined, binding: string) {
  if (value === undefined) return 0;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return yield* new InvalidCursor({});
  const decoded = yield* decodeCursor(Buffer.from(value, "base64url").toString("utf8")).pipe(
    Effect.mapError(() => new InvalidCursor({}))
  );
  if (decoded.binding !== binding) return yield* new InvalidCursor({});
  return decoded.offset;
});

/** The field `contains` reads on types whose value has several. */
const containsField: Partial<Record<AttioAttribute["type"], string>> = {
  "email-address": "email_address",
  domain: "domain",
  "phone-number": "phone_number",
  "personal-name": "full_name",
  location: "locality"
};
/** The `orderBy` field Attio sorts some types by, beside the attribute. */
const sortField: Partial<Record<AttioAttribute["type"], string>> = {
  currency: "currency_value",
  "personal-name": "last_name",
  location: "locality",
  interaction: "interacted_at"
};

/**
 * A `listRecords` or `listEntries` call against an object or list of the snapshot, refused
 * before Attio sees anything if any argument doesn't fit. `parent` is a list's only.
 */
export const plan = Effect.fnUntraced(function* (
  container: Container & { readonly parents?: AttioList["parents"] },
  args: Filters & { readonly parent?: Parent },
  call: Binding
) {
  const { where } = container;
  const filters: Json[] = [];
  const empties: AttioAttribute[] = [];
  const options: AttioAttribute[] = [];
  const references: AttioAttribute[] = [];
  for (const [slug, value] of Object.entries(args.eq ?? {})) {
    const attribute = yield* attributeOf(container, slug, "eq");
    if (value !== null) {
      yield* supports(container, attribute, "eq", "eq");
      filters.push(yield* eq(container, attribute, value));
      continue;
    }
    yield* supports(container, attribute, "eq", "empty");
    empties.push(attribute);
    const needs = empty(attribute);
    if (needs.kind === "now") filters.push(...needs.predicates);
    else if (needs.kind === "options") options.push(attribute);
    else references.push(attribute);
  }
  for (const [slug, text] of Object.entries(args.contains ?? {})) {
    const attribute = yield* attributeOf(container, slug, "contains");
    yield* supports(container, attribute, "contains", "contains");
    const inner = { $contains: text };
    const on = containsField[attribute.type];
    filters.push(field(slug, on === undefined ? inner : field(on, inner)));
  }
  if (args.range !== undefined) {
    const range = args.range;
    const attribute = yield* attributeOf(container, range.attribute, "range");
    yield* supports(container, attribute, "range", "range");
    const bounds = (["gt", "gte", "lt", "lte"] as const).filter((bound) =>
      Object.hasOwn(range, bound)
    );
    if (
      bounds.length === 0 ||
      (Object.hasOwn(range, "gt") && Object.hasOwn(range, "gte")) ||
      (Object.hasOwn(range, "lt") && Object.hasOwn(range, "lte"))
    )
      return yield* refuse(where, "bounds", "range", attribute.slug);
    const operators: Record<string, Json> = {};
    for (const bound of bounds) {
      const value = range[bound]!;
      const numeric =
        attribute.type === "number" || attribute.type === "rating" || attribute.type === "currency";
      if (numeric ? typeof value !== "number" : typeof value !== "string")
        return yield* refuse(where, "value", "range", attribute.slug);
      if (attribute.type === "date" && !DATE.test(value as string))
        return yield* refuse(where, "value", "range", attribute.slug);
      if (
        (attribute.type === "timestamp" || attribute.type === "interaction") &&
        !TIMESTAMP.test(value as string)
      )
        return yield* refuse(where, "timestamp", "range", attribute.slug);
      operators[`$${bound}`] = value;
    }
    filters.push(
      field(
        attribute.slug,
        attribute.type === "currency"
          ? { currency_value: operators }
          : attribute.type === "interaction"
            ? { interacted_at: operators }
            : operators
      )
    );
  }
  if (args.parent !== undefined) {
    const parents = container.parents ?? [];
    const parent = args.parent;
    const object =
      typeof parent === "string"
        ? parents.length === 1
          ? parents[0]!.slug
          : undefined
        : parents.some((candidate) => candidate.slug === parent.object)
          ? parent.object
          : undefined;
    if (object === undefined) return yield* refuse(where, "parent", "parent");
    const id = (typeof parent === "string" ? parent : parent.id).toLowerCase();
    filters.push({
      parent_record: {
        ...(parents.length > 1 ? { target_object: object } : {}),
        target_record_id: id
      }
    });
  }
  const unique = "list" in where ? "entry_id" : "record_id";
  const sorts: Json[] = [];
  if (args.orderBy !== undefined) {
    const attribute = yield* attributeOf(container, args.orderBy.attribute, "orderBy");
    yield* supports(container, attribute, "orderBy", "order");
    if (attribute.type === "select" && attribute.multiselect)
      return yield* refuse(where, "unsupported", "orderBy", attribute.slug);
    const by = sortField[attribute.type];
    sorts.push({
      attribute: attribute.slug,
      ...(by === undefined ? {} : { field: by }),
      direction: args.orderBy.direction ?? "asc"
    });
  }
  // Ties break by id, so paging repeats and skips nothing.
  sorts.push({ attribute: unique, direction: "asc" });
  const binding = sha256(
    canonicalArgs([
      call.connectionId,
      call.operation,
      where,
      call.revision,
      args.eq ?? null,
      args.contains ?? null,
      args.range ?? null,
      args.parent ?? null,
      args.orderBy ?? null
    ])
  );
  return {
    container,
    filters,
    empty: empties,
    options,
    references,
    sorts,
    limit: args.limit ?? DEFAULT_LIMIT,
    offset: yield* offsetOf(args.cursor, binding),
    binding
  } satisfies Plan;
});

/**
 * Attio's request body for a plan, once the check gave the current targets and the options were
 * read: every predicate ANDed, the sorts, one row past the limit to know whether there's another
 * page, and the offset.
 */
/** Attio's query body: an optional filter, sorts, and the page. */
export interface Body {
  readonly filter?: Json;
  readonly sorts: Json[];
  readonly limit: number;
  readonly offset: number;
}
export const body = (
  plan: Plan,
  current: Current,
  options: ReadonlyMap<string, ReadonlyArray<string>>
): Body => {
  const filters = [...plan.filters];
  for (const attribute of plan.options)
    // No active option: every record reads empty, so nothing need be excluded.
    for (const title of options.get(attribute.slug) ?? [])
      filters.push(not(field(attribute.slug, title)));
  for (const attribute of plan.references)
    for (const object of current.targets.get(attribute.slug) ?? [])
      filters.push(not(field(attribute.slug, { target_object: object })));
  const filter = all(filters);
  return {
    ...(filter === undefined ? {} : { filter }),
    sorts: [...plan.sorts],
    limit: plan.limit + 1,
    offset: plan.offset
  };
};

/** Whether a plan's query can run beside its check, needing nothing the check reads. */
export const independent = (plan: Plan) =>
  plan.options.length === 0 && plan.references.length === 0;

/** The next page's cursor when Attio answered past the limit, else `null`. */
export const next = (plan: Plan, answered: number): string | null =>
  answered > plan.limit ? cursor(plan.binding, plan.offset + plan.limit) : null;

/**
 * `getMany`'s query: the distinct ids, at most 100 to an `$in`, ORed when there are more, with an
 * explicit limit. Attio answers in id order and drops ids it doesn't have.
 */
export const many = (
  ids: ReadonlyArray<string>
): {
  readonly distinct: number;
  readonly body: { readonly filter: Json; readonly limit: number };
} => {
  const distinct = [...new Set(ids.map((id) => id.toLowerCase()))];
  return {
    distinct: distinct.length,
    body: {
      filter: any(chunks(distinct, IN_MAX).map((chunk) => ({ record_id: { $in: chunk } }))),
      limit: distinct.length
    }
  };
};

/** The snapshot's object or list by slug, as the call decodes against it. */
export const objectContainer = (object: AttioObject): Container => ({
  where: { object: object.slug },
  attributes: object.attributes
});
export const listContainer = (
  list: AttioList
): Container & { readonly parents: AttioList["parents"] } => ({
  where: { list: list.slug },
  attributes: list.attributes,
  parents: list.parents
});
