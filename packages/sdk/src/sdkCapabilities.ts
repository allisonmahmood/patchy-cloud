export interface SdkCapability {
  /** Stable across releases; refresh compares ids rather than display text. */
  readonly id: string;
  readonly group: "Core" | "Primitives" | "Integrations" | "Helpers";
  readonly name: string;
  readonly entrypoints: readonly string[];
  readonly runs: string;
  readonly limits: string;
}

/** Only shipped APIs belong here. A reserved import is not an available capability. */
export const sdkCapabilities: readonly SdkCapability[] = [
  {
    id: "core.config",
    group: "Core",
    name: "Typed definitions and declarations",
    entrypoints: ["patchy/config"],
    runs: "Build time, in patchy.config.ts",
    limits: "Not a page runtime import. Refresh generates the client and declaration context."
  },
  {
    id: "core.client",
    group: "Core",
    name: "Framework-free client, viewer identity and routing",
    entrypoints: ["patchy/_generated/client.ts"],
    runs: "Tier 1 page through the hosted shell or patchy dev; tier 2 page in patchy dev",
    limits:
      "Import by relative path. The generated implementation uses patchy/client; app code does not import it directly. Tier 2 uses server handlers, not direct named resources. me() is null on public tier 1 patches. Routing is shell-mediated; there is no outbound fetch or client storage."
  },
  {
    id: "core.preact",
    group: "Core",
    name: "Preact with compat semantics",
    entrypoints: ["patchy/preact", "patchy/preact/jsx-runtime", "patchy/preact/jsx-dev-runtime"],
    runs: "Page",
    limits:
      "Bundled Preact, hooks and signals share one instance. Transitions are synchronous and there is no concurrent scheduler. Chromium desktop is the supported browser."
  },
  {
    id: "core.query-adapter",
    group: "Core",
    name: "useQuery adapter",
    entrypoints: ["patchy/preact"],
    runs: "Tier 1 page through the shell's subscribed own and shared table queries",
    limits:
      "Returns status, data, error and loading; retains data through errors. Accepts table list/get callables. Handler subscriptions are not admitted yet."
  },
  {
    id: "primitives.table-subscriptions",
    group: "Primitives",
    name: "Live table subscriptions",
    entrypoints: [
      "patchy/_generated/client.ts: table.list.subscribe and table.get.subscribe",
      "patchy/preact: useQuery"
    ],
    runs: "Tier 1 company pages and patchy dev through the document stream",
    limits:
      "Own and shared tables. Render the whole result; get wakes at table grain. At most 64 subscriptions per document and 8 MiB per snapshot. A permanent error ends the subscription with its last value retained."
  },
  {
    id: "core.server-contract",
    group: "Core",
    name: "Typed handler contract",
    entrypoints: ["patchy/server", "patchy/_generated/server.ts"],
    runs: "Build time, for server handler definitions and types",
    limits:
      "Query, mutation and action builders are available. Mutation execution and tier 2 publishing are not admitted in this release. Runtime imports of server code do not belong in the page graph."
  },
  {
    id: "core.server-calls",
    group: "Core",
    name: "Server queries and actions",
    entrypoints: ["patchy/_generated/client.ts: patchy.server", "patchy/_generated/server.ts"],
    runs: "Local executor in isolated acceptance runs",
    limits:
      "Queries share one read-only snapshot with a 3-second deadline. Actions have 60 seconds, declared connections and nested queries. Shared access is checked per callback. Lost query replies retry once; actions are never replayed. Args are at most 1 MiB and results 8 MiB. The patchy dev connection, production hosting, mutations and handler subscriptions are not admitted yet."
  },
  {
    id: "primitives.tables",
    group: "Primitives",
    name: "Owned tables",
    entrypoints: ["patchy/_generated/client.ts: patchy.tables"],
    runs: "Tier 1 page through Patchy; local PGlite in patchy dev",
    limits:
      "Indexed reads and viewer-attributed writes. Rows are at most 1 MiB, batches at most 1,000 rows and 8 MiB, and list pages at most 1,000 rows. No cross-table transaction or row-level authorization."
  },
  {
    id: "primitives.files",
    group: "Primitives",
    name: "Owned file stores and downloads",
    entrypoints: ["patchy/_generated/client.ts: patchy.files"],
    runs: "Tier 1 page through Patchy; downloads through the shell",
    limits:
      "Objects are at most 20 MiB; names are at most 512 UTF-8 bytes. url(name) returns a frame-local blob URL, not a public link. Stores are not shareable in this release."
  },
  {
    id: "primitives.shared-tables",
    group: "Primitives",
    name: "Shared-table reads",
    entrypoints: ["patchy/_generated/client.ts: patchy.shared"],
    runs: "Tier 1 page through Patchy; synthetic fixtures in patchy dev",
    limits:
      "Declare a shared source first. Reads are bounded and indexed; writes are unavailable. Source sharing and access are checked live."
  },
  {
    id: "integrations.postgres",
    group: "Integrations",
    name: "Company Postgres reads",
    entrypoints: ["patchy/_generated/client.ts: patchy.connections"],
    runs: "Tier 1 page through Patchy; synthetic fixtures in patchy dev",
    limits:
      "Declare a connected company source. Read-only queries return at most 1,000 rows and 8 MiB, with a 10-second statement timeout. Credentials stay with Patchy. Postgres reads are not live-query dependencies."
  }
];

const groups = ["Core", "Primitives", "Integrations", "Helpers"] as const;
const unavailable: Record<(typeof groups)[number], string> = {
  Core: "Hosted handler execution and handler subscriptions, authorised file handles, staged uploads, useFileUrl and generated-file downloads are not available in this release.",
  Primitives: "The member directory and shared file stores are not available in this release.",
  Integrations: "Postgres is the only shipped company integration.",
  Helpers:
    "No Helpers ship in this release. patchy/csv is reserved, not implemented. The SDK does not yet offer PDF, spreadsheets beyond CSV, time-zone arithmetic, phone parsing, component libraries, rich text, charts or HTML sanitisation."
};

/** Rendered into the release-bound loop skill alongside the same metadata in index.json. */
export const sdkCapabilitiesMarkdown = [
  "## What the SDK gives you",
  "",
  "This catalogue describes the installed release, not future capabilities. Import the generated client by a relative path. Page runtime imports are patchy/preact and its JSX runtimes; patchy/csv is reserved. Everything else is company code: write or copy it into the patch.",
  "",
  ...groups.flatMap((group) => [
    `### ${group}`,
    "",
    ...sdkCapabilities
      .filter((capability) => capability.group === group)
      .flatMap((capability) => [
        `- ${capability.name}. Entrypoints: ${capability.entrypoints.map((entry) => `\`${entry}\``).join(", ")}. Runs: ${capability.runs}. Limits: ${capability.limits}`
      ]),
    "",
    unavailable[group],
    ""
  ])
].join("\n");
