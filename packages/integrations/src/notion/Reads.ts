import {
  NotionId,
  notionPropertyType,
  notionPropertyTypes,
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
interface Binding {
  readonly id: string;
  readonly revision: number;
}
type Send = (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<unknown, Refusal>;

const Name = Schema.String;
const Id = Schema.String.check(Schema.isBetweenLength(1, 128));
const WebUrl = Schema.String.check(Schema.isPattern(/^https:\/\//));
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
const Parent = Schema.Struct({
  type: Schema.String,
  data_source_id: Schema.optionalKey(NotionId)
});
const PageInfo = Schema.Struct({
  object: Schema.Literal("page"),
  id: NotionId,
  url: WebUrl,
  last_edited_time: Schema.String,
  parent: Parent,
  properties: Schema.Record(Name, Schema.Unknown)
});
const RawRow = Schema.Struct({
  ...PageInfo.fields,
  created_time: Schema.String,
  in_trash: Schema.Boolean,
  properties: Schema.Record(Name, RawProperty)
});
const page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    results: Schema.Array(item),
    has_more: Schema.Boolean,
    next_cursor: Schema.NullOr(Schema.String),
    request_status: Schema.optionalKey(Schema.Struct({ type: Schema.String }))
  });

const shapeMismatch = (property?: Property) =>
  new Refusal({
    code: "shape_mismatch",
    ...(property && { missing: { kind: "property" as const, name: property.name } })
  });

const decode = <A>(schema: Schema.Decoder<A>) => {
  const read = Schema.decodeUnknownEffect(schema);
  return (body: unknown, property?: Property) =>
    read(body).pipe(Effect.mapError(() => shapeMismatch(property)));
};

const readSource = decode(RawSource);
const readRow = decode(RawRow);
const readPage = decode(page(Schema.Unknown));
const readPageInfo = decode(PageInfo);
const readTitle = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("title"),
    title: RichText
  })
);
const readMarkdown = decode(
  Schema.Struct({
    object: Schema.Literal("page_markdown"),
    id: NotionId,
    markdown: Schema.String,
    truncated: Schema.Boolean
  })
);
const SourceInfo = Schema.Struct({
  object: Schema.Literal("data_source"),
  id: NotionId,
  title: RichText,
  last_edited_time: Schema.String,
  parent: Schema.Struct({ database_id: NotionId })
});
const readSearch = decode(page(Schema.Union([PageInfo, SourceInfo])));
const readDatabase = decode(
  Schema.Struct({
    object: Schema.Literal("database"),
    id: NotionId,
    url: WebUrl
  })
);
const readPeople = decode(
  page(
    Schema.Struct({
      ...RawUser.fields,
      type: Schema.Literals(["person", "bot"])
    })
  )
);
const RawItemsPage = page(Schema.Record(Schema.String, Schema.Unknown));
const readItems = decode(RawItemsPage);
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

const paging = Effect.fnUntraced(function* (
  binding: Binding,
  op: string,
  args: Json,
  cursor: string | undefined
) {
  const crypto = yield* Cryptography.Cryptography;
  const digest = yield* crypto.sha256(canonicalArgs([op, binding.id, binding.revision, args]));
  const start = yield* readCursor(cursor, digest);
  const finish = Effect.fnUntraced(function* (answer: {
    readonly has_more: boolean;
    readonly next_cursor: string | null;
  }) {
    const next = yield* nextPage(answer);
    if (next === null) return null;
    if (next === start) return yield* shapeMismatch();
    return Buffer.from(encodeCursor({ v: 1, binding: digest, next }), "utf8").toString("base64url");
  });
  return { start, finish };
});

const sourcePath = (id: string) => `/data_sources/${encodeURIComponent(id)}`;
const pagePath = (id: string) => `/pages/${encodeURIComponent(id)}`;
const propertySegment = (id: string) => {
  try {
    return encodeURIComponent(decodeURIComponent(id));
  } catch {
    return encodeURIComponent(id);
  }
};
const propertyPath = (rowId: string, propertyId: string) =>
  `${pagePath(rowId)}/properties/${propertySegment(propertyId)}`;
const sourceOf = (snapshot: NotionSnapshot, key: string) => {
  const dataSource = snapshot.dataSources.find((candidate) => candidate.key === key);
  return dataSource === undefined
    ? Effect.fail(new Refusal({ code: "invalid_request" }))
    : Effect.succeed(dataSource);
};

const nameSource = (read: Effect.Effect<unknown, Refusal>, dataSource: string) =>
  read.pipe(
    Effect.mapError((error) =>
      error.code === "not_found"
        ? new Refusal({ code: "not_found", dataSource: dataSource.slice(0, 512) })
        : error
    )
  );

const checkSource = Effect.fnUntraced(function* (
  send: Send,
  snapshot: NotionSnapshot,
  source: DataSource,
  selected: readonly Property[]
) {
  const targets = new Set(
    selected.flatMap(({ relationTarget }) => (relationTarget ? [relationTarget] : []))
  );
  for (const id of targets) {
    if (id === source.id) continue;
    const target = snapshot.dataSources.find((item) => item.id === id);
    yield* nameSource(send(HttpClientRequest.get(sourcePath(id))), target?.title ?? id);
  }
  const live = yield* readSource(
    yield* nameSource(send(HttpClientRequest.get(sourcePath(source.id))), source.title)
  );
  if (live.id !== source.id) return yield* shapeMismatch();
  const byId = new Map(Object.values(live.properties).map((property) => [property.id, property]));
  for (const property of selected) {
    const current = byId.get(property.id);
    if (
      current?.type !== property.type ||
      (property.type === "relation" && current.relation?.data_source_id !== property.relationTarget)
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
      ),
      property
    );
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
  if (raw.parent.type !== "data_source_id" || raw.parent.data_source_id !== source.id)
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
const isId = Schema.is(NotionId);
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

  // Include fields that affect the query even if they aren't returned.
  const used = new Set(selected);
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
    used.add(property);
    filters.push(filter(property, value === null ? { is_empty: true } : { equals: value }));
  }
  for (const [name, value] of Object.entries(args.contains ?? {})) {
    const property = properties.get(name);
    if (
      !property ||
      !notionPropertyType(property.type)?.contains ||
      ((property.type === "people" || property.type === "relation") && !isId(value))
    )
      return yield* invalid();
    used.add(property);
    filters.push(filter(property, { contains: value }));
  }
  if (args.range !== undefined) {
    const { property: name, ...limits } = args.range;
    const property = field(name);
    const range = property && notionPropertyType(property.type)?.range;
    const entries = Object.entries(limits);
    if (!property || !range || entries.length === 0) return yield* invalid();
    if (properties.has(name)) used.add(property);
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
    if (properties.has(order.property)) used.add(property);
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
  return { selected, used: [...used], body };
});

/** Checks user arguments against the pinned snapshot before an upstream request can run. */
export const planList = Effect.fnUntraced(function* (
  snapshot: NotionSnapshot,
  input: NotionListInput,
  binding: Binding
) {
  const source = yield* sourceOf(snapshot, input.source);
  const { selected, used, body } = yield* plan(source, input);
  const cursor = yield* paging(
    binding,
    "notion.listRows",
    [
      source.id,
      input.eq ?? null,
      input.contains ?? null,
      input.range ?? null,
      input.orderBy ?? null,
      input.select ?? null
    ],
    input.cursor
  );
  const payload = {
    ...body,
    ...(cursor.start === undefined ? {} : { start_cursor: cursor.start })
  };
  if (new TextEncoder().encode(canonicalArgs(payload)).byteLength > 500_000)
    return yield* new Refusal({ code: "invalid_request" });
  const propertyLimit = yield* ContractLimits.get("notion.read.propertyItems");
  const checksRelations = used.some(({ type }) => type === "relation");
  return Effect.fnUntraced(function* (send: Send) {
    if (checksRelations) yield* checkSource(send, snapshot, source, used);
    const request = HttpClientRequest.post(`${sourcePath(source.id)}/query`).pipe(
      HttpClientRequest.appendUrlParams(
        input.select === undefined
          ? []
          : selected.map(({ id }) => ["filter_properties", id] as const)
      ),
      HttpClientRequest.bodyJsonUnsafe(payload)
    );
    const answer = yield* readPage(
      yield* nameSource(send(request), source.title).pipe(
        Effect.catchTags({
          NotionRefusal: (error) =>
            !checksRelations &&
            used.length > 0 &&
            (error.code === "invalid_query" ||
              (error.code === "shape_mismatch" && error.missing?.kind === "property"))
              ? checkSource(send, snapshot, source, used).pipe(Effect.andThen(Effect.fail(error)))
              : Effect.fail(error)
        })
      )
    );
    if (answer.request_status?.type === "incomplete")
      return yield* new Refusal({ code: "offset_exhausted" });
    if (answer.results.length > body.page_size) return yield* shapeMismatch();
    const next = yield* cursor.finish(answer);
    // No row to decode means no evidence the fields still match the snapshot.
    if (!checksRelations && answer.results.length === 0 && used.length > 0)
      yield* checkSource(send, snapshot, source, used);
    const budget = { remaining: propertyLimit, limit: propertyLimit };
    const rows: Row[] = [];
    for (const result of answer.results) {
      const raw = yield* readRow(result);
      rows.push(yield* row(send, source, raw, selected, budget));
    }
    return { rows, cursor: next } satisfies NotionListOutput;
  });
});

const getPage = (send: Send, path: string) =>
  send(HttpClientRequest.get(path)).pipe(
    Effect.catchTags({
      NotionRefusal: (error) =>
        error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error)
    })
  );

const pageTitle = (page: typeof PageInfo.Type) => {
  for (const value of Object.values(page.properties)) {
    const title = Option.getOrUndefined(readTitle(value));
    if (title !== undefined) return title.title.map((part) => part.plain_text).join("");
  }
  return "";
};

export const planGet = Effect.fnUntraced(function* (
  snapshot: NotionSnapshot,
  input: NotionGetInput
) {
  const source = yield* sourceOf(snapshot, input.source);
  const propertyLimit = yield* ContractLimits.get("notion.read.propertyItems");
  const id = input.id.toLowerCase();
  return Effect.fnUntraced(function* (send: Send): Effect.fn.Return<NotionGetOutput, Refusal> {
    const answer = yield* getPage(send, pagePath(id));
    if (answer === null) return null;
    const raw = yield* readRow(answer);
    if (raw.id !== id) return yield* shapeMismatch();
    if (raw.parent.type !== "data_source_id" || raw.parent.data_source_id !== source.id)
      return null;
    yield* checkSource(send, snapshot, source, source.properties);
    return yield* row(send, source, raw, source.properties, {
      remaining: propertyLimit,
      limit: propertyLimit
    });
  });
});

export const planMarkdown = (_snapshot: NotionSnapshot, input: NotionMarkdownInput) =>
  Effect.succeed(
    Effect.fnUntraced(function* (send: Send): Effect.fn.Return<NotionMarkdownOutput, Refusal> {
      const id = input.id.toLowerCase();
      const route = pagePath(id);
      const metadata = yield* getPage(send, route);
      if (metadata === null) return null;
      const page = yield* readPageInfo(metadata);
      if (page.id !== id) return yield* shapeMismatch();
      const contents = yield* getPage(send, `${route}/markdown`);
      if (contents === null) return null;
      const markdown = yield* readMarkdown(contents);
      if (markdown.id !== id) return yield* shapeMismatch();
      return {
        id: page.id,
        title: pageTitle(page),
        url: page.url,
        markdown: markdown.markdown,
        truncated: markdown.truncated
      };
    })
  );

export const planSearch = Effect.fnUntraced(function* (
  snapshot: NotionSnapshot,
  input: NotionSearchInput,
  binding: Binding
) {
  const limit = input.limit ?? 100;
  const cursor = yield* paging(
    binding,
    "notion.search",
    [input.text ?? null, input.kind ?? null],
    input.cursor
  );
  const request = HttpClientRequest.post("/search").pipe(
    HttpClientRequest.bodyJsonUnsafe({
      page_size: limit,
      sort: { timestamp: "last_edited_time", direction: "descending" },
      ...(input.text === undefined ? {} : { query: input.text }),
      ...(input.kind === undefined ? {} : { filter: { property: "object", value: input.kind } }),
      ...(cursor.start === undefined ? {} : { start_cursor: cursor.start })
    })
  );
  return Effect.fnUntraced(function* (send: Send): Effect.fn.Return<NotionSearchOutput, Refusal> {
    const answer = yield* readSearch(yield* send(request));
    if (answer.results.length > limit) return yield* shapeMismatch();
    const next = yield* cursor.finish(answer);
    const sourceById = new Map(snapshot.dataSources.map((source) => [source.id, source]));
    const databaseUrls = new Map<string, string>();
    const results: Array<NotionSearchOutput["results"][number]> = [];
    for (const item of answer.results) {
      if (input.kind !== undefined && item.object !== input.kind) return yield* shapeMismatch();
      if (item.object === "page") {
        const dataSource =
          item.parent.type === "data_source_id" && item.parent.data_source_id !== undefined
            ? sourceById.get(item.parent.data_source_id)
            : undefined;
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
      const parent = item.parent.database_id;
      let url = sourceById.get(item.id)?.url ?? databaseUrls.get(parent);
      if (url === undefined) {
        const database = yield* readDatabase(
          yield* send(HttpClientRequest.get(`/databases/${encodeURIComponent(parent)}`))
        );
        if (database.id !== parent) return yield* shapeMismatch();
        url = database.url;
        databaseUrls.set(parent, url);
      }
      results.push({
        kind: "data_source",
        id: item.id,
        title: item.title.map((part) => part.plain_text).join(""),
        url,
        lastEditedTime: item.last_edited_time
      });
    }
    return { results, cursor: next };
  });
});

export const planPeople = Effect.fnUntraced(function* (
  _snapshot: NotionSnapshot,
  input: NotionPeopleInput,
  binding: Binding
) {
  const limit = input.limit ?? 100;
  const cursor = yield* paging(binding, "notion.listPeople", null, input.cursor);
  const request = HttpClientRequest.get("/users").pipe(
    HttpClientRequest.appendUrlParams({
      page_size: String(limit),
      ...(cursor.start === undefined ? {} : { start_cursor: cursor.start })
    })
  );
  return Effect.fnUntraced(function* (send: Send): Effect.fn.Return<NotionPeopleOutput, Refusal> {
    const answer = yield* readPeople(yield* send(request));
    if (answer.results.length > limit) return yield* shapeMismatch();
    return {
      people: answer.results.map((item) => ({ ...person(item), type: item.type })),
      cursor: yield* cursor.finish(answer)
    };
  });
});
