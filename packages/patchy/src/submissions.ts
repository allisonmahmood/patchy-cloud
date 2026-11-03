/**
 * What `patchy request` and `patchy feedback` print: the documents agents read under `--json` and
 * the lines a person reads otherwise. A filed request's document adds, to each match, the exact
 * command that links to it, and `next`, which says what is left to do. Pure: the commands in
 * `commands.ts` call the instance and hand the answers here.
 */
import type {
  RequestBrief,
  RequestFiled,
  RequestLinked,
  SubmissionKind,
  Submissions
} from "@patchy/api";

/** A match as `patchy request --json` shows it: the wire's brief and the command that links to it. */
export interface Match extends RequestBrief {
  readonly link: string;
}

/** What is left after filing: nothing, unless a match is the same need or has shipped. */
export const next = (similar: ReadonlyArray<RequestBrief>): string =>
  [
    "Nothing else is required.",
    ...(similar.length === 0
      ? []
      : [
          "Link a match only when it fully meets the need: run its link command, with --why saying why it does."
        ]),
    ...(similar.some((match) => match.status === "shipped")
      ? ["A match has shipped: tell the person, using its note."]
      : [])
  ].join(" ");

/** `patchy request`'s document: the wire's answer, a link command on each match, and `next`. */
export const filedDocument = (filed: RequestFiled) => ({
  ok: true,
  id: filed.id,
  similar: filed.similar.map((match): Match => ({
    ...match,
    link: `patchy request link ${filed.id} ${match.id}`
  })),
  next: next(filed.similar)
});

const briefLine = (brief: RequestBrief) => `${brief.id}  ${brief.status}  ${brief.title}`;

/** The id, then each match with its note and link command, then what is left. */
export const filedLines = (document: ReturnType<typeof filedDocument>) => [
  `Sent request ${document.id} to Patchy's team.`,
  ...(document.similar.length === 0
    ? []
    : [
        "Similar requests:",
        ...document.similar.flatMap((match) => [
          `  ${briefLine(match)}`,
          ...(match.note === undefined ? [] : [`    ${match.note}`]),
          `    Link: ${match.link}`
        ])
      ]),
  document.next
];

export const linkedLines = (linked: RequestLinked) => [
  `Linked ${linked.id} to ${briefLine(linked.link)}`,
  ...(linked.link.note === undefined ? [] : [`  ${linked.link.note}`])
];

/** Each kind in the plural, as a list of them reads. */
export const kindNouns = { request: "requests", feedback: "feedback" } satisfies Record<
  SubmissionKind,
  string
>;

/** A page of what the person sent, newest first, and the command for the next page. */
export const listLines = (page: Submissions, kind: SubmissionKind) => [
  ...(page.submissions.length === 0 && page.nextCursor === null
    ? [`You have sent no ${kindNouns[kind]}.`]
    : page.submissions.flatMap((sent) => {
        const via = `${sent.surface}${sent.agent === null ? "" : `, ${sent.agent}`}`;
        return sent.kind === "request"
          ? [
              `${sent.id}  ${sent.createdAt}  ${sent.status}  ${sent.title}  (${via})`,
              ...(sent.link === null ? [] : [`  Linked to ${briefLine(sent.link)}`])
            ]
          : [`${sent.id}  ${sent.createdAt}  (${via})`];
      })),
  ...(page.nextCursor === null ? [] : [`More: patchy ${kind} list --cursor ${page.nextCursor}`])
];
