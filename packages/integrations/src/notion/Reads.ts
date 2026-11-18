import {
  NotionDate,
  NotionId,
  notionPropertyType,
  type notionPropertyTypes,
  type NotionGetInput,
  type NotionGetOutput,
  type NotionListInput,
  type NotionListOutput,
  type NotionMarkdownInput,
  type NotionMarkdownOutput,
  type NotionPeopleInput,
  type NotionPeopleOutput,
  type NotionSearchInput,
  type NotionSearchOutput,
  type NotionSnapshot
} from "@patchy/api";
import { Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Refusal, shape } from "./Source.js";

/**
 * Each read is planned against the version's snapshot, where its arguments are checked and
 * nothing is sent, and the plan is then run with a sender holding the token. Property names
 * resolve to Notion's property ids, so a rename in Notion keeps reading; a selected property that
 * is gone or retyped fails `shape_mismatch` naming it. Notion's cursors pass through as they are.
 */

type Json = Schema.Json;
type DataSource = NotionSnapshot["dataSources"][number];
type Property = DataSource["properties"][number];
type Row = NotionListOutput["rows"][number];
/** One request with the call's token, within its byte budget. */
export type Send = (
  request: HttpClientRequest.HttpClientRequest
) => Effect.Effect<unknown, Refusal>;
/**
 * A call checked against its snapshot, ready to send. Bad arguments fail `invalid_request` with
 * nothing sent; a write naming an option the snapshot doesn't know is a refusal naming the known.
 */
export type Plan<I, A, E = Runtime.InvalidRequest> = (
  snapshot: NotionSnapshot,
  input: I
) => Effect.Effect<(send: Send) => Effect.Effect<A, Refusal>, E>;

const WebUrl = Schema.String.check(Schema.isPattern(/^https:\/\//));
const RawUser = Schema.Struct({
  id: NotionId,
  name: Schema.optionalKey(Schema.NullOr(Schema.String))
});
const RichText = Schema.Array(
  Schema.Struct({
    plain_text: Schema.String,
    mention: Schema.optionalKey(Schema.Struct({ type: Schema.String }))
  })
);
const RawProperty = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    type: Schema.String,
    has_more: Schema.optionalKey(Schema.Boolean)
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
const PageInfo = Schema.Struct({
  object: Schema.Literal("page"),
  id: NotionId,
  url: WebUrl,
  last_edited_time: Schema.String,
  parent: Schema.Struct({ data_source_id: Schema.optionalKey(Schema.String) }),
  properties: Schema.Record(Schema.String, Schema.Unknown)
});
const RawRow = Schema.Struct({
  ...PageInfo.fields,
  created_time: Schema.String,
  in_trash: Schema.Boolean,
  properties: Schema.Record(Schema.String, RawProperty)
});
const SourceInfo = Schema.Struct({
  object: Schema.Literal("data_source"),
  id: NotionId,
  title: RichText,
  last_edited_time: Schema.String,
  parent: Schema.Struct({ database_id: NotionId })
});
const list = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    results: Schema.Array(item),
    has_more: Schema.Boolean,
    next_cursor: Schema.NullOr(Schema.String),
    request_status: Schema.optionalKey(Schema.Struct({ type: Schema.String }))
  });

const decode = <A>(schema: Schema.Decoder<A>) => {
  const read = Schema.decodeUnknownEffect(schema);
  return (body: unknown) => read(body).pipe(Effect.mapError(shape));
};
const readRows = decode(list(Schema.Unknown));
const readRow = decode(RawRow);
const RawItems = list(Schema.Record(Schema.String, Schema.Unknown));
const readItems = decode(RawItems);
const readPageInfo = decode(PageInfo);
const readMarkdown = decode(Schema.Struct({ markdown: Schema.String, truncated: Schema.Boolean }));
const readSearch = decode(list(Schema.Union([PageInfo, SourceInfo])));
const readDatabase = decode(Schema.Struct({ url: WebUrl }));
const readPeople = decode(
  list(Schema.Struct({ ...RawUser.fields, type: Schema.Literals(["person", "bot"]) }))
);
const readTitle = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("title"), title: RichText })
);
const readRichText = Schema.decodeUnknownOption(RichText);
const readArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

/** A property's value as the wire carries it, or undefined when Notion's doesn't decode. */
const reader = <A>(schema: Schema.Decoder<A>, map: (value: A) => Json) => {
  const read = Schema.decodeUnknownOption(schema);
  return (raw: unknown) => Option.match(read(raw), { onNone: () => undefined, onSome: map });
};
const plain = reader(RichText, (value) => value.map((part) => part.plain_text).join("") || null);
const string = reader(Schema.NullOr(Schema.String), (value) => value);
const timestamp = reader(Schema.String, (value) => value);
const option = reader(
  Schema.NullOr(Schema.Struct({ name: Schema.String })),
  (value) => value?.name ?? null
);
const names = reader(Schema.Array(Schema.Struct({ name: Schema.String })), (items) =>
  items.map(({ name }) => name)
);
const person = ({ id, name }: typeof RawUser.Type) => ({ id, name: name ?? null });
const actor = reader(RawUser, person);

const values = {
  title: plain,
  rich_text: plain,
  number: reader(Schema.NullOr(Schema.Number.check(Schema.isFinite())), (value) => value),
  checkbox: reader(Schema.Boolean, (value) => value),
  select: option,
  status: option,
  multi_select: names,
  date: reader(
    Schema.NullOr(Schema.Struct({ start: Schema.String, end: Schema.NullOr(Schema.String) })),
    (value) => value
  ),
  url: string,
  email: string,
  phone_number: string,
  people: reader(Schema.Array(RawUser), (users) => users.map(person)),
  relation: reader(Schema.Array(Schema.Struct({ id: NotionId })), (refs) =>
    refs.map(({ id }) => id)
  ),
  files: names,
  created_time: timestamp,
  last_edited_time: timestamp,
  created_by: actor,
  last_edited_by: actor,
  unique_id: reader(
    Schema.NullOr(
      Schema.Struct({ prefix: Schema.NullOr(Schema.String), number: Schema.NullOr(Schema.Int) })
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

const invalid = () => new Runtime.InvalidRequest({});
const mismatch = (property: Property) =>
  new Refusal({ code: "shape_mismatch", property: property.name });
const isId = Schema.is(NotionId);
const isDate = Schema.is(NotionDate);
const nextCursor = (answer: { readonly has_more: boolean; readonly next_cursor: string | null }) =>
  answer.has_more ? answer.next_cursor : null;
/** A page that is missing or no longer shared reads as null. */
const orNull = (sent: Effect.Effect<unknown, Refusal>) =>
  sent.pipe(
    Effect.catchTags({
      NotionRefusal: (error) =>
        error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error)
    })
  );

/** The data source a call names by its generated key. */
export const sourceOf = (snapshot: NotionSnapshot, key: string) => {
  const found = snapshot.dataSources.find((source) => source.key === key);
  return found === undefined ? Effect.fail(invalid()) : Effect.succeed(found);
};

/**
 * Notion's page object holds at most 25 people, relation references and mentions in one value;
 * one at that cut is read whole through the property endpoint.
 */
const isCut = (value: typeof RawProperty.Type) => {
  if (value.type === "relation") return value.has_more === true;
  if (value.type === "people")
    return (Option.getOrUndefined(readArray(value.people))?.length ?? 0) >= 25;
  if (value.type !== "title" && value.type !== "rich_text") return false;
  const mentions = Option.getOrUndefined(readRichText(value[value.type]))?.filter(
    ({ mention }) => mention?.type === "page" || mention?.type === "user"
  );
  return (mentions?.length ?? 0) >= 25;
};

/** Every item of one property of one row, page after page; the call's byte budget bounds it. */
const readWhole = Effect.fnUntraced(function* (send: Send, rowId: string, property: Property) {
  const items: unknown[] = [];
  let cursor: string | null = null;
  do {
    const answer: typeof RawItems.Type = yield* readItems(
      yield* send(
        // Notion's property ids come URL-encoded, so they go in the path as they are.
        HttpClientRequest.get(`/pages/${rowId}/properties/${property.id}`).pipe(
          HttpClientRequest.appendUrlParams({
            page_size: "100",
            ...(cursor === null ? {} : { start_cursor: cursor })
          })
        )
      )
    );
    for (const item of answer.results) items.push(item[property.type]);
    cursor = nextCursor(answer);
  } while (cursor !== null);
  return items;
});

/** A row with the selected properties by the snapshot's names, matched by property id. */
const row = Effect.fnUntraced(function* (
  send: Send,
  raw: typeof RawRow.Type,
  selected: readonly Property[]
) {
  const byId = new Map(Object.values(raw.properties).map((value) => [value.id, value]));
  // A property may be named __proto__.
  const properties: Record<string, Json> = Object.create(null);
  for (const property of selected) {
    const value = byId.get(property.id);
    if (value?.type !== property.type || !isKnownType(property.type))
      return yield* mismatch(property);
    const read = values[property.type](
      isCut(value) ? yield* readWhole(send, raw.id, property) : value[value.type]
    );
    if (read === undefined) return yield* mismatch(property);
    properties[property.name] = read;
  }
  return {
    id: raw.id,
    url: raw.url,
    createdTime: raw.created_time,
    lastEditedTime: raw.last_edited_time,
    inTrash: raw.in_trash,
    properties
  } satisfies Row;
});

/** Created and edited time, for range and order when no property takes their names. */
const times: Readonly<Record<string, Property>> = {
  createdTime: { id: "createdTime", name: "createdTime", type: "created_time" },
  lastEditedTime: { id: "lastEditedTime", name: "lastEditedTime", type: "last_edited_time" }
};
const isTime = (property: Property) =>
  property.type === "created_time" || property.type === "last_edited_time";
const on = (property: Property, criterion: Json) =>
  isTime(property)
    ? { timestamp: property.type, [property.type]: criterion }
    : { property: property.id, [property.type]: criterion };
const comparisons = {
  number: {
    gt: "greater_than",
    gte: "greater_than_or_equal_to",
    lt: "less_than",
    lte: "less_than_or_equal_to"
  },
  string: { gt: "after", gte: "on_or_after", lt: "before", lte: "on_or_before" }
} as const;

/** A data source's rows: its filters, order and selection, resolved by property id. */
export const planList = Effect.fnUntraced(function* (
  snapshot: NotionSnapshot,
  input: NotionListInput
) {
  const source = yield* sourceOf(snapshot, input.source);
  const byName = new Map(source.properties.map((property) => [property.name, property]));
  const field = (name: string) =>
    byName.get(name) ?? (Object.hasOwn(times, name) ? times[name] : undefined);

  const selected: Property[] = [];
  for (const name of new Set(input.select ?? byName.keys())) {
    const property = byName.get(name);
    if (property === undefined) return yield* invalid();
    selected.push(property);
  }

  const filters: Json[] = [];
  for (const [name, value] of Object.entries(input.eq ?? {})) {
    const property = byName.get(name);
    const eq = property && notionPropertyType(property.type)?.eq;
    if (
      !property ||
      !eq ||
      (value === null ? eq === "boolean" : typeof value !== eq) ||
      (property.type === "date" && value !== null && !isDate(value))
    )
      return yield* invalid();
    filters.push(on(property, value === null ? { is_empty: true } : { equals: value }));
  }
  for (const [name, value] of Object.entries(input.contains ?? {})) {
    const property = byName.get(name);
    if (
      !property ||
      !notionPropertyType(property.type)?.contains ||
      ((property.type === "people" || property.type === "relation") && !isId(value))
    )
      return yield* invalid();
    filters.push(on(property, { contains: value }));
  }
  if (input.range !== undefined) {
    const property = field(input.range.property);
    const kind = property && notionPropertyType(property.type)?.range;
    if (!property || !kind) return yield* invalid();
    const before = filters.length;
    for (const operator of ["gt", "gte", "lt", "lte"] as const) {
      const value = input.range[operator];
      if (value === undefined) continue;
      if (kind === "number" ? typeof value !== "number" : !isDate(value)) return yield* invalid();
      filters.push(on(property, { [comparisons[kind][operator]]: value }));
    }
    // A range with no bound would list everything while looking filtered.
    if (filters.length === before) return yield* invalid();
  }
  let sort: Json | undefined;
  if (input.orderBy !== undefined) {
    const property = field(input.orderBy.property);
    if (!property) return yield* invalid();
    sort = {
      ...(isTime(property) ? { timestamp: property.type } : { property: property.id }),
      direction: input.orderBy.direction === "desc" ? "descending" : "ascending"
    };
  }

  const request = HttpClientRequest.post(
    `/data_sources/${encodeURIComponent(source.id)}/query`
  ).pipe(
    HttpClientRequest.appendUrlParams(
      input.select === undefined ? [] : selected.map(({ id }) => ["filter_properties", id] as const)
    ),
    HttpClientRequest.bodyJsonUnsafe({
      result_type: "page",
      page_size: input.limit ?? 100,
      ...(filters.length === 0
        ? {}
        : { filter: filters.length === 1 ? filters[0] : { and: filters } }),
      ...(sort === undefined ? {} : { sorts: [sort] }),
      ...(input.cursor === undefined ? {} : { start_cursor: input.cursor })
    })
  );
  return Effect.fnUntraced(function* (send: Send): Effect.fn.Return<NotionListOutput, Refusal> {
    const answer = yield* readRows(
      yield* send(request).pipe(
        Effect.mapError((error) =>
          error.code === "not_found"
            ? new Refusal({ code: "not_found", dataSource: source.key })
            : error
        )
      )
    );
    // Notion marks every page of a query past its 10,000th row, and pages no further.
    if (answer.request_status?.type === "incomplete")
      return yield* new Refusal({ code: "offset_exhausted" });
    const rows: Row[] = [];
    for (const result of answer.results)
      rows.push(yield* row(send, yield* readRow(result), selected));
    return { rows, cursor: nextCursor(answer) };
  });
});

/** One row, or null when it is missing, unshared or another data source's. */
export const planGet: Plan<NotionGetInput, NotionGetOutput> = (snapshot, input) =>
  Effect.map(sourceOf(snapshot, input.source), (source) =>
    Effect.fnUntraced(function* (send: Send) {
      const answer = yield* orNull(send(HttpClientRequest.get(`/pages/${input.id}`)));
      if (answer === null) return null;
      const raw = yield* readRow(answer);
      if (raw.parent.data_source_id !== source.id) return null;
      return yield* row(send, raw, source.properties);
    })
  );

const pageTitle = (page: typeof PageInfo.Type) => {
  for (const value of Object.values(page.properties)) {
    const title = Option.getOrUndefined(readTitle(value));
    if (title !== undefined) return title.title.map((part) => part.plain_text).join("");
  }
  return "";
};

/** A page's Markdown as Notion renders it, `<unknown>` tags and its truncation mark kept. */
export const planMarkdown: Plan<NotionMarkdownInput, NotionMarkdownOutput> = (_snapshot, input) =>
  Effect.succeed(
    Effect.fnUntraced(function* (send: Send) {
      const metadata = yield* orNull(send(HttpClientRequest.get(`/pages/${input.id}`)));
      if (metadata === null) return null;
      const page = yield* readPageInfo(metadata);
      const contents = yield* orNull(send(HttpClientRequest.get(`/pages/${input.id}/markdown`)));
      if (contents === null) return null;
      const { markdown, truncated } = yield* readMarkdown(contents);
      return { id: page.id, title: pageTitle(page), url: page.url, markdown, truncated };
    })
  );

/** Shared pages and data sources by title, newest edited first. */
export const planSearch: Plan<NotionSearchInput, NotionSearchOutput> = (snapshot, input) =>
  Effect.succeed(
    Effect.fnUntraced(function* (send: Send) {
      const answer = yield* readSearch(
        yield* send(
          HttpClientRequest.post("/search").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              page_size: input.limit ?? 100,
              sort: { timestamp: "last_edited_time", direction: "descending" },
              ...(input.text === undefined ? {} : { query: input.text }),
              ...(input.kind === undefined
                ? {}
                : { filter: { property: "object", value: input.kind } }),
              ...(input.cursor === undefined ? {} : { start_cursor: input.cursor })
            })
          )
        )
      );
      const discovered = new Map(snapshot.dataSources.map((source) => [source.id, source]));
      // A data source has no URL of its own: it's its database's.
      const databaseUrls = new Map<string, string>();
      const results: Array<NotionSearchOutput["results"][number]> = [];
      for (const item of answer.results) {
        if (item.object === "page") {
          const dataSource =
            item.parent.data_source_id === undefined
              ? undefined
              : discovered.get(item.parent.data_source_id);
          results.push({
            kind: "page",
            id: item.id,
            title: pageTitle(item),
            url: item.url,
            lastEditedTime: item.last_edited_time,
            ...(dataSource === undefined ? {} : { dataSource: dataSource.key })
          });
          continue;
        }
        const database = item.parent.database_id;
        let url = discovered.get(item.id)?.url ?? databaseUrls.get(database);
        if (url === undefined) {
          url = (yield* readDatabase(yield* send(HttpClientRequest.get(`/databases/${database}`))))
            .url;
          databaseUrls.set(database, url);
        }
        results.push({
          kind: "data_source",
          id: item.id,
          title: item.title.map((part) => part.plain_text).join(""),
          url,
          lastEditedTime: item.last_edited_time
        });
      }
      return { results, cursor: nextCursor(answer) };
    })
  );

/** The workspace's people and bots, without their email addresses. */
export const planPeople: Plan<NotionPeopleInput, NotionPeopleOutput> = (_snapshot, input) =>
  Effect.succeed(
    Effect.fnUntraced(function* (send: Send) {
      const answer = yield* readPeople(
        yield* send(
          HttpClientRequest.get("/users").pipe(
            HttpClientRequest.appendUrlParams({
              page_size: String(input.limit ?? 100),
              ...(input.cursor === undefined ? {} : { start_cursor: input.cursor })
            })
          )
        )
      );
      return {
        people: answer.results.map((item) => ({ ...person(item), type: item.type })),
        cursor: nextCursor(answer)
      };
    })
  );
