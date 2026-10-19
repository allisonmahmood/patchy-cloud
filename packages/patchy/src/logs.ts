/**
 * `patchy logs` text output: one page of a patch's log as lines an agent can grep and a person
 * can read. `--json` prints the wire document instead, for `jq`.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { LogEntry, PatchLog } from "@patchy/api";

/** What `ctx.log` and a thrown error write: a message, with optional details such as a stack. */
const decodeLine = Schema.decodeUnknownOption(
  Schema.Struct({ message: Schema.String, details: Schema.optionalKey(Schema.Json) })
);
const decodeStack = Schema.decodeUnknownOption(Schema.Struct({ stack: Schema.String }));

const indented = (indent: string, text: string) =>
  text.split("\n").map((line) => `${indent}${line}`);

/** A stack prints as it was thrown; any other details print as indented JSON. */
const logLines = (lines: LogEntry["logLines"], indent: string) =>
  lines.flatMap((json) =>
    Option.match(decodeLine(json), {
      onNone: () => [`${indent}log: ${JSON.stringify(json)}`],
      onSome: ({ message, details }) => [
        `${indent}log: ${message}`,
        ...(details === undefined
          ? []
          : indented(
              `${indent}  `,
              Option.match(decodeStack(details), {
                onNone: () => JSON.stringify(details, null, 2),
                onSome: ({ stack }) => stack
              })
            ))
      ]
    })
  );

const settled = (outcome: string, code: string | null) =>
  code === null || code === outcome ? outcome : `${outcome} ${code}`;

const took = (durationMs: number | null) =>
  durationMs === null ? "unsettled" : `${durationMs} ms`;

const entryLines = (entry: LogEntry) => {
  const viewer = entry.viewer.name ?? entry.viewer.id;
  const as = (principal: string) =>
    principal === "patch"
      ? "as the patch"
      : `as ${principal === entry.viewer.id ? viewer : principal}`;
  // Steps arrive each after its parent, so a step's depth is known when it is reached.
  const depth = new Map([[entry.id, 0]]);
  const steps = entry.steps.flatMap((step) => {
    const level = (depth.get(step.parentId) ?? 0) + 1;
    depth.set(step.id, level);
    const indent = "  ".repeat(level);
    const name = [
      step.name,
      step.kind === null ? null : `(${step.kind})`,
      step.resource,
      step.connection === null ? null : `on ${step.connection}`
    ]
      .filter((part) => part !== null)
      .join(" ");
    return [
      [
        `${indent}- ${name}`,
        as(step.effectivePrincipal),
        settled(step.outcome, step.code),
        took(step.durationMs),
        ...(step.rowCount === null ? [] : [`${step.rowCount} rows`]),
        ...(step.attempts > 1 ? [`${step.attempts} attempts`] : [])
      ].join(" · "),
      ...logLines(step.logLines, `${indent}    `)
    ];
  });
  return [
    [
      entry.startedAt,
      entry.version === null ? "v?" : `v${entry.version}`,
      `${entry.handler} (${entry.kind})`,
      settled(entry.outcome, entry.code),
      took(entry.durationMs),
      viewer
    ].join(" · "),
    `  entry ${entry.id} · correlation ${entry.correlationId}${entry.replyDelivered ? "" : " · reply not delivered"}`,
    ...logLines(entry.logLines, "  "),
    ...steps,
    ...(entry.stepsTruncated ? ["  … more steps than the log keeps"] : [])
  ];
};

/** The page, then how to read further: older entries, or past the failure search's window. */
export const render = (
  log: PatchLog,
  options: { readonly failed: boolean; readonly patch: Option.Option<string> }
): ReadonlyArray<string> => {
  const again = (before: string) =>
    [
      "patchy logs",
      ...Option.match(options.patch, { onNone: () => [], onSome: (id) => [`--patch ${id}`] }),
      ...(options.failed ? ["--failed"] : []),
      `--before ${before}`
    ].join(" ");
  const lines =
    log.entries.length === 0
      ? [
          options.failed
            ? "No failed calls in this part of the log."
            : "No log entries. Only tier 2 handler calls write them; quiet successful queries don't."
        ]
      : log.entries.flatMap((entry, index) => [...(index === 0 ? [] : [""]), ...entryLines(entry)]);
  if (log.next === null) return lines;
  return [
    ...lines,
    "",
    log.windowEnded
      ? `Searched 1,000 entries for failures. Search older ones: ${again(log.next)}`
      : `Older entries: ${again(log.next)}`
  ];
};
