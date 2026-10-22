import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { Analytics } from "@patchy/analytics";
import { escapeAttribute } from "@patchy/core";
import * as NangoConnect from "./NangoConnect.js";
import * as SalesforcePage from "./salesforce/Page.js";
import { Integration, integrations } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import { Users } from "@patchy/companies";
import { RuntimeLog } from "@patchy/runtime";
import * as ConnectionStore from "./ConnectionStore.js";
import * as View from "./ConnectionsView.js";
import * as PostgresPage from "./postgres/Page.js";
import * as PostHogPage from "./posthog/Page.js";

/** A page to read. */
export type Target =
  | { readonly kind: "index" }
  | { readonly kind: "catalogue" }
  | { readonly kind: "connect"; readonly integration: string }
  | { readonly kind: "view"; readonly id: string }
  | { readonly kind: "confirm"; readonly id: string; readonly action: View.Confirmation };

/** A change an admin submits. */
export type Change =
  | { readonly kind: "finish" }
  | { readonly kind: "connect"; readonly integration: string }
  | {
      readonly kind: "test" | "refresh" | "reconnect" | View.Confirmation;
      readonly id: string;
    };

export interface Page {
  readonly title: string;
  readonly body: string;
  readonly status?: number;
  readonly redirect?: string;
}

type Submitted = Readonly<Record<string, string | undefined>>;

/** An integration's page for new credentials or a new destination. */
interface CredentialsPage {
  readonly title: (name: string) => string;
  readonly consequence: string;
  /** The fields; a refused submit keeps what the integration echoes, never secrets. */
  readonly fields: (submitted: Submitted, refusal?: View.Notice) => string;
}

/** What the pages say about one integration; the layout around it is the same for every one. */
interface IntegrationPage {
  readonly integration: View.Integration;
  readonly offer: View.Offer;
  readonly actions: View.Actions;
  readonly connectIntro: string;
  /** The steps around the connect form, when connecting starts outside Patchy. */
  readonly walkthrough?: View.Walkthrough;
  readonly connectFields: (submitted: Submitted, refusal?: View.Notice) => string;
  readonly rotate: CredentialsPage;
  readonly retarget: CredentialsPage;
  /** Refusal codes about the credentials, by the field they are shown under. */
  readonly credentialRefusals: ReadonlyMap<string, View.Field>;
  /** The submitted credentials as one secret, or the refusal at the field that stops them. */
  readonly credentials: (
    form: Submitted,
    current?: ConnectionStore.Connection
  ) => Redacted.Redacted<string> | View.Notice;
  /** The integration's own words for a completed action, where they differ. */
  readonly results?: Partial<Record<keyof typeof results, string>>;
}
const pages: { readonly [K in Integration]: IntegrationPage } = {
  postgres: PostgresPage,
  salesforce: SalesforcePage,
  posthog: PostHogPage
};
const offers = integrations.map((integration) => pages[integration].offer);
const isIntegration = Schema.is(Integration);

/** Where a connection reads and its facts, in its integration's words. */
const about = (connection: ConnectionStore.Connection) =>
  connection.integration === "postgres"
    ? { source: PostgresPage.source(connection), facts: PostgresPage.facts(connection) }
    : connection.integration === "salesforce"
      ? { source: SalesforcePage.source(connection), facts: SalesforcePage.facts(connection) }
      : { source: PostHogPage.source(connection), facts: PostHogPage.facts(connection) };
/** What a snapshot lets patches read, in its integration's words. */
const readsOf = (metadata: ConnectionStore.Metadata) =>
  metadata.integration === "postgres"
    ? PostgresPage.reads(metadata.snapshot)
    : metadata.integration === "salesforce"
      ? SalesforcePage.reads(metadata.snapshot)
      : PostHogPage.reads(metadata.snapshot);

/** The field each refusal is about, when it is about one. */
const refusedField = (page: IntegrationPage, code: string | undefined): View.Field | undefined =>
  code === "invalid_connection_handle" || code === "connection_handle_taken"
    ? "handle"
    : code === "invalid_connection_description"
      ? "description"
      : code === undefined
        ? undefined
        : page.credentialRefusals.get(code);
/** A refusal placed at its field when the re-rendered form has that field, else atop the page. */
const atField = (
  page: IntegrationPage,
  notice: View.Notice,
  fields: ReadonlyArray<View.Field>
): View.Notice => {
  if (notice.field !== undefined)
    return fields.includes(notice.field) ? notice : { ...notice, field: undefined };
  const field = refusedField(page, notice.code);
  return field !== undefined && fields.includes(field) ? { ...notice, field } : notice;
};

const results = {
  connect: "Database connected and schema discovered.",
  test: "Connection tested successfully.",
  rotate: "Credentials replaced. The connection keeps its identity and what patches can read.",
  retarget:
    "Pointed elsewhere and its schema discovered. Existing patches keep the schema they were published with.",
  refresh:
    "Schema refreshed. Existing patches keep their pinned schema; regenerate before publishing against the new schema.",
  disconnect: "Connection disconnected. Patches cannot use it until an admin reconnects it.",
  reconnect: "Connection tested and reconnected. Its schema revision is unchanged.",
  description: "Description updated.",
  delete: "Connection deleted. Its schema snapshots have been kept."
} as const;
const isResult = Schema.is(Schema.Literals(Object.keys(results) as Array<keyof typeof results>));
type Result = keyof typeof results;
const result = (page: IntegrationPage | undefined, key: Result): View.Notice => ({
  message: page?.results?.[key] ?? results[key]
});

const forbidden: View.Notice = {
  message: "Only an admin can manage company connections.",
  code: "access_denied",
  status: 403
};

/** The index's filters from its query string. */
const filters = (query: URLSearchParams): View.Filters => {
  const view = query.get("view");
  return {
    q: (query.get("q") ?? "").trim().toLowerCase().slice(0, 100),
    source: query.get("source") || undefined,
    view: view === "attention" || view === "unused" ? view : "all"
  };
};

const row = (
  connection: ConnectionStore.Connection,
  usage: ReadonlyMap<string, ConnectionStore.Usage>
): View.Row => ({
  id: connection.id,
  integration: pages[connection.integration].integration,
  handle: connection.handle,
  description: connection.description,
  source: about(connection).source,
  status: connection.status,
  ...(usage.get(connection.id) ?? ConnectionStore.unused)
});

const index = Effect.fn("ConnectionPage.index")(function* (
  viewer: RequireSession.Viewer["Service"],
  query: URLSearchParams,
  notice?: View.Notice
) {
  const store = yield* ConnectionStore.ConnectionStore;
  const admin = viewer.role === "admin";
  const connections = yield* store.list(viewer.company.id);
  const usage = yield* store.usage(viewer.company.id);
  // Members can see connection status, but must never read the call log.
  const lastCalls: View.LastCalls | undefined = admin
    ? yield* (yield* RuntimeLog.RuntimeLog)
        .latest({
          companyId: viewer.company.id,
          connectionIds: connections.map((connection) => connection.id)
        })
        .pipe(
          Effect.map(
            (latest) => new Map([...latest].map(([id, at]) => [id, at.toISOString()] as const))
          ),
          Effect.catchTags({ SqlError: () => Effect.succeed("unavailable" as const) })
        )
    : undefined;
  // Names to ask are a courtesy: an unreadable directory leaves them out.
  const admins =
    !admin && connections.length === 0
      ? yield* (yield* Users.Users).list(viewer.company.id).pipe(
          Effect.map((users) =>
            users
              .filter((user) => user.role === "admin" && user.deactivatedAt === null)
              .map((user) => user.name)
              .sort((a, b) => a.localeCompare(b))
          ),
          Effect.catchTags({ SqlError: () => Effect.succeed([]) })
        )
      : [];
  return {
    title: "Connections",
    body: View.renderIndex({
      admin,
      company: viewer.company.name,
      admins,
      rows: connections.map((connection) => row(connection, usage)),
      lastCalls,
      offers,
      filters: filters(query),
      now: yield* Clock.currentTimeMillis,
      notice
    }),
    status: notice?.status
  } satisfies Page;
});

const catalogue = Effect.fn("ConnectionPage.catalogue")(function* (
  viewer: RequireSession.Viewer["Service"]
) {
  const connections = yield* (yield* ConnectionStore.ConnectionStore).list(viewer.company.id);
  return {
    title: "Connect a source",
    body: View.renderCatalogue({
      admin: viewer.role === "admin",
      rows: connections.map((connection) => row(connection, new Map())),
      offers
    })
  } satisfies Page;
});

const connectForm = (
  integration: Integration,
  submitted: Submitted = {},
  notice?: View.Notice
): Page => {
  const page = pages[integration];
  return {
    title: `Connect ${page.integration.label}`,
    body: View.renderConnect({
      integration: page.integration,
      intro: page.connectIntro,
      fields: page.connectFields(submitted, notice),
      ...(page.walkthrough === undefined ? {} : { walkthrough: page.walkthrough }),
      notice
    }),
    status: notice?.status
  };
};

/** One connection in the pages' words: its integration's facts, usage and who added it. */
const connectionView = Effect.fn("ConnectionPage.connectionView")(function* (
  viewer: RequireSession.Viewer["Service"],
  id: string
) {
  const store = yield* ConnectionStore.ConnectionStore;
  const connection = yield* store.get(viewer.company.id, id);
  const page = pages[connection.integration];
  const usage = (yield* store.usage(viewer.company.id)).get(id) ?? ConnectionStore.unused;
  // Deactivated people keep their names: they still added connections and made calls. A
  // directory that cannot be read leaves the page and its actions working, without names.
  const people = yield* (yield* Users.Users).list(viewer.company.id).pipe(
    Effect.map((users) => new Map(users.map((user) => [user.id, user.name]))),
    Effect.catchTags({ SqlError: () => Effect.succeed(null) })
  );
  return {
    connection,
    page,
    people: people ?? new Map<string, string>(),
    view: {
      id: connection.id,
      integration: page.integration,
      handle: connection.handle,
      description: connection.description,
      status: connection.status,
      mode: page.offer.mode,
      testedAt: connection.lastTestedAt,
      addedBy:
        people === null
          ? "Unknown"
          : (people.get(connection.createdBy) ?? "Someone no longer in the company"),
      facts: about(connection).facts,
      ...usage
    } satisfies View.Connection
  };
});

const connectionPage = Effect.fn("ConnectionPage.connectionPage")(function* (
  viewer: RequireSession.Viewer["Service"],
  id: string,
  given?: View.Notice | Result
) {
  const store = yield* ConnectionStore.ConnectionStore;
  const admin = viewer.role === "admin";
  const { connection, page, people, view } = yield* connectionView(viewer, id);
  const notice = typeof given === "string" ? result(page, given) : given;
  const reads = yield* store.snapshot(viewer.company.id, id, connection.metadataRevision).pipe(
    Effect.map((metadata) => ({
      ...readsOf(metadata),
      revision: connection.metadataRevision,
      foundAt: connection.lastDiscoveredAt
    })),
    Effect.catchTags({ ConnectionNotFound: () => Effect.succeed(null) })
  );
  // Members can see safe connection metadata, but must never read the call log. A log or its
  // names that cannot be read leave administration working.
  const calls = admin
    ? yield* Effect.gen(function* () {
        const list = yield* (yield* RuntimeLog.RuntimeLog).recent({
          companyId: viewer.company.id,
          connectionId: id,
          limit: View.RECENT_CALLS
        });
        const versions = yield* store.versions(
          viewer.company.id,
          list.flatMap((call) => (call.versionId === null ? [] : [call.versionId]))
        );
        return { list, names: { people, versions } };
      }).pipe(
        Effect.catch(() =>
          Effect.succeed({
            list: "unavailable" as const,
            names: { people, versions: new Map() }
          })
        )
      )
    : undefined;
  return {
    title: `${connection.integration}/${connection.handle}`,
    body: View.renderConnection({
      connection: view,
      reads,
      actions: page.actions,
      calls,
      admin,
      now: yield* Clock.currentTimeMillis,
      notice
    }),
    status: notice?.status
  } satisfies Page;
});

const confirmationPage = Effect.fn("ConnectionPage.confirmationPage")(function* (
  viewer: RequireSession.Viewer["Service"],
  id: string,
  action: View.Confirmation,
  form: {
    readonly description?: string;
    readonly submitted?: Submitted;
    readonly notice?: View.Notice;
  } = {}
) {
  const { page, view } = yield* connectionView(viewer, id);
  // Delete is offered only while nothing declares the connection; a stale link says why.
  if (action === "delete" && view.declared) return yield* connectionPage(viewer, id, inUse(id));
  const credentials = action === "rotate" || action === "retarget" ? page[action] : undefined;
  const name = `${view.integration.key}/${view.handle}`;
  return {
    title: name,
    body: View.renderConfirmation({
      connection: view,
      action,
      actions: page.actions,
      form: credentials && {
        title: credentials.title(name),
        consequence: credentials.consequence,
        fields: credentials.fields(form.submitted ?? {}, form.notice)
      },
      description: form.description,
      notice: form.notice
    }),
    status: form.notice?.status
  } satisfies Page;
});

const inUse = (id: string): View.Notice => ({
  message: new ConnectionStore.ConnectionInUse({}).message,
  code: "connection_in_use",
  status: 409,
  next: { href: View.connectionPath(id, "disconnect"), label: "Disconnect it instead" }
});

/** Renders a page; Auth supplies a live viewer, and no query parameter selects authority. */
export const read = Effect.fn("ConnectionPage.read")(function* (
  viewer: RequireSession.Viewer["Service"],
  target: Target,
  query: URLSearchParams
) {
  const key = query.get("result");
  const done = key && isResult(key) ? key : undefined;
  const admin = viewer.role === "admin";
  switch (target.kind) {
    case "index":
      return yield* index(viewer, query, done && result(undefined, done));
    case "catalogue":
      return yield* catalogue(viewer);
    case "connect":
      if (!isIntegration(target.integration))
        return yield* new ConnectionStore.ConnectionNotFound({
          companyId: viewer.company.id,
          lookup: { integration: target.integration, handle: "" }
        });
      if (!admin) return yield* index(viewer, new URLSearchParams(), forbidden);
      return connectForm(target.integration);
    case "view":
      return yield* connectionPage(viewer, target.id, done);
    case "confirm":
      if (!admin) return yield* connectionPage(viewer, target.id, forbidden);
      return yield* confirmationPage(viewer, target.id, target.action);
  }
});

const decodeConnect = Schema.decodeUnknownEffect(
  Schema.Struct({ handle: Schema.String, description: Schema.String })
);
const decodeDescription = Schema.decodeUnknownEffect(Schema.Struct({ description: Schema.String }));
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
/** The form's text fields; a page echoes only the ones that are not secret. */
const submittedOf = (form: Readonly<Record<string, unknown>> | null): Submitted =>
  Object.fromEntries(
    Object.entries(form ?? {}).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : []
    )
  );

const unreadable: View.Notice = {
  message: "The form could not be read. Submit it again.",
  code: "invalid_request",
  status: 400
};
const incomplete: View.Notice = {
  message: "Complete the form and submit it again. Credentials are never redisplayed.",
  code: "invalid_request",
  status: 422
};
/** A store refusal as the page shows it. */
const refusal = (error: ConnectionStore.ConnectionError): View.Notice => ({
  message: error.message,
  code: error.code,
  status: error.status
});

/** The submitted form, or null when its body cannot be read. */
const formBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.urlParamsBody.pipe(
    Effect.map((params): Readonly<Record<string, unknown>> => Object.fromEntries(params)),
    Effect.catchTags({ HttpServerError: () => Effect.succeed(null) })
  );
});

/** The store reports each change with its commit; a refusal or rollback reports nothing. */
const reporter = Effect.fn("ConnectionPage.reporter")(function* (
  viewer: RequireSession.Viewer["Service"],
  name: "connection.connected" | "connection.deleted"
) {
  const analytics = yield* Analytics.Analytics;
  return (connection: ConnectionStore.Connection) =>
    analytics.track({
      name,
      principalId: viewer.user.id,
      companyId: viewer.company.id,
      properties: { connectionId: connection.id, integration: connection.integration }
    });
});

const authorize = Effect.fn("ConnectionPage.authorize")(function* (
  viewer: RequireSession.Viewer["Service"],
  input: Parameters<typeof NangoConnect.begin>[1]
) {
  const attempt = yield* NangoConnect.begin(viewer, input);
  return {
    title: "Authorize Salesforce",
    body: `<div class="page-heading"><h1>Connect Salesforce</h1></div><p><a class="btn btn-primary" href="${escapeAttribute(attempt.link)}" target="_blank" rel="noopener noreferrer">Authorize in Salesforce</a></p><p>After authorization succeeds, return to this page. This attempt expires in ten minutes.</p><form method="post" action="/company/connections/finish"><input type="hidden" name="attempt" value="${escapeAttribute(attempt.id)}"><button class="btn btn-primary" type="submit">Finish connecting</button></form>`
  } satisfies Page;
});

const connect = Effect.fn("ConnectionPage.connect")(function* (
  viewer: RequireSession.Viewer["Service"],
  integration: Integration
) {
  const page = pages[integration];
  const form = yield* formBody;
  const submitted = submittedOf(form);
  // A refused connect keeps what was typed, except the credentials.
  const refused = (notice: View.Notice) =>
    connectForm(
      integration,
      submitted,
      atField(page, notice, ["handle", "description", "credentials", "region", "project", "key"])
    );
  if (form === null) return refused(unreadable);
  return yield* Effect.gen(function* () {
    const fields = yield* decodeConnect(form);
    if (integration === "salesforce") return yield* authorize(viewer, { ...fields, integration });
    const credentials = page.credentials(submitted);
    if (!Redacted.isRedacted(credentials)) return refused(credentials);
    const connection = yield* (yield* ConnectionStore.ConnectionStore).connect(
      {
        integration,
        companyId: viewer.company.id,
        userId: viewer.user.id,
        handle: fields.handle,
        description: fields.description,
        credentials
      },
      yield* reporter(viewer, "connection.connected")
    );
    return {
      title: "Connections",
      body: "",
      redirect: `${View.connectionPath(connection.id)}?result=connect`
    } satisfies Page;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(refused(error._tag === "SchemaError" ? incomplete : refusal(error)))
    )
  );
});

const act = Effect.fn("ConnectionPage.act")(function* (
  viewer: RequireSession.Viewer["Service"],
  id: string,
  kind: Exclude<Change["kind"], "connect" | "finish">
) {
  const form = yield* formBody;
  const submitted = submittedOf(form);
  /** The page the change came from, with its refusal and a typed description kept. */
  const refused = (notice: View.Notice) =>
    Effect.gen(function* () {
      switch (kind) {
        case "rotate":
        case "retarget": {
          const { page } = yield* connectionView(viewer, id);
          return yield* confirmationPage(viewer, id, kind, {
            submitted,
            notice: atField(page, notice, ["credentials", "region", "project", "key"])
          });
        }
        case "description": {
          const { page } = yield* connectionView(viewer, id);
          return yield* confirmationPage(viewer, id, kind, {
            description: text(form?.description),
            notice: atField(page, notice, ["description"])
          });
        }
        case "delete":
          return yield* connectionPage(
            viewer,
            id,
            notice.code === "connection_in_use" ? inUse(id) : notice
          );
        default:
          return yield* connectionPage(viewer, id, notice);
      }
    });
  if (form === null) return yield* refused(unreadable);
  return yield* Effect.gen(function* () {
    const store = yield* ConnectionStore.ConnectionStore;
    const input = { companyId: viewer.company.id, userId: viewer.user.id, id };
    const existing = yield* store.get(viewer.company.id, id);
    if (
      existing.integration === "salesforce" &&
      (kind === "reconnect" || kind === "rotate" || kind === "retarget")
    )
      return yield* authorize(viewer, {
        integration: existing.integration,
        handle: existing.handle,
        description: existing.description,
        connectionId: id,
        action: kind
      });
    if (kind === "rotate" || kind === "retarget") {
      const current = yield* store.get(viewer.company.id, id);
      // Replacing credentials keeps where they point; pointing elsewhere names it anew.
      const credentials = pages[current.integration].credentials(
        submitted,
        kind === "rotate" ? current : undefined
      );
      if (!Redacted.isRedacted(credentials)) return yield* refused(credentials);
      yield* store[kind]({ ...input, credentials });
    } else if (kind === "description") {
      const fields = yield* decodeDescription(form);
      yield* store.describe({ ...input, description: fields.description });
    } else if (kind === "delete") {
      yield* store.delete(input, yield* reporter(viewer, "connection.deleted"));
    } else {
      yield* store[kind](input);
    }
    return {
      title: "Connections",
      body: "",
      redirect: `${kind === "delete" ? View.indexPath : View.connectionPath(id)}?result=${kind}`
    } satisfies Page;
  }).pipe(
    Effect.catch((error) =>
      refused(
        error._tag === "SchemaError"
          ? incomplete
          : error._tag === "ConnectionRetargetRequired"
            ? // Credentials for another target belong to pointing elsewhere; say so where refused.
              {
                ...refusal(error),
                next: {
                  href: View.connectionPath(id, "retarget"),
                  label: "Point it elsewhere instead"
                }
              }
            : refusal(error)
      )
    )
  );
});

/** Runs an admin's change; a refusal re-renders the page it came from. */
export const submit = Effect.fn("ConnectionPage.submit")(function* (
  viewer: RequireSession.Viewer["Service"],
  change: Change
) {
  // Refused before the body is read: a member's form never reaches the store.
  if (viewer.role !== "admin") {
    if (change.kind === "connect" || change.kind === "finish")
      return yield* index(viewer, new URLSearchParams(), forbidden);
    return yield* connectionPage(viewer, change.id, forbidden);
  }
  if (change.kind === "finish") {
    const form = yield* formBody;
    const connection = yield* NangoConnect.finish(viewer, text(form?.attempt) ?? "");
    return {
      title: "Connections",
      body: "",
      redirect: `${View.connectionPath(connection.id)}?result=connect`
    } satisfies Page;
  }
  if (change.kind !== "connect") return yield* act(viewer, change.id, change.kind);
  if (!isIntegration(change.integration))
    return yield* new ConnectionStore.ConnectionNotFound({
      companyId: viewer.company.id,
      lookup: { integration: change.integration, handle: "" }
    });
  return yield* connect(viewer, change.integration);
});
