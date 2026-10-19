/**
 * `patchy logs` text output: one page of a patch's log as lines an agent can grep and a person
 * can read. `--json` prints the wire document instead, for `jq`.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { LogEntry, PatchLog } from "@patchy/api";

/**
 * Text stops after about as much as the page's own bound, since indenting every line of deep
 * stacks could otherwise multiply a page many times over.
 */
const TEXT_BYTES = 2 * 1024 * 1024;

/** What `ctx.log` and a thrown error write: a message, with optional details such as a stack. */
const decodeLine = Schema.decodeUnknownOption(
  Schema.Struct({ message: Schema.String, details: Schema.optionalKey(Schema.Json) })
);
const decodeStack = Schema.decodeUnknownOption(Schema.Struct({ stack: Schema.String }));

type Step = LogEntry["steps"][number];

/** A stack prints as it was thrown; any other details print as one line of JSON. */
function* logLines(lines: LogEntry["logLines"], indent: string): Generator<string> {
  for (const json of lines) {
    const line = decodeLine(json);
    if (Option.isNone(line)) {
      yield `${indent}log: ${JSON.stringify(json)}`;
      continue;
    }
    const { message, details } = line.value;
    yield `${indent}log: ${message}`;
    if (details === undefined) continue;
    const text = Option.match(decodeStack(details), {
      onNone: () => JSON.stringify(details),
      onSome: ({ stack }) => stack
    });
    for (const row of text.split("\n")) yield `${indent}  ${row}`;
  }
}

const settled = (outcome: string, code: string | null) =>
  code === null || code === outcome ? outcome : `${outcome} ${code}`;

const took = (durationMs: number | null) =>
  durationMs === null ? "unsettled" : `${durationMs} ms`;

function* entryLines(entry: LogEntry): Generator<string> {
  const viewer = entry.viewer.name ?? entry.viewer.id;
  const as = (principal: string) =>
    principal === "patch"
      ? "as the patch"
      : `as ${principal === entry.viewer.id ? viewer : principal}`;
  yield [
    entry.startedAt,
    entry.version === null ? "v?" : `v${entry.version}`,
    `${entry.handler} (${entry.kind})`,
    settled(entry.outcome, entry.code),
    took(entry.durationMs),
    viewer
  ].join(" · ");
  yield `  entry ${entry.id} · correlation ${entry.correlationId}${entry.replyDelivered ? "" : " · reply not delivered"}`;
  yield* logLines(entry.logLines, "  ");
  // Steps arrive shallowest first; each prints under the handler that made it, in time order.
  const children = new Map<string, Step[]>();
  for (const step of entry.steps)
    children.set(step.parentId, [...(children.get(step.parentId) ?? []), step]);
  function* under(parentId: string, level: number): Generator<string> {
    const indent = "  ".repeat(level);
    for (const step of children.get(parentId) ?? []) {
      const name = [
        step.name,
        step.kind === null ? null : `(${step.kind})`,
        step.resource,
        step.connection === null ? null : `on ${step.connection}`
      ]
        .filter((part) => part !== null)
        .join(" ");
      yield [
        `${indent}- ${name}`,
        as(step.effectivePrincipal),
        settled(step.outcome, step.code),
        took(step.durationMs),
        ...(step.rowCount === null ? [] : [`${step.rowCount} rows`]),
        ...(step.attempts > 1 ? [`${step.attempts} attempts`] : [])
      ].join(" · ");
      yield* logLines(step.logLines, `${indent}    `);
      yield* under(step.id, level + 1);
    }
  }
  yield* under(entry.id, 1);
  if (entry.stepsTruncated) yield "  … more steps than the log keeps";
}

function* pageLines(log: PatchLog, failed: boolean): Generator<string> {
  if (log.entries.length === 0)
    yield failed
      ? "No failed calls in this part of the log."
      : "No log entries. Only tier 2 handler calls write them; quiet successful queries don't.";
  for (const [index, entry] of log.entries.entries()) {
    if (index > 0) yield "";
    yield* entryLines(entry);
  }
}

/** The page up to `TEXT_BYTES`, then how to read further: older entries, or past the search window. */
export const render = (
  log: PatchLog,
  options: { readonly failed: boolean; readonly patch: Option.Option<string> }
): ReadonlyArray<string> => {
  const lines: string[] = [];
  let bytes = 0;
  for (const line of pageLines(log, options.failed)) {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > TEXT_BYTES) {
      lines.push("… the rest of this page is longer than text shows; read it all with --json.");
      break;
    }
    lines.push(line);
  }
  if (log.next === null) return lines;
  const again = [
    "patchy logs",
    ...Option.match(options.patch, { onNone: () => [], onSome: (id) => [`--patch ${id}`] }),
    ...(options.failed ? ["--failed"] : []),
    `--before ${log.next}`
  ].join(" ");
  return [
    ...lines,
    "",
    log.windowEnded
      ? `Searched 1,000 entries for failures. Search older ones: ${again}`
      : `Older entries: ${again}`
  ];
};
