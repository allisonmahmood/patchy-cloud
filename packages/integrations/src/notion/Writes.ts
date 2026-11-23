import {
  NotionDate,
  NotionId,
  type NotionCreateInput,
  type NotionCreateOutput,
  type NotionSnapshot,
  type NotionTrashInput,
  type NotionTrashOutput,
  type NotionUpdateInput,
  type NotionUpdateOutput
} from "@patchy/api";
import { Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { sourceOf, type Send } from "./Reads.js";
import { afterWrite, Refusal, shape } from "./Source.js";

/**
 * Each write is planned against the version's snapshot, like a read: property names resolve to
 * Notion's property ids and option names to option ids, so Notion never makes an option out of a
 * typo, and a value Notion would refuse is refused with nothing sent. Sending first reads only
 * what keeps a write inside its data source and from dropping relations the patch never saw, then
 * sends the write once.
 */

type Json = Schema.Json;
type DataSource = NotionSnapshot["dataSources"][number];
type Property = DataSource["properties"][number];

/** Notion's limits on one value: characters per text object, and text objects or list items. */
const TEXT = 2000;
const ITEMS = 100;

/** Plain text as Notion's text objects, split between code points; undefined past Notion's. */
const text = (value: Json): Json | undefined => {
  if (typeof value !== "string") return undefined;
  const parts: Json[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + TEXT, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push({ type: "text", text: { content: value.slice(start, end) } });
    start = end;
  }
  return parts.length <= ITEMS ? parts : undefined;
};
/** A value `schema` takes, in Notion's shape; undefined when it doesn't decode. */
const writer = <A>(schema: Schema.Decoder<A>, map: (value: A) => Json) => {
  const read = Schema.decodeUnknownOption(schema);
  return (value: Json) => Option.match(read(value), { onNone: () => undefined, onSome: map });
};
const upTo = (length: number) =>
  writer(Schema.NullOr(Schema.String.check(Schema.isMaxLength(length))), (value) => value);
const references = writer(Schema.Array(NotionId).check(Schema.isMaxLength(ITEMS)), (ids) =>
  ids.map((id) => ({ id }))
);
const option = (property: Property, name: Json) => {
  const found = property.options?.find((candidate) => candidate.name === name);
  return found && { id: found.id };
};

/** Each writable type's value, as Notion takes it. Every other type is read-only. */
const writers: Readonly<Record<string, (value: Json, property: Property) => Json | undefined>> = {
  title: text,
  rich_text: text,
  number: writer(Schema.NullOr(Schema.Number), (value) => value),
  checkbox: writer(Schema.Boolean, (value) => value),
  date: writer(
    Schema.NullOr(
      Schema.Struct({ start: NotionDate, end: Schema.optionalKey(Schema.NullOr(NotionDate)) })
    ),
    (date) => date && { start: date.start, end: date.end ?? null }
  ),
  url: upTo(2000),
  email: upTo(200),
  phone_number: upTo(200),
  people: references,
  relation: references,
  select: (value, property) => (value === null ? null : option(property, value)),
  status: (value, property) => (value === null ? null : option(property, value)),
  multi_select: (value, property) => {
    if (!Array.isArray(value) || value.length > ITEMS) return undefined;
    const chosen = value.map((name) => option(property, name));
    return chosen.every(Predicate.isNotUndefined) ? chosen : undefined;
  }
};

/** Whether a select, status or multi-select value names an option this version doesn't know. */
const unknownOption = (property: Property, value: Json) =>
  property.options !== undefined &&
  (Array.isArray(value) ? value : [value]).some(
    (name) => name !== null && option(property, name) === undefined
  );

/**
 * Values by property name as Notion takes them, by property id, and the data sources the
 * relations they set point at, by id and key.
 */
const encode = Effect.fnUntraced(function* (
  snapshot: NotionSnapshot,
  source: DataSource,
  values: NotionCreateInput["properties"]
) {
  const byName = new Map(source.properties.map((property) => [property.name, property]));
  // A property may be named __proto__.
  const properties: Record<string, Json> = Object.create(null);
  const relations = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    const property = byName.get(name);
    const write =
      property && Object.hasOwn(writers, property.type) ? writers[property.type] : undefined;
    if (property === undefined || write === undefined) return yield* new Runtime.InvalidRequest({});
    if (unknownOption(property, value))
      return yield* new Refusal({
        code: "invalid_request",
        property: name,
        knownOptions: (property.options ?? []).map((known) => known.name)
      });
    const encoded = write(value, property);
    if (encoded === undefined) return yield* new Runtime.InvalidRequest({});
    properties[property.id] = { [property.type]: encoded };
    if (property.relationTarget !== undefined)
      relations.set(
        property.relationTarget,
        snapshot.dataSources.find(({ id }) => id === property.relationTarget)?.key ??
          property.relationTarget
      );
  }
  return { properties, relations };
});

const isId = Schema.is(NotionId);
/** A row id as Notion has it: never one `patchy dev` answered a simulated create with. */
const rowIdOf = (id: string) =>
  isId(id) ? Effect.succeed(id) : Effect.fail(new Runtime.InvalidRequest({}));

const decode = <A>(schema: Schema.Decoder<A>) => {
  const read = Schema.decodeUnknownEffect(schema);
  return (body: unknown) => read(body).pipe(Effect.mapError(shape));
};
const readParent = decode(
  Schema.Struct({ parent: Schema.Struct({ data_source_id: Schema.optionalKey(Schema.String) }) })
);
const readCreated = decode(Schema.Struct({ id: NotionId, url: Schema.String }));
const readUpdated = decode(Schema.Struct({ id: NotionId }));
const readTrashed = decode(Schema.Struct({ id: NotionId, in_trash: Schema.Boolean }));

/**
 * Before a write that sets a relation, each target data source still readable: Notion answers a
 * relation to one no longer shared as empty, so writing it back would drop what the patch never
 * saw.
 */
const readable = (send: Send, relations: ReadonlyMap<string, string>) =>
  Effect.forEach(
    relations,
    ([id, key]) =>
      send(HttpClientRequest.get(`/data_sources/${encodeURIComponent(id)}`)).pipe(
        Effect.mapError((error) =>
          error.code === "not_found" ? new Refusal({ code: "not_found", dataSource: key }) : error
        )
      ),
    { discard: true }
  );

/**
 * Before a change to a row, that it is this data source's: otherwise any page shared with the
 * connection could be changed or trashed through it.
 */
const owned = (send: Send, rowId: string, source: DataSource) =>
  send(HttpClientRequest.get(`/pages/${rowId}`)).pipe(
    Effect.flatMap(readParent),
    Effect.flatMap(({ parent }) =>
      parent.data_source_id === source.id
        ? Effect.void
        : Effect.fail(new Refusal({ code: "not_found" }))
    )
  );

/** The write itself, sent once: an answer that decodes is Notion's success. */
const write = <A>(
  send: Send,
  request: HttpClientRequest.HttpClientRequest,
  read: (body: unknown) => Effect.Effect<A, Refusal>
) => send(request).pipe(Effect.flatMap(read), Effect.mapError(afterWrite));

/** A row in the data source, answering its id and URL. */
export const planCreate = Effect.fnUntraced(function* (
  snapshot: NotionSnapshot,
  input: NotionCreateInput
) {
  const source = yield* sourceOf(snapshot, input.source);
  const { properties, relations } = yield* encode(snapshot, source, input.properties);
  const request = HttpClientRequest.post("/pages").pipe(
    HttpClientRequest.bodyJsonUnsafe({
      parent: { type: "data_source_id", data_source_id: source.id },
      properties
    })
  );
  return Effect.fnUntraced(function* (send: Send): Effect.fn.Return<NotionCreateOutput, Refusal> {
    yield* readable(send, relations);
    return yield* write(send, request, readCreated);
  });
});

/** The properties named, each set whole; the rest are left as they are. */
export const planUpdate = Effect.fnUntraced(function* (
  snapshot: NotionSnapshot,
  input: NotionUpdateInput
) {
  const source = yield* sourceOf(snapshot, input.source);
  const rowId = yield* rowIdOf(input.id);
  const { properties, relations } = yield* encode(snapshot, source, input.properties);
  const request = HttpClientRequest.patch(`/pages/${rowId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe({ properties })
  );
  return Effect.fnUntraced(function* (send: Send): Effect.fn.Return<NotionUpdateOutput, Refusal> {
    yield* owned(send, rowId, source);
    yield* readable(send, relations);
    return yield* write(send, request, readUpdated);
  });
});

/** Notion's trash, which `restore` takes a row back out of. */
const planTrashed = (inTrash: boolean) =>
  Effect.fnUntraced(function* (snapshot: NotionSnapshot, input: NotionTrashInput) {
    const source = yield* sourceOf(snapshot, input.source);
    const rowId = yield* rowIdOf(input.id);
    const request = HttpClientRequest.patch(`/pages/${rowId}`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ in_trash: inTrash })
    );
    return Effect.fnUntraced(function* (send: Send): Effect.fn.Return<NotionTrashOutput, Refusal> {
      yield* owned(send, rowId, source);
      const answer = yield* write(send, request, readTrashed);
      return { id: answer.id, inTrash: answer.in_trash };
    });
  });
export const planTrash = planTrashed(true);
export const planRestore = planTrashed(false);
