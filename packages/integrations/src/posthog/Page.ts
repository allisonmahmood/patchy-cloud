import type { PostHogSnapshot } from "@patchy/api";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import type * as Redacted from "effect/Redacted";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";
import * as Source from "./Source.js";

/** What the connections pages say about PostHog; the layout around it is every integration's. */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "posthog" }>;

export const integration = { key: "posthog", label: "PostHog" } as const;
export const offer = {
  integration,
  reads: "SQL over a PostHog Cloud project's events and people.",
  mode: "Company-wide · read-only"
};
export const actions = {
  refresh: "Refresh events",
  rotate: "Replace key",
  retarget: "Change project"
};
export const results = {
  connect: "PostHog connected and its events discovered.",
  rotate: "Key replaced. The connection keeps its project and what patches can read.",
  retarget:
    "Pointed at the new project and its events discovered. Existing patches keep the events they were published with.",
  refresh:
    "Events refreshed. Existing patches keep their pinned events; regenerate before publishing against the new ones.",
  reconnect: "Connection tested and reconnected. Its events revision is unchanged."
};

const regionNames: { readonly [R in Source.Region]: string } = { us: "US Cloud", eu: "EU Cloud" };

export const source = (connection: Connection) =>
  `project ${connection.display.projectId}, ${Source.regionLabels[connection.display.region]}`;
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  ["Project", `${connection.display.projectId}, ${regionNames[connection.display.region]}`],
  ["Key", connection.display.keyHint]
];

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const SHOWN = 5;

/** "47 events, 312 event properties and 58 person properties.", then the first events by name. */
export const reads = (snapshot: PostHogSnapshot) => ({
  summary:
    snapshot.events.length + snapshot.eventProperties.length + snapshot.personProperties.length ===
    0
      ? "No events or properties yet."
      : `${plural(snapshot.events.length, "event")}, ${plural(snapshot.eventProperties.length, "event property", "event properties")} and ${plural(snapshot.personProperties.length, "person property", "person properties")}.`,
  items: snapshot.events.slice(0, SHOWN).map((event) => event.name),
  more: Math.max(0, snapshot.events.length - SHOWN)
});

export const connectIntro =
  "About two minutes. Nothing is saved until Patchy has tested the key and found your events.";

export const walkthrough: View.Walkthrough = {
  before: [
    {
      title: "Create a read-only key in PostHog",
      text: "Settings › Personal API keys › Create key. Limit it to one project; set Query, Event definitions and Property definitions to Read."
    }
  ],
  current: "Paste it here",
  after: [
    {
      title: "Use it in a patch",
      text: "Ask your agent to add it to a patch by its name, such as posthog/product."
    }
  ]
};

const access = `<div class="note"><strong class="note-title">Company-wide access</strong><p>Every member can read this project's events and people through any patch that declares it, including anything your events carry, such as emails or user ids.</p></div>`;
const building = `<div class="note note-warn"><strong class="note-title">Agents read real data while building</strong><p>While someone builds a patch that uses this connection, their agent reads real PostHog data through Patchy, as them. Nothing is written, and every read appears in recent calls.</p></div>`;

type Submitted = Readonly<Record<string, string | undefined>>;

const regionField = (submitted: Submitted, refusal: View.Notice | undefined) => {
  const note = View.fieldNote(
    "connection-region",
    "region",
    "Where your PostHog project lives.",
    refusal
  );
  return `<label class="field-label" for="connection-region">Region</label><select class="field" id="connection-region" name="region" required${note.attributes}>${(["us", "eu"] as const).map((region) => `<option value="${region}"${submitted.region === region ? " selected" : ""}>${escapeHtml(`${regionNames[region]} · ${new URL(Source.hosts[region]).host}`)}</option>`).join("")}</select>${note.note}`;
};
const projectField = (submitted: Submitted, refusal: View.Notice | undefined) => {
  const note = View.fieldNote(
    "connection-project",
    "project",
    "The number in your project's address: us.posthog.com/project/12345.",
    refusal
  );
  return `<label class="field-label" for="connection-project">Project ID</label><input class="field" id="connection-project" name="project" value="${escapeAttribute(submitted.project ?? "")}" required inputmode="numeric" pattern="[0-9]+" maxlength="15" autocomplete="off" spellcheck="false"${note.attributes}>${note.note}`;
};
const keyField = (refusal: View.Notice | undefined) => {
  const note = View.fieldNote(
    "connection-key",
    "key",
    "Patchy encrypts it and never shows it again.",
    refusal
  );
  return `<label class="field-label" for="connection-key">Personal API key</label><input class="field" id="connection-key" type="password" name="key" required placeholder="phx_…" autocomplete="new-password" spellcheck="false"${note.attributes}>${note.note}`;
};

/** Refusals about the key or project, shown under their field rather than atop the page. */
export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["invalid_credentials", "key"],
  ["posthog_key_rejected", "key"],
  ["posthog_access_denied", "key"],
  ["posthog_project_not_found", "project"]
]);

/** The connect form's fields; a refused submit keeps everything typed except the key. */
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
    "One line on what this project is for, so builders pick the right one.",
    refusal
  );
  return `<label class="field-label" for="connection-handle">Name</label><div class="field field-group"><label class="field-prefix" for="connection-handle">posthog/</label><input id="connection-handle" name="handle" value="${escapeAttribute(submitted.handle ?? "")}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false"${handle.attributes}></div>${handle.note}<label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(submitted.description ?? "")}"${description.attributes}>${description.note}${regionField(submitted, refusal)}${projectField(submitted, refusal)}${keyField(refusal)}${access}${building}`;
};

export const rotate = {
  title: (name: string) => `Replace the key for ${name}`,
  consequence:
    "Patchy tests the new key against the same project before saving it. The connection keeps its project and what patches can read. To read another project, change the project instead.",
  fields: (_submitted: Submitted, refusal?: View.Notice) => keyField(refusal)
};
export const retarget = {
  title: (name: string) => `Change the project of ${name}`,
  consequence:
    "Patchy tests the key and finds the new project's events before switching. Every declaring patch then reads the new project through the events it was published with, until it is refreshed and published again. A disconnected connection stays disconnected.",
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    `${regionField(submitted, refusal)}${projectField(submitted, refusal)}${keyField(refusal)}${access}`
};

const refused = (field: View.Field, message: string): View.Notice => ({
  message,
  code: "invalid_credentials",
  status: 422,
  field
});

/**
 * The submitted region, project and key as one secret, or the refusal at the field that stops
 * them. Replacing the key keeps the connection's region and project.
 */
export const credentials = (
  form: Submitted,
  current?: ConnectionStore.Connection
): Redacted.Redacted<string> | View.Notice => {
  const kept = current?.integration === "posthog" ? current.display : undefined;
  const region = kept?.region ?? form.region;
  const project = kept === undefined ? (form.project ?? "").trim() : String(kept.projectId);
  const key = (form.key ?? "").trim();
  if (region !== "us" && region !== "eu") return refused("region", "Choose US or EU Cloud.");
  if (!/^[1-9][0-9]{0,14}$/.test(project))
    return refused("project", "Enter the project's numeric ID, the number in its address.");
  if (!/^phx_[A-Za-z0-9_-]{8,256}$/.test(key))
    return refused(
      "key",
      key.startsWith("phc_")
        ? "This is a project API key. Paste a personal API key; they start with phx_."
        : key.startsWith("phs_")
          ? "This is a project secret key. Paste a personal API key; they start with phx_."
          : "Paste a personal API key; they start with phx_."
    );
  return Source.credentials({ region, projectId: Number(project), apiKey: key });
};
