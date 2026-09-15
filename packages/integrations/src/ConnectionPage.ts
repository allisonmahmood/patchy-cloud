import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { pageResponse, RequireSession } from "@patchy/auth";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import * as ConnectionStore from "./ConnectionStore.js";

export type Action =
  | { readonly kind: "list" }
  | { readonly kind: "connect" }
  | { readonly kind: "view"; readonly id: string }
  | {
      readonly kind:
        | "test"
        | "rotate"
        | "retarget"
        | "refresh"
        | "disconnect"
        | "reconnect"
        | "description"
        | "delete";
      readonly id: string;
    };

export type Page = Parameters<typeof pageResponse>[0] & {
  readonly redirect?: string;
};

interface Notice {
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
}

const results = {
  connect: "Database connected and schema discovered.",
  test: "Connection tested successfully.",
  rotate: "Credentials rotated. The connection keeps its identity and schema revision.",
  retarget:
    "Connection retargeted and schema discovered. Existing patches keep their pinned schema.",
  refresh:
    "Schema refreshed. Existing patches keep their pinned schema; regenerate before publishing against the new schema.",
  disconnect: "Connection disconnected. Patches cannot use it until an admin reconnects it.",
  reconnect: "Connection tested and reconnected. Its schema revision is unchanged.",
  description: "Description updated.",
  delete: "Connection deleted. Its schema snapshots have been kept."
} as const;
const isResult = Schema.is(Schema.Literals(Object.keys(results) as Array<keyof typeof results>));

export const styles = `
    .connection-status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .connection-meta time { white-space: nowrap; }
    .connection-sql { max-height: 18rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    .connection-calls summary { margin: 12px 0; }
`;

const pathFor = (id: string) => `/company/connections/${encodeURIComponent(id)}`;
/** A refusal is an alert on amber; a completed action is a status on green. */
const noticeHtml = (notice?: Notice) =>
  notice
    ? `<div class="note ${notice.status ? "note-warn" : "note-ok"}" role="${notice.status ? "alert" : "status"}">${escapeHtml(notice.message)}${notice.code ? `<br><code>${escapeHtml(notice.code)}</code>` : ""}</div>`
    : "";
/** Stored timestamps are ISO in UTC; readers get the minute, the machine keeps the instant. */
const time = (value: string | null) =>
  value === null
    ? "Never"
    : `<time datetime="${escapeAttribute(value)}">${escapeHtml(`${value.slice(0, 10)} ${value.slice(11, 16)} UTC`)}</time>`;
const statusPill = (connection: ConnectionStore.Connection) =>
  connection.status === "connected"
    ? '<span class="pill pill-done">Connected</span>'
    : '<span class="pill">Disconnected</span>';
const description = (connection: ConnectionStore.Connection) =>
  `<p>${escapeHtml(connection.description || "No description.")}</p>`;
const actionForm = (path: string, label: string, destructive = false) =>
  `<form method="post" action="${escapeAttribute(path)}"><button class="btn${destructive ? " btn-danger" : ""}" type="submit">${escapeHtml(label)}</button></form>`;
/** The access note sits with the credentials field: it is about the role inside that string. */
const promise = `<div class="note"><strong class="note-title">Company-wide access</strong><p>Every member can query this database through any patch that declares it, as the role you supply.</p><p>Patchy sends constrained reads through the role you supplied, but a SELECT can still invoke functions and extensions, so this is not a promise that arbitrary SQL is harmless. Supply a dedicated, least-privileged role.</p></div>`;
const credentialsField = (id: string, note = "") =>
  `${note}<label class="field-label" for="${id}">Connection string</label><input class="field" id="${id}" type="password" name="credentials" required autocomplete="new-password" spellcheck="false" aria-describedby="${id}-hint"><p id="${id}-hint" class="field-hint">A Postgres connection string with a password and sslmode=verify-full. Only host, port, database, user, password and sslmode are accepted. Credentials are encrypted and never shown again.</p>`;
const connectForm = `<section class="section" aria-labelledby="connection-connect"><h2 class="section-heading" id="connection-connect">Connect Postgres</h2><p>Patchy tests the connection and discovers its schema before saving anything. The database must be reachable from the internet over TLS with a verified certificate and hostname; superusers and roles with CREATEDB or CREATEROLE are refused.</p><form class="connection-form" method="post" action="/company/connections/connect"><label class="field-label" for="connection-handle">Handle</label><input class="field" id="connection-handle" name="handle" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="connection-handle-hint"><p id="connection-handle-hint" class="field-hint">3–32 lowercase letters, digits or hyphens, with no leading or trailing hyphen. Patches declare this connection by its handle.</p><label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" aria-describedby="connection-description-hint"><p id="connection-description-hint" class="field-hint">One line explaining what this database is for.</p>${credentialsField("connection-credentials", promise)}<div class="actions"><button class="btn btn-primary" type="submit">Test and connect</button></div></form></section>`;

const recentCalls = (calls: ReadonlyArray<RuntimeLog.Call>) =>
  `<section class="section" aria-labelledby="connection-calls"><h2 class="section-heading" id="connection-calls">Recent calls</h2><p class="supporting-text">Visible only to company admins. Query text is limited to its first 8 KiB; parameters and returned rows are never logged. Pending calls past their deadline have an unknown outcome.</p>${
    calls.length === 0
      ? "<p>No calls yet.</p>"
      : `<ol class="list connection-calls">${calls
          .map((call) => {
            const outcome =
              call.outcome === "failure"
                ? "Failed"
                : call.outcome === "success"
                  ? "Succeeded"
                  : call.outcome === "unknown"
                    ? "Unknown"
                    : "Pending";
            return `<li class="list-row"><p class="connection-status"><strong>${escapeHtml(call.op)}</strong><span class="pill${call.outcome === "success" ? " pill-done" : ""}">${outcome}</span>${call.outcomeCode === null ? "" : `<code>${escapeHtml(call.outcomeCode)}</code>`}</p><p class="supporting-text connection-meta">${time(call.at.toISOString())} · ${call.durationMs === null ? "Duration unknown" : `${call.durationMs} ms`} · ${call.rowCount === null ? "Row count unknown" : `${call.rowCount} rows`}</p><dl class="facts"><dt>Patch / version</dt><dd>${call.patchId === null ? "Connection administration" : `<code>${escapeHtml(call.patchId)}</code> / <code>${escapeHtml(call.versionId ?? "Unknown")}</code>`}</dd><dt>User</dt><dd><code>${escapeHtml(call.userId)}</code></dd><dt>Credential kind</dt><dd>${escapeHtml(call.credentialKind)}</dd>${call.resource === null ? "" : `<dt>Resource</dt><dd><code>${escapeHtml(call.resource)}</code></dd>`}<dt>Correlation ID</dt><dd><code>${escapeHtml(call.correlationId)}</code></dd></dl>${call.op === "postgres.query" && call.sql !== null ? `<details><summary>SQL query</summary><pre class="connection-sql"><code>${escapeHtml(call.sql)}</code></pre></details>` : ""}</li>`;
          })
          .join("")}</ol>`
  }</section>`;

const render = Effect.fn("ConnectionPage.render")(function* (
  viewer: RequireSession.Viewer["Service"],
  id: string | undefined,
  notice?: Notice
): Effect.fn.Return<
  Page,
  ConnectionStore.ConnectionError,
  ConnectionStore.ConnectionStore | RuntimeLog.RuntimeLog
> {
  const store = yield* ConnectionStore.ConnectionStore;
  const admin = viewer.role === "admin";
  const company = `<a href="/company">${escapeHtml(viewer.company.name)}</a>`;
  if (id === undefined) {
    const connections = yield* store.list(viewer.company.id);
    const rows = connections.map(
      (connection) =>
        `<li class="list-row"><p class="connection-status"><a href="${escapeAttribute(pathFor(connection.id))}"><strong>${escapeHtml(connection.handle)}</strong></a>${statusPill(connection)}</p>${description(connection)}<p class="supporting-text connection-meta">Postgres · Last tested ${time(connection.lastTestedAt)} · Schema discovered ${time(connection.lastDiscoveredAt)}</p></li>`
    );
    return {
      title: "Connections",
      body: `<p>${company} · Connections</p>${noticeHtml(notice)}<section class="section" aria-labelledby="connection-list"><h2 class="section-heading" id="connection-list">Company connections</h2>${connections.length ? `<ul class="list">${rows.join("")}</ul>` : "<p>No databases connected yet.</p>"}</section>${admin ? connectForm : '<p class="supporting-text">An admin can connect and manage databases for your company.</p>'}`,
      app: { viewer, section: "connections" },
      status: notice?.status
    };
  }
  const connection = yield* store.get(viewer.company.id, id);
  const path = pathFor(connection.id);
  const display = connection.display;
  // Members can see safe connection metadata, but must never fetch the call log.
  const calls = admin
    ? yield* Effect.gen(function* () {
        const log = yield* RuntimeLog.RuntimeLog;
        return recentCalls(
          yield* log.recent({ companyId: viewer.company.id, connectionId: connection.id })
        );
      }).pipe(
        Effect.catchTags({
          SqlError: () =>
            Effect.succeed(
              '<section class="section" aria-labelledby="connection-calls"><h2 class="section-heading" id="connection-calls">Recent calls</h2><div class="note note-warn" role="alert">Recent calls could not be loaded. Reload the page to try again.</div></section>'
            )
        })
      )
    : "";
  const management = admin
    ? `<section class="section" aria-labelledby="connection-access"><h2 class="section-heading" id="connection-access">Access</h2><p>${connection.status === "connected" ? "Disconnect to revoke this connection for every patch. Reconnecting tests the stored credentials before restoring access." : "This connection is disconnected. Reconnecting tests the stored credentials before restoring access, without changing the schema revision."}</p><div class="actions">${actionForm(`${path}/test`, "Test connection")}${connection.status === "connected" ? actionForm(`${path}/disconnect`, "Disconnect", true) : actionForm(`${path}/reconnect`, "Reconnect")}</div></section><section class="section" aria-labelledby="connection-schema"><h2 class="section-heading" id="connection-schema">Schema</h2><p>Refresh discovers a new immutable schema revision. If discovery fails, the previous revision stays available. Existing patches keep their pinned schema.</p>${connection.status === "connected" ? `<div class="actions">${actionForm(`${path}/refresh`, "Refresh schema")}</div>` : "<p>Reconnect before refreshing the schema.</p>"}</section><section class="section" aria-labelledby="connection-rotate"><h2 class="section-heading" id="connection-rotate">Rotate credentials</h2><p>Replace the credentials for the same database without changing the connection id or schema revision. A new role changes the access every declaring patch has. To change the destination, use Retarget.</p><form class="connection-form" method="post" action="${escapeAttribute(`${path}/rotate`)}">${credentialsField("rotate-credentials")}<div class="actions"><button class="btn" type="submit">Rotate credentials</button></div></form></section><section class="section" aria-labelledby="connection-retarget"><h2 class="section-heading" id="connection-retarget">Retarget</h2><p>Point this connection at another database or role, keeping its id. Patchy tests and discovers the destination before replacing it. Every declaring patch will use the new destination, through its pinned schema. A disconnected connection stays disconnected.</p><form class="connection-form" method="post" action="${escapeAttribute(`${path}/retarget`)}">${credentialsField("retarget-credentials", promise)}<div class="actions"><button class="btn" type="submit">Retarget connection</button></div></form></section><section class="section" aria-labelledby="connection-description-title"><h2 class="section-heading" id="connection-description-title">Edit description</h2><form class="connection-form" method="post" action="${escapeAttribute(`${path}/description`)}"><label class="field-label" for="edit-description">Description</label><input class="field" id="edit-description" name="description" maxlength="500" value="${escapeAttribute(connection.description)}"><div class="actions"><button class="btn" type="submit">Save description</button></div></form></section><section class="section" aria-labelledby="connection-delete"><h2 class="section-heading" id="connection-delete">Delete connection</h2><p>Delete only when no stored patch version declares this connection. Disconnect instead to revoke access while keeping those declarations. Deletion cannot be undone; schema snapshots are kept.</p><div class="actions">${actionForm(`${path}/delete`, "Delete connection", true)}</div></section>`
    : '<p class="supporting-text">Only admins can change this connection.</p>';
  return {
    title: connection.handle,
    body: `<p>${company} · <a href="/company/connections">Connections</a></p>${noticeHtml(notice)}<p class="connection-status">${statusPill(connection)}<span class="supporting-text">Postgres · Company-wide</span></p>${description(connection)}<dl class="facts"><dt>Connection ID</dt><dd><code>${escapeHtml(connection.id)}</code></dd><dt>Host</dt><dd>${escapeHtml(display.host)}:${escapeHtml(display.port)}</dd><dt>Database</dt><dd>${escapeHtml(display.database)}</dd><dt>Role</dt><dd>${escapeHtml(display.role)}</dd><dt>Last tested</dt><dd>${time(connection.lastTestedAt)}</dd><dt>Schema discovered</dt><dd>${time(connection.lastDiscoveredAt)}</dd><dt>Credential revision</dt><dd>${connection.credentialRevision}</dd><dt>Schema revision</dt><dd>${connection.metadataRevision}</dd></dl>${calls}${management}`,
    app: { viewer, section: "connections" },
    status: notice?.status
  };
});

const decodeConnect = Schema.decodeUnknownEffect(
  Schema.Struct({ handle: Schema.String, description: Schema.String, credentials: Schema.String })
);
const decodeCredentials = Schema.decodeUnknownEffect(Schema.Struct({ credentials: Schema.String }));
const decodeDescription = Schema.decodeUnknownEffect(Schema.Struct({ description: Schema.String }));

/** Auth supplies a live viewer; no submitted company or user id can select authority. */
export const handle = Effect.fn("ConnectionPage.handle")(function* (
  viewer: RequireSession.Viewer["Service"],
  action: Action,
  result?: string | null
) {
  const id = "id" in action ? action.id : undefined;
  if (action.kind === "list" || action.kind === "view") {
    return yield* render(
      viewer,
      id,
      result && isResult(result) ? { message: results[result] } : undefined
    );
  }
  if (viewer.role !== "admin") {
    return yield* render(viewer, id, {
      message: "Only an admin can manage company connections.",
      code: "access_denied",
      status: 403
    });
  }
  return yield* Effect.gen(function* () {
    const store = yield* ConnectionStore.ConnectionStore;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const identity = { companyId: viewer.company.id, userId: viewer.user.id };
    let target: string;
    if (action.kind === "connect") {
      const form = yield* decodeConnect(Object.fromEntries(yield* request.urlParamsBody));
      const connection = yield* store.connect({
        ...identity,
        handle: form.handle,
        description: form.description,
        credentials: Redacted.make(form.credentials)
      });
      target = pathFor(connection.id);
    } else {
      const input = { ...identity, id: action.id };
      target = pathFor(action.id);
      if (action.kind === "rotate" || action.kind === "retarget") {
        const form = yield* decodeCredentials(Object.fromEntries(yield* request.urlParamsBody));
        yield* store[action.kind]({ ...input, credentials: Redacted.make(form.credentials) });
      } else if (action.kind === "description") {
        const form = yield* decodeDescription(Object.fromEntries(yield* request.urlParamsBody));
        yield* store.describe({ ...input, description: form.description });
      } else if (action.kind === "delete") {
        yield* store.delete(input);
        target = "/company/connections";
      } else {
        yield* store[action.kind](input);
      }
    }
    return {
      title: "Connections",
      body: "",
      redirect: `${target}?result=${action.kind}`
    } satisfies Page;
  }).pipe(
    Effect.catchTags({
      SchemaError: () =>
        render(viewer, id, {
          message:
            "Complete the form and submit it again. Connection strings are never redisplayed.",
          code: "invalid_request",
          status: 422
        }),
      HttpServerError: () =>
        render(viewer, id, {
          message: "The form could not be read. Submit it again.",
          code: "invalid_request",
          status: 400
        })
    }),
    Effect.catch((error) => render(viewer, id, error))
  );
});
