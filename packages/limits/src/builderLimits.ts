// The public docs' Limits page: the limits a builder meets, from the same registry as
// docs/limits.md. Values, units, kinds and refusal codes come from the registry, so a change
// there changes the page on the next docs build. The words around them are written here.
//
// Only the ids listed below reach the page. Operator material stays out: override mechanics and
// deployment configuration, host and fleet capacity, internal timers and caches, and the bounds
// only an admin meets while connecting an integration.
import { registry, type LimitDefinition, type LimitId, type LimitRefusalCode } from "./registry.js";

type Registry = typeof registry;
/** Page text, or text built from registry values so it follows them. */
type Text = string | ((limits: Registry) => string);

/**
 * One row's words. `reached` says what happens when the limit is reached. A row whose registry
 * entry has a refusal code names it as `{code}`, filled in from the registry; one without a code
 * must say what happens, since nothing else on the page would.
 */
type RowWords<Id extends LimitId> = {
  /** What is limited, in the reader's words. */
  readonly what: Text;
  /** Whom or what the count belongs to. */
  readonly per: Text;
} & (Registry[Id]["refusal"] extends null
  ? { readonly reached: Text }
  : { readonly reached?: Text });

interface BuilderLimit {
  readonly id: LimitId;
  readonly what: Text;
  readonly per: Text;
  readonly reached?: Text;
}

interface BuilderLimitGroup {
  /** What the builder is doing when they meet these limits. */
  readonly title: string;
  readonly rows: ReadonlyArray<BuilderLimit>;
}

const row = <Id extends LimitId>(id: Id, words: RowWords<Id>): BuilderLimit => ({ id, ...words });

const snapshotLimit =
  "The CLI refuses the publish with {code} before building, naming the largest top-level entries, and warns past 80%.";

/** The allowlist, grouped by what the builder is doing, in page order. */
export const builderLimitGroups: ReadonlyArray<BuilderLimitGroup> = [
  {
    title: "Publishing a patch",
    rows: [
      row("publish.repo.bytes", {
        what: "Files kept with a version from its repo",
        per: "Each version",
        reached: snapshotLimit
      }),
      row("publish.repo.files", {
        what: "Number of files kept with a version from its repo",
        per: "Each version",
        reached: snapshotLimit
      }),
      row("rate.publish.perMinute", {
        what: "New publish attempts",
        per: "Each computer's publishing key"
      }),
      row("rate.patchCreate.perMinute", {
        what: "New patches",
        per: "Each computer's publishing key"
      })
    ]
  },
  {
    title: "Calling Patchy from a page",
    rows: [
      row("runtime.calls.perMinute", {
        what: "Calls from a patch's page",
        per: "Each person, per patch"
      }),
      row("frame.outstanding", { what: "Calls waiting for an answer", per: "Each open page" }),
      row("frame.heldBytes", { what: "Bytes held for one open page", per: "Each open page" }),
      row("runtime.call.bytes", { what: "One tier 1 call, as sent", per: "Each call" }),
      row("runtime.result.bytes", { what: "One tier 1 call's result", per: "Each call" }),
      row("runtime.mutation.deadline", { what: "Time for one tier 1 write", per: "Each write" }),
      row("company.admission.rate", {
        what: "Calls from pages and people's agents",
        per: "Each company"
      }),
      row("company.admission.burst", {
        what: "Calls allowed at once above that rate",
        per: "Each company"
      }),
      row("download.bytes", {
        what: "A file the page hands over to download",
        per: "Each download"
      })
    ]
  },
  {
    title: "Working with tables and the member directory",
    rows: [
      row("runtime.row.bytes", { what: "One row, as stored", per: "Each insert or update" }),
      row("runtime.batch.bytes", { what: "Rows written by one `insertMany`", per: "Each call" }),
      row("members.page", {
        what: "People in one page of the member directory's `list` or `search`",
        per: "Each page",
        reached: "The page ends with a cursor for the next one."
      }),
      row("members.getMany", { what: "Ids in one member directory `getMany`", per: "Each call" })
    ]
  },
  {
    title: "Storing files",
    rows: [
      row("runtime.file.bytes", { what: "One file, read or written", per: "Each file" }),
      row("files.stage.bytes", { what: "One staged upload", per: "Each upload" }),
      row("files.stage.count", {
        what: "Staged uploads not yet saved",
        per: "Each person, per patch"
      }),
      row("files.stage.viewerBytes", {
        what: "Bytes in staged uploads not yet saved",
        per: "Each person, per patch"
      }),
      row("files.stage.companyBytes", {
        what: "Bytes in staged uploads not yet saved",
        per: "Each company"
      }),
      row("files.stage.lifetime", {
        what: "Time a staged upload waits to be saved",
        per: "Each upload",
        reached: "The upload is removed, and saving it afterwards answers {code}."
      })
    ]
  },
  {
    title: "Keeping a screen live",
    rows: [
      row("subscriptions.document", {
        what: "Live queries",
        per: "Each open page",
        reached: "The newest is refused with {code}; the others keep running."
      }),
      row("subscriptions.patch", { what: "Live queries", per: "Each patch" }),
      row("subscriptions.company", { what: "Live queries", per: "Each company" }),
      row("subscriptions.snapshot.bytes", {
        what: "One live query's result",
        per: "Each live query",
        reached:
          "That live query ends with {code}, keeping its last result; the others keep running."
      }),
      row("stream.documents", {
        what: "Pages of one patch open at once",
        per: "Each person, per patch"
      })
    ]
  },
  {
    title: "Running tier 2 handlers",
    rows: [
      row("tier2.query.deadline", { what: "Time for one query", per: "Each call" }),
      row("tier2.mutation.deadline", {
        what: "Time for one mutation, waiting and every attempt included",
        per: "Each call"
      }),
      row("tier2.action.deadline", {
        what: "Time for one action, the handlers it runs included",
        per: "Each call"
      }),
      row("tier2.args.bytes", { what: "Arguments of one handler call", per: "Each call" }),
      row("tier2.query.resultBytes", { what: "One query's result", per: "Each call" }),
      row("tier2.mutation.resultBytes", { what: "One mutation's result", per: "Each call" }),
      row("tier2.action.resultBytes", { what: "One action's result", per: "Each call" }),
      row("tier2.mutation.attempts", {
        what: "Runs of one mutation when other writes conflict with it",
        per: "Each call",
        reached:
          "Each conflict runs the whole mutation again; when the last run conflicts too, the call fails with {code}."
      }),
      row("tier2.mutation.keyLifetime", {
        what: "Time a mutation's `retry()` can recover its first result",
        per: "Each mutation key",
        reached: "A `retry()` with an older key is refused."
      }),
      row("tier2.callbacks.count", {
        what: "Table, file and connection calls one handler run makes",
        per: "Each handler run; a handler it runs counts its own"
      }),
      row("tier2.callbacks.bytes", {
        what: "Bytes those calls carry",
        per: "Each call, across its attempts and the handlers it runs"
      }),
      row("tier2.callbacks.fileBytes", {
        what: "File bytes in one of those calls",
        per: "Each call to a file store"
      }),
      row("tier2.log.bytes", { what: "`ctx.log` output", per: "Each handler run" }),
      row("tier2.actions.viewer", {
        what: "Actions running at once",
        per: "Each person, per patch; their agent has its own"
      }),
      row("tier2.actions.company", { what: "Actions running at once", per: "Each company" }),
      row("execution.breaker.kills", {
        what: "Times a handler process is stopped for running past its deadline, stalling or running out of memory",
        per: (limits) =>
          `Each patch, across its versions, within ${formatValue(limits["execution.breaker.window"])}`,
        reached: (limits) =>
          `Calls are refused with {code} for ${formatValue(limits["execution.breaker.pause"])}; a new publish ends the pause.`
      })
    ]
  },
  {
    title: "Reading company connections",
    rows: [
      row("integration.deadline", {
        what: "Time for one call to a connection",
        per: "Each call, within its action's own time"
      }),
      row("runtime.postgres.bytes", { what: "Arguments of one Postgres call", per: "Each call" }),
      row("runtime.posthog.bytes", { what: "Arguments of one PostHog call", per: "Each call" }),
      row("runtime.pidgeon.bytes", { what: "Arguments of one Pidgeon call", per: "Each call" }),
      row("pidgeon.thread.messages", {
        what: "Messages in one page of a Pidgeon thread",
        per: "Each page",
        reached: "The answer carries `nextCursor` for the next page."
      }),
      row("pidgeon.sends.daily", {
        what: "Emails sent or replied from one inbox",
        per: "Each Pidgeon connection, per UTC day",
        reached: "A new email is refused with {code} and nothing is sent, until the next UTC day."
      }),
      row("runtime.attio.bytes", { what: "Arguments of one Attio call", per: "Each call" }),
      row("attio.call.bytes", {
        what: "What Attio sends back for one call, before Patchy decodes it",
        per: "Each call"
      }),
      row("runtime.imap.bytes", { what: "Arguments of one mailbox call", per: "Each call" }),
      row("imap.call.bytes", {
        what: "What the mail server sends back for one read",
        per: "Each call"
      }),
      row("imap.page.messages", {
        what: "Messages in one page of `scanMessages`, `listMessages` or `searchMessages`",
        per: "Each page",
        reached: "The page ends with a cursor to carry on."
      }),
      row("imap.getMessages.refs", {
        what: "Messages one `getMessages` reads",
        per: "Each call",
        reached: "A call naming more is refused."
      }),
      row("imap.message.text", {
        what: "One message's text",
        per: "Each message",
        reached: "The text is cut on a character and marked `truncated`."
      }),
      row("runtime.github.bytes", { what: "Arguments of one GitHub call", per: "Each call" }),
      row("github.response.bytes", {
        what: "One answer from GitHub, before Patchy decodes it",
        per: "Each answer"
      }),
      row("github.list.items", {
        what: "Items in a list answered without a cursor: workflows, a run's jobs, a commit's check runs or a pull request's reviews",
        per: "Each call",
        reached: "The answer says `complete: false`."
      }),
      row("github.log.bytes", {
        what: "One job log",
        per: "Each `jobs.log` call",
        reached: "The call answers the end of the log, marked `truncated`."
      })
    ]
  },
  {
    title: "Serving people's agents",
    rows: [
      row("mcp.requests.perMinute", {
        what: "Requests to Patchy MCP",
        per: "Each person, across their agents",
        reached:
          "A tool call is refused in its result with {code} and a time to wait; any other request is answered HTTP 429."
      }),
      row("mcp.calls.perMinute", {
        what: "`read_patch` and `change_patch` calls",
        per: "Each person, per patch, across their agents"
      }),
      row("mcp.inFlight", {
        what: "`read_patch` and `change_patch` calls running at once",
        per: "Each person, across their agents"
      }),
      row("mcp.body.bytes", {
        what: "One request to Patchy MCP",
        per: "Each request",
        reached: "Refused with {code}, as HTTP 413, before the request is read."
      })
    ]
  },
  {
    title: "Parsing CSV",
    rows: [
      row("csv.characters", { what: "Characters one `patchy/csv` parse reads", per: "Each parse" }),
      row("csv.cells", { what: "Cells one `patchy/csv` parse reads", per: "Each parse" })
    ]
  },
  {
    title: "Changing the company look",
    rows: [
      row("look.bytes", {
        what: "A look's files together, embedded fonts included",
        per: "Each look revision",
        reached: "Publishing the look is refused with `invalid_look`."
      }),
      row("look.brief.bytes", {
        what: "A look's `LOOK.md`",
        per: "Each look revision",
        reached: "Publishing the look is refused with `invalid_look`."
      })
    ]
  },
  {
    title: "Telling Patchy's team",
    rows: [
      row("feedback.sends.perMinute", {
        what: "Requests and feedback sent",
        per: "Each person, from the CLI, their agents and the portal together"
      })
    ]
  }
];

/** What happens at a refusal code, when a row says nothing more. */
const refusals: Record<LimitRefusalCode, string> = {
  rate_limited: "Refused with {code} and a time to wait.",
  too_many_requests: "Refused with {code}.",
  too_large: "Refused with {code}.",
  timeout: "Fails with {code}.",
  handler_timeout: "Fails with {code}.",
  handler_failed: "Fails with {code}.",
  unknown_outcome: "Ends with {code}.",
  limit_exceeded: "Refused with {code}.",
  write_conflict: "Fails with {code}.",
  busy: "Refused with {code}.",
  patch_paused: "Refused with {code} and a time to wait.",
  not_found: "Answers {code}.",
  source_rate_limited: "Refused with {code}."
};

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// Registry units in the page's words.
const unitWords: Readonly<Record<string, string>> = {
  callbacks: "calls",
  documents: "pages",
  refs: "messages",
  stages: "uploads",
  subscriptions: "live queries"
};

const count = (n: number): string => n.toLocaleString("en-US");
function plural(n: number, unit: string): string {
  const noun = unitWords[unit] ?? unit;
  if (n !== 1) return `${count(n)} ${noun}`;
  return `1 ${noun.endsWith("ies") ? `${noun.slice(0, -3)}y` : noun.replace(/s$/, "")}`;
}

/** A limit's value in its unit, as a reader says it: "20 MiB", "3 seconds", "300 calls a minute". */
export function formatValue(limit: LimitDefinition): string {
  const n = limit.default;
  if (limit.unit === "bytes") {
    for (const [size, name] of [
      [GiB, "GiB"],
      [MiB, "MiB"],
      [KiB, "KiB"]
    ] as const)
      if (n >= size && n % size === 0) return `${count(n / size)} ${name}`;
    // The MCP body cap is the tier 2 argument cap plus an envelope: "1 MiB and 64 KiB".
    if (n > MiB && n % KiB === 0)
      return `${count(Math.floor(n / MiB))} MiB and ${count((n % MiB) / KiB)} KiB`;
    return plural(n, "bytes");
  }
  if (limit.unit === "milliseconds") {
    if (n >= HOUR && n % HOUR === 0) return plural(n / HOUR, "hours");
    if (n >= 2 * MINUTE && n % MINUTE === 0) return plural(n / MINUTE, "minutes");
    if (n % SECOND === 0) return plural(n / SECOND, "seconds");
    return plural(n, "milliseconds");
  }
  const rate = /^(.+)\/(minute|second)$/.exec(limit.unit);
  if (rate?.[1] !== undefined) return `${plural(n, rate[1])} a ${rate[2]}`;
  return plural(n, limit.unit);
}

/** The "When it's reached" cell: the row's words, or its refusal code's, with the code filled in. */
function outcome(id: LimitId, reached: Text | undefined): string {
  const { refusal } = registry[id];
  const text =
    reached === undefined ? undefined : typeof reached === "string" ? reached : reached(registry);
  if (refusal === null) {
    // RowWords requires words for these rows; a placeholder would have nothing to name.
    if (text === undefined || text.includes("{code}"))
      throw new Error(
        `${id} has no refusal code, so its row must say what happens without {code}.`
      );
    return text;
  }
  const sentence = text ?? refusals[refusal];
  if (!sentence.includes("{code}"))
    throw new Error(`${id}'s row must name its refusal code as {code}.`);
  return sentence.replaceAll("{code}", `\`${refusal}\``);
}

const say = (text: Text): string => (typeof text === "string" ? text : text(registry));
// A pipe would split a table cell.
const cell = (text: string): string => text.replaceAll("|", "\\|");

// The id rides in the first cell: an id can't wrap, and a column of its own crowds the prose.
function line({ id, what, per, reached }: BuilderLimit): string {
  const limit: LimitDefinition = registry[id];
  const value = `${formatValue(limit)}${limit.kind === "operating" ? " (default)" : ""}`;
  return `| ${[`${say(what)} \`${id}\``, value, say(per), outcome(id, reached)].map(cell).join(" | ")} |`;
}

/**
 * The Limits page's Markdown body, without its title, which the docs app gives it. The docs app
 * writes it into its content before every `dev` and `build`.
 */
export function renderBuilderLimits(): string {
  return [
    "These are the limits a patch meets: its page, its handlers, its connections and the agents that use it. They are the ones in the release this site was built from.",
    "",
    "- A value marked **(default)** is the one Patchy starts with and can change, so treat it as typical rather than promised. Every other value is fixed for the release.",
    "- Rates, and counts of work running at once, are kept by each of Patchy's servers on its own.",
    "- The id after each limit is the `limitId` a refusal of that limit carries.",
    "",
    ...builderLimitGroups.flatMap((group) => [
      `## ${group.title}`,
      "",
      "| Limit | Value | Applies to | When it's reached |",
      "| --- | --- | --- | --- |",
      ...group.rows.map(line),
      ""
    ])
  ].join("\n");
}
