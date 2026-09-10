import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { RequireSession } from "@patchy/auth";
import { CompanyPage } from "@patchy/companies";
import { escapeAttribute, escapeHtml } from "@patchy/core";
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

export const styles = `${CompanyPage.styles}
    .connection-details { margin: 20px 0; overflow-wrap: anywhere; }
    .connection-details dt { font-weight: 750; margin-top: 12px; }
    .connection-details dd { margin: 4px 0 0; }
    .connection-form button { margin-top: 20px; }
`;

const pathFor = (id: string) => `/company/connections/${encodeURIComponent(id)}`;
const noticeHtml = (notice?: Notice) =>
  notice
    ? `<div class="note${notice.status ? " note-warn" : ""}" role="${notice.status ? "alert" : "status"}">${escapeHtml(notice.message)}${notice.code ? `<br><code>${escapeHtml(notice.code)}</code>` : ""}</div>`
    : "";
const time = (value: string | null) =>
  value === null
    ? "Never"
    : `<time datetime="${escapeAttribute(value)}">${escapeHtml(value)}</time>`;
const state = (connection: ConnectionStore.Connection) =>
  `<p><strong>${connection.status === "connected" ? "Connected" : "Disconnected"}</strong> · ${escapeHtml(connection.integration)}</p><p>Last tested: ${time(connection.lastTestedAt)}<br>Last discovered: ${time(connection.lastDiscoveredAt)}</p>`;
const actionForm = (path: string, label: string) =>
  `<form method="post" action="${escapeAttribute(path)}"><button class="auth-action" type="submit">${escapeHtml(label)}</button></form>`;
const credentialsField = (id: string) =>
  `<label for="${id}">Connection string</label><input id="${id}" type="password" name="credentials" required autocomplete="new-password" spellcheck="false" aria-describedby="${id}-hint"><p id="${id}-hint" class="auth-hint">Paste a Postgres connection string with a password and sslmode=verify-full. Credentials are encrypted and never shown again. Only host, port, database, user, password and sslmode are accepted.</p>`;
const promise = `<div class="note"><strong class="note-title">Company-wide access</strong><p>Every member can query this database through any patch that declares it, as the role you supply.</p><p>Patchy provides constrained reads through the role you supplied. SELECT can invoke side effects or extensions; this is not a promise that arbitrary SQL is harmless. Supply a dedicated, least-privileged role with only the access your company should have.</p></div>`;
const connectForm = `<section class="company-section" aria-labelledby="connection-connect"><h2 id="connection-connect">Connect Postgres</h2>${promise}<p>The database must be reachable from the internet over TLS, with a verified certificate and hostname. Superusers and roles with CREATEDB or CREATEROLE cannot be connected.</p><form class="connection-form" method="post" action="/company/connections/connect"><label for="connection-handle">Handle</label><input id="connection-handle" name="handle" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="connection-handle-hint"><p id="connection-handle-hint" class="auth-hint">3–32 lowercase letters, digits or hyphens, with no leading or trailing hyphen. Patches declare this connection by its handle.</p><label for="connection-description">Description</label><input id="connection-description" name="description" maxlength="500" aria-describedby="connection-description-hint"><p id="connection-description-hint" class="auth-hint">One line explaining what this database is for.</p>${credentialsField("connection-credentials")}<button class="auth-action" type="submit">Test and connect</button></form></section>`;

const render = Effect.fn("ConnectionPage.render")(function* (
  viewer: RequireSession.Viewer["Service"],
  id: string | undefined,
  notice?: Notice
): Effect.fn.Return<Page, ConnectionStore.ConnectionError, ConnectionStore.ConnectionStore> {
  const store = yield* ConnectionStore.ConnectionStore;
  const admin = viewer.role === "admin";
  const company = `<p><a href="/company">${escapeHtml(viewer.company.name)}</a> · Connections</p>`;
  if (id === undefined) {
    const connections = yield* store.list(viewer.company.id);
    const rows = connections.map(
      (connection) =>
        `<li class="company-row"><p><a href="${escapeAttribute(pathFor(connection.id))}"><strong>${escapeHtml(connection.handle)}</strong></a></p><p>${escapeHtml(connection.description || "No description.")}</p>${state(connection)}</li>`
    );
    return {
      title: "Connections",
      body: `${company}${noticeHtml(notice)}<section class="company-section" aria-labelledby="connection-list"><h2 id="connection-list">Company connections</h2>${connections.length ? `<ul class="company-list">${rows.join("")}</ul>` : "<p>No databases connected yet.</p>"}</section>${admin ? connectForm : '<p class="auth-hint">An admin can connect and manage databases for your company.</p>'}`,
      status: notice?.status
    };
  }
  const connection = yield* store.get(viewer.company.id, id);
  const path = pathFor(connection.id);
  const display = connection.display;
  const management = admin
    ? `<section class="company-section" aria-labelledby="connection-access"><h2 id="connection-access">Access</h2><p>${connection.status === "connected" ? "Disconnect to revoke this connection for every patch. Reconnecting tests the stored credentials before restoring access." : "This connection is disconnected. Reconnecting tests the stored credentials before restoring access, without changing the schema revision."}</p><div class="company-actions">${actionForm(`${path}/test`, "Test connection")}${connection.status === "connected" ? actionForm(`${path}/disconnect`, "Disconnect") : actionForm(`${path}/reconnect`, "Reconnect")}</div></section><section class="company-section" aria-labelledby="connection-schema"><h2 id="connection-schema">Schema</h2><p>Refresh discovers a new immutable schema revision. If discovery fails, the previous revision stays available. Existing patches keep their pinned schema.</p>${connection.status === "connected" ? `<div class="company-actions">${actionForm(`${path}/refresh`, "Refresh schema")}</div>` : "<p>Reconnect before refreshing the schema.</p>"}</section><section class="company-section" aria-labelledby="connection-rotate"><h2 id="connection-rotate">Rotate credentials</h2><p>Replace the credentials for the same database without changing the connection id or schema revision. A new role changes the access every declaring patch has. To change the destination, use Retarget.</p><form class="connection-form" method="post" action="${escapeAttribute(`${path}/rotate`)}">${credentialsField("rotate-credentials")}<button class="auth-action" type="submit">Rotate credentials</button></form></section><section class="company-section" aria-labelledby="connection-retarget"><h2 id="connection-retarget">Retarget</h2><p>Point this connection at another database or role, keeping its id. Patchy tests and discovers the destination before replacing it. Every declaring patch will use the new destination, through its pinned schema. A disconnected connection stays disconnected.</p>${promise}<form class="connection-form" method="post" action="${escapeAttribute(`${path}/retarget`)}">${credentialsField("retarget-credentials")}<button class="auth-action" type="submit">Retarget connection</button></form></section><section class="company-section" aria-labelledby="connection-description-title"><h2 id="connection-description-title">Edit description</h2><form class="connection-form" method="post" action="${escapeAttribute(`${path}/description`)}"><label for="edit-description">Description</label><input id="edit-description" name="description" maxlength="500" value="${escapeAttribute(connection.description)}"><button class="auth-action" type="submit">Save description</button></form></section><section class="company-section" aria-labelledby="connection-delete"><h2 id="connection-delete">Delete connection</h2><p>Delete only when no stored patch version declares this connection. Disconnect instead to revoke access while keeping those declarations. Deletion cannot be undone; schema snapshots are kept.</p><div class="company-actions">${actionForm(`${path}/delete`, "Delete connection")}</div></section>`
    : '<p class="auth-hint">Only admins can change this connection.</p>';
  return {
    title: connection.handle,
    body: `${company}<p><a href="/company/connections">All connections</a></p>${noticeHtml(notice)}<p>${escapeHtml(connection.description || "No description.")}</p>${state(connection)}<dl class="connection-details"><dt>Host</dt><dd>${escapeHtml(display.host)}:${escapeHtml(display.port)}</dd><dt>Database</dt><dd>${escapeHtml(display.database)}</dd><dt>Role</dt><dd>${escapeHtml(display.role)}</dd><dt>Access</dt><dd>Company-wide</dd><dt>Credential revision</dt><dd>${connection.credentialRevision}</dd><dt>Schema revision</dt><dd>${connection.metadataRevision}</dd></dl>${management}`,
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
