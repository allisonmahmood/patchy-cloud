import { escapeAttribute, escapeHtml } from "@patchy/core";
import type { AgentAccess } from "@patchy/patches";

import type * as Effect from "effect/Effect";

type Access = Effect.Success<ReturnType<AgentAccess.AgentAccess["Service"]["inspect"]>>;

export const renderAgentAccess = (input: {
  readonly name: string;
  readonly patchId: string;
  readonly choices: readonly string[];
  readonly access: Access;
  readonly notice?: string;
  readonly all?: boolean;
}): string => {
  const { name, patchId, access } = input;
  const query = input.all ? "?all=1" : "";
  const path = `/patches/${encodeURIComponent(name)}/agent-access${query}`;
  const hidden = `<input type="hidden" name="expectedPatchId" value="${escapeAttribute(patchId)}">`;
  const start = (action: string) =>
    `<form method="post" action="${escapeAttribute(path)}">${hidden}<input type="hidden" name="action" value="${action}">`;
  const operations = Object.entries(access.manifest.handlers ?? {})
    .map(
      ([name, descriptor]) =>
        `<li class="list-row"><label class="field-choice"><input class="field-checkbox" type="checkbox" name="handler" value="${escapeAttribute(name)}"${access.policy.handlers.includes(name) ? " checked" : ""}><span>${escapeHtml(name)} · ${escapeHtml(descriptor.kind)}</span></label></li>`
    )
    .join("");
  const granted = access.connections.filter((connection) => connection.granted);
  const available = access.connections.filter((connection) => !connection.granted);
  const grantedList = granted
    .map(
      (connection) =>
        `<li class="list-row"><p><strong>${escapeHtml(connection.name)}</strong> · ${escapeHtml(connection.person)} (${escapeHtml(connection.email)})</p>${start("revoke")}<input type="hidden" name="machineId" value="${escapeAttribute(connection.machineId)}"><button class="btn btn-danger" type="submit">Revoke access</button></form></li>`
    )
    .join("");
  const grantForm =
    available.length === 0
      ? '<p class="supporting-text">No other active connections. Sign in a personal agent to connect it.</p>'
      : `${start("grant")}<label class="field-label" for="agent-machine">Personal agent connection</label><select class="field" id="agent-machine" name="machineId" required>${available.map((connection) => `<option value="${escapeAttribute(connection.machineId)}">${escapeHtml(connection.name)} · ${escapeHtml(connection.person)} (${escapeHtml(connection.email)})</option>`).join("")}</select><div class="actions"><button class="btn btn-primary" type="submit">Grant access to this patch</button></div></form>`;
  const patchSelector = `<form method="get" action="/patches/${encodeURIComponent(name)}/agent-access">${input.all ? '<input type="hidden" name="all" value="1">' : ""}<label class="field-label" for="agent-patch">Patch</label><select class="field" id="agent-patch" name="patch">${input.choices.map((choice) => `<option value="${escapeAttribute(choice)}"${choice === name ? " selected" : ""}>${escapeHtml(choice)}</option>`).join("")}</select><div class="actions"><button class="btn" type="submit">Open patch</button></div></form>`;
  return `<article class="portal-subpage"><p><a href="/patches/${encodeURIComponent(name)}${query}">Back to ${escapeHtml(name)}</a></p><h1 class="page-heading">Agent access</h1>${input.notice ? `<div class="note note-refused" role="alert">${escapeHtml(input.notice)} Nothing was done.</div>` : ""}<p>Choose what connected personal agents can do in this patch. Each agent acts as its owner, with that person's existing data permissions.</p>${patchSelector}<section class="section"><h2 class="section-heading">Access</h2>${start("save")}<input type="hidden" name="revision" value="${access.policy.revision}"><label class="field-label" for="agent-mode">Access mode</label><select class="field" id="agent-mode" name="mode" aria-describedby="agent-mode-hint"><option value="read-only"${access.policy.mode === "read-only" ? " selected" : ""}>Read only</option><option value="actions"${access.policy.mode === "actions" ? " selected" : ""}>Declared actions</option></select><p class="field-hint" id="agent-mode-hint">Read only answers questions. Declared actions can also make changes through the patch’s allowed operations. Existing agents follow this setting.</p><details><summary>Allowed operations</summary><fieldset><legend>Available operations</legend><ul class="list list-compact">${operations}</ul></fieldset></details><div class="actions"><button class="btn btn-primary" type="submit">Save agent access</button></div></form></section><section class="section"><h2 class="section-heading">Authorized personal agents</h2><p class="supporting-text">Connection names are supplied by their owners. Only active connections appear here. Access is separate for each patch.</p>${granted.length ? `<ul class="list">${grantedList}</ul>` : "<p>No personal agents are authorized for this patch.</p>"}${grantForm}</section></article>`;
};
