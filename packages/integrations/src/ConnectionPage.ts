import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { Analytics } from "@patchy/analytics";
import { Integration, capBody, integrations } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import { Teams, Users } from "@patchy/companies";
import { checkbox, choiceGroup, radio } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { RuntimeLog } from "@patchy/runtime";
import * as ConnectFrame from "./ConnectFrame.js";
import * as ConnectionStore from "./ConnectionStore.js";
import * as View from "./ConnectionsView.js";
import * as PatchVisibility from "./PatchVisibility.js";
import * as PostgresPage from "./postgres/Page.js";
import * as PostHogPage from "./posthog/Page.js";
import * as PidgeonKeys from "./pidgeon/Keys.js";
import * as PidgeonPage from "./pidgeon/Page.js";
import * as AttioPage from "./attio/Page.js";
import * as ImapPage from "./imap/Page.js";

/** A page to read. */
export type Target =
  | { readonly kind: "index" }
  | { readonly kind: "catalogue" }
  | { readonly kind: "connect"; readonly integration: string }
  | { readonly kind: "view"; readonly id: string; readonly tab: View.Tab }
  | { readonly kind: "confirm"; readonly id: string; readonly action: View.Confirmation };

/** A change an admin submits. */
export type Change =
  | { readonly kind: "connect"; readonly integration: string }
  | {
      readonly kind:
        "test" | "refresh" | "reconnect" | "block-guests" | "allow-guests" | View.Confirmation;
      readonly id: string;
    };

export interface Page {
  readonly title: string;
  readonly body: string;
  /** A dialog over the page, such as Replace key over a connection's Settings. */
  readonly overlay?: string;
  readonly status?: number;
  readonly redirect?: string;
}

type Submitted = Readonly<Record<string, string | undefined>>;

/** An integration's page for new credentials, a new destination or new access. */
interface CredentialsPage {
  readonly title: (name: string) => string;
  /** What submitting does, in words that may name where the connection reads. */
  readonly consequence: string | ((connection: ConnectionStore.Connection) => string);
  /** The submit button's label, where testing first isn't what it does. */
  readonly submit?: string;
  /** The fields; a refused submit keeps what the integration echoes, never secrets. */
  readonly fields: (submitted: Submitted, refusal?: View.Notice) => string;
  /** The fields it shows, where a refusal can sit; one about any other reads above its actions. */
  readonly shows: ReadonlyArray<View.Field>;
  /** What the form starts with, such as a Change access dialog's current access. */
  readonly initial?: (connection: ConnectionStore.Connection) => Submitted;
}

/** What the pages say about one integration; the layout around it is the same for every one. */
interface IntegrationPage {
  readonly integration: View.Integration;
  readonly offer: View.Offer;
  readonly actions: View.Actions;
  /** What its connect page asks for; the shared frame draws it. */
  readonly connect: ConnectFrame.ConnectSpec;
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
  /** What recent calls keep of its calls, and what they never keep, in its own words. */
  readonly logged: string;
  /** The integration's own words for a completed action, where they differ. */
  readonly results?: Partial<
    Record<Result, string | ((connection: ConnectionStore.Connection) => string)>
  >;
}
const pages: { readonly [K in Integration]: IntegrationPage } = {
  postgres: PostgresPage,
  posthog: PostHogPage,
  pidgeon: PidgeonPage,
  attio: AttioPage,
  imap: ImapPage
};
const offers = integrations.map((integration) => pages[integration].offer);
/**
 * A connection's integration as the pages name and mark it: wearing the logo of the provider the
 * connection reaches where Patchy knows it, such as Gmail's for a mailbox on Gmail's server.
 */
export const integrationOf = (connection: ConnectionStore.Connection): View.Integration =>
  connection.integration === "imap"
    ? { ...ImapPage.integration, mark: ImapPage.mark(connection) }
    : pages[connection.integration].integration;
const isIntegration = Schema.is(Integration);

/** What a connection's page and row say about it, in its integration's words. */
interface About {
  readonly source: string;
  readonly facts: ReadonlyArray<readonly [string, string]>;
  readonly credential: View.Connection["credential"];
  readonly target?: View.Connection["target"];
  readonly access?: string;
  readonly attention?: View.Attention | undefined;
  readonly tag?: string | undefined;
}

/**
 * Where a connection reads, its facts and credentials, why it needs an admin and the word beside
 * its name, in its integration's words. An Attio key a check found writable and an IMAP login a
 * server refused name whose check or login it was, from `people`.
 */
const about = (
  connection: ConnectionStore.Connection,
  people: ReadonlyMap<string, string>,
  now: number
): About => {
  switch (connection.integration) {
    case "postgres":
      return {
        source: PostgresPage.source(connection),
        facts: PostgresPage.facts(connection),
        credential: PostgresPage.credential(connection),
        target: PostgresPage.target(connection)
      };
    case "posthog":
      return {
        source: PostHogPage.source(connection),
        facts: PostHogPage.facts(connection),
        credential: PostHogPage.credential(connection),
        target: PostHogPage.target(connection)
      };
    case "attio":
      return {
        source: AttioPage.source(connection),
        facts: AttioPage.facts(connection),
        credential: AttioPage.credential(connection),
        attention: AttioPage.attention(connection, people, now)
      };
    case "imap":
      return {
        source: ImapPage.source(connection),
        facts: ImapPage.facts(connection),
        credential: ImapPage.credential(connection),
        attention: ImapPage.attention(connection, people, now)
      };
    case "pidgeon":
      return {
        source: PidgeonPage.source(connection),
        facts: PidgeonPage.facts(connection),
        credential: PidgeonPage.credential(connection),
        access: PidgeonPage.allowed(connection),
        attention: PidgeonPage.attention(connection),
        tag: PidgeonPage.tag(connection)
      };
  }
};
/** What a snapshot lets patches read, in its integration's words. */
const readsOf = (metadata: ConnectionStore.Metadata) =>
  metadata.integration === "postgres"
    ? PostgresPage.reads(metadata.snapshot)
    : metadata.integration === "posthog"
      ? PostHogPage.reads(metadata.snapshot)
      : metadata.integration === "attio"
        ? AttioPage.reads(metadata.snapshot)
        : metadata.integration === "imap"
          ? ImapPage.reads(metadata.snapshot)
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
  // A refusal with somewhere else to go stays above the form, where its way out is a button.
  if (titled.next !== undefined) return { ...titled, field: undefined };
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
  disconnect: "Paused. Patches can't read it until an admin resumes it.",
  reconnect: "Tested and resumed. Its revision is unchanged.",
  description: "Description updated.",
  audience: "Audience changed.",
  "block-guests": "Guests blocked. Patches that use this connection turn their guests away.",
  "allow-guests": "Guests allowed. Patches that use this connection admit their guests again.",
  delete: "Disconnected. Its credentials are gone and its name is free; its snapshots are kept."
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
    view: view === "attention" || view === "paused" || view === "unused" ? view : "all"
  };
};

const row = (
  connection: ConnectionStore.Connection,
  usage: ReadonlyMap<string, ConnectionStore.Usage>,
  people: ReadonlyMap<string, string>,
  now: number
): View.Row => {
  const known = about(connection, people, now);
  return {
    id: connection.id,
    integration: integrationOf(connection),
    handle: connection.handle,
    description: connection.description,
    source: known.source,
    status: connection.status,
    ...(known.tag === undefined ? {} : { tag: known.tag }),
    ...(known.attention === undefined ? {} : { attention: known.attention }),
    ...(usage.get(connection.id) ?? ConnectionStore.unused)
  };
};

/** The word for replacing an integration's credentials, by its key: "Replace key". */
const rotateLabel = (integration: string) =>
  isIntegration(integration) ? pages[integration].actions.rotate : "Replace key";

/**
 * The company's people by id, and its active admins' names for the line that tells members whom
 * to ask. A directory that can't be read leaves the pages and their actions working, without names.
 */
const directory = Effect.fn("ConnectionPage.directory")(function* (
  viewer: RequireSession.Viewer["Service"]
) {
  return yield* (yield* Users.Users).list(viewer.company.id).pipe(
    Effect.map((users) => ({
      people: new Map(users.map((user) => [user.id, user.name])) as ReadonlyMap<string, string>,
      admins: users
        .filter((user) => user.role === "admin" && user.deactivatedAt === null)
        .map((user) => user.name)
        .sort((a, b) => a.localeCompare(b)) as ReadonlyArray<string>
    })),
    Effect.catchTags({ SqlError: () => Effect.succeed(null) })
  );
});

const index = Effect.fn("ConnectionPage.index")(function* (
  viewer: RequireSession.Viewer["Service"],
  query: URLSearchParams,
  notice?: View.Notice
) {
  const store = yield* ConnectionStore.ConnectionStore;
  const admin = viewer.role === "admin";
  // Admins see every connection and every patch using it; members, what they can build with and
  // the patches they can open.
  const reader = admin ? undefined : viewer.user.id;
  const connections = yield* store.list(viewer.company.id, reader);
  const usage = yield* store.usage(viewer.company.id, reader);
  const now = yield* Clock.currentTimeMillis;
  // Members can see connection status, but must never read the call log. An admin's last call is
  // the newest the Calls tab would show them.
  const lastCalls: View.LastCalls | undefined = admin
    ? yield* Effect.gen(function* () {
        const latest = yield* (yield* RuntimeLog.RuntimeLog).latest({
          companyId: viewer.company.id,
          connectionIds: connections.map((connection) => connection.id),
          patchIds: yield* (yield* PatchVisibility.PatchVisibility).openableIds(
            viewer.company.id,
            viewer.user.id
          )
        });
        return new Map([...latest].map(([id, at]) => [id, at.toISOString()] as const));
      }).pipe(Effect.catchTags({ SqlError: () => Effect.succeed("unavailable" as const) }))
    : undefined;
  const known = yield* directory(viewer);
  const people = known?.people ?? new Map<string, string>();
  return {
    title: "Integrations",
    ...View.renderIndex({
      admin,
      admins: known?.admins ?? [],
      rows: connections.map((connection) => row(connection, usage, people, now)),
      lastCalls,
      offers,
      rotate: rotateLabel,
      filters: filters(query),
      now,
      notice
    }),
    status: notice?.status
  } satisfies Page;
});

const catalogue = Effect.fn("ConnectionPage.catalogue")(function* (
  viewer: RequireSession.Viewer["Service"]
) {
  // Members count only the connections they can build with, as on Integrations itself.
  const reader = viewer.role === "admin" ? undefined : viewer.user.id;
  const connections = yield* (yield* ConnectionStore.ConnectionStore).list(
    viewer.company.id,
    reader
  );
  const now = yield* Clock.currentTimeMillis;
  const admins = viewer.role === "admin" ? [] : ((yield* directory(viewer))?.admins ?? []);
  return {
    title: "Connect an integration",
    ...View.renderCatalogue({
      admin: viewer.role === "admin",
      admins,
      rows: connections.map((connection) => row(connection, new Map(), new Map(), now)),
      offers
    })
  } satisfies Page;
});

/**
 * An integration's connect form. Cancel returns to where it was chosen: Integrations itself while
 * the company has no connections, since that empty page lists the integrations; else the catalogue.
 */
/**
 * A refused submit's attempt, or a fresh one: a form keeps its attempt across a refused submit,
 * so a retry repeats it.
 */
const withAttempt = (submitted: Submitted) =>
  PidgeonKeys.isAttempt(submitted.attempt ?? "")
    ? Effect.succeed(submitted)
    : Effect.map(PidgeonKeys.newAttempt, (attempt): Submitted => ({ ...submitted, attempt }));

const connectForm = Effect.fn("ConnectionPage.connectForm")(function* (
  viewer: RequireSession.Viewer["Service"],
  integration: Integration,
  given: Submitted = {},
  notice?: View.Notice
) {
  const page = pages[integration];
  const submitted = yield* withAttempt(given);
  const connections = yield* (yield* ConnectionStore.ConnectionStore).list(viewer.company.id);
  return {
    title: `Connect ${page.integration.label}`,
    ...ConnectFrame.render({
      integration: page.integration,
      spec: page.connect,
      submitted,
      ...(notice === undefined ? {} : { notice }),
      back: connections.length === 0 ? View.indexPath : View.cataloguePath
    }),
    status: notice?.status
  } satisfies Page;
});

/**
 * One connection in the pages' words: its integration's facts, credentials and usage, who added
 * it, why it needs an admin, and the company's admins for the line that tells members whom to ask.
 */
const connectionView = Effect.fn("ConnectionPage.connectionView")(function* (
  viewer: RequireSession.Viewer["Service"],
  id: string
) {
  const store = yield* ConnectionStore.ConnectionStore;
  const connection = yield* store.get(viewer.company.id, id);
  // A member reads only the connections they can build with, and the patches they can open.
  const reader = viewer.role === "admin" ? undefined : viewer.user.id;
  if (reader !== undefined && !(yield* store.canUse(viewer.company.id, id, reader)))
    return yield* new ConnectionStore.ConnectionNotFound({
      companyId: viewer.company.id,
      lookup: { id }
    });
  const page = pages[connection.integration];
  const usage = (yield* store.usage(viewer.company.id, reader)).get(id) ?? ConnectionStore.unused;
  const audience = yield* store.audience(viewer.company.id, id);
  const teamNames = new Map((yield* teamsOf(viewer)).map((team) => [team.id, team.name]));
  const builders =
    audience.kind === "company"
      ? `People at ${viewer.company.name}`
      : audience.teamIds.flatMap((teamId) => teamNames.get(teamId) ?? []).join(", ");
  // Deactivated people keep their names: they still added connections and made calls. A
  // directory that cannot be read leaves the page and its actions working, without names.
  const known = yield* directory(viewer);
  const people = known?.people ?? new Map<string, string>();
  const now = yield* Clock.currentTimeMillis;
  const told = about(connection, people, now);
  // A Pidgeon connection's sends today, against its budget; a count that can't be read says so.
  const sends =
    connection.integration === "pidgeon"
      ? PidgeonPage.sendsToday(
          connection,
          yield* store
            .sends(viewer.company.id, id, DateTime.formatIsoDateUtc(DateTime.makeUnsafe(now)))
            .pipe(Effect.orElseSucceed(() => undefined)),
          yield* ContractLimits.get("pidgeon.sends.daily")
        )
      : [];
  return {
    connection,
    page,
    people,
    admins: known?.admins ?? [],
    view: {
      id: connection.id,
      integration: integrationOf(connection),
      handle: connection.handle,
      description: connection.description,
      status: connection.status,
      blockGuests: connection.blockGuests,
      builders,
      testedAt: connection.lastTestedAt,
      addedBy:
        known === null
          ? "Unknown"
          : (people.get(connection.createdBy) ?? "Someone no longer in the company"),
      facts: [...told.facts, ...sends],
      credential: told.credential,
      ...(told.target === undefined ? {} : { target: told.target }),
      ...(told.access === undefined ? {} : { access: told.access }),
      ...(told.attention === undefined ? {} : { attention: told.attention }),
      ...(told.tag === undefined ? {} : { tag: told.tag }),
      ...usage
    } satisfies View.Connection
  };
});
type Loaded = Effect.Success<ReturnType<typeof connectionView>>;

/** What a connection's page carries besides its tab and notice. */
interface Extra {
  /** A description a refused save typed, kept in Settings' field. */
  readonly description?: string | undefined;
  /** Settings opens with the description in focus, as its old Edit description address asks. */
  readonly focusDescription?: boolean;
  /** A dialog over Settings, and the status its refusal answers with. */
  readonly overlay?: string;
  readonly status?: number | undefined;
  /** The connection as `connectionView` already read it, so a dialog's page reads it once. */
  readonly loaded?: Loaded;
}

/**
 * A connection's page on `tab`, with a completed action's receipt or a refusal. Overview reads
 * what patches can read; Calls, for admins, reads the call log and its names.
 */
const connectionPage = Effect.fn("ConnectionPage.connectionPage")(function* (
  viewer: RequireSession.Viewer["Service"],
  id: string,
  tab: View.Tab,
  given?: View.Notice | Result,
  extra: Extra = {}
) {
  const store = yield* ConnectionStore.ConnectionStore;
  const admin = viewer.role === "admin";
  const { connection, page, people, admins, view } =
    extra.loaded ?? (yield* connectionView(viewer, id));
  const notice =
    typeof given === "string"
      ? result(page, given, connection)
      : given === undefined
        ? undefined
        : atField(page, given, tab === "settings" ? ["description"] : []);
  const reads =
    tab === "overview"
      ? yield* store.snapshot(viewer.company.id, id, connection.metadataRevision).pipe(
          Effect.map((metadata) => ({
            ...readsOf(metadata),
            revision: connection.metadataRevision,
            foundAt: connection.lastDiscoveredAt
          })),
          Effect.catchTags({ ConnectionNotFound: () => Effect.succeed(null) })
        )
      : null;
  // Members can see safe connection metadata, but must never read the call log. A patch's calls
  // are its content, shown only to an admin who can open it now; calls from no patch, such as the
  // admins' own and `patchy dev`'s, stay. A log or its names that cannot be read leave
  // administration working.
  const calls =
    admin && tab === "calls"
      ? yield* Effect.gen(function* () {
          const list = yield* (yield* RuntimeLog.RuntimeLog).recent({
            companyId: viewer.company.id,
            connectionId: id,
            limit: View.RECENT_CALLS,
            patchIds: yield* (yield* PatchVisibility.PatchVisibility).openableIds(
              viewer.company.id,
              viewer.user.id
            )
          });
          const versions = yield* store.versions(
            viewer.company.id,
            list.flatMap((call) => (call.versionId === null ? [] : [call.versionId]))
          );
          // A patch's guests call as themselves, from outside the company's directory.
          const guests = yield* (yield* Users.Users).names(
            list.flatMap((call) =>
              call.effectivePrincipal === "patch" || people.has(call.effectivePrincipal)
                ? []
                : [call.effectivePrincipal]
            )
          );
          return {
            list,
            names: { people: new Map([...people, ...guests]), versions },
            logged: page.logged
          };
        }).pipe(
          Effect.catch(() =>
            Effect.succeed({
              list: "unavailable" as const,
              names: { people, versions: new Map() },
              logged: page.logged
            })
          )
        )
      : undefined;
  return {
    title: `${connection.integration}/${connection.handle}`,
    ...View.renderConnection({
      connection: view,
      tab,
      reads,
      actions: page.actions,
      calls,
      admin,
      admins,
      now: yield* Clock.currentTimeMillis,
      notice,
      ...(extra.description === undefined ? {} : { description: extra.description }),
      ...(extra.focusDescription === undefined ? {} : { focusDescription: extra.focusDescription })
    }),
    ...(extra.overlay === undefined ? {} : { overlay: extra.overlay }),
    status: extra.status ?? notice?.status
  } satisfies Page;
});

/** An action the connection's integration doesn't offer, such as moving a Pidgeon address. */
const notOffered: View.Notice = {
  message: "This connection doesn't offer that.",
  code: "not_found",
  status: 404
};

/** Why a connection that something declares isn't disconnected: which patches, and what to do. */
const inUse = (usage: ConnectionStore.Usage): View.Notice => ({
  message: View.declaredBy(usage),
  code: "connection_in_use",
  status: 409
});

/**
 * A change that needs its own form or a second look, as a dialog over the connection's Settings:
 * Replace key, Change project or Point elsewhere, Change access, Who can build with it, Pause and
 * Disconnect. Edit description's old address opens Settings with its field in focus.
 */
const confirmationPage = Effect.fn("ConnectionPage.confirmationPage")(function* (
  viewer: RequireSession.Viewer["Service"],
  id: string,
  action: View.Confirmation,
  form: {
    readonly description?: string | undefined;
    readonly submitted?: Submitted;
    readonly notice?: View.Notice;
    /** The audience a refused or warned save asked for, drawn again as it was. */
    readonly audience?: AudienceChoice;
    /** The live patches that save would cut off, to submit again past. */
    readonly cutOff?: ReadonlyArray<string>;
  } = {}
) {
  if (action === "description")
    return yield* connectionPage(viewer, id, "settings", form.notice, {
      description: form.description,
      focusDescription: true
    });
  const loaded = yield* connectionView(viewer, id);
  const { connection, page, view } = loaded;
  // Disconnect is offered only while nothing declares the connection; a stale link says why.
  if (action === "delete" && view.declared)
    return yield* connectionPage(viewer, id, "settings", inUse(view), { loaded });
  if (action === "audience") {
    const teams = yield* teamsOf(viewer);
    const chosen =
      form.audience ??
      (yield* (yield* ConnectionStore.ConnectionStore)
        .audience(viewer.company.id, id)
        .pipe(
          Effect.map((current): AudienceChoice =>
            current.kind === "company"
              ? { kind: "company", teamIds: [] }
              : { kind: "teams", teamIds: current.teamIds }
          )
        ));
    const error = form.notice?.code === "invalid_connection_audience" ? form.notice : undefined;
    const overlay = View.renderDialog({
      connection: view,
      action,
      actions: page.actions,
      form: {
        title: "Who can build with it",
        fields: `${choiceGroup({
          id: "connection-audience",
          legend: "Who can build with it",
          hideLegend: true,
          ...(error === undefined ? {} : { error: error.message }),
          choices: (aria) =>
            `${radio({ name: "audience", value: "company", label: `People at ${viewer.company.name}`, checked: chosen.kind === "company", aria })}${radio({ name: "audience", value: "teams", label: "Selected teams", checked: chosen.kind === "teams", aria })}`
        })}${
          teams.length === 0
            ? ""
            : choiceGroup({
                id: "connection-teams",
                legend: "Teams",
                choices: teams
                  .map((team) =>
                    checkbox({
                      name: "teamIds",
                      value: team.id,
                      label: team.name,
                      checked: chosen.teamIds.includes(team.id)
                    })
                  )
                  .join("")
              })
        }${form.cutOff === undefined ? "" : '<input type="hidden" name="acknowledged" value="1">'}`,
        submit: form.cutOff === undefined ? "Save" : "Save anyway",
        ...(form.cutOff === undefined ? {} : { warning: View.cutOffWarning(form.cutOff) })
      },
      ...(form.notice === undefined || error !== undefined ? {} : { notice: form.notice })
    });
    return yield* connectionPage(viewer, id, "settings", undefined, {
      overlay,
      loaded,
      status: form.notice?.status
    });
  }
  const credentials =
    action === "rotate" || action === "retarget" || action === "access" ? page[action] : undefined;
  if ((action === "retarget" || action === "access") && credentials === undefined)
    return yield* connectionPage(viewer, id, "settings", notOffered, { loaded });
  const name = `${view.integration.key}/${view.handle}`;
  const notice =
    form.notice === undefined ? undefined : atField(page, form.notice, credentials?.shows ?? []);
  const overlay = View.renderDialog({
    connection: view,
    action,
    actions: page.actions,
    ...(credentials === undefined
      ? {}
      : {
          form: {
            title: credentials.title(name),
            consequence:
              typeof credentials.consequence === "string"
                ? credentials.consequence
                : credentials.consequence(connection),
            fields: credentials.fields(
              yield* withAttempt(form.submitted ?? credentials.initial?.(connection) ?? {}),
              notice
            ),
            ...(credentials.submit === undefined ? {} : { submit: credentials.submit })
          }
        }),
    ...(page.consequences === undefined ? {} : { consequences: page.consequences }),
    ...(notice === undefined ? {} : { notice })
  });
  return yield* connectionPage(viewer, id, "settings", undefined, {
    overlay,
    status: notice?.status,
    loaded
  });
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
      // A disconnected connection's integration may have its own words for what that did.
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
      // Members read Overview; Calls and Settings refuse them on it.
      if (!admin && target.tab !== "overview")
        return yield* connectionPage(viewer, target.id, "overview", forbidden);
      return yield* connectionPage(viewer, target.id, target.tab, done);
    case "confirm":
      if (!admin) return yield* connectionPage(viewer, target.id, "overview", forbidden);
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

/**
 * Every form here. The longest is Postgres's: a connection string of up to 16,384 characters, up
 * to 9 bytes each once percent-encoded (147,456 bytes), beside a handle and a description.
 */
const MAX_FORM_BYTES = 262_144;

/**
 * The submitted form, a repeated field as its values in order, or null when it cannot be read or
 * is larger than `MAX_FORM_BYTES`.
 */
const formBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.urlParamsBody.pipe(
    capBody(MAX_FORM_BYTES),
    Effect.map((params): Readonly<Record<string, string | ReadonlyArray<string>>> => {
      const fields = new Map<string, string | ReadonlyArray<string>>();
      for (const [key, value] of params) {
        if (typeof value !== "string") continue;
        const had = fields.get(key);
        fields.set(
          key,
          had === undefined ? value : [...(typeof had === "string" ? [had] : had), value]
        );
      }
      return Object.fromEntries(fields);
    }),
    Effect.catchTags({ HttpServerError: () => Effect.succeed(null) })
  );
});

/** What an audience form asked for, kept as it was so a refusal or warning can draw it again. */
interface AudienceChoice {
  readonly kind: string | undefined;
  readonly teamIds: ReadonlyArray<string>;
}
const audienceChoice = (
  form: Readonly<Record<string, string | ReadonlyArray<string>>> | null
): AudienceChoice => {
  const teamIds = form?.teamIds ?? [];
  return {
    kind: typeof form?.audience === "string" ? form.audience : undefined,
    teamIds: typeof teamIds === "string" ? [teamIds] : teamIds
  };
};

/** The company's teams, for the audience form and the page's words; none to someone gone. */
const teamsOf = Effect.fn("ConnectionPage.teamsOf")(function* (
  viewer: RequireSession.Viewer["Service"]
) {
  return yield* (yield* Teams.Teams)
    .list({ companyId: viewer.company.id, actorId: viewer.user.id })
    .pipe(Effect.catchTags({ RoleForbidden: () => Effect.succeed([]) }));
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
      atField(page, notice, ConnectFrame.shows(page.connect))
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
  const chosen = audienceChoice(form);
  /** The page the change came from, with its refusal and a typed description kept. */
  const refused = (notice: View.Notice) =>
    Effect.gen(function* () {
      switch (kind) {
        case "rotate":
        case "retarget":
        case "access":
          return yield* confirmationPage(viewer, id, kind, { submitted, notice });
        case "audience":
          return yield* confirmationPage(viewer, id, kind, { audience: chosen, notice });
        case "description":
          return yield* connectionPage(viewer, id, "settings", notice, {
            description: text(form?.description)
          });
        // A failed Pause or Disconnect draws its dialog again, to try again from; one something
        // declares can't be disconnected at all, so Settings says which.
        case "delete": {
          if (notice.code !== "connection_in_use")
            return yield* confirmationPage(viewer, id, kind, { notice });
          const loaded = yield* connectionView(viewer, id);
          return yield* connectionPage(viewer, id, "settings", inUse(loaded.view), { loaded });
        }
        case "disconnect":
          return yield* confirmationPage(viewer, id, kind, { notice });
        case "block-guests":
        case "allow-guests":
          return yield* connectionPage(viewer, id, "settings", notice);
        default: {
          // A key that stopped working, an Attio key that can write, or a password a mail server
          // refused, is fixed by replacing it.
          const replace =
            notice.code === "pidgeon_key_stopped" ||
            notice.code === "attio_key_unknown" ||
            notice.code === "attio_write_scopes"
              ? { next: { href: View.connectionPath(id, "rotate"), label: "Replace key…" } }
              : notice.code === "auth_failed"
                ? { next: { href: View.connectionPath(id, "rotate"), label: "Replace password…" } }
                : {};
          return yield* connectionPage(viewer, id, "overview", { ...notice, ...replace });
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
    } else if (kind === "audience") {
      const audience: ConnectionStore.Audience | undefined =
        chosen.kind === "company"
          ? { kind: "company" }
          : chosen.kind === "teams" && chosen.teamIds.length > 0
            ? { kind: "teams", teamIds: chosen.teamIds }
            : undefined;
      if (audience === undefined) return yield* new ConnectionStore.InvalidConnectionAudience({});
      // Narrowing that cuts off live patches says which, as Pause does, and saves once asked again.
      const cutOff = yield* store
        .setAudience({ ...input, audience, acknowledged: form.acknowledged === "1" })
        .pipe(
          Effect.as(undefined),
          Effect.catchTags({ ConnectionCutsOff: (refused) => Effect.succeed(refused.patches) })
        );
      if (cutOff !== undefined)
        return yield* confirmationPage(viewer, id, kind, { audience: chosen, cutOff });
    } else if (kind === "description") {
      const fields = yield* decodeDescription(form);
      yield* store.describe({ ...input, description: fields.description });
    } else if (kind === "block-guests" || kind === "allow-guests") {
      yield* store.blockGuests({ ...input, block: kind === "block-guests" });
    } else if (kind === "delete") {
      const deleted = yield* store.delete(input, yield* reporter(viewer, "connection.deleted"));
      integration = deleted.connection.integration;
      // The connection is gone, but a key it held is still live in Pidgeon: say which.
      if (deleted.keyLeft !== null)
        return yield* index(viewer, new URLSearchParams(), {
          title: "Disconnected, but its key is still active in Pidgeon",
          message: `Patchy couldn't revoke it: ${deleted.keyLeft}. Revoke it in Pidgeon under Developers › API keys. The address and its mail stay in Pidgeon.`,
          code: "pidgeon_key_left",
          status: 200
        });
    } else {
      yield* store[kind](input);
    }
    const done = `?result=${kind}${kind === "delete" && integration !== undefined ? `&integration=${integration}` : ""}`;
    // A change made in Settings lands back on Settings; Test, Refresh and Resume on Overview.
    const settled =
      kind === "delete"
        ? View.indexPath
        : kind === "test" || kind === "refresh" || kind === "reconnect"
          ? View.connectionPath(id)
          : View.connectionPath(id, "settings");
    return { title: "Integrations", body: "", redirect: `${settled}${done}` } satisfies Page;
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
            : error._tag === "SqlError"
              ? { message: "Company service unavailable.", code: "source_unavailable", status: 503 }
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
    return yield* connectionPage(viewer, change.id, "overview", forbidden);
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
