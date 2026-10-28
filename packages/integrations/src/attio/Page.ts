import type { AttioSnapshot } from "@patchy/api";
import { escapeAttribute } from "@patchy/core";
import * as Redacted from "effect/Redacted";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";

/** What the connections pages say about Attio; the layout around it is every integration's. */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "attio" }>;

export const integration = { key: "attio", label: "Attio" } as const;
export const offer = {
  integration,
  reads: "A workspace's objects, lists and members, read-only.",
  mode: "Company-wide · read-only"
};
export const actions = {
  refresh: "Refresh workspace",
  rotate: "Replace key"
};
export const results = {
  connect: "Attio connected and its workspace discovered.",
  rotate:
    "Key replaced and the workspace discovered again. Existing patches keep what they were published with.",
  refresh:
    "Workspace refreshed. Existing patches keep their pinned shape; regenerate before publishing against the new one.",
  reconnect: "Key checked and the connection reconnected. Its snapshot revision is unchanged."
};

export const source = (connection: Connection) => connection.display.workspace.name;
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  ["Workspace", `${connection.display.workspace.name} (${connection.display.workspace.slug})`],
  ["Key", connection.display.keyHint]
];

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const SHOWN = 5;

export const reads = (snapshot: AttioSnapshot) => ({
  summary: `${plural(snapshot.objects.length, "object")} and ${plural(snapshot.lists.length, "list")}.`,
  items: [...snapshot.objects, ...snapshot.lists].slice(0, SHOWN).map((item) => item.slug),
  more: Math.max(0, snapshot.objects.length + snapshot.lists.length - SHOWN)
});

type Submitted = Readonly<Record<string, string | undefined>>;

const keyField = (refusal: View.Notice | undefined) => {
  const note = View.fieldNote(
    "connection-key",
    "key",
    "Patchy encrypts it and never shows it again.",
    refusal
  );
  return `<label class="field-label" for="connection-key">Access token</label><input class="field" id="connection-key" type="password" name="key" required autocomplete="new-password" spellcheck="false"${note.attributes}>${note.note}`;
};

export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["invalid_credentials", "key"],
  ["attio_key_unknown", "key"],
  ["attio_not_a_token", "key"],
  ["attio_not_workspace_key", "key"],
  ["attio_missing_scopes", "key"],
  ["attio_write_scopes", "key"],
  ["attio_other_workspace", "key"]
]);

export const connectFields = (submitted: Submitted, refusal?: View.Notice) => {
  const handle = View.fieldNote(
    "connection-handle",
    "handle",
    "3–32 lowercase letters, digits or hyphens. Patches use this name, which can't be changed later.",
    refusal
  );
  const description = View.fieldNote(
    "connection-description",
    "description",
    "One line on what this workspace holds, so builders pick the right one.",
    refusal
  );
  return `<label class="field-label" for="connection-handle">Name</label><div class="field field-group"><label class="field-prefix" for="connection-handle">attio/</label><input id="connection-handle" name="handle" value="${escapeAttribute(submitted.handle ?? "")}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false"${handle.attributes}></div>${handle.note}<label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(submitted.description ?? "")}"${description.attributes}>${description.note}${keyField(refusal)}`;
};

export const rotate = {
  title: (name: string) => `Replace the key for ${name}`,
  consequence:
    "Patchy checks the new key and discovers the workspace again before saving either. The key must read the same workspace.",
  fields: (_submitted: Submitted, refusal?: View.Notice) => keyField(refusal)
};

/** The pasted key, or the refusal under its field. */
export const credentials = (form: Submitted): Redacted.Redacted<string> | View.Notice => {
  const key = (form.key ?? "").trim();
  if (!/^[\x21-\x7e]{1,512}$/.test(key))
    return {
      message: "Paste an Attio access token, from Workspace settings › Developers.",
      code: "invalid_credentials",
      status: 422,
      field: "key"
    };
  return Redacted.make(key);
};
