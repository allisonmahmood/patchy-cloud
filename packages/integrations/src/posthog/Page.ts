import type { PostHogSnapshot } from "@patchy/api";
import type * as Redacted from "effect/Redacted";
import type * as ConnectionStore from "../ConnectionStore.js";
import type * as ConnectFrame from "../ConnectFrame.js";
import type * as View from "../ConnectionsView.js";
import * as Fields from "../Fields.js";
import * as Source from "./Source.js";

/** What the connections pages say about PostHog; the layout around it is every integration's. */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "posthog" }>;

export const integration = { key: "posthog", label: "PostHog", mark: { logo: "posthog" } } as const;
export const offer = { integration, line: "Events and people from a project" };
/** What recent calls keep of a PostHog call. */
export const logged =
  "Each query keeps its name and the first 8 KiB of its HogQL; values and returned rows are never logged.";
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
  reconnect: "Tested and resumed. Its events revision is unchanged."
};

const regionNames: { readonly [R in Source.Region]: string } = { us: "US Cloud", eu: "EU Cloud" };

export const source = (connection: Connection) =>
  `project ${connection.display.projectId}, ${Source.regionLabels[connection.display.region]}`;
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  ["Project", `${connection.display.projectId}, ${regionNames[connection.display.region]}`],
  ["Key", connection.display.keyHint]
];
/** What it holds, as Settings names it: the key, never shown, by the last characters it showed at connect. */
export const credential = (connection: Connection) => ({
  label: "Personal API key",
  detail: `Stored · ${connection.display.keyHint}`
});
/** Where it reads, which Change project changes. */
export const target = (connection: Connection) => ({
  label: "Project",
  value: `${connection.display.projectId}, ${regionNames[connection.display.region]}`
});

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

type Submitted = Readonly<Record<string, string | undefined>>;

/** Refusals about the key or project, shown under their field rather than atop the page. */
export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["invalid_credentials", "key"],
  ["posthog_key_rejected", "key"],
  ["posthog_access_denied", "key"],
  ["posthog_project_not_found", "project"]
]);

/** The region, project and key, as Replace key and Change project ask for them. */
export const regionSpec: Fields.Spec = {
  kind: "select",
  name: "region",
  field: "region",
  label: "Region",
  choices: (["us", "eu"] as const).map((region) => ({
    value: region,
    label: `${regionNames[region]} · ${new URL(Source.hosts[region]).host}`
  })),
  width: "md"
};
export const projectSpec: Fields.Spec = {
  kind: "text",
  name: "project",
  field: "project",
  label: "Project ID",
  hint: "The number in its address: us.posthog.com/project/12345.",
  inputmode: "numeric",
  pattern: "[0-9]+",
  maxlength: 15,
  mono: true,
  width: "md"
};
export const keySpec: Fields.Spec = {
  kind: "secret",
  name: "key",
  field: "key",
  label: "Personal API key",
  hint: "Encrypted, and never shown again.",
  placeholder: "phx_…",
  autocomplete: "new-password"
};

/** What the connect page asks for, in the shared frame. */
export const connect: ConnectFrame.ConnectSpec = {
  getIt: {
    title: "Make a personal API key",
    steps: [
      "In PostHog, open Settings › Personal API keys › Create key. Limit it to one project, with these scopes."
    ],
    table: {
      head: ["Scope", "Set to"],
      rows: [
        ["Query", "Read"],
        ["Event definitions", "Read"],
        ["Property definitions", "Read"]
      ]
    }
  },
  paste: { title: "Paste it", fields: [[regionSpec, projectSpec], keySpec] },
  name: { example: "product", describe: "Product analytics for the client portal" },
  once: {
    reads: "this project's events and people",
    devReads: true,
    cannot: ["Nothing is written to PostHog"],
    caveat: "Events may carry emails or user ids, which everyone reading it reads too."
  }
};

export const rotate = {
  title: (name: string) => `Replace the key for ${name}`,
  consequence:
    "Patchy tests the new key against the same project before saving it. The connection keeps its project and what patches can read. To read another project, change the project instead.",
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    Fields.render(keySpec, submitted, refusal, true),
  shows: ["key"]
} as const;
export const retarget = {
  title: (name: string) => `Change the project of ${name}`,
  consequence:
    "Patchy tests the key and finds the new project's events before switching. Every declaring patch then reads the new project through the events it was published with, until it is refreshed and published again. A paused connection stays paused.",
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    Fields.renderAll([[regionSpec, projectSpec], keySpec], submitted, refusal, true),
  shows: ["region", "project", "key"],
  // The region starts where it is: a project elsewhere is the rarer move.
  initial: (connection: ConnectionStore.Connection) =>
    connection.integration === "posthog" ? { region: connection.display.region } : {}
} as const;

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
