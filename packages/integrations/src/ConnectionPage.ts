import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { Analytics } from "@patchy/analytics";
import { Integration, integrations } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import { Users } from "@patchy/companies";
import { ContractLimits } from "@patchy/limits";
import { RuntimeLog } from "@patchy/runtime";
import * as ConnectionStore from "./ConnectionStore.js";
import * as View from "./ConnectionsView.js";
import * as PostgresPage from "./postgres/Page.js";
import * as PostHogPage from "./posthog/Page.js";
import * as PidgeonKeys from "./pidgeon/Keys.js";
import * as PidgeonPage from "./pidgeon/Page.js";
import * as AttioPage from "./attio/Page.js";

/** A page to read. */
export type Target =
  | { readonly kind: "index" }
  | { readonly kind: "catalogue" }
  | { readonly kind: "connect"; readonly integration: string }
  | { readonly kind: "view"; readonly id: string }
  | { readonly kind: "confirm"; readonly id: string; readonly action: View.Confirmation };

/** A change an admin submits. */
export type Change =
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

/** Every connections page's layout, the shared frame's and each integration's own. */
export const styles = `${View.styles}${PidgeonPage.styles}`;

type Submitted = Readonly<Record<string, string | undefined>>;

/** An integration's page for new credentials, a new destination or new access. */
interface CredentialsPage {
  readonly title: (name: string) => string;
  readonly consequence: string;
  /** The submit button's label, where testing first isn't what it does. */
  readonly submit?: string;
  /** The fields; a refused submit keeps what the integration echoes, never secrets. */
  readonly fields: (submitted: Submitted, refusal?: View.Notice) => string;
}

/** What the pages say about one integration; the layout around it is the same for every one. */
interface IntegrationPage {
  readonly integration: View.Integration;
  readonly offer: View.Offer;
  readonly actions: View.Actions;
  /** The shared connect frame's intro and fields, unless the integration has its own page. */
  readonly connectIntro?: string;
  /** The steps around the connect form, when connecting starts outside Patchy. */
  readonly walkthrough?: View.Walkthrough;
  readonly connectFields?: (submitted: Submitted, refusal?: View.Notice) => string;
  /** The whole connect page, for an integration whose connecting takes more than a form. */
  readonly renderConnect?: (submitted: Submitted, refusal?: View.Notice) => string;
  readonly rotate: CredentialsPage;
  /** Absent where a connection can't move to another target. */
  readonly retarget?: CredentialsPage;
  /** Present where what the credentials may do is a choice. */
  readonly access?: CredentialsPage;
  readonly consequences?: Partial<Record<"delete" | "disconnect", string>>;
  /** Refusal codes about the credentials, by the field they are shown under. */
  readonly credentialRefusals: ReadonlyMap<string, View.Field>;
  /** A refusal's bold first line, by its code, where the integration gives one. */
  readonly refusalTitles?: ReadonlyMap<string, string>;
  /** The submitted credentials as one secret, or the refusal at the field that stops them. */
  readonly credentials: (
    form: Submitted,
    current?: ConnectionStore.Connection
  ) => Redacted.Redacted<string> | View.Notice;
  /** The integration's own words for a completed action, where they differ. */
  readonly results?: Partial<
    Record<Result, string | ((connection: ConnectionStore.Connection) => string)>
  >;
}
const pages: { readonly [K in Integration]: IntegrationPage } = {
  postgres: PostgresPage,
  posthog: PostHogPage,
  pidgeon: PidgeonPage,
  attio: AttioPage
};
const offers = integrations.map((integration) => pages[integration].offer);
const isIntegration = Schema.is(Integration);

/**
 * Where a connection reads, its facts, what its page keeps saying and the label beside its name,
 * in its integration's words.
 */
const about = (
  connection: ConnectionStore.Connection
): {
  readonly source: string;
  readonly facts: ReadonlyArray<readonly [string, string]>;
  readonly standing?: ReadonlyArray<View.Standing>;
  readonly tag?: string | undefined;
} =>
  connection.integration === "postgres"
    ? { source: PostgresPage.source(connection), facts: PostgresPage.facts(connection) }
    : connection.integration === "posthog"
      ? { source: PostHogPage.source(connection), facts: PostHogPage.facts(connection) }
      : connection.integration === "attio"
        ? { source: AttioPage.source(connection), facts: AttioPage.facts(connection) }
        : {
            source: PidgeonPage.source(connection),
            facts: PidgeonPage.facts(connection),
            standing: PidgeonPage.standing(connection),
            tag: PidgeonPage.tag(connection)
          };
/** What a snapshot lets patches read, in its integration's words. */
const readsOf = (metadata: ConnectionStore.Metadata) =>
  metadata.integration === "postgres"
    ? PostgresPage.reads(metadata.snapshot)
    : metadata.integration === "posthog"
      ? PostHogPage.reads(metadata.snapshot)
      : metadata.integration === "attio"
        ? AttioPage.reads(metadata.snapshot)
        : PidgeonPage.reads(metadata.snapshot);

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
  const titled =
    notice.title === undefined && notice.code !== undefined && page.refusalTitles?.has(notice.code)
      ? { ...notice, title: page.refusalTitles.get(notice.code) }
      : notice;
  if (titled.field !== undefined)
    return fields.includes(titled.field) ? titled : { ...titled, field: undefined };
  const field = refusedField(page, titled.code);
  return field !== undefined && fields.includes(field) ? { ...titled, field } : titled;
};

const results = {
  connect: "Database connected and schema discovered.",
  test: "Connection tested successfully.",
  rotate: "Credentials replaced. The connection keeps its identity and what patches can read.",
  retarget:
    "Pointed elsewhere and its schema discovered. Existing patches keep the schema they were published with.",
  access: "Access changed. Existing patches keep what they were published with until refreshed.",
  refresh:
    "Schema refreshed. Existing patches keep their pinned schema; regenerate before publishing against the new schema.",
  disconnect: "Connection disconnected. Patches cannot use it until an admin reconnects it.",
  reconnect: "Connection tested and reconnected. Its schema revision is unchanged.",
  description: "Description updated.",
  delete: "Connection deleted. Its schema snapshots have been kept."
} as const;
const isResult = Schema.is(Schema.Literals(Object.keys(results) as Array<keyof typeof results>));
type Result = keyof typeof results;
/** A completed action's notice, in its integration's words about this connection where it has them. */
const result = (
  page: IntegrationPage | undefined,
  key: Result,
  connection?: ConnectionStore.Connection
): View.Notice => {
  const own = page?.results?.[key];
  return {
    message:
      typeof own === "string"
        ? own
        : own !== undefined && connection !== undefined
          ? own(connection)
          : results[key]
  };
};

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
): View.Row => {
  const known = about(connection);
  return {
    id: connection.id,
    integration: pages[connection.integration].integration,
    handle: connection.handle,
    description: connection.description,
    source: known.source,
    status: connection.status,
    ...(known.tag === undefined ? {} : { tag: known.tag }),
    ...(usage.get(connection.id) ?? ConnectionStore.unused)
  };
};

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
    title: "Integrations",
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
    title: "Connect an integration",
    body: View.renderCatalogue({
      admin: viewer.role === "admin",
      rows: connections.map((connection) => row(connection, new Map())),
      offers
    })
  } satisfies Page;
});

/**
 * An integration's connect form. Cancel returns to where it was chosen: Integrations itself while
 * the company has no connections, since that empty page lists the integrations; else the catalogue.
 */
const connectForm = Effect.fn("ConnectionPage.connectForm")(function* (
  viewer: RequireSession.Viewer["Service"],
  integration: Integration,
  submitted: Submitted = {},
  notice?: View.Notice
) {
  const page = pages[integration];
  const connections = yield* (yield* ConnectionStore.ConnectionStore).list(viewer.company.id);
  return {
    title: `Connect ${page.integration.label}`,
    body:
      page.renderConnect !== undefined
        ? page.renderConnect(submitted, notice)
        : View.renderConnect({
            integration: page.integration,
            intro: page.connectIntro ?? "",
            fields: page.connectFields?.(submitted, notice) ?? "",
            ...(page.walkthrough === undefined ? {} : { walkthrough: page.walkthrough }),
            notice,
            back: connections.length === 0 ? View.indexPath : View.cataloguePath
          }),
    status: notice?.status
  } satisfies Page;
});

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
  const known = about(connection);
  // A Pidgeon connection's sends today, against its budget; a count that can't be read says so.
  const sends =
    connection.integration === "pidgeon"
      ? PidgeonPage.sendsToday(
          connection,
          yield* store
            .sends(
              viewer.company.id,
              id,
              DateTime.formatIsoDateUtc(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
            )
            .pipe(Effect.orElseSucceed(() => undefined)),
          yield* ContractLimits.get("pidgeon.sends.daily")
        )
      : [];
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
      facts: [...known.facts, ...sends],
      ...(known.standing === undefined ? {} : { standing: known.standing }),
      ...(known.tag === undefined ? {} : { tag: known.tag }),
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
  const notice =
    typeof given === "string"
      ? result(page, given, connection)
      : given === undefined
        ? undefined
        : atField(page, given, []);
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

/** An action the connection's integration doesn't offer, such as moving a Pidgeon address. */
const notOffered: View.Notice = {
  message: "This connection doesn't offer that.",
  code: "not_found",
  status: 404
};

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
  const credentials =
    action === "rotate" || action === "retarget" || action === "access" ? page[action] : undefined;
  if ((action === "retarget" || action === "access") && credentials === undefined)
    return yield* connectionPage(viewer, id, notOffered);
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
        fields: credentials.fields(form.submitted ?? {}, form.notice),
        ...(credentials.submit === undefined ? {} : { submit: credentials.submit })
      },
      ...(page.consequences === undefined ? {} : { consequences: page.consequences }),
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
    case "index": {
      // A deleted connection's integration may have its own words for what deleting did.
      const named = query.get("integration");
      const page = named !== null && isIntegration(named) ? pages[named] : undefined;
      return yield* index(viewer, query, done && result(page, done));
    }
    case "catalogue":
      return yield* catalogue(viewer);
    case "connect":
      if (!isIntegration(target.integration))
        return yield* new ConnectionStore.ConnectionNotFound({
          companyId: viewer.company.id,
          lookup: { integration: target.integration, handle: "" }
        });
      if (!admin) return yield* index(viewer, new URLSearchParams(), forbidden);
      return yield* connectForm(viewer, target.integration);
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

/** The fields a credentials form can show a refusal at. */
const credentialFields: ReadonlyArray<View.Field> = [
  "credentials",
  "region",
  "project",
  "key",
  "address",
  "access"
];

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
      viewer,
      integration,
      submitted,
      atField(page, notice, ["handle", "description", ...credentialFields])
    );
  if (form === null) return yield* refused(unreadable);
  return yield* Effect.gen(function* () {
    const fields = yield* decodeConnect(form);
    const credentials = page.credentials(submitted);
    if (!Redacted.isRedacted(credentials)) return yield* refused(credentials);
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
      title: "Integrations",
      body: "",
      redirect: `${View.connectionPath(connection.id)}?result=connect`
    } satisfies Page;
  }).pipe(
    Effect.catch((error) => refused(error._tag === "SchemaError" ? incomplete : refusal(error)))
  );
});

const act = Effect.fn("ConnectionPage.act")(function* (
  viewer: RequireSession.Viewer["Service"],
  id: string,
  kind: Exclude<Change["kind"], "connect">
) {
  const form = yield* formBody;
  const submitted = submittedOf(form);
  /** The page the change came from, with its refusal and a typed description kept. */
  const refused = (notice: View.Notice) =>
    Effect.gen(function* () {
      switch (kind) {
        case "rotate":
        case "retarget":
        case "access": {
          const { page } = yield* connectionView(viewer, id);
          return yield* confirmationPage(viewer, id, kind, {
            submitted,
            notice: atField(page, notice, credentialFields)
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
        default: {
          const { page } = yield* connectionView(viewer, id);
          // A key that stopped working, or an Attio key that can write, is fixed by replacing it.
          const replace =
            notice.code === "pidgeon_key_stopped" ||
            notice.code === "attio_key_unknown" ||
            notice.code === "attio_write_scopes"
              ? { next: { href: View.connectionPath(id, "rotate"), label: "Replace key…" } }
              : {};
          return yield* connectionPage(viewer, id, { ...atField(page, notice, []), ...replace });
        }
      }
    });
  if (form === null) return yield* refused(unreadable);
  return yield* Effect.gen(function* () {
    const store = yield* ConnectionStore.ConnectionStore;
    const input = { companyId: viewer.company.id, userId: viewer.user.id, id };
    let integration: Integration | undefined;
    if (kind === "rotate" || kind === "retarget" || kind === "access") {
      const current = yield* store.get(viewer.company.id, id);
      // Replacing credentials keeps where they point; pointing elsewhere names it anew.
      const credentials = pages[current.integration].credentials(
        submitted,
        kind === "retarget" ? undefined : current
      );
      if (!Redacted.isRedacted(credentials)) return yield* refused(credentials);
      if (kind === "retarget") yield* store.retarget({ ...input, credentials });
      else yield* store.rotate({ ...input, credentials });
    } else if (kind === "description") {
      const fields = yield* decodeDescription(form);
      yield* store.describe({ ...input, description: fields.description });
    } else if (kind === "delete") {
      const deleted = yield* store.delete(input, yield* reporter(viewer, "connection.deleted"));
      integration = deleted.connection.integration;
      // The connection is gone, but a key it held is still live in Pidgeon: say which.
      if (deleted.keyLeft !== null)
        return yield* index(viewer, new URLSearchParams(), {
          title: "Connection deleted, but its key is still active in Pidgeon",
          message: `Patchy couldn't revoke it: ${deleted.keyLeft}. Revoke it in Pidgeon under Developers › API keys. The address and its mail stay in Pidgeon.`,
          code: "pidgeon_key_left",
          status: 200
        });
    } else {
      yield* store[kind](input);
    }
    const done = `?result=${kind}${kind === "delete" && integration !== undefined ? `&integration=${integration}` : ""}`;
    return {
      title: "Integrations",
      body: "",
      redirect: `${kind === "delete" ? View.indexPath : View.connectionPath(id)}${done}`
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
    if (change.kind === "connect") return yield* index(viewer, new URLSearchParams(), forbidden);
    return yield* connectionPage(viewer, change.id, forbidden);
  }
  if (change.kind !== "connect") return yield* act(viewer, change.id, change.kind);
  if (!isIntegration(change.integration))
    return yield* new ConnectionStore.ConnectionNotFound({
      companyId: viewer.company.id,
      lookup: { integration: change.integration, handle: "" }
    });
  return yield* connect(viewer, change.integration);
});

/** A fragment the connect page's script swaps in, never a page of its own. */
export interface Fragment {
  readonly status: number;
  readonly body: string;
}

/**
 * Pidgeon's Find addresses: the admin key, posted in the body, checked and used once to list the
 * addresses it reaches. The answer never holds the key; a refusal is shown under it.
 */
export const pidgeonAddresses = Effect.fn("ConnectionPage.pidgeonAddresses")(function* (
  viewer: RequireSession.Viewer["Service"]
) {
  const refused = (notice: View.Notice): Fragment => ({
    status: notice.status ?? 422,
    body: PidgeonPage.keyRefusalFragment(atField(pages.pidgeon, notice, []))
  });
  // Refused before the body is read: a member's key never reaches Pidgeon.
  if (viewer.role !== "admin") return refused(forbidden);
  const form = yield* formBody;
  const key = typeof form?.key === "string" ? form.key.trim() : "";
  if (key === "")
    return refused({
      message: "Paste a Pidgeon admin key: it starts with pgn_live_.",
      code: "invalid_credentials",
      status: 422
    });
  return yield* PidgeonKeys.addresses(Redacted.make(key)).pipe(
    Effect.map((found): Fragment => ({ status: 200, body: PidgeonPage.addressesFragment(found) })),
    Effect.catch((error) => Effect.succeed(refused(refusal(error))))
  );
});
