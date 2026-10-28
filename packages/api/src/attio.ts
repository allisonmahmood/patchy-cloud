/**
 * Attio: one workspace's CRM, read through operations Patchy writes. Patch code names an object or
 * list by its slug and filters by attribute slugs and plain values, never a path, filter JSON or
 * key: Patchy builds every request from these arguments and the connection's snapshot, and checks
 * each call against the workspace's current attributes before decoding. Nothing can be written.
 */
import * as Schema from "effect/Schema";
import { DefinitionName } from "./schemas.js";

/** An object's, list's or attribute's `api_slug`. */
export const AttioSlug = Schema.String.check(Schema.isBetweenLength(1, 256));
/** A record's or entry's id, as Attio gives it. */
export const AttioRecordId = Schema.String.check(
  Schema.isPattern(/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/)
);
/** Patchy's cursor for the next page, passed back as it came. */
const Cursor = Schema.String.check(Schema.isBetweenLength(1, 2048));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));
const Text = Schema.String.check(Schema.isBetweenLength(1, 10_000));

// ---------- what a patch filters by ----------

/** A record, by its object's slug and its id. */
export const AttioRecordRef = Schema.Struct({ object: AttioSlug, id: AttioRecordId });
/** A location matches on the fields given, each exactly. */
export const AttioLocationMatch = Schema.Struct({
  locality: Schema.optionalKey(Text),
  region: Schema.optionalKey(Text),
  postcode: Schema.optionalKey(Text),
  countryCode: Schema.optionalKey(Text)
});
/**
 * One value `eq` compares with: text, a number, a checkbox, a date or timestamp, an option's
 * title, an email, domain or phone, a full name, a member's id, a record or a location's fields.
 */
export const AttioEqValue = Schema.Union([
  Text,
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
  AttioRecordRef,
  AttioLocationMatch
]);
export type AttioEqValue = typeof AttioEqValue.Type;
/** A value, any of up to 100, or `null` for no value. */
export const AttioEq = Schema.Union([
  Schema.Null,
  AttioEqValue,
  Schema.Array(AttioEqValue).check(Schema.isBetweenLength(1, 100))
]);
const Bound = Schema.Union([Schema.Number.check(Schema.isFinite()), Text]);
/** One attribute between bounds: numbers, currency amounts, dates and full ISO timestamps. */
export const AttioRange = Schema.Struct({
  attribute: AttioSlug,
  gt: Schema.optionalKey(Bound),
  gte: Schema.optionalKey(Bound),
  lt: Schema.optionalKey(Bound),
  lte: Schema.optionalKey(Bound)
});
export const AttioOrderBy = Schema.Struct({
  attribute: AttioSlug,
  direction: Schema.optionalKey(Schema.Literals(["asc", "desc"]))
});
const filters = {
  /** Equality, ANDed across attributes. */
  eq: Schema.optionalKey(Schema.Record(AttioSlug, AttioEq)),
  /** Case-insensitive substring, ANDed across attributes. */
  contains: Schema.optionalKey(Schema.Record(AttioSlug, Text)),
  range: Schema.optionalKey(AttioRange),
  orderBy: Schema.optionalKey(AttioOrderBy),
  /** 1–500; 100 when left out. */
  limit: Schema.optionalKey(Limit),
  cursor: Schema.optionalKey(Cursor)
};

// ---------- what a patch gets back: every field that leaves the host ----------

export const AttioCurrency = Schema.Struct({
  amount: Schema.Number,
  currency: Schema.NullOr(Schema.String)
});
export const AttioPersonalName = Schema.Struct({
  first: Schema.NullOr(Schema.String),
  last: Schema.NullOr(Schema.String),
  full: Schema.NullOr(Schema.String)
});
const Part = Schema.NullOr(Schema.String);
export const AttioLocation = Schema.Struct({
  line1: Part,
  line2: Part,
  line3: Part,
  line4: Part,
  locality: Part,
  region: Part,
  postcode: Part,
  countryCode: Part,
  latitude: Part,
  longitude: Part
});
/** Who: a workspace member, an API token or Attio itself. */
export const AttioActor = Schema.Struct({ type: Schema.String, id: Schema.NullOr(Schema.String) });
/** An email or calendar event Attio saw, by when and whose. */
export const AttioInteraction = Schema.Struct({
  type: Schema.String,
  at: Schema.String,
  owner: Schema.NullOr(AttioActor)
});
const One = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  AttioCurrency,
  AttioPersonalName,
  AttioLocation,
  AttioRecordRef,
  AttioActor,
  AttioInteraction
]);
/** An attribute's value: an array for a multiselect attribute, else the value or `null`. */
export const AttioValue = Schema.Union([Schema.Null, One, Schema.Array(One)]);
/** Every attribute the snapshot keeps, by slug. */
export const AttioValues = Schema.Record(Schema.String, AttioValue);
export const AttioRecord = Schema.Struct({
  id: Schema.String,
  /** The record in Attio's app. */
  url: Schema.String,
  createdAt: Schema.String,
  values: AttioValues
});
export const AttioEntry = Schema.Struct({
  id: Schema.String,
  /** The record the entry is on. */
  parent: AttioRecordRef,
  createdAt: Schema.String,
  values: AttioValues
});
export const AttioMember = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  /** False for a suspended member. */
  active: Schema.Boolean
});

const page = <Row extends Schema.Top>(row: Row) =>
  Schema.Struct({
    ok: Schema.Literal(true),
    rows: Schema.Array(row),
    /** Pass back as `cursor` for the next page; `null` on the last. */
    cursor: Schema.NullOr(Schema.String)
  });
const rows = <Row extends Schema.Top>(row: Row) =>
  Schema.Struct({ ok: Schema.Literal(true), rows: Schema.Array(row) });

/** Each operation's arguments, without the alias, and its result. */
export const attioReads = {
  listRecords: {
    input: Schema.Struct({ object: AttioSlug, ...filters }),
    output: page(AttioRecord)
  },
  /** At most one row: none when the record is missing or another object's. */
  getRecord: {
    input: Schema.Struct({ object: AttioSlug, id: AttioRecordId }),
    output: rows(AttioRecord)
  },
  /** One row per id asked, in order, `null` for a missing one. */
  getManyRecords: {
    input: Schema.Struct({
      object: AttioSlug,
      ids: Schema.Array(AttioRecordId).check(Schema.isMaxLength(500))
    }),
    output: rows(Schema.NullOr(AttioRecord))
  },
  listEntries: {
    input: Schema.Struct({
      list: AttioSlug,
      ...filters,
      /** One parent record's entries: `{ object, id }`, or its id when the list has one parent. */
      parent: Schema.optionalKey(Schema.Union([AttioRecordRef, AttioRecordId]))
    }),
    output: page(AttioEntry)
  },
  getEntry: {
    input: Schema.Struct({ list: AttioSlug, id: AttioRecordId }),
    output: rows(AttioEntry)
  },
  // No arguments: an empty Struct would let any key through, so this one refuses every key.
  listMembers: { input: Schema.Record(Schema.String, Schema.Never), output: rows(AttioMember) }
} as const;
export type AttioRead = keyof typeof attioReads;
export const attioOperationNames = [
  "listRecords",
  "getRecord",
  "getManyRecords",
  "listEntries",
  "getEntry",
  "listMembers"
] as const satisfies ReadonlyArray<AttioRead>;

/** An operation's arguments on a declared connection: its alias beside the input. */
const withAlias = <F extends Schema.Struct.Fields>(input: Schema.Struct<F>) =>
  Schema.Struct({ connection: DefinitionName, ...input.fields });
export const AttioListRecords = withAlias(attioReads.listRecords.input);
export const AttioGetRecord = withAlias(attioReads.getRecord.input);
export const AttioGetManyRecords = withAlias(attioReads.getManyRecords.input);
export const AttioListEntries = withAlias(attioReads.listEntries.input);
export const AttioGetEntry = withAlias(attioReads.getEntry.input);
export const AttioListMembers = Schema.Struct({ connection: DefinitionName });

const operation = <const Op extends string, Args extends Schema.Top, Output extends Schema.Top>(
  op: Op,
  args: Args,
  response: Output
) =>
  ({
    request: Schema.Struct({ op: Schema.Literal(op), args }),
    response,
    kind: "integration"
  }) as const;

/**
 * The runtime operations, flat as the runtime and dev-read grammar take them. Each result encodes
 * through its operation's own schema, so a field outside it never leaves the host.
 */
export const attioOperations = {
  "attio.listRecords": operation(
    "attio.listRecords",
    AttioListRecords,
    attioReads.listRecords.output
  ),
  "attio.getRecord": operation("attio.getRecord", AttioGetRecord, attioReads.getRecord.output),
  "attio.getManyRecords": operation(
    "attio.getManyRecords",
    AttioGetManyRecords,
    attioReads.getManyRecords.output
  ),
  "attio.listEntries": operation(
    "attio.listEntries",
    AttioListEntries,
    attioReads.listEntries.output
  ),
  "attio.getEntry": operation("attio.getEntry", AttioGetEntry, attioReads.getEntry.output),
  "attio.listMembers": operation(
    "attio.listMembers",
    AttioListMembers,
    attioReads.listMembers.output
  )
} as const;
export type AttioOperation = keyof typeof attioOperations;
