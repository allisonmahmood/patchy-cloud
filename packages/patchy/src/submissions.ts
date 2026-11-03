/**
 * What `patchy request` and `patchy feedback` print and check before sending: the documents agents
 * read under `--json`, the lines a person reads otherwise, and each text's bounds. A filed
 * request's document adds, to each match, the exact command that links to it, and `next`, which
 * says what is left to do. Pure: the commands in `commands.ts` call the instance and hand the
 * answers here.
 */
import {
  type RequestBrief,
  type RequestFiled,
  type RequestLinked,
  SUBMISSION_TEXT_MAX,
  SUBMISSION_TITLE_MAX,
  SUBMISSION_TITLE_MIN,
  type SubmissionKind,
  type Submissions
} from "@patchy/api";

/**
 * `value` as one POSIX shell word: as it is when only safe characters make it up, otherwise
 * single-quoted with each `'` closed, escaped and reopened. A general request's id is written by
 * Patchy's team and has no shape, so a command built from one is quoted before it is shown.
 */
export const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

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
    link: `patchy request link ${shellWord(filed.id)} ${shellWord(match.id)}`
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

const count = (value: number) => value.toLocaleString("en-US");
const characters = (text: string) => [...text].length;

/**
 * A text the CLI sends, with the bounds the store holds it to: characters once it is normalized as
 * the store normalizes it.
 */
export interface TextField {
  /** How a message names it. */
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly normalize: (text: string) => string;
}

export const requestText: TextField = {
  name: "The request",
  min: SUBMISSION_TITLE_MIN,
  max: SUBMISSION_TITLE_MAX,
  normalize: (text) => text.replace(/\s+/gu, " ").trim()
};
/** A blank why is none, so it has no minimum. */
export const whyText: TextField = {
  name: "--why",
  min: 0,
  max: SUBMISSION_TEXT_MAX,
  normalize: (text) => text.trim()
};
export const feedbackText: TextField = {
  name: "The feedback",
  min: 1,
  max: SUBMISSION_TEXT_MAX,
  normalize: (text) => text.trim()
};

/**
 * Whether text read so far is already too long for `field`: more input can only lengthen it.
 * Whitespace past four times the bound counts too, so an endless pipe of blanks ends as well.
 */
export const pastBound = (field: TextField, text: string) =>
  text.length > 4 * field.max || characters(field.normalize(text)) > field.max;

/** Why `text` can't be sent as `field`, or undefined when it can. */
export const outOfBounds = (field: TextField, text: string) => {
  const length = characters(field.normalize(text));
  if (length >= field.min && length <= field.max) return undefined;
  const bounds =
    field.min > 0 ? `${count(field.min)}–${count(field.max)}` : `at most ${count(field.max)}`;
  return `${field.name} must be ${bounds} characters; it is ${count(length)}. Nothing was sent.`;
};
