import { NotionId, type NotionSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { belongsToSource, checkSource, pagePath, RowParent, sourceOf } from "./Reads.js";
import { Refusal } from "./Source.js";

type Json = Schema.Json;
type DataSource = NotionSnapshot["dataSources"][number];
type Property = DataSource["properties"][number];
type Values = Readonly<Record<string, Json>>;
type Send = (
  request: HttpClientRequest.HttpClientRequest,
  write?: boolean
) => Effect.Effect<unknown, Refusal>;
type Target = { readonly source: string; readonly id: string };
type Create = { readonly source: string; readonly properties: Values };

const MAX_ITEMS = 100;
const MAX_TEXT = 2000;
const encoder = new TextEncoder();
const isId = Schema.is(NotionId);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const text = (value: Json) => {
  if (typeof value !== "string" || value.length > MAX_ITEMS * MAX_TEXT) return undefined;
  const chunks = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + MAX_TEXT, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push({ type: "text", text: { content: value.slice(start, end) } });
    start = end;
  }
  return chunks.length <= MAX_ITEMS ? chunks : undefined;
};

const option = ({ options }: Property, value: Json) => {
  const found = options?.find(({ name }) => name === value);
  return found === undefined ? undefined : { id: found.id };
};

const array = (value: Json, map: (item: Json) => Json | undefined) => {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined;
  const result: Json[] = [];
  for (const item of value) {
    const encoded = map(item);
    if (encoded === undefined) return undefined;
    result.push(encoded);
  }
  return result;
};

const id = (value: Json) => (isId(value) ? { id: value.toLowerCase() } : undefined);
const nullableString = (max: number) => (value: Json) =>
  value === null || (typeof value === "string" && value.length <= max) ? value : undefined;

const timestamp = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && timestamp.test(value) && Number.isFinite(Date.parse(value));

const date = (value: Json) => {
  if (value === null) return null;
  if (!Predicate.isObject(value) || !isTimestamp(value.start)) return undefined;
  const { start, end } = value;
  if (end !== undefined && end !== null && !isTimestamp(end)) return undefined;
  return { start, end: end ?? null };
};

const writers: Readonly<Record<string, (value: Json, property: Property) => Json | undefined>> = {
  title: text,
  rich_text: text,
  number: (value) => (value === null || typeof value === "number" ? value : undefined),
  select: (value, property) => (value === null ? null : option(property, value)),
  status: (value, property) => (value === null ? null : option(property, value)),
  multi_select: (value, property) => array(value, (name) => option(property, name)),
  date,
  checkbox: (value) => (typeof value === "boolean" ? value : undefined),
  url: nullableString(2000),
  email: nullableString(200),
  phone_number: nullableString(200),
  people: (value) => array(value, id),
  relation: (value) => array(value, id)
};

const encodeProperties = Effect.fnUntraced(function* (source: DataSource, values: Values) {
  const properties: Record<string, Json> = Object.create(null);
  const options = new Map<Property, readonly string[]>();
  const selected: Property[] = [];
  for (const [name, value] of Object.entries(values)) {
    const property = source.properties.find((candidate) => candidate.name === name);
    if (property === undefined || !Object.hasOwn(writers, property.type))
      return yield* new Refusal({ code: "invalid_request" });
    const encoded = writers[property.type]!(value, property);
    if (encoded === undefined)
      return yield* new Refusal({
        code: "invalid_request",
        property: name,
        ...(property.options === undefined
          ? {}
          : { knownOptions: property.options.map(({ name }) => name) })
      });
    properties[property.id] = { [property.type]: encoded };
    selected.push(property);
    if (property.options !== undefined) {
      const names = Array.isArray(value) ? value : [value];
      options.set(
        property,
        names.flatMap((name) => option(property, name)?.id ?? [])
      );
    }
  }
  return { properties, selected, options };
});

/** Count the actual provider body, including property IDs and rich text wrappers. */
const body = (request: HttpClientRequest.HttpClientRequest, value: Json) => {
  const content = json(value);
  return encoder.encode(content).byteLength > 500_000
    ? Effect.fail(new Refusal({ code: "invalid_request" }))
    : Effect.succeed(request.pipe(HttpClientRequest.bodyText(content, "application/json")));
};

const readCreated = Schema.decodeUnknownEffect(
  Schema.Struct({ id: NotionId, url: Schema.String.check(Schema.isPattern(/^https:\/\//)) })
);
const readUpdated = Schema.decodeUnknownEffect(Schema.Struct({ id: NotionId }));
const readTrash = Schema.decodeUnknownEffect(
  Schema.Struct({ id: NotionId, in_trash: Schema.Boolean })
);
const readParent = Schema.decodeUnknownEffect(Schema.Struct({ id: NotionId, parent: RowParent }));
const unknownOutcome = () => new Refusal({ code: "unknown_outcome" });

const owned = Effect.fnUntraced(function* (send: Send, rowId: string, source: DataSource) {
  const row = yield* readParent(yield* send(HttpClientRequest.get(pagePath(rowId)))).pipe(
    Effect.mapError(() => new Refusal({ code: "shape_mismatch" }))
  );
  if (row.id !== rowId || !belongsToSource(row.parent, source.id))
    return yield* new Refusal({ code: "not_found", dataSource: source.title.slice(0, 512) });
});

export const planCreate = Effect.fnUntraced(function* (snapshot: NotionSnapshot, input: Create) {
  const source = yield* sourceOf(snapshot, input.source);
  const { properties, selected, options } = yield* encodeProperties(source, input.properties);
  const request = yield* body(HttpClientRequest.post("/pages"), {
    parent: { type: "data_source_id", data_source_id: source.id },
    properties
  });
  return Effect.fnUntraced(function* (send: Send) {
    yield* checkSource(send, snapshot, source, selected, options);
    return yield* readCreated(yield* send(request, true)).pipe(Effect.mapError(unknownOutcome));
  });
});

export const planUpdate = Effect.fnUntraced(function* (
  snapshot: NotionSnapshot,
  input: Target & { readonly properties: Values }
) {
  const source = yield* sourceOf(snapshot, input.source);
  if (!isId(input.id)) return yield* new Refusal({ code: "invalid_request" });
  const rowId = input.id.toLowerCase();
  const { properties, selected, options } = yield* encodeProperties(source, input.properties);
  const request = yield* body(HttpClientRequest.patch(pagePath(rowId)), { properties });
  return Effect.fnUntraced(function* (send: Send) {
    yield* owned(send, rowId, source);
    yield* checkSource(send, snapshot, source, selected, options);
    const result = yield* readUpdated(yield* send(request, true)).pipe(
      Effect.mapError(unknownOutcome)
    );
    if (result.id !== rowId) return yield* unknownOutcome();
    return result;
  });
});

const planTrashState = Effect.fnUntraced(function* (
  snapshot: NotionSnapshot,
  input: Target,
  inTrash: boolean
) {
  const source = yield* sourceOf(snapshot, input.source);
  if (!isId(input.id)) return yield* new Refusal({ code: "invalid_request" });
  const rowId = input.id.toLowerCase();
  const request = HttpClientRequest.patch(pagePath(rowId)).pipe(
    HttpClientRequest.bodyJsonUnsafe({ in_trash: inTrash })
  );
  return Effect.fnUntraced(function* (send: Send) {
    yield* owned(send, rowId, source);
    const result = yield* readTrash(yield* send(request, true)).pipe(
      Effect.mapError(unknownOutcome)
    );
    if (result.id !== rowId || result.in_trash !== inTrash) return yield* unknownOutcome();
    return { id: result.id, inTrash: result.in_trash };
  });
});

export const planTrash = (snapshot: NotionSnapshot, input: Target) =>
  planTrashState(snapshot, input, true);
export const planRestore = (snapshot: NotionSnapshot, input: Target) =>
  planTrashState(snapshot, input, false);
