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

/**
 * Notion, through a workspace's own internal connection. The hosting server makes every call,
 * only to `https://api.notion.com/v1` at the pinned `Notion-Version`, never following a redirect.
 * Each answer is collected under `notion.response.bytes` before it is decoded, and classified
 * before anything reaches its caller; nothing is retried. Calls through one internal connection,
 * its bot, pass one gate per process.
 */

export const BASE_URL = "https://api.notion.com/v1";
export const VERSION = "2026-03-11";
const Key = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,512}$/));
const Id = Schema.NonEmptyString;
const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });

/** What the ciphertext holds: the token and the workspace its check found, which binds it. */
const Credentials = Schema.Struct({ key: Key, workspaceId: Id });
type Credentials = typeof Credentials.Type;
/** Safe to show: the workspace, its connection's bot, the access chosen and the token's end. */
export const Display = Schema.Struct({
  workspace: Schema.Struct({ id: Id, name: Schema.String }),
  botId: Id,
  access: NotionAccess,
  keyHint: Schema.String
});
export type Display = typeof Display.Type;
/** What the token check found. */
type Self = Pick<Display, "workspace" | "botId">;

/** Each refusal's status and words, true whether it stops a connect, a read or a write. */
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
    "Notion refused access. Check the connection's capabilities and what is shared with it."
  ],
  not_found: [
    404,
    "Notion found nothing there: it may be gone or no longer shared with the connection."
  ],
  invalid_request: [
    400,
    "Notion refused the request. A property or option may have changed since this version was generated: refresh the connection, run patchy refresh and publish again."
  ],
  write_conflict: [409, "Notion reported a conflict. Try again."],
  source_rate_limited: [429, "Notion is limiting requests. Try again shortly."],
  shape_mismatch: [422, "Notion answered in a shape Patchy doesn't read."],
  too_large: [413, "Notion's answer is larger than Patchy reads."],
  timeout: [504, "Notion did not answer in time."],
  busy: [
    503,
    "Patchy is already making its maximum number of calls for this Notion connection. Try again."
  ]
} as const;

/** Every way a Notion call fails, by its wire code; Notion's own words never reach the message. */
export class Refusal extends Schema.TaggedError<Refusal>()("NotionRefusal", {
  code: Schema.Literals(Record.keys(refusals)),
  /** Notion's status, when the refusal is about one; a 401 names the token as the fix. */
  upstreamStatus: Schema.optionalKey(Schema.Int),
  retryAfterSeconds: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(SecretCause)
}) {
  get status() {
    return refusals[this.code][0];
  }

  override get message() {
    if (this.code === "source_unavailable" && this.upstreamStatus === 401)
      return "Notion did not accept the token. Paste a working internal connection token.";
    if (this.code === "source_rate_limited" && this.retryAfterSeconds !== undefined)
      return `Notion is limiting requests. Try again in ${this.retryAfterSeconds} seconds.`;
    return refusals[this.code][1];
  }
}

/** Bytes left to one call across every request it sends; each answer draws it down. */
export interface Budget {
  remaining: number;
}

export class Source extends Context.Service<
  Source,
  {
    /**
     * The token check: `GET /v1/users/me`, refusing a token that acts for one person, and one from
     * another workspace than `expectedWorkspace`. Takes no slot: it's one small request.
     */
    readonly check: (
      key: Redacted.Redacted<string>,
      expectedWorkspace?: string
    ) => Effect.Effect<Self, Refusal>;
    /**
     * The check, then the data sources the connection can see, holding one of its bot's slots, all
     * within `notion.discovery.deadline`. Nothing partial is returned.
     */
    readonly inspect: (
      key: Redacted.Redacted<string>,
      access: NotionAccess,
      expectedWorkspace?: string
    ) => Effect.Effect<NotionSnapshot, Refusal>;
    /**
     * Runs `effect` holding one of the bot's `notion.calls.concurrent` slots. Waiting keeps a
     * one-second reserve before `deadline` (epoch milliseconds), then refuses `busy` with nothing
     * sent. The slot is released however `effect` ends, including interruption.
     */
    readonly withSlot: (
      botId: string,
      deadline: number
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Refusal, R>;
    /**
     * One request to the API with the token, answering its decoded JSON or a refusal. The answer
     * is collected under `notion.response.bytes`, and under `budget` when the request shares one.
     */
    readonly send: (
      key: Redacted.Redacted<string>,
      request: HttpClientRequest.HttpClientRequest,
      options?: { readonly budget?: Budget }
    ) => Effect.Effect<unknown, Refusal>;
  }
>()("@patchy/integrations/notion/Source") {}

/** The reserve a queued call keeps before its deadline, so a slot freed later isn't worth taking. */
const SLOT_RESERVE_MS = 1_000;

const credentialsJson = Schema.fromJsonString(Credentials);
const encodeCredentials = Schema.encodeSync(credentialsJson);
const decodeCredentials = Schema.decodeUnknownEffect(credentialsJson, {
  onExcessProperty: "error"
});
/** A secret as `decode` reads it; one that doesn't decode isn't a credential Patchy made. */
const parsed =
  <A>(decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
  (secret: Redacted.Redacted<string>) =>
    decode(Redacted.value(secret)).pipe(
      Effect.mapError(
        (cause) => new Refusal({ code: "invalid_credentials", cause: Redacted.make(cause) })
      )
    );
export const credentials = (value: Credentials) => Redacted.make(encodeCredentials(value));
export const parseCredentials = parsed(decodeCredentials);
/** A pasted token's last characters, safe to show. */
export const keyHint = (key: Redacted.Redacted<string>) => `…${Redacted.value(key).slice(-4)}`;

/** Connect's secret, as the page submits it: the token and what patches may do. */
const ConnectRequest = Schema.Struct({ key: Schema.String, access: NotionAccess });
/** Replace token's: a new token at the connection's access. Change access's: only the access. */
const ChangeRequest = Schema.Union([
  Schema.Struct({ key: Schema.String }),
  Schema.Struct({ access: NotionAccess })
]);
const connectJson = Schema.fromJsonString(ConnectRequest);
const changeJson = Schema.fromJsonString(ChangeRequest);
const encodeConnect = Schema.encodeSync(connectJson);
const encodeChange = Schema.encodeSync(changeJson);
const decodeConnect = Schema.decodeUnknownEffect(connectJson);
const decodeChange = Schema.decodeUnknownEffect(changeJson);
export const connectSecret = (value: typeof ConnectRequest.Type) =>
  Redacted.make(encodeConnect(value));
export const changeSecret = (value: typeof ChangeRequest.Type) =>
  Redacted.make(encodeChange(value));
export const parseConnect = parsed(decodeConnect);
export const parseChange = parsed(decodeChange);

const hasKeyShape = Schema.is(Key);
const SelfBody = Schema.Struct({
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
const Choices = Schema.Struct({
  options: Schema.Array(Schema.Struct({ id: Id, name: Schema.String }))
});
const Status = Schema.Struct({
  ...Choices.fields,
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
const SourceBody = Schema.Struct({
  id: Id,
  title: RichTitle,
  parent: Schema.Struct({ database_id: Id }),
  properties: Schema.Record(Schema.String, PropertyBody)
});
const SearchBody = Schema.Struct({
  results: Schema.Array(Schema.Unknown),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String),
  request_status: Schema.optionalKey(Schema.Struct({ type: Schema.String }))
});
const DatabaseBody = Schema.Struct({
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
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSelf = Schema.decodeUnknownEffect(SelfBody);
const decodeSearch = Schema.decodeUnknownEffect(SearchBody);
const decodeSourceId = Schema.decodeUnknownEffect(Schema.Struct({ id: Id }));
const decodeSearchSource = Schema.decodeUnknownOption(SourceBody);
const decodeSource = Schema.decodeUnknownEffect(SourceBody);
const decodeDatabase = Schema.decodeUnknownEffect(DatabaseBody);
const decodeError = Schema.decodeUnknownOption(ErrorBody);
const shape = (cause: Schema.SchemaError) =>
  new Refusal({ code: "shape_mismatch", cause: Redacted.make(cause) });

/** The property types a snapshot keeps; the rest, formulas and rollups among them, are excluded. */
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
/** Names the generated client already uses, so a data source titled one gets an id suffix. */
const reservedNames = ["search", "pages", "people"];
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const titleOf = (richText: typeof RichTitle.Type) =>
  richText.map((part) => part.plain_text).join("");
type Property = NotionSnapshot["dataSources"][number]["properties"][number];
/**
 * What a property's type carries in its schema, as a snapshot keeps it: options, status groups
 * and a relation's target. Undefined where Notion left them out.
 */
const settingsOf = (
  property: typeof PropertyBody.Type
): Pick<Property, "options" | "groups" | "relationTarget"> | undefined => {
  switch (property.type) {
    case "select":
      return property.select && { options: property.select.options };
    case "multi_select":
      return property.multi_select && { options: property.multi_select.options };
    case "status":
      return (
        property.status && {
          options: property.status.options,
          groups: property.status.groups.map(({ option_ids, ...group }) => ({
            ...group,
            optionIds: option_ids
          }))
        }
      );
    case "relation":
      return property.relation && { relationTarget: property.relation.data_source_id };
    default:
      return {};
  }
};
/** Search may leave out a property's settings; a source without all of them is read in full. */
const complete = (source: typeof SourceBody.Type) =>
  Object.values(source.properties).every((property) => settingsOf(property) !== undefined);

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const concurrency = yield* ContractLimits.get("notion.calls.concurrent");
  const gates = new Map<string, Semaphore.Semaphore>();
  const gate = (botId: string) => {
    let found = gates.get(botId);
    if (found === undefined) {
      found = Semaphore.makeUnsafe(concurrency);
      gates.set(botId, found);
    }
    return found;
  };

  const send = Effect.fn("Notion.send")(function* (
    key: Redacted.Redacted<string>,
    request: HttpClientRequest.HttpClientRequest,
    options: { readonly budget?: Budget } = {}
  ) {
    const cap = yield* ContractLimits.get("notion.response.bytes");
    const limit = Math.min(cap, options.budget?.remaining ?? cap);
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
        // Never follow a redirect: fetch would otherwise leave api.notion.com with the token.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        // Trace context stays inside Patchy.
        Effect.provideService(Tracer.DisablePropagation, true)
      );
    const status = response.status;
    if ((status >= 300 && status < 400) || status === 401 || (status >= 500 && status !== 529))
      return yield* new Refusal({ code: "source_unavailable", upstreamStatus: status });
    if (Number(response.headers["content-length"]) > limit)
      return yield* new Refusal({ code: "too_large" });
    const chunks = yield* response.stream.pipe(
      Stream.mapError(
        (cause) => new Refusal({ code: "source_unavailable", cause: Redacted.make(cause) })
      ),
      Stream.runFoldEffect(
        () => ({ length: 0, values: [] as Uint8Array[] }),
        (state, chunk) => {
          state.length += chunk.byteLength;
          if (state.length > limit) return Effect.fail(new Refusal({ code: "too_large" }));
          state.values.push(chunk);
          return Effect.succeed(state);
        }
      )
    );
    if (options.budget !== undefined) options.budget.remaining -= chunks.length;
    const body = new Uint8Array(chunks.length);
    let offset = 0;
    for (const chunk of chunks.values) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const json = decodeJson(decoder.decode(body));
    if (status >= 200 && status < 300) {
      if (Option.isNone(json))
        return yield* new Refusal({ code: "source_unavailable", upstreamStatus: status });
      return json.value;
    }
    if (status === 400) return yield* new Refusal({ code: "invalid_request" });
    if (status === 404) return yield* new Refusal({ code: "not_found" });
    if (status === 409) return yield* new Refusal({ code: "write_conflict" });
    const error = Option.getOrUndefined(Option.flatMap(json, decodeError));
    if (status === 403) {
      // The workspace's block limit is Notion's, not a capability the connection lacks.
      if (
        error?.additional_data?.limit_kind !== undefined ||
        /block limit/i.test(error?.message ?? "")
      )
        return yield* new Refusal({ code: "source_unavailable", upstreamStatus: status });
      return yield* new Refusal({ code: "access_denied" });
    }
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
    return yield* new Refusal({ code: "source_unavailable", upstreamStatus: status });
  });

  const withSlot =
    (botId: string, deadline: number) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Refusal, R> => {
      const semaphore = gate(botId);
      // Only the waiting may be interrupted, never the taking, so an interrupted caller never
      // holds a slot it won't release.
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (!(yield* semaphore.takeIfAvailable(1))) {
            const budget = deadline - SLOT_RESERVE_MS - (yield* Clock.currentTimeMillis);
            if (budget <= 0) return yield* new Refusal({ code: "busy" });
            const freed = yield* restore(
              semaphore.withPermits(1)(Effect.void).pipe(Effect.timeoutOption(budget))
            );
            if (Option.isNone(freed)) return yield* new Refusal({ code: "busy" });
          }
          return yield* restore(effect).pipe(Effect.ensuring(semaphore.release(1)));
        })
      );
    };

  const self = Effect.fn("Notion.self")(function* (
    key: Redacted.Redacted<string>,
    expectedWorkspace?: string
  ) {
    if (!hasKeyShape(Redacted.value(key)))
      return yield* new Refusal({ code: "invalid_credentials" });
    const found = yield* decodeSelf(yield* send(key, HttpClientRequest.get("/users/me"))).pipe(
      Effect.mapError(shape)
    );
    // Only an internal connection's bot is owned by the workspace; the rest act for one person.
    if (found.bot?.owner.type !== "workspace")
      return yield* new Refusal({ code: "notion_not_workspace_key" });
    const { workspace_id: id, workspace_name: name } = found.bot;
    if (id == null || name == null) return yield* new Refusal({ code: "shape_mismatch" });
    if (expectedWorkspace !== undefined && id !== expectedWorkspace)
      return yield* new Refusal({ code: "notion_other_workspace" });
    return { workspace: { id, name }, botId: found.id } satisfies Self;
  });

  const check = Effect.fn("Notion.check")(function* (
    key: Redacted.Redacted<string>,
    expectedWorkspace?: string
  ) {
    const milliseconds = yield* ContractLimits.get("integration.deadline");
    return yield* self(key, expectedWorkspace).pipe(
      Effect.timeoutOrElse({
        duration: milliseconds,
        orElse: () => Effect.fail(new Refusal({ code: "timeout" }))
      })
    );
  });

  /**
   * Every data source search finds, with its database's title and URL, its kept properties and
   * what was left out: unsupported types, and relations to a data source discovery didn't see.
   */
  const discover = Effect.fn("Notion.discover")(function* (
    key: Redacted.Redacted<string>,
    identity: Self,
    access: NotionAccess
  ) {
    type DataSource = NotionSnapshot["dataSources"][number];
    type Exclusion = NotionSnapshot["exclusions"][number];
    const sources = new Map<string, Omit<DataSource, "key">>();
    const databases = new Map<string, Pick<DataSource, "databaseTitle" | "url">>();
    const exclusions: Exclusion[] = [];
    let cursor: string | null = null;
    do {
      const page: typeof SearchBody.Type = yield* decodeSearch(
        yield* send(
          key,
          HttpClientRequest.post("/search").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              filter: { property: "object", value: "data_source" },
              page_size: 100,
              ...(cursor === null ? {} : { start_cursor: cursor })
            })
          )
        )
      ).pipe(Effect.mapError(shape));
      // A partial search would store a partial snapshot as complete.
      if (page.request_status?.type === "incomplete")
        return yield* new Refusal({ code: "shape_mismatch" });
      for (const item of page.results) {
        const inSearch = Option.getOrUndefined(decodeSearchSource(item));
        const id = inSearch?.id ?? (yield* decodeSourceId(item).pipe(Effect.mapError(shape))).id;
        if (sources.has(id)) continue;
        const source =
          inSearch !== undefined && complete(inSearch)
            ? inSearch
            : yield* decodeSource(
                yield* send(key, HttpClientRequest.get(`/data_sources/${encodeURIComponent(id)}`))
              ).pipe(Effect.mapError(shape));
        const databaseId = source.parent.database_id;
        let parent = databases.get(databaseId);
        if (parent === undefined) {
          const database = yield* decodeDatabase(
            yield* send(key, HttpClientRequest.get(`/databases/${encodeURIComponent(databaseId)}`))
          ).pipe(Effect.mapError(shape));
          parent = { databaseTitle: titleOf(database.title), url: database.url };
          databases.set(databaseId, parent);
        }
        const title = titleOf(source.title) || "Untitled";
        const properties: Property[] = [];
        for (const property of Object.values(source.properties)) {
          if (supported.has(property.type))
            properties.push({
              id: property.id,
              name: property.name,
              type: property.type,
              ...settingsOf(property)
            });
          else exclusions.push({ source: title, name: property.name, reason: "unsupported_type" });
        }
        sources.set(id, { id, title, ...parent, properties });
      }
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor !== null);

    // Generated names: a title two data sources share, or one the client uses, gets an id suffix.
    const counts = new Map<string, number>();
    for (const source of sources.values())
      counts.set(source.title, (counts.get(source.title) ?? 0) + 1);
    const used = new Set([...counts.keys(), ...reservedNames]);
    const dataSources: DataSource[] = [];
    for (const source of [...sources.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      let name = source.title;
      if (counts.get(name) !== 1 || reservedNames.includes(name)) {
        name = `${source.title}-${source.id.slice(-8)}`;
        while (used.has(name)) name += `-${source.id.slice(-8)}`;
        used.add(name);
      }
      const properties = source.properties.filter((property) => {
        if (property.relationTarget === undefined || sources.has(property.relationTarget))
          return true;
        exclusions.push({ source: source.title, name: property.name, reason: "unshared_relation" });
        return false;
      });
      dataSources.push({ ...source, key: name, properties });
    }
    const snapshot = { ...identity, access, dataSources, exclusions } satisfies NotionSnapshot;
    const cap = yield* ContractLimits.get("notion.response.bytes");
    if (encoder.encode(toJson(snapshot)).byteLength > cap)
      return yield* new Refusal({ code: "too_large" });
    return snapshot;
  });

  const inspect = Effect.fn("Notion.inspect")(function* (
    key: Redacted.Redacted<string>,
    access: NotionAccess,
    expectedWorkspace?: string
  ) {
    const deadline = yield* ContractLimits.get("notion.discovery.deadline");
    const started = yield* Clock.currentTimeMillis;
    return yield* Effect.gen(function* () {
      const identity = yield* self(key, expectedWorkspace);
      return yield* withSlot(identity.botId, started + deadline)(discover(key, identity, access));
    }).pipe(
      Effect.timeoutOrElse({
        duration: deadline,
        orElse: () => Effect.fail(new Refusal({ code: "timeout" }))
      })
    );
  });

  return Source.of({ check, inspect, withSlot, send });
});

export const layer = Layer.effect(Source, make).pipe(Layer.provide(FetchHttpClient.layer));
