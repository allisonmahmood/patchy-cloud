import type { SalesforceSnapshot } from "@patchy/api";
import { escapeAttribute } from "@patchy/core";
import type * as Store from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";
export const integration = { key: "salesforce", label: "Salesforce" } as const;
export const offer = {
  integration,
  reads: "CRM objects, fields and records through read-only Salesforce queries.",
  mode: "Company-wide · read-only"
};
export const actions = {
  refresh: "Refresh objects",
  rotate: "Authorize again",
  retarget: "Change Salesforce org"
};
export const connectIntro =
  "Authorize Salesforce in the next tab, then return here to finish connecting. Credentials stay with the connector.";
export const source = (connection: Extract<Store.Connection, { integration: "salesforce" }>) =>
  connection.display.organizationId;
export const facts = (
  connection: Extract<Store.Connection, { integration: "salesforce" }>
): ReadonlyArray<readonly [string, string]> => [
  ["Salesforce org", connection.display.organizationId]
];
export const reads = (snapshot: typeof SalesforceSnapshot.Type) => ({
  summary: `${snapshot.objects.length} queryable objects. Fields are discovered on demand with describe().`,
  items: snapshot.objects.slice(0, 5).map((object) => object.name),
  more: Math.max(0, snapshot.objects.length - 5)
});
export const connectFields = (
  submitted: Readonly<Record<string, string | undefined>>,
  refusal?: View.Notice
) => {
  const handle = View.fieldNote(
    "connection-handle",
    "handle",
    "3–32 lowercase letters, digits or hyphens.",
    refusal
  );
  const description = View.fieldNote(
    "connection-description",
    "description",
    "One line telling builders what this source contains.",
    refusal
  );
  return `<label class="field-label" for="connection-handle">Name</label><input class="field" id="connection-handle" name="handle" required minlength="3" maxlength="32" value="${escapeAttribute(submitted.handle ?? "")}"${handle.attributes}>${handle.note}<label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(submitted.description ?? "")}"${description.attributes}>${description.note}<div class="note note-warn"><strong class="note-title">Company-wide access</strong><p>Every active member and their agent can read this Salesforce account through patches that declare it, including real data while building. Patchy exposes read operations only. Use a Salesforce account limited to the objects and fields your company intends to share.</p></div>`;
};
export const rotate = {
  title: (name: string) => `Authorize ${name} again`,
  consequence: "Authorize the same Salesforce org. This connection keeps its identity.",
  fields: () => ""
};
export const retarget = {
  ...rotate,
  title: (name: string) => `Change the Salesforce org of ${name}`,
  consequence:
    "Every declaring patch will read the newly authorized org. Refresh and regenerate the patch to pick up its objects."
};
export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map();
export const credentials = (): View.Notice => ({
  message: "Authorize Salesforce through the connection form.",
  status: 422,
  code: "invalid_credentials"
});
export const results = {
  connect: "Salesforce connected and its objects discovered.",
  refresh: "Salesforce objects refreshed.",
  reconnect: "Salesforce authorized and reconnected."
};
