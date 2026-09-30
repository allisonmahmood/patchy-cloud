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
    runs: "Tier 1 and 2 pages through the hosted shell and patchy dev",
    limits:
      "Import by relative path. The generated implementation uses patchy/client; app code does not import it directly. Tier 2 uses server handlers, not direct named resources. me() is null on public tier 1 patches. Routing is shell-mediated; there is no outbound fetch or client storage."
  },
  {
    id: "core.generated-downloads",
    group: "Core",
    name: "Generated-file downloads",
    entrypoints: ["patchy/_generated/client.ts: patchy.download"],
    runs: "Tier 1 and 2 pages through the shell, including public tier 1 pages and patchy dev",
    limits:
      "download(name, data) accepts Blob, Uint8Array or ArrayBuffer, up to 20 MiB of encoded bytes enforced by the shell. The viewer approves the shell's filename and size card; Not now rejects. Success means browser handoff, not a saved file. Reloading or closing loses pending files. Separate from stored-file downloads."
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
    runs: "Tier 1 and 2 company pages through the hosted shell and patchy dev",
    limits:
      "Accepts table list/get, member-directory callables or generated server queries. Returns status, data, error and loading. Retains data through errors; a permanent error ends the subscription without restarting for another consumer or reconnect."
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
      "Query, mutation and action builders are available. Publish bundles one closed server module and the instance re-derives its descriptors. Page imports of server code must be type-only."
  },
  {
    id: "core.server-calls",
    group: "Core",
    name: "Server handlers",
    entrypoints: ["patchy/_generated/client.ts: patchy.server", "patchy/_generated/server.ts"],
    runs: "Tier 2 company pages; ECS fleet execution in production, local execution in dev and tests",
    limits:
      "Queries share a read-only snapshot with a 3-second deadline; resource-free queries need no company database. Mutations use one SERIALIZABLE transaction, up to three attempts in 5 seconds and a keyed retry() for unknown outcomes. Actions have 60 seconds, declared connections and nested queries or mutations. Shared access is checked per callback. Lost query replies retry once; actions are never replayed. Args are at most 1 MiB, mutation results 64 KiB and query/action results 8 MiB. Local dev uses the same engine and callback path with live server rebinding and a colleague mount, not production scheduling, operating capacity or containment."
  },
  {
    id: "core.server-subscriptions",
    group: "Core",
    name: "Live server queries",
    entrypoints: [
      "patchy/_generated/client.ts: patchy.server.<module>.<query>.subscribe",
      "patchy/preact: useQuery"
    ],
    runs: "Tier 2 company pages through the hosted shell and patchy dev, over the document stream",
    limits:
      "Queries only. Host-observed reads determine dependencies; read only what the screen needs. A source refusal can recover after reshare, even on the first run. Permanent errors retain the last data. Canonical arguments share one subscription, with remount grace, hidden suspension and reconciliation. At most 64 subscriptions per document, 256 per patch, 1,024 per company and 8 MiB per snapshot. Member reads are outside the company snapshot."
  },
  {
    id: "primitives.tables",
    group: "Primitives",
    name: "Owned tables",
    entrypoints: [
      "patchy/_generated/client.ts: patchy.tables",
      "patchy/_generated/server.ts: ctx.tables"
    ],
    runs: "Tier 1 pages through the broker; tier 2 queries, mutations and actions; local PGlite in patchy dev",
    limits:
      "Indexed reads. Tier 1 writes act as the viewer, with no cross-call transaction or row-level authorization. Tier 2 writes act as the patch; mutation handlers group owned-table operations into one transaction and enforce the patch's rules. Queries are read-only. Rows are at most 1 MiB, batches at most 1,000 rows and 8 MiB, and list pages at most 1,000 rows."
  },
  {
    id: "primitives.files",
    group: "Primitives",
    name: "Owned file stores and downloads",
    entrypoints: [
      "patchy/_generated/client.ts: patchy.files",
      "patchy/_generated/server.ts: ctx.files"
    ],
    runs: "Tier 1 pages through the broker; tier 2 queries read metadata and actions read or write bytes; downloads through the shell; local files in patchy dev",
    limits:
      "Objects are at most 20 MiB; names are at most 512 UTF-8 bytes. Tier 1 url(name) returns a frame-local blob URL, not a public link. Tier 2 pages use handles returned by handlers, not store names. File writes are not part of a mutation transaction. A shared store publishes read access to every file."
  },
  {
    id: "core.file-handles",
    group: "Core",
    name: "Authorised file handles",
    entrypoints: [
      "patchy/_generated/client.ts: patchy.files.url and patchy.files.download",
      "patchy/preact: useFileUrl"
    ],
    runs: "Tier 2 company pages through the signed-in shell",
    limits:
      "Handlers return 57-character handles from file metadata. Every redemption checks live authority. url(handle) returns a frame-local blob URL; useFileUrl releases it on change or unmount and clears failed images. Downloads need a click on the shell's filename and size card. Closing or reloading discards pending downloads."
  },
  {
    id: "core.staged-uploads",
    group: "Core",
    name: "Staged uploads",
    entrypoints: [
      "patchy/_generated/client.ts: patchy.files.stage and patchy.files.discard",
      "patchy/_generated/server.ts: t.upload and ctx.files"
    ],
    runs: "Tier 2 company pages through the shell; adoption in actions, including patchy dev",
    limits:
      "Stage at most 20 MiB without sending bytes through server code. Uploads are single-use, viewer/patch/version-bound and expire after one hour. At most 16 stages and 100 MiB per viewer per patch; 1 GiB per company by default. Adoption writes a file pointer, not a copy. A following mutation is separate: if it fails, the file remains. A content type is a claim."
  },
  {
    id: "primitives.shared-tables",
    group: "Primitives",
    name: "Shared-table reads",
    entrypoints: [
      "patchy/_generated/client.ts: patchy.shared",
      "patchy/_generated/server.ts: ctx.shared"
    ],
    runs: "Tier 1 pages through the broker; tier 2 queries and actions; synthetic fixtures in patchy dev",
    limits:
      "Declare a shared source first. Reads are bounded and indexed; writes are unavailable. Source sharing and access are checked live."
  },
  {
    id: "primitives.shared-stores",
    group: "Primitives",
    name: "Shared file-store reads",
    entrypoints: [
      "patchy/_generated/client.ts: patchy.shared",
      "patchy/_generated/server.ts: ctx.shared"
    ],
    runs: "Tier 1 pages through the broker; tier 2 queries and actions; invented file fixtures in patchy dev",
    limits:
      "Stores are shared whole and read-only. Tier 2 queries read list and stat metadata; actions also read bytes. Every read and download checks live source access and sharing. Files are at most 20 MiB; list pages at most 1,000 files."
  },
  {
    id: "primitives.members",
    group: "Primitives",
    name: "Company member directory and member columns",
    entrypoints: [
      "patchy/config: members and t.member",
      "patchy/_generated/client.ts: patchy.members",
      "patchy/_generated/server.ts: ctx.members"
    ],
    runs: "Tier 1 company viewers through the broker; tier 2 queries, mutations and actions; two mount identities in patchy dev",
    limits:
      "Declare with patchy add members. Candidates are active company users; resolution includes deactivated users. Prefix search only, pages of 50, getMany at most 1,000 ids. Tier 1 directory reads are subscribable; tier 2 queries track directory dependencies. Member columns check new assignments on arrival, outside the company transaction snapshot. Outsiders and direct tier 2 page operations are refused."
  },
  {
    id: "integrations.postgres",
    group: "Integrations",
    name: "Company Postgres reads",
    entrypoints: [
      "patchy/_generated/client.ts: patchy.connections",
      "patchy/_generated/server.ts: ctx.connections"
    ],
    runs: "Tier 1 pages through the broker; tier 2 actions; synthetic fixtures in patchy dev",
    limits:
      "Declare a connected company source. Read-only queries return at most 1,000 rows and 8 MiB, with a 10-second statement timeout and a 15-second service deadline bounded by the action's remaining time. Credentials stay with Patchy and access is checked on each call. Queries and mutations cannot use ctx.connections; Postgres reads are not live-query dependencies."
  },
  {
    id: "helpers.csv",
    group: "Helpers",
    name: "CSV text codec",
    entrypoints: ["patchy/csv"],
    runs: "Page and server import graphs; tier 1 and 2 pages and tier 2 handlers",
    limits:
      "Based on PapaParse with Patchy's own synchronous parse, records and stringify API. Parsing allows 10,000,000 input characters and 1,000,000 cells. Records reject duplicate headers and report wrong-width rows by physical line without padding. Stringify writes CRLF; formula protection is on by default, leaves numbers untouched and is not lossless."
  }
];

const groups = ["Core", "Primitives", "Integrations", "Helpers"] as const;
const unavailable: Partial<Record<(typeof groups)[number], string>> = {
  Core: "The ECS fleet implementation is built. Role-only Fargate acceptance and the first production deploy remain pending. window.print() works in the frame, including browser print-to-PDF.",
  Integrations: "Postgres is the only shipped company integration.",
  Helpers:
    "The SDK does not yet offer PDF generation, spreadsheets beyond CSV, time-zone arithmetic, phone parsing, component libraries, rich text, charts or HTML sanitisation."
};

/** Rendered into the release-bound loop skill alongside the same metadata in index.json. */
export const sdkCapabilitiesMarkdown = [
  "## What the SDK gives you",
  "",
  "This catalogue describes the installed release, not future capabilities. Import the generated client by a relative path. Page runtime imports are patchy/preact with its JSX runtimes and patchy/csv; server runtime imports are patchy/server and patchy/csv. Everything else is company code: write or copy it into the patch.",
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
    ...(unavailable[group] === undefined ? [] : [unavailable[group]]),
    ""
  ])
].join("\n");
