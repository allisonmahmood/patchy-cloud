/** One form renderer for admitted piece metadata. Module descriptions are always escaped text. */
import { escapeAttribute as attr, escapeHtml as html } from "@patchy/core";
import type { RuntimeLog } from "@patchy/runtime";
import type { Connection } from "./CommunityConnections.js";
import type { Info } from "./Pieces.js";
import { definition, type Key } from "./catalog.js";
import type { AuthField } from "./adapter.js";

export const path = "/company/connections/community";
export const providerPath = (key: Key) => `${path}/${key}`;
export const catalogue = (infos: ReadonlyArray<Info>) =>
  `<p><a href="/company/connections">Connections</a> / Local connector catalog</p><p>Choose a service, enter its credentials, and test the connection. Patchy keeps credentials encrypted for your company.</p><p class="supporting-text">Local prototype · Real provider requests · Only the listed read actions are enabled</p><ul class="list">${infos.map((info) => `<li><h2 class="section-heading">${html(info.displayName)}</h2><p><strong>${html(definition(info.key).setup.label)}</strong> · ${info.actions.map((action) => html(action.displayName)).join(", ")}</p><p>${html(definition(info.key).setup.instructions)}</p><a class="btn btn-primary" href="${providerPath(info.key)}">Connect ${html(info.displayName)}</a></li>`).join("")}</ul>`;

const fields = (properties: ReadonlyArray<AuthField>, prefix: string, namespace = "credential") =>
  properties
    .map((field) => {
      const id = `${prefix}-${field.name}`;
      return `<label class="field-label" for="${attr(id)}">${html(field.displayName)}</label><input class="field" id="${attr(id)}" name="${namespace}.${attr(field.name)}" type="${field.type === "SECRET_TEXT" ? "password" : "text"}" autocomplete="off" spellcheck="false" maxlength="4096"${field.required ? " required" : ""}${field.description ? ` aria-describedby="${attr(id)}-hint"` : ""}>${field.description ? `<p class="field-hint" id="${attr(id)}-hint">${html(field.description)}</p>` : ""}`;
    })
    .join("");
const post = (base: string, action: string, label: string) =>
  `<form method="post" action="${attr(base)}/${action}"><button class="btn btn-quiet" type="submit">${label}</button></form>`;

export const provider = (input: {
  readonly info: Info;
  readonly company: string;
  readonly rows: ReadonlyArray<Connection>;
  readonly calls: ReadonlyMap<string, ReadonlyArray<RuntimeLog.Call>>;
  readonly notice?: string;
  readonly status?: number;
  readonly result?: unknown;
}) => {
  const { info } = input;
  const target = providerPath(info.key);
  const entry = definition(info.key);
  const cards = input.rows
    .map((row) => {
      const base = `${target}/${encodeURIComponent(row.id)}`;
      const history = input.calls.get(row.id) ?? [];
      return `<section class="section"><h2 class="section-heading">${html(info.displayName)} / ${html(row.handle)}</h2><p>${html(row.status)} · <code>${html(row.id)}</code></p>
      ${row.status === "connected" ? info.actions.map((action) => `<form method="post" action="${base}/run/${encodeURIComponent(action.name)}">${fields(action.fields, `${row.id}-${action.name}`, "input")}<div class="actions"><button class="btn btn-primary" type="submit">${html(action.displayName)}</button></div></form>`).join("") : "<p>The saved credentials have been removed. Enter credentials below to reconnect.</p>"}
      <details><summary>${row.status === "connected" ? "Replace credentials" : "Reconnect"}</summary><form method="post" action="${base}/connect"><input type="hidden" name="handle" value="${attr(row.handle)}">${fields(info.fields, row.id)}<button class="btn" type="submit">Test and save credentials</button></form></details>
      <div class="actions">${row.status === "connected" ? post(base, "disconnect", "Disconnect and remove credentials") : post(base, "delete", "Delete connection")}</div>
      <h3>Recent calls</h3>${history.length ? `<ul class="list list-compact">${history.map((call) => `<li>${html(info.actions.find((action) => action.name === call.resource)?.displayName ?? call.op)} · ${html(call.outcome)} · ${html(call.at.toISOString())}</li>`).join("")}</ul>` : "<p>No calls yet.</p>"}</section>`;
    })
    .join("");
  return `<p><a href="${path}">Connector catalog</a></p><p>Connect ${html(info.displayName)} for <strong>${html(input.company)}</strong>. Credentials stay encrypted in Patchy.</p>
    <p class="supporting-text">Local prototype · Real provider requests · Only the listed read actions are enabled</p>
    <div class="note"><strong class="note-title">${html(entry.setup.label)}</strong><p>${html(entry.setup.instructions)}</p><a href="${attr(entry.setup.url)}" target="_blank" rel="noopener noreferrer">Open ${html(info.displayName)} settings</a></div>
    ${info.authDescription ? `<details><summary>Connector setup instructions</summary><pre class="code-panel">${html(info.authDescription)}</pre></details>` : ""}
    ${input.notice ? `<div class="note ${(input.status ?? 200) >= 400 ? "note-refused" : "note-ok"}" role="${(input.status ?? 200) >= 400 ? "alert" : "status"}">${html(input.notice)}</div>` : ""}
    ${input.result === undefined ? "" : `<section class="section"><h2 class="section-heading">${html(info.displayName)} result</h2><pre class="code-panel">${html(JSON.stringify(input.result, null, 2))}</pre></section>`}
    ${cards}<section class="section"><h2 class="section-heading">Connect ${html(info.displayName)}</h2><form method="post" action="${target}">
    <label class="field-label" for="handle">Connection handle</label><input class="field" id="handle" name="handle" value="workspace" minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" required>${fields(info.fields, "new")}<div class="actions"><button class="btn btn-primary" type="submit">Test and connect</button></div></form></section>`;
};
