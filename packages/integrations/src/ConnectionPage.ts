import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { RequireSession } from "@patchy/auth";
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

export interface Page {
  readonly title: string;
  readonly body: string;
  readonly status?: number;
  readonly redirect?: string;
}

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
    .auth-card { width: min(800px, calc(100% - 32px)); }
    .connection-status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .connection-meta { color: var(--muted); font-size: .9rem; }
    .connection-meta time { white-space: nowrap; }
    .connection-details { display: grid; grid-template-columns: max-content 1fr; gap: 8px 24px; margin: 20px 0 0; overflow-wrap: anywhere; }
    .connection-details dt { font-weight: 750; }
    .connection-details dd { margin: 0; }
    .connection-form button { margin-top: 20px; }
    .note-ok { border-left-color: var(--green-ink); background: var(--paper-green); }
    .connection-calls .connection-details { margin: 12px 0; grid-template-columns: max-content minmax(0, 1fr); }
    .connection-sql { max-height: 18rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    .connection-calls summary { cursor: pointer; margin: 12px 0; }
    @media (max-width: 480px) {
      .connection-calls .connection-details { grid-template-columns: 1fr; gap: 4px; }
      .connection-calls .connection-details dd { margin-bottom: 8px; }
    }
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
const actionForm = (path: string, label: string) =>
  `<form method="post" action="${escapeAttribute(path)}"><button class="auth-action" type="submit">${escapeHtml(label)}</button></form>`;
/** The access note sits with the credentials field: it is about the role inside that string. */
const promise = `<div class="note"><strong class="note-title">Company-wide access</strong><p>Every member can query this database through any patch that declares it, as the role you supply.</p><p>Patchy sends constrained reads through the role you supplied, but a SELECT can still invoke functions and extensions, so this is not a promise that arbitrary SQL is harmless. Supply a dedicated, least-privileged role.</p></div>`;
const credentialsField = (id: string, note = "") =>
  `${note}<label for="${id}">Connection string</label><input id="${id}" type="password" name="credentials" required autocomplete="new-password" spellcheck="false" aria-describedby="${id}-hint"><p id="${id}-hint" class="auth-hint">A Postgres connection string with a password and sslmode=verify-full. Only host, port, database, user, password and sslmode are accepted. Credentials are encrypted and never shown again.</p>`;
const connectForm = `<section class="company-section" aria-labelledby="connection-connect"><h2 id="connection-connect">Connect Postgres</h2><p>Patchy tests the connection and discovers its schema before saving anything. The database must be reachable from the internet over TLS with a verified certificate and hostname; superusers and roles with CREATEDB or CREATEROLE are refused.</p><form class="connection-form" method="post" action="/company/connections/connect"><label for="connection-handle">Handle</label><input id="connection-handle" name="handle" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="connection-handle-hint"><p id="connection-handle-hint" class="auth-hint">3–32 lowercase letters, digits or hyphens, with no leading or trailing hyphen. Patches declare this connection by its handle.</p><label for="connection-description">Description</label><input id="connection-description" name="description" maxlength="500" aria-describedby="connection-description-hint"><p id="connection-description-hint" class="auth-hint">One line explaining what this database is for.</p>${credentialsField("connection-credentials", promise)}<button class="auth-action" type="submit">Test and connect</button></form></section>`;

const recentCalls = (calls: ReadonlyArray<RuntimeLog.Call>) =>
  `<section class="company-section" aria-labelledby="connection-calls"><h2 id="connection-calls">Recent calls</h2><p class="auth-hint">Visible only to company admins. Query text is limited to its first 8 KiB; parameters and returned rows are never logged. Pending calls past their deadline have an unknown outcome.</p>${
    calls.length === 0
      ? "<p>No calls yet.</p>"
      : `<ol class="company-list connection-calls">${calls
          .map((call) => {
            const outcome =
              call.outcome === "failure"
                ? "Failed"
                : call.outcome === "success"
                  ? "Succeeded"
                  : call.outcome === "unknown"
                    ? "Unknown"
                    : "Pending";
            return `<li class="company-row"><p class="connection-status"><strong>${escapeHtml(call.op)}</strong><span class="pill${call.outcome === "success" ? " pill-done" : ""}">${outcome}</span>${call.outcomeCode === null ? "" : `<code>${escapeHtml(call.outcomeCode)}</code>`}</p><p class="connection-meta">${time(call.at.toISOString())} · ${call.durationMs === null ? "Duration unknown" : `${call.durationMs} ms`} · ${call.rowCount === null ? "Row count unknown" : `${call.rowCount} rows`}</p><dl class="connection-details"><dt>Patch / version</dt><dd>${call.patchId === null ? "Connection administration" : `<code>${escapeHtml(call.patchId)}</code> / <code>${escapeHtml(call.versionId ?? "Unknown")}</code>`}</dd><dt>User</dt><dd><code>${escapeHtml(call.userId)}</code></dd><dt>Credential kind</dt><dd>${escapeHtml(call.credentialKind)}</dd>${call.resource === null ? "" : `<dt>Resource</dt><dd><code>${escapeHtml(call.resource)}</code></dd>`}<dt>Correlation ID</dt><dd><code>${escapeHtml(call.correlationId)}</code></dd></dl>${call.op === "postgres.query" && call.sql !== null ? `<details><summary>SQL query</summary><pre class="connection-sql"><code>${escapeHtml(call.sql)}</code></pre></details>` : ""}</li>`;
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
        `<li class="company-row"><p class="connection-status"><a href="${escapeAttribute(pathFor(connection.id))}"><strong>${escapeHtml(connection.handle)}</strong></a>${statusPill(connection)}</p>${description(connection)}<p class="connection-meta">Postgres · Last tested ${time(connection.lastTestedAt)} · Schema discovered ${time(connection.lastDiscoveredAt)}</p></li>`
    );
    return {
      title: "Connections",
      body: `<p>${company} · Connections</p>${noticeHtml(notice)}<section class="company-section" aria-labelledby="connection-list"><h2 id="connection-list">Company connections</h2>${connections.length ? `<ul class="company-list">${rows.join("")}</ul>` : "<p>No databases connected yet.</p>"}</section>${admin ? connectForm : '<p class="auth-hint">An admin can connect and manage databases for your company.</p>'}`,
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
              '<section class="company-section" aria-labelledby="connection-calls"><h2 id="connection-calls">Recent calls</h2><div class="note note-warn" role="alert">Recent calls could not be loaded. Reload the page to try again.</div></section>'
            )
        })
      )
    : "";
  const management = admin
    ? `<section class="company-section" aria-labelledby="connection-access"><h2 id="connection-access">Access</h2><p>${connection.status === "connected" ? "Disconnect to revoke this connection for every patch. Reconnecting tests the stored credentials before restoring access." : "This connection is disconnected. Reconnecting tests the stored credentials before restoring access, without changing the schema revision."}</p><div class="company-actions">${actionForm(`${path}/test`, "Test connection")}${connection.status === "connected" ? actionForm(`${path}/disconnect`, "Disconnect") : actionForm(`${path}/reconnect`, "Reconnect")}</div></section><section class="company-section" aria-labelledby="connection-schema"><h2 id="connection-schema">Schema</h2><p>Refresh discovers a new immutable schema revision. If discovery fails, the previous revision stays available. Existing patches keep their pinned schema.</p>${connection.status === "connected" ? `<div class="company-actions">${actionForm(`${path}/refresh`, "Refresh schema")}</div>` : "<p>Reconnect before refreshing the schema.</p>"}</section><section class="company-section" aria-labelledby="connection-rotate"><h2 id="connection-rotate">Rotate credentials</h2><p>Replace the credentials for the same database without changing the connection id or schema revision. A new role changes the access every declaring patch has. To change the destination, use Retarget.</p><form class="connection-form" method="post" action="${escapeAttribute(`${path}/rotate`)}">${credentialsField("rotate-credentials")}<button class="auth-action" type="submit">Rotate credentials</button></form></section><section class="company-section" aria-labelledby="connection-retarget"><h2 id="connection-retarget">Retarget</h2><p>Point this connection at another database or role, keeping its id. Patchy tests and discovers the destination before replacing it. Every declaring patch will use the new destination, through its pinned schema. A disconnected connection stays disconnected.</p><form class="connection-form" method="post" action="${escapeAttribute(`${path}/retarget`)}">${credentialsField("retarget-credentials", promise)}<button class="auth-action" type="submit">Retarget connection</button></form></section><section class="company-section" aria-labelledby="connection-description-title"><h2 id="connection-description-title">Edit description</h2><form class="connection-form" method="post" action="${escapeAttribute(`${path}/description`)}"><label for="edit-description">Description</label><input id="edit-description" name="description" maxlength="500" value="${escapeAttribute(connection.description)}"><button class="auth-action" type="submit">Save description</button></form></section><section class="company-section" aria-labelledby="connection-delete"><h2 id="connection-delete">Delete connection</h2><p>Delete only when no stored patch version declares this connection. Disconnect instead to revoke access while keeping those declarations. Deletion cannot be undone; schema snapshots are kept.</p><div class="company-actions">${actionForm(`${path}/delete`, "Delete connection")}</div></section>`
    : '<p class="auth-hint">Only admins can change this connection.</p>';
  return {
    title: connection.handle,
    body: `<p>${company} · <a href="/company/connections">Connections</a></p>${noticeHtml(notice)}<p class="connection-status">${statusPill(connection)}<span class="connection-meta">Postgres · Company-wide</span></p>${description(connection)}<dl class="connection-details"><dt>Connection ID</dt><dd><code>${escapeHtml(connection.id)}</code></dd><dt>Host</dt><dd>${escapeHtml(display.host)}:${escapeHtml(display.port)}</dd><dt>Database</dt><dd>${escapeHtml(display.database)}</dd><dt>Role</dt><dd>${escapeHtml(display.role)}</dd><dt>Last tested</dt><dd>${time(connection.lastTestedAt)}</dd><dt>Schema discovered</dt><dd>${time(connection.lastDiscoveredAt)}</dd><dt>Credential revision</dt><dd>${connection.credentialRevision}</dd><dt>Schema revision</dt><dd>${connection.metadataRevision}</dd></dl>${calls}${management}`,
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
