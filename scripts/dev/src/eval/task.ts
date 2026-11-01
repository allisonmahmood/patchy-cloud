/**
 * What a `pnpm dev eval` task is: a request in a person's words, the scenario
 * it runs in, what it should produce, what good looks like for the judges, and
 * the checks that decide whether it worked. Tasks live in `tasks/`, one module
 * each, and come from the runner's own checkout for every side, so a base and
 * a head are graded by the same suite.
 */
import type { FrameLocator, Page } from "@playwright/test";

/** One of the run's people: the scenario's, under the run's own email and company. */
export interface RunPerson {
  readonly key: string;
  readonly name: string;
  readonly email: string;
  readonly role: "admin" | "member";
}

/** The patch a run is graded on: its final published version. */
export interface Target {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly tier: number;
  readonly version: number;
}

/** A person's browser on the target, once its frame is ready. */
export interface Opened {
  readonly page: Page;
  /** The patch's own frame. */
  readonly frame: FrameLocator;
}

export interface CheckContext {
  readonly target: Target;
  readonly people: ReadonlyArray<RunPerson>;
  /**
   * A fresh browser signed in as `person` (a key such as `ben`), with the
   * target open at `path` and ready. Closed when the check ends.
   */
  readonly open: (person: string, path?: string) => Promise<Opened>;
}

export type CheckOutcome =
  { readonly ok: true; readonly note?: string } | { readonly ok: false; readonly reason: string };

/** A task's own check: narrow and role- or text-based, so it survives different UIs. */
export interface TaskCheck {
  readonly name: string;
  readonly run: (ctx: CheckContext) => Promise<CheckOutcome>;
}

export interface Task {
  readonly id: string;
  /** A folder under `scenarios/`: whose company and people the run gets. */
  readonly scenario: string;
  /** The request, as a person would make it. The runner adds the same unattended line to every task. */
  readonly words: string;
  /** What the run should leave published: a new repo patch or a new single-file page. */
  readonly target: { readonly create: "repo" | "page" };
  /** The tier a correct answer must have, when only one is; omitted, the judges weigh the choice. */
  readonly tier?: 1 | 2;
  readonly minutes: number;
  /** Held-out tasks confirm a candidate before its PR and never feed the clusters an edit works from. */
  readonly heldOut: boolean;
  /** What good looks like, for the judges: the platform choices an expert would make. */
  readonly rubric: string;
  readonly checks: ReadonlyArray<TaskCheck>;
}

/** Appended to every task: the run is unattended, and asking instead of building is classified, not waited on. */
export const UNATTENDED =
  "I'm away until this is done, so don't wait on me: make reasonable calls and tell me what you assumed.";

export const taskPrompt = (task: Task) => `${task.words}\n\n${UNATTENDED}\n`;

/**
 * The numbers a page shows beside `word`, in reading order: one just before
 * it ("3 cheers", "3 total cheers") or the first within a short stretch after
 * it ("Cheers: 3", "CHEERS FROM THE TEAM\n3"). Numbers nowhere near the word,
 * such as a list or a member count, aren't read. `text` is visible text, as
 * `innerText` gives it; `word` matches its plural too.
 */
export const countsBeside = (text: string, word: string): ReadonlyArray<number> => {
  const name = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`(\d[\d,]*)\s+(?:[a-z]+\s+)?${name}s?\b|\b${name}s?\b[^\d]{0,40}?(\d[\d,]*)`,
    "gi"
  );
  return [...text.matchAll(pattern)].map((match) =>
    Number((match[1] ?? match[2]!).replaceAll(",", ""))
  );
};

/**
 * Whether one count went up by exactly one at each step: the same position in
 * every snapshot reading `n`, `n + 1`, `n + 2`…, with a snapshot taken after
 * each action. A count that didn't move never passes.
 */
export const steadyRise = (snapshots: ReadonlyArray<ReadonlyArray<number>>) => {
  const [first, ...rest] = snapshots;
  if (first === undefined || rest.length === 0) return false;
  return first.some((value, index) =>
    rest.every((snapshot, step) => snapshot[index] === value + step + 1)
  );
};
