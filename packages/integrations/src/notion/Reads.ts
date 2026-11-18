import {
  NotionId,
  notionPropertyType,
  notionPropertyTypes,
  type NotionListInput,
  type NotionListOutput,
  type NotionSnapshot
} from "@patchy/api";
import { canonicalArgs } from "@patchy/api/canonical-args";
import { Cryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Refusal } from "./Source.js";

type Json = Schema.Json;
type DataSource = NotionSnapshot["dataSources"][number];
type Property = DataSource["properties"][number];
type Row = NotionListOutput["rows"][number];
type Send = (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<unknown, Refusal>;

const Name = Schema.String;
const Id = Schema.String.check(Schema.isBetweenLength(1, 128));
const RawReference = Schema.Struct({ id: NotionId });
const RawUser = Schema.Struct({ id: NotionId, name: Schema.optionalKey(Schema.NullOr(Name)) });
const RichText = Schema.Array(
  Schema.Struct({
    plain_text: Schema.String,
    mention: Schema.optionalKey(Schema.Struct({ type: Schema.String }))
  })
);
const RawSchemaProperty = Schema.Struct({
  id: Id,
  type: Schema.String,
  relation: Schema.optionalKey(Schema.Struct({ data_source_id: Schema.optionalKey(Id) }))
});
const RawSource = Schema.Struct({
  id: Id,
  properties: Schema.Record(Name, RawSchemaProperty)
});
const RawProperty = Schema.StructWithRest(
  Schema.Struct({ id: Id, type: Schema.String, has_more: Schema.optionalKey(Schema.Boolean) }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
const RawRow = Schema.Struct({
  object: Schema.Literal("page"),
  id: NotionId,
  url: Schema.String,
  created_time: Schema.String,
  last_edited_time: Schema.String,
  in_trash: Schema.Boolean,
  parent: Schema.optionalKey(
    Schema.Struct({ type: Schema.String, data_source_id: Schema.optionalKey(Id) })
  ),
  properties: Schema.Record(Name, RawProperty)
});
const page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    results: Schema.Array(item),
    has_more: Schema.Boolean,
    next_cursor: Schema.NullOr(Schema.String),
    request_status: Schema.optionalKey(Schema.Struct({ type: Schema.String }))
  });

const readSource = Schema.decodeUnknownEffect(RawSource);
const readRows = Schema.decodeUnknownEffect(page(RawRow));
const RawItemsPage = page(Schema.Record(Schema.String, Schema.Unknown));
const readItems = Schema.decodeUnknownEffect(RawItemsPage);
const readRichText = Schema.decodeUnknownOption(RichText);
const readArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

const reader = <A>(schema: Schema.Decoder<A>, map: (value: A) => Json) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (raw: unknown) => Option.match(decode(raw), { onNone: () => undefined, onSome: map });
};
const plain = reader(RichText, (value) => value.map((part) => part.plain_text).join("") || null);
const string = reader(Schema.NullOr(Schema.String), (value) => value);
const number = reader(Schema.NullOr(Schema.Number.check(Schema.isFinite())), (value) => value);
const checkbox = reader(Schema.Boolean, (value) => value);
const timestamp = reader(Schema.String, (value) => value);
const option = reader(Schema.NullOr(Schema.Struct({ name: Name })), (value) => value?.name ?? null);
const person = ({ id, name }: typeof RawUser.Type) => ({ id, name: name ?? null });

const values = {
  title: plain,
  rich_text: plain,
  number,
  checkbox,
  select: option,
  status: option,
  multi_select: reader(Schema.Array(Schema.Struct({ name: Name })), (options) =>
    options.map(({ name }) => name)
  ),
  date: reader(
    Schema.NullOr(Schema.Struct({ start: Schema.String, end: Schema.NullOr(Schema.String) })),
    (value) => value
  ),
  url: string,
  email: string,
  phone_number: string,
  people: reader(Schema.Array(RawUser), (users) => users.map(person)),
  relation: reader(Schema.Array(RawReference), (refs) => refs.map(({ id }) => id)),
  files: reader(Schema.Array(Schema.Struct({ name: Name })), (files) =>
    files.map(({ name }) => name)
  ),
  created_time: timestamp,
  last_edited_time: timestamp,
  created_by: reader(RawUser, person),
  last_edited_by: reader(RawUser, person),
  unique_id: reader(
    Schema.NullOr(
      Schema.Struct({ prefix: Schema.NullOr(Name), number: Schema.NullOr(Schema.Int) })
    ),
    (value) =>
      value?.number == null
        ? null
        : value.prefix
          ? `${value.prefix}-${value.number}`
          : String(value.number)
  )
} satisfies Record<keyof typeof notionPropertyTypes, (value: unknown) => Json | undefined>;
const isKnownType = (type: string): type is keyof typeof values => Object.hasOwn(values, type);

const CursorJson = Schema.fromJsonString(
  Schema.Struct({
    v: Schema.Literal(1),
    binding: Schema.String,
    next: Schema.String.check(Schema.isBetweenLength(1, 1024))
  })
);
const decodeCursor = Schema.decodeUnknownEffect(CursorJson, { onExcessProperty: "error" });
const encodeCursor = Schema.encodeSync(CursorJson);
const readCursor = Effect.fnUntraced(function* (cursor: string | undefined, binding: string) {
  if (cursor === undefined) return undefined;
  if (cursor.length > 1800 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    return yield* new Refusal({ code: "invalid_cursor" });
  const value = yield* decodeCursor(Buffer.from(cursor, "base64url").toString("utf8")).pipe(
    Effect.mapError(() => new Refusal({ code: "invalid_cursor" }))
  );
  if (value.binding !== binding) return yield* new Refusal({ code: "invalid_cursor" });
  return value.next;
});

const nextPage = (answer: { readonly has_more: boolean; readonly next_cursor: string | null }) =>
  answer.has_more &&
  (answer.next_cursor === null ||
    answer.next_cursor.length === 0 ||
    answer.next_cursor.length > 1024)
    ? Effect.fail(new Refusal({ code: "shape_mismatch" }))
    : Effect.succeed(answer.has_more ? answer.next_cursor : null);

const sourcePath = (id: string) => `/data_sources/${encodeURIComponent(id)}`;
const propertyPath = (rowId: string, propertyId: string) =>
  `/pages/${encodeURIComponent(rowId)}/properties/${encodeURIComponent(propertyId).replace(/%25([0-9a-f]{2})/gi, "%$1")}`;
const shapeMismatch = (property?: Property) =>
  new Refusal({
    code: "shape_mismatch",
    ...(property === undefined
      ? {}
      : { missing: { kind: "property" as const, name: property.name } })
  });

const checkSource = Effect.fnUntraced(function* (
  send: Send,
  source: DataSource,
  selected: readonly Property[]
) {
  const targets = new Set(
    selected.flatMap(({ relationTarget }) => (relationTarget ? [relationTarget] : []))
  );
  for (const id of targets) {
    if (id === source.id) continue;
    yield* send(HttpClientRequest.get(sourcePath(id)));
  }
  const live = yield* readSource(yield* send(HttpClientRequest.get(sourcePath(source.id)))).pipe(
    Effect.mapError(() => shapeMismatch())
  );
  if (live.id !== source.id) return yield* shapeMismatch();
  const byId = new Map(Object.values(live.properties).map((property) => [property.id, property]));
  for (const property of source.properties) {
    const current = byId.get(property.id);
    if (
      current?.type !== property.type ||
      (property.type === "relation" &&
        selected.includes(property) &&
        current.relation?.data_source_id !== property.relationTarget)
    )
      return yield* shapeMismatch(property);
  }
});

const potentiallyCut = (property: typeof RawProperty.Type) => {
  if (property.type === "relation") return property.has_more === true;
  if (property.type === "people")
    return (Option.getOrUndefined(readArray(property.people))?.length ?? 0) >= 25;
  if (property.type !== "title" && property.type !== "rich_text") return false;
  const rich = Option.getOrUndefined(readRichText(property[property.type]));
  return (
    (rich?.filter((item) => item.mention?.type === "page" || item.mention?.type === "user")
      .length ?? 0) >= 25
  );
};

const readComplete = Effect.fnUntraced(function* (
  send: Send,
  rowId: string,
  property: Property,
  budget: { remaining: number; limit: number }
) {
  let cursor: string | null = null;
  const seen = new Set<string>();
  const items: unknown[] = [];
  const route = propertyPath(rowId, property.id);
  do {
    if (budget.remaining <= 0)
      return yield* new Refusal({
        code: "too_large",
        bound: { name: "property items", limit: budget.limit }
      });
    const request = HttpClientRequest.get(route).pipe(
      HttpClientRequest.appendUrlParam("page_size", "100")
    );
    const answer: typeof RawItemsPage.Type = yield* readItems(
      yield* send(
        cursor === null
          ? request
          : request.pipe(HttpClientRequest.appendUrlParam("start_cursor", cursor))
      )
    ).pipe(Effect.mapError(() => shapeMismatch(property)));
    budget.remaining -= Math.max(1, answer.results.length);
    if (budget.remaining < 0)
      return yield* new Refusal({
        code: "too_large",
        bound: { name: "property items", limit: budget.limit }
      });
    for (const item of answer.results) {
      if (item.type !== property.type || !Object.hasOwn(item, property.type))
        return yield* shapeMismatch(property);
      items.push(item[property.type]);
    }
    cursor = yield* nextPage(answer);
    if (cursor !== null) {
      if (seen.has(cursor)) return yield* shapeMismatch(property);
      seen.add(cursor);
    }
  } while (cursor !== null);
  return items;
});

const row = Effect.fnUntraced(function* (
  send: Send,
  source: DataSource,
  raw: typeof RawRow.Type,
  selected: readonly Property[],
  budget: { remaining: number; limit: number }
) {
  if (
    raw.parent !== undefined &&
    (raw.parent.type !== "data_source_id" || raw.parent.data_source_id !== source.id)
  )
    return yield* shapeMismatch();
  const byId = new Map(Object.values(raw.properties).map((property) => [property.id, property]));
  const output: Record<string, Json> = Object.create(null);
  for (const property of selected) {
    const value = byId.get(property.id);
    if (
      value?.type !== property.type ||
      !isKnownType(property.type) ||
      !Object.hasOwn(value, value.type)
    )
      return yield* shapeMismatch(property);
    const rawValue = potentiallyCut(value)
      ? yield* readComplete(send, raw.id, property, budget)
      : value[value.type];
    const read = values[property.type](rawValue);
    if (read === undefined) return yield* shapeMismatch(property);
    output[property.name] = read;
  }
  return {
    id: raw.id,
    url: raw.url,
    createdTime: raw.created_time,
    lastEditedTime: raw.last_edited_time,
    inTrash: raw.in_trash,
    properties: output
  } satisfies Row;
});

const timestamps = { createdTime: "created_time", lastEditedTime: "last_edited_time" } as const;
const timeType = (type: string) => type === "created_time" || type === "last_edited_time";
const timeValue = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const directions = { asc: "ascending", desc: "descending" } as const;
const numberRange = {
  gt: "greater_than",
  gte: "greater_than_or_equal_to",
  lt: "less_than",
  lte: "less_than_or_equal_to"
} as const;
const dateRange = { gt: "after", gte: "on_or_after", lt: "before", lte: "on_or_before" } as const;

const filter = (property: Property, criterion: Json) =>
  timeType(property.type)
    ? { timestamp: property.type, [property.type]: criterion }
    : { property: property.id, [property.type]: criterion };

const plan = Effect.fnUntraced(function* (source: DataSource, args: NotionListInput) {
  const properties = new Map(source.properties.map((property) => [property.name, property]));
  const field = (name: string) =>
    properties.get(name) ??
    (name === "createdTime" || name === "lastEditedTime"
      ? { id: name, name, type: timestamps[name] }
      : undefined);
  const invalid = () => new Refusal({ code: "invalid_request" });

  const selected: Property[] = args.select === undefined ? [...source.properties] : [];
  if (args.select !== undefined) {
    for (const name of new Set(args.select)) {
      const property = properties.get(name);
      if (property === undefined) return yield* invalid();
      selected.push(property);
    }
  }

  const filters: Json[] = [];
  for (const [name, value] of Object.entries(args.eq ?? {})) {
    const property = properties.get(name);
    const eq = property && notionPropertyType(property.type)?.eq;
    if (
      !property ||
      !eq ||
      (value === null ? eq === "boolean" : typeof value !== eq) ||
      (property.type === "date" && typeof value === "string" && !timeValue.test(value))
    )
      return yield* invalid();
    filters.push(filter(property, value === null ? { is_empty: true } : { equals: value }));
  }
  for (const [name, value] of Object.entries(args.contains ?? {})) {
    const property = properties.get(name);
    if (
      !property ||
      !notionPropertyType(property.type)?.contains ||
      ((property.type === "people" || property.type === "relation") && !uuid.test(value))
    )
      return yield* invalid();
    filters.push(filter(property, { contains: value }));
  }
  if (args.range !== undefined) {
    const { property: name, ...limits } = args.range;
    const property = field(name);
    const range = property && notionPropertyType(property.type)?.range;
    const entries = Object.entries(limits);
    if (!property || !range || entries.length === 0) return yield* invalid();
    for (const [operator, value] of entries) {
      if (
        !(operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") ||
        (range === "number"
          ? typeof value !== "number"
          : typeof value !== "string" || !timeValue.test(value))
      )
        return yield* invalid();
      const comparison = range === "number" ? numberRange[operator] : dateRange[operator];
      filters.push(filter(property, { [comparison]: value }));
    }
  }
  const order = args.orderBy;
  let sort: Json | undefined;
  if (order !== undefined) {
    const property = field(order.property);
    if (!property) return yield* invalid();
    sort = {
      ...(timeType(property.type) ? { timestamp: property.type } : { property: property.id }),
      direction: directions[order.direction ?? "asc"]
    };
  }
  const body = {
    result_type: "page",
    page_size: args.limit ?? 100,
    ...(filters.length > 0 ? { filter: filters.length === 1 ? filters[0] : { and: filters } } : {}),
    ...(sort === undefined ? {} : { sorts: [sort] })
  } satisfies Json;
  return { selected, body };
});

/** Checks user arguments against the pinned snapshot before an upstream request can run. */
export const planList = Effect.fnUntraced(function* (
  snapshot: NotionSnapshot,
  input: NotionListInput,
  binding: { readonly id: string; readonly revision: number }
) {
  const source = snapshot.dataSources.find((candidate) => candidate.key === input.source);
  if (source === undefined) return yield* new Refusal({ code: "invalid_request" });
  const { selected, body } = yield* plan(source, input);
  const cryptography = yield* Cryptography.Cryptography;
  const digest = yield* cryptography.sha256(
    canonicalArgs([
      "notion.listRows",
      binding.id,
      binding.revision,
      source.id,
      input.eq ?? null,
      input.contains ?? null,
      input.range ?? null,
      input.orderBy ?? null,
      input.select ?? null
    ])
  );
  const cursor = yield* readCursor(input.cursor, digest);
  const payload = { ...body, ...(cursor === undefined ? {} : { start_cursor: cursor }) };
  if (new TextEncoder().encode(canonicalArgs(payload)).byteLength > 500_000)
    return yield* new Refusal({ code: "invalid_request" });
  const propertyLimit = yield* ContractLimits.get("notion.read.propertyItems");
  return Effect.fnUntraced(function* (send: Send) {
    yield* checkSource(send, source, selected);
    const request = HttpClientRequest.post(`${sourcePath(source.id)}/query`).pipe(
      HttpClientRequest.appendUrlParams(
        input.select === undefined
          ? []
          : selected.map(({ id }) => ["filter_properties", id] as const)
      ),
      HttpClientRequest.bodyJsonUnsafe(payload)
    );
    const answer = yield* readRows(yield* send(request)).pipe(
      Effect.mapError(() => shapeMismatch())
    );
    if (answer.request_status?.type === "incomplete")
      return yield* new Refusal({ code: "offset_exhausted" });
    if (answer.results.length > body.page_size) return yield* shapeMismatch();
    const next = yield* nextPage(answer);
    if (next !== null && next === cursor) return yield* shapeMismatch();
    const budget = { remaining: propertyLimit, limit: propertyLimit };
    const rows: Row[] = [];
    for (const raw of answer.results) rows.push(yield* row(send, source, raw, selected, budget));
    return {
      rows,
      cursor:
        next === null
          ? null
          : Buffer.from(encodeCursor({ v: 1, binding: digest, next }), "utf8").toString("base64url")
    } satisfies NotionListOutput;
  });
});
