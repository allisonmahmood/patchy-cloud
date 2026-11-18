import { NotionAccess, type NotionSnapshot } from "@patchy/api";
import { ContractLimits } from "@patchy/limits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export const BASE_URL = "https://api.notion.com/v1";
export const VERSION = "2026-03-11";
const Key = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,512}$/));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Workspace = Schema.Struct({ id: Id, name: Schema.String });
const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });
const Credentials = Schema.Struct({ key: Key, workspaceId: Id });
type Credentials = typeof Credentials.Type;
export const Display = Schema.Struct({
  workspace: Workspace,
  botId: Id,
  access: NotionAccess,
  keyHint: Schema.String
});
export type Display = typeof Display.Type;
type Self = Pick<Display, "workspace" | "botId">;

const refusals = {
  invalid_credentials: [
    422,
    "Paste the token from an internal connection in the Notion Developer portal."
  ],
  notion_not_workspace_key: [
    422,
    "Use a workspace-owned internal connection. Patchy does not accept personal access tokens or public connections."
  ],
  notion_other_workspace: [
    409,
    "This token belongs to a different Notion workspace. Connect that workspace separately."
  ],
  source_unavailable: [503, "Notion could not be reached or answered unexpectedly. Try again."],
  access_denied: [
    403,
    "Notion refused access. Check the connection's capabilities and share the database with it."
  ],
  not_found: [
    404,
    "Notion could not find the database or it is no longer shared with the connection."
  ],
  invalid_query: [400, "Notion refused a discovery request that Patchy built."],
  write_conflict: [409, "Notion reported a conflict. Try again."],
  source_rate_limited: [429, "Notion is limiting requests. Try again shortly."],
  shape_mismatch: [422, "Notion returned an unexpected discovery shape. Nothing was saved."],
  too_large: [413, "Notion discovery exceeded a Patchy limit. Nothing was saved."],
  timeout: [504, "Notion did not answer before the discovery deadline. Nothing was saved."],
  busy: [
    503,
    "Patchy is already making its maximum number of calls for this Notion connection. Try again."
  ]
} as const;
const Bound = Schema.Struct({
  name: Schema.Literals(["bytes", "data sources", "properties", "options"]),
  limit: Schema.Int
});

export class Refusal extends Schema.TaggedError<Refusal>()("NotionRefusal", {
  code: Schema.Literals(Record.keys(refusals)),
  upstreamStatus: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(SecretCause),
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
  bound: Schema.optionalKey(Bound)
}) {
  get status() {
    return refusals[this.code][0];
  }

  override get message() {
    if (this.code === "source_unavailable" && this.upstreamStatus === 401)
      return "Notion did not accept the token. Paste a working internal connection token.";
    if (this.code === "source_rate_limited" && this.retryAfterSeconds !== undefined)
      return `Notion is limiting requests. Try again in ${this.retryAfterSeconds} seconds.`;
    if (this.code === "too_large" && this.bound !== undefined)
      return `Notion discovery exceeded the Patchy limit for ${this.bound.name} (${this.bound.limit}). Nothing was saved.`;
    return refusals[this.code][1];
  }
}

const tooLarge = (name: typeof Bound.Type.name, limit: number) =>
  new Refusal({ code: "too_large", bound: { name, limit } });

export class Source extends Context.Service<
  Source,
  {
    readonly withSlot: <A, E, R>(
      connectionId: string,
      run: (waited: boolean) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | Refusal, R>;
    readonly check: (
      key: Redacted.Redacted<string>,
      expectedWorkspace?: string
    ) => Effect.Effect<Self, Refusal>;
    readonly inspect: (
      key: Redacted.Redacted<string>,
      access: NotionAccess,
      expectedWorkspace?: string
    ) => Effect.Effect<NotionSnapshot, Refusal>;
  }
>()("@patchy/integrations/notion/Source") {}

const credentialsJson = Schema.fromJsonString(Credentials);
const encodeCredentials = Schema.encodeSync(credentialsJson);
const decodeCredentials = Schema.decodeUnknownEffect(credentialsJson, {
  onExcessProperty: "error"
});
export const credentials = (value: Credentials) => Redacted.make(encodeCredentials(value));
export const parseCredentials = Effect.fn("Notion.parseCredentials")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* decodeCredentials(Redacted.value(secret)).pipe(
    Effect.mapError(
      (cause) => new Refusal({ code: "invalid_credentials", cause: Redacted.make(cause) })
    )
  );
});
export const keyHint = (key: Redacted.Redacted<string>) => `…${Redacted.value(key).slice(-4)}`;

const hasKeyShape = Schema.is(Key);
const SelfBody = Schema.Struct({
  type: Schema.String,
  id: Id,
  bot: Schema.optionalKey(
    Schema.Struct({
      owner: Schema.Struct({ type: Schema.String }),
      workspace_id: Schema.optionalKey(Schema.NullOr(Id)),
      workspace_name: Schema.optionalKey(Schema.NullOr(Schema.String))
    })
  )
});
const RichTitle = Schema.Array(Schema.Struct({ plain_text: Schema.String }));
const Choice = Schema.Struct({ id: Id, name: Schema.String });
const Choices = Schema.Struct({ options: Schema.Array(Choice) });
const Status = Schema.Struct({
  options: Schema.Array(Choice),
  groups: Schema.Array(Schema.Struct({ id: Id, name: Schema.String, option_ids: Schema.Array(Id) }))
});
const PropertyBody = Schema.Struct({
  id: Id,
  name: Schema.String,
  type: Schema.String,
  select: Schema.optionalKey(Choices),
  multi_select: Schema.optionalKey(Choices),
  status: Schema.optionalKey(Status),
  relation: Schema.optionalKey(Schema.Struct({ data_source_id: Id }))
});
const sourceRef = { object: Schema.Literal("data_source"), id: Id };
const SourceBody = Schema.Struct({
  ...sourceRef,
  title: RichTitle,
  parent: Schema.Struct({
    type: Schema.Literals(["database_id", "data_source_id"]),
    database_id: Id
  }),
  properties: Schema.Record(Schema.String, PropertyBody)
});
const SearchBody = Schema.Struct({
  results: Schema.Array(Schema.Unknown),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String),
  request_status: Schema.optionalKey(Schema.Struct({ type: Schema.String }))
});
const DatabaseBody = Schema.Struct({
  object: Schema.Literal("database"),
  id: Id,
  title: RichTitle,
  url: Schema.String.check(Schema.isPattern(/^https:\/\//))
});
const ErrorBody = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  retry_after: Schema.optionalKey(Schema.Number),
  additional_data: Schema.optionalKey(
    Schema.Struct({
      retry_after: Schema.optionalKey(Schema.Number),
      limit_kind: Schema.optionalKey(Schema.String)
    })
  )
});
const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSelf = Schema.decodeUnknownEffect(SelfBody);
const decodeSearch = Schema.decodeUnknownEffect(SearchBody);
const decodeSourceId = Schema.decodeUnknownEffect(Schema.Struct(sourceRef));
const decodeSearchSource = Schema.decodeUnknownOption(SourceBody);
const decodeSource = Schema.decodeUnknownEffect(SourceBody);
const decodeDatabase = Schema.decodeUnknownEffect(DatabaseBody);
const decodeError = Schema.decodeUnknownOption(ErrorBody);
const supported = new Set([
  "title",
  "rich_text",
  "number",
  "select",
  "status",
  "multi_select",
  "date",
  "checkbox",
  "url",
  "email",
  "phone_number",
  "people",
  "relation",
  "files",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "unique_id"
]);
const reservedNames = ["search", "pages", "people"];
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const titleOf = (richText: typeof RichTitle.Type) =>
  richText.map((part) => part.plain_text).join("");
const propertySettings = (property: typeof PropertyBody.Type) => {
  switch (property.type) {
    case "select":
      return property.select;
    case "multi_select":
      return property.multi_select;
    case "status":
      return property.status;
    case "relation":
      return property.relation;
    default:
      return {};
  }
};
const completeSource = (source: typeof SourceBody.Type) =>
  Object.values(source.properties).every((property) => propertySettings(property) !== undefined);

const bounds = Effect.all({
  deadline: ContractLimits.get("notion.discovery.deadline"),
  bytes: ContractLimits.get("notion.discovery.bytes"),
  sources: ContractLimits.get("notion.discovery.sources"),
  properties: ContractLimits.get("notion.discovery.properties"),
  options: ContractLimits.get("notion.discovery.options")
});
type Bounds = Effect.Success<typeof bounds>;
const shape = (cause: Schema.SchemaError) =>
  new Refusal({ code: "shape_mismatch", cause: Redacted.make(cause) });

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const concurrency = yield* ContractLimits.get("notion.calls.concurrent");
  const gates = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

  /** One upstream boundary owns the fixed host, credential, deadline budget, JSON and refusals. */
  const send = Effect.fn("Notion.send")(function* (
    key: Redacted.Redacted<string>,
    request: HttpClientRequest.HttpClientRequest,
    maxBytes: number
  ) {
    const response = yield* client
      .execute(
        request.pipe(
          HttpClientRequest.prependUrl(BASE_URL),
          HttpClientRequest.bearerToken(Redacted.value(key)),
          HttpClientRequest.setHeader("Notion-Version", VERSION),
          HttpClientRequest.acceptJson
        )
      )
      .pipe(
        Effect.mapError(
          (cause) => new Refusal({ code: "source_unavailable", cause: Redacted.make(cause) })
        ),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(Tracer.DisablePropagation, true)
      );
    const status = response.status;
    if ((status >= 300 && status < 400) || status === 401 || (status >= 500 && status !== 529))
      return yield* new Refusal({ code: "source_unavailable", upstreamStatus: status });
    if (Number(response.headers["content-length"]) > maxBytes)
      return yield* tooLarge("bytes", maxBytes);
    const chunks = yield* response.stream.pipe(
      Stream.mapError(
        (cause) => new Refusal({ code: "source_unavailable", cause: Redacted.make(cause) })
      ),
      Stream.runFoldEffect(
        () => ({ length: 0, values: [] as Uint8Array[] }),
        (state, chunk) => {
          state.length += chunk.byteLength;
          if (state.length > maxBytes) return Effect.fail(tooLarge("bytes", maxBytes));
          state.values.push(chunk);
          return Effect.succeed(state);
        }
      )
    );
    const body = new Uint8Array(chunks.length);
    let offset = 0;
    for (const chunk of chunks.values) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const result = yield* json(decoder.decode(body)).pipe(
      Effect.mapError(
        (cause) =>
          new Refusal({
            code: "source_unavailable",
            upstreamStatus: status,
            cause: Redacted.make(cause)
          })
      )
    );
    if (status >= 200 && status < 300) return result;
    const error = Option.getOrUndefined(decodeError(result));
    if (status === 403) {
      if (error?.additional_data?.limit_kind || /block limit/i.test(error?.message ?? ""))
        return yield* new Refusal({ code: "source_unavailable", upstreamStatus: status });
      return yield* new Refusal({ code: "access_denied" });
    }
    if (status === 404) return yield* new Refusal({ code: "not_found" });
    if (status === 409) return yield* new Refusal({ code: "write_conflict" });
    if (status === 429 || status === 529) {
      const seconds =
        error?.retry_after ??
        error?.additional_data?.retry_after ??
        Number(response.headers["retry-after"]);
      return yield* new Refusal({
        code: "source_rate_limited",
        ...(Number.isFinite(seconds) && seconds >= 0
          ? { retryAfterSeconds: Math.ceil(seconds) }
          : {})
      });
    }
    if (status === 400) return yield* new Refusal({ code: "invalid_query" });
    return yield* new Refusal({ code: "source_unavailable", upstreamStatus: status });
  });

  const self = Effect.fn("Notion.self")(function* (
    key: Redacted.Redacted<string>,
    maxBytes: number,
    expectedWorkspace?: string
  ) {
    if (!hasKeyShape(Redacted.value(key)))
      return yield* new Refusal({ code: "invalid_credentials" });
    const body = yield* send(key, HttpClientRequest.get("/users/me"), maxBytes);
    const found = yield* decodeSelf(body).pipe(Effect.mapError(shape));
    if (found.type !== "bot" || found.bot?.owner.type !== "workspace")
      return yield* new Refusal({ code: "notion_not_workspace_key" });
    const id = found.bot.workspace_id;
    if (id == null || found.bot.workspace_name == null)
      return yield* new Refusal({ code: "shape_mismatch" });
    if (expectedWorkspace !== undefined && id !== expectedWorkspace)
      return yield* new Refusal({ code: "notion_other_workspace" });
    return { workspace: { id, name: found.bot.workspace_name }, botId: found.id };
  });

  const check = Effect.fn("Notion.check")(function* (
    key: Redacted.Redacted<string>,
    expectedWorkspace?: string
  ) {
    const milliseconds = yield* ContractLimits.get("integration.deadline");
    const bytes = yield* ContractLimits.get("notion.discovery.bytes");
    return yield* self(key, bytes, expectedWorkspace).pipe(
      Effect.timeoutOrElse({
        duration: milliseconds,
        orElse: () => Effect.fail(new Refusal({ code: "timeout" }))
      })
    );
  });

  const discover = Effect.fn("Notion.discover")(function* (
    key: Redacted.Redacted<string>,
    identity: Self,
    access: NotionAccess,
    limits: Bounds
  ) {
    type DataSource = NotionSnapshot["dataSources"][number];
    type Property = DataSource["properties"][number];
    type Exclusion = NotionSnapshot["exclusions"][number];
    const sources = new Map<string, Omit<DataSource, "key">>();
    const databases = new Map<string, Pick<DataSource, "databaseTitle" | "url">>();
    const exclusions: Exclusion[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    while (true) {
      const response = yield* send(
        key,
        HttpClientRequest.post("/search").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            filter: { property: "object", value: "data_source" },
            page_size: 100,
            ...(cursor === undefined ? {} : { start_cursor: cursor })
          })
        ),
        limits.bytes
      );
      const page = yield* decodeSearch(response).pipe(Effect.mapError(shape));
      if (page.request_status?.type === "incomplete")
        return yield* new Refusal({ code: "shape_mismatch" });
      for (const item of page.results) {
        const inSearch = Option.getOrUndefined(decodeSearchSource(item));
        const id = inSearch?.id ?? (yield* decodeSourceId(item).pipe(Effect.mapError(shape))).id;
        if (sources.has(id)) continue;
        if (sources.size >= limits.sources) return yield* tooLarge("data sources", limits.sources);
        const source =
          inSearch && completeSource(inSearch)
            ? inSearch
            : yield* decodeSource(
                yield* send(
                  key,
                  HttpClientRequest.get(`/data_sources/${encodeURIComponent(id)}`),
                  limits.bytes
                )
              ).pipe(Effect.mapError(shape));
        if (source.id !== id || !completeSource(source))
          return yield* new Refusal({ code: "shape_mismatch" });
        const entries = Object.values(source.properties);
        if (entries.length > limits.properties)
          return yield* tooLarge("properties", limits.properties);
        const databaseId = source.parent.database_id;
        let parent = databases.get(databaseId);
        if (parent === undefined) {
          const database = yield* decodeDatabase(
            yield* send(
              key,
              HttpClientRequest.get(`/databases/${encodeURIComponent(databaseId)}`),
              limits.bytes
            )
          ).pipe(Effect.mapError(shape));
          if (database.id !== databaseId) return yield* new Refusal({ code: "shape_mismatch" });
          parent = { databaseTitle: titleOf(database.title), url: database.url };
          databases.set(databaseId, parent);
        }
        const properties: Property[] = [];
        const skipped: Exclusion[] = [];
        const title = titleOf(source.title) || "Untitled";
        for (const property of entries) {
          if (!supported.has(property.type)) {
            skipped.push({ source: title, name: property.name, reason: "unsupported_type" });
            continue;
          }
          const select =
            property.type === "select"
              ? property.select
              : property.type === "multi_select"
                ? property.multi_select
                : property.type === "status"
                  ? property.status
                  : undefined;
          if ((select?.options.length ?? 0) > limits.options)
            return yield* tooLarge("options", limits.options);
          properties.push({
            id: property.id,
            name: property.name,
            type: property.type,
            ...(select ? { options: select.options } : {}),
            ...(property.type === "status" && property.status
              ? {
                  groups: property.status.groups.map(({ option_ids, ...group }) => ({
                    ...group,
                    optionIds: option_ids
                  }))
                }
              : {}),
            ...(property.type === "relation" && property.relation
              ? { relationTarget: property.relation.data_source_id }
              : {})
          });
        }
        const value = { id, title, ...parent, properties };
        bytes += encoder.encode(toJson([value, skipped])).byteLength;
        if (bytes > limits.bytes) return yield* tooLarge("bytes", limits.bytes);
        sources.set(id, value);
        exclusions.push(...skipped);
      }
      if (!page.has_more) break;
      if (!page.next_cursor || seenCursors.has(page.next_cursor))
        return yield* new Refusal({ code: "shape_mismatch" });
      cursor = page.next_cursor;
      seenCursors.add(cursor);
    }

    const counts = new Map<string, number>();
    for (const source of sources.values())
      counts.set(source.title, (counts.get(source.title) ?? 0) + 1);
    const used = new Set([...counts.keys(), ...reservedNames]);
    const dataSources: DataSource[] = [];
    for (const source of [...sources.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      let key = source.title;
      if (counts.get(key) !== 1 || reservedNames.includes(key)) {
        key = `${source.title}-${source.id.slice(-8)}`;
        while (used.has(key)) key += `-${source.id.slice(-8)}`;
        used.add(key);
      }
      const properties = source.properties.filter((property) => {
        if (!property.relationTarget || sources.has(property.relationTarget)) return true;
        exclusions.push({ source: source.title, name: property.name, reason: "unshared_relation" });
        return false;
      });
      dataSources.push({ ...source, key, properties });
    }
    const snapshot = { ...identity, access, dataSources, exclusions } satisfies NotionSnapshot;
    if (encoder.encode(toJson(snapshot)).byteLength > limits.bytes)
      return yield* tooLarge("bytes", limits.bytes);
    return snapshot;
  });

  const inspect = Effect.fn("Notion.inspect")(function* (
    key: Redacted.Redacted<string>,
    access: NotionAccess,
    expectedWorkspace?: string
  ) {
    const limits = yield* bounds;
    return yield* Effect.gen(function* () {
      const identity = yield* self(key, limits.bytes, expectedWorkspace);
      return yield* discover(key, identity, access, limits);
    }).pipe(
      Effect.timeoutOrElse({
        duration: limits.deadline,
        orElse: () => Effect.fail(new Refusal({ code: "timeout" }))
      })
    );
  });

  const withSlot = <A, E, R>(
    connectionId: string,
    run: (waited: boolean) => Effect.Effect<A, E, R>
  ) =>
    Effect.gen(function* () {
      const deadline = yield* ContractLimits.get("notion.discovery.deadline");
      const started = yield* Clock.currentTimeMillis;
      const slot = gates.get(connectionId) ?? {
        semaphore: Semaphore.makeUnsafe(concurrency),
        users: 0
      };
      gates.set(connectionId, slot);
      slot.users++;
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let waited = false;
          while (!(yield* slot.semaphore.takeIfAvailable(1))) {
            waited = true;
            const budget = deadline - ((yield* Clock.currentTimeMillis) - started) - 1000;
            if (budget <= 0) return yield* new Refusal({ code: "busy" });
            const freed = yield* restore(
              slot.semaphore.withPermits(1)(Effect.void).pipe(Effect.timeoutOption(budget))
            );
            if (Option.isNone(freed)) return yield* new Refusal({ code: "busy" });
          }
          return yield* restore(Effect.suspend(() => run(waited))).pipe(
            Effect.ensuring(slot.semaphore.release(1))
          );
        })
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (--slot.users === 0) gates.delete(connectionId);
          })
        ),
        Effect.timeoutOrElse({
          duration: deadline,
          orElse: () => Effect.fail(new Refusal({ code: "timeout" }))
        })
      );
    });

  return Source.of({ withSlot, check, inspect });
});

export const layer = Layer.effect(Source, make).pipe(Layer.provide(FetchHttpClient.layer));
