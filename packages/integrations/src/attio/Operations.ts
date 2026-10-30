/**
 * The operations patch code calls on one Attio workspace: records of an object, entries of a list,
 * and the workspace's members, read and never written. Each call is checked against the snapshot
 * its client was generated from before Attio sees anything, reads the object's or list's current
 * attributes beside its query, and decodes nothing until those match the snapshot. Results leave
 * the host through their wire schema only.
 */
import {
  AttioGetEntry,
  AttioGetManyRecords,
  AttioGetRecord,
  AttioListEntries,
  AttioListMembers,
  AttioListRecords,
  AttioValues,
  attioReads,
  type AttioList,
  type AttioObject,
  type AttioRead,
  type AttioSnapshot
} from "@patchy/api";
import { Directory } from "@patchy/companies";
import { registry } from "@patchy/limits/registry";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ConnectionStore from "../ConnectionStore.js";
import { operation, type DevRead } from "../definition.js";
import * as Calls from "./Calls.js";
import {
  Changed,
  Denied,
  InvalidCursor,
  InvalidQuery,
  InvalidRequest,
  Merging,
  NotFound,
  ShapeMismatch,
  TooLarge
} from "./Errors.js";
import * as Query from "./Query.js";
import * as Source from "./Source.js";
import * as Values from "./Values.js";
import { Cryptography } from "@patchy/core";

export class ConnectionNotDeclared extends Schema.TaggedError<ConnectionNotDeclared>()(
  "AttioConnectionNotDeclared",
  {}
) {
  readonly code = "connection_not_declared" as const;
  readonly status = 400;
  override get message() {
    return "This Attio connection is not declared by this version.";
  }
}

export const Errors = Schema.Union([
  ConnectionNotDeclared,
  ShapeMismatch,
  InvalidRequest,
  InvalidQuery,
  NotFound,
  InvalidCursor,
  TooLarge,
  Changed,
  Merging,
  Denied,
  Source.RateLimited,
  Source.Unavailable,
  Source.Timeout,
  Source.Busy,
  Runtime.InvalidRequest,
  Runtime.AccessDenied,
  Runtime.SessionExpired,
  Runtime.SessionRefreshRequired,
  Runtime.PrincipalChanged,
  Runtime.SourceUnavailable,
  Runtime.TooLarge
]);
const isError = Schema.is(Errors);
/** The connection is gone or disconnected: each door says which, its own way. */
const isAbsent = Schema.is(
  Schema.Union([ConnectionStore.ConnectionNotFound, ConnectionStore.ConnectionNotConnected])
);

const DEADLINE_MS = registry["integration.deadline"].default;
const MAX_RESULT = registry["runtime.result.bytes"].default;
const ATTRIBUTES_PAGE = 500;
type Json = typeof Schema.Json.Type;
type Inputs = { readonly [K in AttioRead]: (typeof attioReads)[K]["input"]["Type"] };
type Where = Values.Where;

/** The scope each kind of read needs, from Patchy's own table: Attio names scopes only in prose. */
const scopes = {
  records: "record_permission:read",
  entries: "list_entry:read",
  objects: "object_configuration:read",
  lists: "list_configuration:read",
  members: "user_management:read"
} as const;
const segment = (value: string) => encodeURIComponent(value);
const encoder = new TextEncoder();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

// ---------- Attio's refusals, named for where the call was ----------

const ErrorBody = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.Array(Schema.Unknown))
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);
/** The codes that mean Patchy built a request Attio can't read: Patchy's defect. */
const malformed = new Set([
  "invalid_filter_operator",
  "invalid_filter_field",
  "invalid_filter",
  "missing_sort_field",
  "sort_error",
  "filter_error"
]);

/** What a read was of, so a refusal names it and a 403 the scope. */
interface Of {
  readonly where: Where;
  readonly attributes: ReadonlyArray<{ readonly slug: string }>;
  readonly scope: string;
}

/**
 * Attio's answer, or its refusal as Patchy says it. A 404 is the object or list gone; `row` reads
 * it as no row instead, for `get` once the check showed the object or list is there.
 */
const classify = Effect.fnUntraced(function* (answer: Source.Answer, of: Of, row = false) {
  if (answer.body === undefined)
    return yield* new Source.Unavailable({ stage: "response", upstreamStatus: answer.status });
  if (answer.status >= 200 && answer.status < 300) return Option.some(answer.body);
  const refusal = Option.getOrUndefined(decodeErrorBody(answer.body));
  const code = refusal?.code ?? "";
  // Attio's `path` names the attribute; only a slug the snapshot has is repeated.
  const named = refusal?.path?.[0];
  const attribute =
    typeof named === "string" && of.attributes.some((item) => item.slug === named)
      ? { attribute: named }
      : {};
  if (answer.status === 403) return yield* new Denied({ requires: of.scope });
  if (answer.status === 404) {
    if (code === "merge_in_progress") return yield* new Merging(of.where);
    if (row) return Option.none();
    return yield* new NotFound(of.where);
  }
  if (answer.status === 400) {
    if (code === "standard_object_disabled") return yield* new NotFound(of.where);
    if (code === "unknown_filter_attribute_slug")
      return yield* new ShapeMismatch({ ...of.where, ...attribute, reason: "missing" });
    if (code === "unknown_filter_object_slug")
      return yield* new ShapeMismatch({ ...of.where, ...attribute, reason: "target" });
    if (code === "unknown_filter_select_option_slug" || code === "unknown_filter_status_slug")
      return yield* new InvalidRequest({
        ...of.where,
        ...attribute,
        operator: "eq",
        reason: "option"
      });
    if (code === "validation_type")
      return yield* new InvalidRequest({ ...of.where, ...attribute, reason: "attio" });
    return yield* new InvalidQuery({
      ...of.where,
      // Only a code Patchy knows is repeated; anything else in Attio's body stays there.
      reason: malformed.has(code) ? code : "unknown"
    });
  }
  return yield* new Source.Unavailable({ stage: "status", upstreamStatus: answer.status });
});
const readable = <A>(decoded: A | undefined) =>
  decoded === undefined
    ? Effect.fail(new Source.Unavailable({ stage: "response", upstreamStatus: 200 }))
    : Effect.succeed(decoded);
/** A success's body, which a refusal never is. */
const success = (answer: Source.Answer, of: Of) =>
  Effect.flatMap(classify(answer, of), (body) =>
    Option.isSome(body)
      ? Effect.succeed(body.value)
      : Effect.fail(new Source.Unavailable({ stage: "status", upstreamStatus: answer.status }))
  );

// ---------- the call's check, and the options `null` needs ----------

type Kind = "objects" | "lists";
interface Read {
  readonly kind: Kind;
  readonly slug: string;
  readonly container: Values.Container;
}
const base = (read: Read) => `/v2/${read.kind}/${segment(read.slug)}`;
const configuration = (read: Read): Of => ({
  where: read.container.where,
  attributes: read.container.attributes,
  scope: scopes[read.kind]
});

/** The object's or list's attributes as they are now, archived ones included. */
const currentAttributes = Effect.fnUntraced(function* (workspace: Calls.Workspace, read: Read) {
  const found: Values.RawAttribute[] = [];
  for (let offset = 0; ; offset += ATTRIBUTES_PAGE) {
    const answer = yield* workspace.send(
      HttpClientRequest.get(
        `${base(read)}/attributes?show_archived=true&limit=${ATTRIBUTES_PAGE}&offset=${offset}`
      )
    );
    const page = yield* readable(
      Values.answers.attributes(yield* success(answer, configuration(read)))
    );
    found.push(...page.data);
    if (page.data.length < ATTRIBUTES_PAGE) return found;
  }
});

/** The active options or statuses of a select or status, as `null` excludes them now. */
const currentOptions = Effect.fnUntraced(function* (
  workspace: Calls.Workspace,
  read: Read,
  attribute: { readonly slug: string; readonly type: string }
) {
  const answer = yield* workspace.send(
    HttpClientRequest.get(
      `${base(read)}/attributes/${segment(attribute.slug)}/${attribute.type === "status" ? "statuses" : "options"}`
    )
  );
  const body = yield* classify(answer, configuration(read), true);
  if (Option.isNone(body))
    return yield* new ShapeMismatch({
      ...read.container.where,
      attribute: attribute.slug,
      reason: "missing"
    });
  return [
    attribute.slug,
    Values.titles((yield* readable(Values.answers.options(body.value))).data)
  ] as const;
});

/**
 * Sends `request` beside the check, for a read that needs nothing the check finds. The check's
 * refusals come first: a query Attio refused for a gone attribute names it as the check does.
 */
const besideCheck = Effect.fnUntraced(function* (
  workspace: Calls.Workspace,
  read: Read,
  request: HttpClientRequest.HttpClientRequest
) {
  const [attributes, answer] = yield* Effect.all(
    [currentAttributes(workspace, read), workspace.send(request)],
    { concurrency: 2 }
  );
  const current = yield* Values.check(read.container, attributes);
  return { current, answer };
});

// ---------- results ----------

/**
 * The result through its operation's wire schema, so nothing outside it leaves the host, held to
 * the decoded bound; `advice` says what to ask for instead.
 */
const result = <A, I extends Json>(output: Schema.Codec<A, I>, advice: TooLarge["advice"]) => {
  const encode = Schema.encodeEffect(output);
  return (value: A) =>
    Effect.flatMap(
      Effect.mapError(encode(value), (cause) => new Runtime.SourceUnavailable({ cause })),
      (encoded) =>
        encoder.encode(encodeJson(encoded)).byteLength > MAX_RESULT
          ? Effect.fail(new TooLarge({ limitId: "runtime.result.bytes", advice }))
          : Effect.succeed(encoded)
    );
};
const results = {
  listRecords: result(attioReads.listRecords.output, "limit"),
  getRecord: result(attioReads.getRecord.output, "none"),
  getManyRecords: result(attioReads.getManyRecords.output, "ids"),
  listEntries: result(attioReads.listEntries.output, "limit"),
  getEntry: result(attioReads.getEntry.output, "none"),
  listMembers: result(attioReads.listMembers.output, "none")
};

/** Every row is empty on every attribute the call asked to be empty, or nothing is returned. */
const verify = (
  plan: Query.Plan,
  rows: ReadonlyArray<{ readonly values: (typeof AttioValues)["Type"] }>
) => {
  for (const attribute of plan.empty)
    if (rows.some((row) => !Values.isEmpty(row.values[attribute.slug] ?? null)))
      return Effect.fail(new Changed({ ...plan.container.where, attribute: attribute.slug }));
  return Effect.void;
};

// ---------- the operations, checked before a slot, then sent ----------

/** What a call reads with: the snapshot, and what binds its cursors. */
interface Call {
  readonly snapshot: AttioSnapshot;
  readonly binding: Query.Binding;
}
/** An operation checked against the snapshot, ready to send once the call holds its slot. */
type Prepared = Effect.Effect<
  | { readonly send: (workspace: Calls.Workspace) => Effect.Effect<Json, Failure> }
  | { readonly done: Json },
  InvalidRequest | InvalidCursor | Runtime.SourceUnavailable | TooLarge,
  Cryptography.Cryptography
>;
type Failure =
  | InvalidRequest
  | InvalidQuery
  | InvalidCursor
  | ShapeMismatch
  | NotFound
  | Changed
  | Merging
  | TooLarge
  | Denied
  | Source.SendError
  | Runtime.SourceUnavailable;

const objectOf = (snapshot: AttioSnapshot, slug: string) => {
  const found = snapshot.objects.find((object) => object.slug === slug);
  return found === undefined
    ? Effect.fail(new InvalidRequest({ object: slug, reason: "unknown" }))
    : Effect.succeed(found);
};
const listOf = (snapshot: AttioSnapshot, slug: string) => {
  const found = snapshot.lists.find((list) => list.slug === slug);
  return found === undefined
    ? Effect.fail(new InvalidRequest({ list: slug, reason: "unknown" }))
    : Effect.succeed(found);
};
const objectRead = (object: AttioObject): Read => ({
  kind: "objects",
  slug: object.slug,
  container: Query.objectContainer(object)
});
const listRead = (
  list: AttioList
): Read & { readonly container: ReturnType<typeof Query.listContainer> } => ({
  kind: "lists",
  slug: list.slug,
  container: Query.listContainer(list)
});

/** A `listRecords` or `listEntries` page: the check, the options `null` needs, the query. */
const page = Effect.fnUntraced(function* <Row>(
  workspace: Calls.Workspace,
  read: Read,
  plan: Query.Plan,
  rows: (body: unknown) => { readonly data: ReadonlyArray<Row> } | undefined
) {
  const path = `${base(read)}/${read.kind === "objects" ? "records" : "entries"}/query`;
  const of: Of = {
    ...configuration(read),
    scope: scopes[read.kind === "objects" ? "records" : "entries"]
  };
  const query = (body: Query.Body) =>
    HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe(body));
  let answer: Source.Answer;
  if (Query.independent(plan))
    answer = (yield* besideCheck(
      workspace,
      read,
      query(Query.body(plan, { targets: new Map() }, new Map()))
    )).answer;
  else {
    // `null` on a select, status or reference excludes what Attio holds now: read it first.
    const [attributes, options] = yield* Effect.all(
      [
        currentAttributes(workspace, read),
        Effect.forEach(plan.options, (attribute) => currentOptions(workspace, read, attribute), {
          concurrency: "unbounded"
        })
      ],
      { concurrency: 2 }
    );
    const current = yield* Values.check(read.container, attributes);
    answer = yield* workspace.send(query(Query.body(plan, current, new Map(options))));
  }
  return (yield* readable(rows(yield* success(answer, of)))).data;
});

const prepare: { readonly [K in AttioRead]: (call: Call, input: Inputs[K]) => Prepared } = {
  listRecords: (call, input) =>
    Effect.gen(function* () {
      const read = objectRead(yield* objectOf(call.snapshot, input.object));
      const plan = yield* Query.plan(read.container, input, call.binding);
      return {
        send: (workspace: Calls.Workspace) =>
          Effect.gen(function* () {
            const answered = yield* page(workspace, read, plan, Values.answers.records);
            const rows = yield* Effect.forEach(answered.slice(0, plan.limit), (raw) =>
              Values.record(read.container, raw)
            );
            yield* verify(plan, rows);
            return yield* results.listRecords({
              ok: true,
              rows,
              cursor: Query.next(plan, answered.length)
            });
          })
      };
    }),
  listEntries: (call, input) =>
    Effect.gen(function* () {
      const read = listRead(yield* listOf(call.snapshot, input.list));
      const plan = yield* Query.plan(read.container, input, call.binding);
      return {
        send: (workspace: Calls.Workspace) =>
          Effect.gen(function* () {
            const answered = yield* page(workspace, read, plan, Values.answers.entries);
            const rows = yield* Effect.forEach(answered.slice(0, plan.limit), (raw) =>
              Values.entry(read.container, raw)
            );
            yield* verify(plan, rows);
            return yield* results.listEntries({
              ok: true,
              rows,
              cursor: Query.next(plan, answered.length)
            });
          })
      };
    }),
  getRecord: (call, input) =>
    Effect.gen(function* () {
      const read = objectRead(yield* objectOf(call.snapshot, input.object));
      const id = input.id.toLowerCase();
      return {
        send: (workspace: Calls.Workspace) =>
          Effect.gen(function* () {
            const { answer } = yield* besideCheck(
              workspace,
              read,
              HttpClientRequest.get(`${base(read)}/records/${segment(id)}`)
            );
            // The check showed the object is there: a 404 is the record's.
            const body = yield* classify(
              answer,
              { ...configuration(read), scope: scopes.records },
              true
            );
            if (Option.isNone(body)) return yield* results.getRecord({ ok: true, rows: [] });
            const raw = (yield* readable(Values.answers.record(body.value))).data;
            return yield* results.getRecord({
              ok: true,
              rows: [yield* Values.record(read.container, raw)]
            });
          })
      };
    }),
  getManyRecords: (call, input) =>
    Effect.gen(function* () {
      const read = objectRead(yield* objectOf(call.snapshot, input.object));
      // No ids: no call.
      if (input.ids.length === 0)
        return { done: yield* results.getManyRecords({ ok: true, rows: [] }) };
      const many = Query.many(input.ids);
      return {
        send: (workspace: Calls.Workspace) =>
          Effect.gen(function* () {
            const { answer } = yield* besideCheck(
              workspace,
              read,
              HttpClientRequest.post(`${base(read)}/records/query`).pipe(
                HttpClientRequest.bodyJsonUnsafe(many.body)
              )
            );
            const body = yield* success(answer, { ...configuration(read), scope: scopes.records });
            const answered = (yield* readable(Values.answers.records(body))).data;
            const found = new Map<
              string,
              (typeof attioReads.getRecord.output.Type)["rows"][number]
            >();
            for (const raw of answered)
              found.set(raw.id.record_id.toLowerCase(), yield* Values.record(read.container, raw));
            // Duplicates repeat a row: the answer's size, counted before it's built, holds them to
            // the decoded bound however many times one record is asked for.
            const sizes = new Map(
              [...found].map(([id, row]) => [id, encoder.encode(JSON.stringify(row)).byteLength])
            );
            let size = 0;
            for (const id of input.ids) size += (sizes.get(id.toLowerCase()) ?? 4) + 1;
            if (size > MAX_RESULT)
              return yield* new TooLarge({ limitId: "runtime.result.bytes", advice: "ids" });
            // In the order asked, duplicates kept, null for an id Attio doesn't have.
            return yield* results.getManyRecords({
              ok: true,
              rows: input.ids.map((id) => found.get(id.toLowerCase()) ?? null)
            });
          })
      };
    }),
  getEntry: (call, input) =>
    Effect.gen(function* () {
      const read = listRead(yield* listOf(call.snapshot, input.list));
      const id = input.id.toLowerCase();
      return {
        send: (workspace: Calls.Workspace) =>
          Effect.gen(function* () {
            const { answer } = yield* besideCheck(
              workspace,
              read,
              HttpClientRequest.get(`${base(read)}/entries/${segment(id)}`)
            );
            const body = yield* classify(
              answer,
              { ...configuration(read), scope: scopes.entries },
              true
            );
            if (Option.isNone(body)) return yield* results.getEntry({ ok: true, rows: [] });
            const raw = (yield* readable(Values.answers.entry(body.value))).data;
            return yield* results.getEntry({
              ok: true,
              rows: [yield* Values.entry(read.container, raw)]
            });
          })
      };
    }),
  listMembers: () =>
    Effect.succeed({
      send: (workspace: Calls.Workspace) =>
        Effect.gen(function* () {
          const answer = yield* workspace.send(HttpClientRequest.get("/v2/workspace_members"));
          const body = yield* success(answer, {
            where: { object: "workspace_members" },
            attributes: [],
            scope: scopes.members
          });
          const members = (yield* readable(Values.answers.members(body))).data;
          return yield* results.listMembers({ ok: true, rows: members.map(Values.member) });
        })
    })
};

/** The door refused its caller once the call held a slot; `atWorkspace` hands on what it said. */
class CallerRefused extends Schema.TaggedError<CallerRefused>()("AttioCallerRefused", {}) {
  override get message() {
    return "The caller was refused once the call held a slot; nothing was sent.";
  }
}

/**
 * One operation on the workspace its door admitted: checked against the caller's snapshot first,
 * then sent once it holds its slots, with the caller and the connection as they stand then.
 * Refusals come back as the wire says them, and the door's refusal of its caller and the
 * connection's absence as they are, for the door to say. Anything else is Patchy's side being
 * unavailable.
 */
const atWorkspace = Effect.fnUntraced(function* <K extends AttioRead, E>(
  target: Calls.Target<E>,
  name: K,
  input: Inputs[K]
) {
  const caller = yield* Ref.make(Option.none<E>());
  return yield* Effect.gen(function* () {
    const snapshot = yield* Calls.snapshot(target.companyId, target.connection);
    const prepared = yield* prepare[name](
      {
        snapshot,
        binding: {
          connectionId: target.connection.id,
          operation: `attio.${name}`,
          revision: target.connection.revision
        }
      },
      input
    );
    // Nothing to ask Attio, but the connection must still be one the caller may read.
    if ("done" in prepared) {
      yield* Calls.current(target.companyId, target.connection);
      return prepared.done;
    }
    return yield* Calls.withWorkspace(
      {
        ...target,
        recheck: target.recheck.pipe(
          Effect.tapError((error) => Ref.set(caller, Option.some(error))),
          Effect.mapError(() => new CallerRefused({}))
        )
      },
      prepared.send
    );
  }).pipe(
    Effect.catchTags({
      AttioOverflow: () =>
        Effect.fail(
          new TooLarge({
            limitId: "attio.call.bytes",
            advice:
              name === "listRecords" || name === "listEntries"
                ? "limit"
                : name === "getManyRecords"
                  ? "ids"
                  : "none"
          })
        )
    }),
    Effect.catch((error) =>
      Effect.flatMap(Ref.get(caller), (refused) =>
        Effect.fail(
          Option.isSome(refused)
            ? refused.value
            : isError(error) || isAbsent(error)
              ? error
              : new Runtime.SourceUnavailable({ cause: error })
        )
      )
    )
  );
});

/**
 * One operation as a loaded version's door admitted it: the declared connection, its revision and
 * its viewer. A viewer deactivated or a connection that stopped working while the call waited
 * sends nothing.
 */
const perform = Effect.fn("AttioOperations.perform")(function* <K extends AttioRead>(
  connection: string,
  name: K,
  input: Inputs[K]
) {
  const binding = yield* Binding.Binding;
  const declaration = binding.manifest.uses[connection];
  if (!Object.hasOwn(binding.manifest.uses, connection) || declaration?.kind !== "attio")
    return yield* new ConnectionNotDeclared({});
  const { identity, principal, companyId } = binding;
  if (
    binding.scope !== "company" ||
    identity === null ||
    principal === null ||
    identity.company.id !== companyId ||
    identity.user.id !== principal.userId
  )
    return yield* new Runtime.AccessDenied({});
  // The caller's own deadline bounds the wait for a slot, so a refused wait is never a timeout.
  const deadline = binding.deadline ?? (yield* Clock.currentTimeMillis) + DEADLINE_MS;
  // A viewer deactivated while the call waited sends nothing.
  const recheck = binding.reauthorize
    ? binding.reauthorize.pipe(
        Effect.mapError((cause) =>
          isError(cause) ? cause : new Runtime.SourceUnavailable({ cause })
        ),
        Effect.flatMap((current) =>
          current.company.id === companyId && current.user.id === identity.user.id
            ? Effect.void
            : Effect.fail(new Runtime.AccessDenied({}))
        )
      )
    : (yield* Directory.Directory).get(companyId, identity.user.id).pipe(
        Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })),
        Effect.flatMap((member) =>
          member?.active === true ? Effect.void : Effect.fail(new Runtime.AccessDenied({}))
        )
      );
  return yield* atWorkspace(
    {
      companyId,
      connection: {
        id: declaration.id,
        handle: declaration.handle,
        revision: declaration.revision
      },
      deadline,
      recheck
    },
    name,
    input
  ).pipe(
    Effect.catchTags({
      ConnectionNotFound: (cause) => Effect.fail(new Runtime.AccessDenied({ cause })),
      ConnectionNotConnected: (cause) => Effect.fail(new Runtime.AccessDenied({ cause }))
    })
  );
});

const listRecords = operation({
  input: AttioListRecords,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection, ...input }: typeof AttioListRecords.Type) =>
    perform(connection, "listRecords", input)
});
const getRecord = operation({
  input: AttioGetRecord,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection, ...input }: typeof AttioGetRecord.Type) =>
    perform(connection, "getRecord", input)
});
const getManyRecords = operation({
  input: AttioGetManyRecords,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection, ...input }: typeof AttioGetManyRecords.Type) =>
    perform(connection, "getManyRecords", input)
});
const listEntries = operation({
  input: AttioListEntries,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection, ...input }: typeof AttioListEntries.Type) =>
    perform(connection, "listEntries", input)
});
const getEntry = operation({
  input: AttioGetEntry,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection, ...input }: typeof AttioGetEntry.Type) =>
    perform(connection, "getEntry", input)
});
const listMembers = operation({
  input: AttioListMembers,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection }: typeof AttioListMembers.Type) => perform(connection, "listMembers", {})
});

export const operations = {
  listRecords,
  getRecord,
  getManyRecords,
  listEntries,
  getEntry,
  listMembers
};

const connectionId = (args: unknown, binding: Binding.Binding["Service"]): string | null => {
  if (
    !Predicate.isObject(args) ||
    typeof args.connection !== "string" ||
    !Object.hasOwn(binding.manifest.uses, args.connection)
  )
    return null;
  const declaration = binding.manifest.uses[args.connection];
  return declaration?.kind === "attio" ? declaration.id : null;
};

/** An object's or list's name as Attio gives slugs; anything else isn't recorded. */
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * How a call reads in recent calls: the object or list its operation names, and how many rows.
 * Never a filter, an id, a value or an email. It runs on arguments not yet checked, so it reads
 * only the field its operation names, and only a name shaped like a slug.
 */
const recordedBy = (field: "object" | "list" | null) => ({
  resource: (args: unknown): string | null => {
    if (field === null || !Predicate.isObject(args)) return null;
    const named = args[field];
    return typeof named === "string" && SLUG.test(named) ? named : null;
  },
  rowCount: (value: unknown): number | null =>
    Predicate.isObject(value) && Array.isArray(value.rows)
      ? value.rows.filter((row) => row !== null).length
      : null
});
export const recorded = {
  listRecords: recordedBy("object"),
  getRecord: recordedBy("object"),
  getManyRecords: recordedBy("object"),
  listEntries: recordedBy("list"),
  getEntry: recordedBy("list"),
  listMembers: recordedBy(null)
} satisfies { readonly [K in AttioRead]: unknown };

/**
 * One read the definition's `live` names, for `patchy dev` through the instance's dev door
 * (ADR-0013): the caller is the door's, never a loaded version's, and the alias stays in the
 * repo. The dev read carries its declaration's revision, so a client generated before a Refresh
 * decodes by its own snapshot; a revision of another connection isn't found.
 */
const devRead = <K extends AttioRead>(
  name: K,
  input: Schema.Decoder<Inputs[K]>
): DevRead<Source.Source | Cryptography.Cryptography> => {
  const decode = Schema.decodeUnknownEffect(input, { onExcessProperty: "error" });
  return {
    ...recorded[name],
    run: (target, args) => {
      const revision = target.connection.revision;
      return revision === undefined
        ? Effect.fail(new Runtime.InvalidRequest({}))
        : decode(args).pipe(
            Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })),
            Effect.flatMap((decoded) =>
              atWorkspace(
                { ...target, connection: { ...target.connection, revision } },
                name,
                decoded
              )
            )
          );
    }
  };
};
export const devReads = {
  "attio.listRecords": devRead("listRecords", attioReads.listRecords.input),
  "attio.getRecord": devRead("getRecord", attioReads.getRecord.input),
  "attio.getManyRecords": devRead("getManyRecords", attioReads.getManyRecords.input),
  "attio.listEntries": devRead("listEntries", attioReads.listEntries.input),
  "attio.getEntry": devRead("getEntry", attioReads.getEntry.input),
  "attio.listMembers": devRead("listMembers", attioReads.listMembers.input)
};

/**
 * Published patches, the dev door and connection administration share one Source, so a
 * workspace's slots span them all.
 */
export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const connections = yield* ConnectionStore.ConnectionStore;
  const directory = yield* Directory.Directory;
  const cryptography = yield* Cryptography.Cryptography;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Source.Source, source),
      Effect.provideService(ConnectionStore.ConnectionStore, connections),
      Effect.provideService(Directory.Directory, directory),
      Effect.provideService(Cryptography.Cryptography, cryptography)
    );
  const handler = <I extends Schema.Top & Schema.Codec<unknown, unknown>>(
    definition: {
      readonly input: I;
      readonly output: typeof Schema.Json;
      readonly run: (
        args: I["Type"]
      ) => Effect.Effect<
        Json,
        Runtime.RuntimeError,
        | Binding.Binding
        | Source.Source
        | ConnectionStore.ConnectionStore
        | Directory.Directory
        | Cryptography.Cryptography
      >;
    },
    record: ReturnType<typeof recordedBy>
  ) =>
    Runtime.handler({ kind: "integration", ...definition, ...record, connectionId }, (args) =>
      provide(definition.run(args))
    );
  return {
    "attio.listRecords": handler(listRecords, recorded.listRecords),
    "attio.getRecord": handler(getRecord, recorded.getRecord),
    "attio.getManyRecords": handler(getManyRecords, recorded.getManyRecords),
    "attio.listEntries": handler(listEntries, recorded.listEntries),
    "attio.getEntry": handler(getEntry, recorded.getEntry),
    "attio.listMembers": handler(listMembers, recorded.listMembers)
  };
});
