/**
 * What a `pnpm dev eval` task is: a request in a person's words, the scenario
 * it runs in, what it should produce, what good looks like for the judges, and
 * the checks that decide whether it worked. Tasks live in `tasks/`, one module
 * each, and come from the runner's own checkout for every side, so a base and
 * a head are graded by the same suite.
 */
import * as Schema from "effect/Schema";
import type { FrameLocator, Page } from "@playwright/test";
import type { Barrier } from "./barrier.js";
import type { StagedPatch } from "./stage.js";

/**
 * Patchy didn't answer a call the grader made as one of the run's people, or
 * answered it in a way that says nothing about the patch: the grader's
 * trouble, so grading ends as infrastructure and is tried again rather than
 * charged to the builder. Its message is safe for the scorecard; whatever
 * failed underneath, which can carry a credential, stays its `cause`.
 */
export class GraderTrouble extends Schema.TaggedError<GraderTrouble>()("GraderTrouble", {
  what: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return this.what;
  }
}

export const isGraderTrouble = Schema.is(GraderTrouble);

/** One of the run's people: the scenario's, under the run's own email and company. */
export interface RunPerson {
  /** Their user id, which is also their id in the member directory. */
  readonly id: string;
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
/** What a handler does, by its kind in the published manifest: only a query never writes. */
export type HandlerKind = "query" | "mutation" | "action";

export interface Opened {
  readonly page: Page;
  /** The patch's own frame. */
  readonly frame: FrameLocator;
  /** Closes this person's browser, as they would close the tab; the check closes any left open. */
  readonly close: () => Promise<void>;
  /**
   * The page's write barrier, up from its first request: it reads, but every
   * write is held unless a deliberate step lowers it (`barrier.deliberately`).
   */
  readonly barrier: Barrier;
}

/** One of the target's agent tools, as `open_patch` shows it. */
export interface AgentTool {
  readonly name: string;
  readonly kind: "read" | "change";
  readonly description: string;
  /** Its arguments, as JSON Schema. */
  readonly args: JsonSchema;
}

/** The parts of JSON Schema `open_patch` describes arguments with. */
export interface JsonSchema {
  readonly type?: string;
  readonly description?: string;
  readonly enum?: ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: JsonSchema;
  readonly anyOf?: ReadonlyArray<JsonSchema>;
  readonly minimum?: number;
  readonly maximum?: number;
}

/** What a tool call answered: its result, or the refusal a person's agent would read. */
export type AgentCall =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A person's own agent on the target, through Patchy MCP, as a worker agent reaches it. */
export interface Agent {
  readonly tools: () => Promise<ReadonlyArray<AgentTool>>;
  /** Runs one of its tools: a read through `read_patch`, a change through `change_patch` with a fresh key. */
  readonly call: (tool: AgentTool, args: Readonly<Record<string, unknown>>) => Promise<AgentCall>;
}

export interface CheckContext {
  readonly target: Target;
  readonly people: ReadonlyArray<RunPerson>;
  /** The run's person with this key; the check fails when there is none. */
  readonly person: (key: string) => RunPerson;
  /** A short code new to this grading, for words a check writes, so nothing already there can pass for them. */
  readonly code: string;
  /**
   * A fresh browser signed in as `person` (a key such as `ben`), with the
   * target open at `path` and ready. Closed when the check ends.
   */
  readonly open: (person: string, path?: string) => Promise<Opened>;
  /** The target as it was staged before the builder started; absent for a new patch. */
  readonly staged?: StagedPatch;
  /** `person`'s agent, for a person the check names in its `agents`. */
  readonly agent: (person: string) => Agent;
  /**
   * Notes one refusal the check provoked and asserts itself, such as a
   * member trying an admin's decision: `person`'s refusal in `handler` with
   * `code`, around `at` (the time Patchy answered, as its `Date` header gave
   * it). That one log entry then doesn't fail `opens ready`; any other
   * refusal during grading does.
   */
  readonly expectRefusal: (refusal: ExpectedRefusal) => void;
}

/** A refusal a check provoked: by whom (a person's key), where, with what code, and when. */
export interface ExpectedRefusal {
  readonly person: string;
  readonly handler: string;
  readonly code: string;
  readonly at: string | null;
}

export type CheckOutcome =
  { readonly ok: true; readonly note?: string } | { readonly ok: false; readonly reason: string };

/** A task's own check: narrow and role- or text-based, so it survives different UIs. */
export interface TaskCheck {
  readonly name: string;
  /** The people whose agents it acts as; grading gives each an agent connection first. */
  readonly agents?: ReadonlyArray<string>;
  readonly run: (ctx: CheckContext) => Promise<CheckOutcome>;
}

/**
 * What a run should leave published: a new repo patch, a new single-file
 * page, or a new version of one of the scenario's patches (by its `repo`, or
 * a file patch's `name`), which the run's publisher has published before the
 * builder starts.
 */
export type TaskTarget = { readonly create: "repo" | "page" } | { readonly existing: string };

export interface Task {
  readonly id: string;
  /** A folder under `scenarios/`: whose company and people the run gets. */
  readonly scenario: string;
  /** The request, as a person would make it. The runner adds the same unattended line to every task. */
  readonly words: string;
  readonly target: TaskTarget;
  /**
   * The scenario's patches (a `repo`, or a file patch's `name`) whose source
   * the builder finds in `~/Patchy`, as the person who built them would; the
   * rest are published but not on its machine. By default an existing
   * target's own, and none for a new patch.
   */
  readonly visible?: ReadonlyArray<string>;
  /** The tier a correct answer must have, when only one is; omitted, the judges weigh the choice. */
  readonly tier?: 1 | 2;
  readonly minutes: number;
  /** Held-out tasks confirm a candidate before its PR and never feed the clusters an edit works from. */
  readonly heldOut: boolean;
  /** What good looks like, for the judges: the platform choices an expert would make. */
  readonly rubric: string;
  readonly checks: ReadonlyArray<TaskCheck>;
}

/** The scenario patches whose source a task's builder finds on its machine. */
export const visibleRepos = (task: Pick<Task, "target" | "visible">): ReadonlyArray<string> =>
  task.visible ?? ("existing" in task.target ? [task.target.existing] : []);

/** Appended to every task: the run is unattended, and asking instead of building is classified, not waited on. */
export const UNATTENDED =
  "I'm away until this is done, so don't wait on me: make reasonable calls and tell me what you assumed.";

export const taskPrompt = (task: Task) => `${task.words}\n\n${UNATTENDED}\n`;

/**
 * The numbers a page shows as a count of `word`, in reading order: one just
 * before it, decoration allowed between ("3 cheers", "3 total cheers",
 * "3 🎉\ncheers"), or the first within a short stretch after it ("Cheers: 3
 * so far", "CHEERS FROM THE TEAM\n3"). A number near the word that counts
 * something else is read too; the check's visit-only step is what tells a
 * count of cheers from a count of visitors. `text` is visible text, as
 * `innerText` gives it; `word` matches its plural too.
 */
export const countsBeside = (text: string, word: string): ReadonlyArray<number> => {
  const name = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`(\d[\d,]*)[^\p{L}\d]{1,8}(?:\p{L}+[ \t]+)?${name}s?\b|\b${name}s?\b[^\d]{0,40}?(\d[\d,]*)`,
    "giu"
  );
  return [...text.matchAll(pattern)].map((match) =>
    Number((match[1] ?? match[2]!).replaceAll(",", ""))
  );
};

/**
 * Whether one count moved exactly as `steps` says across `snapshots`: the
 * same position reading the first snapshot's value plus `steps[k]` in the
 * k-th. With a step of 0 after a visit that changed nothing, a counter of
 * visits or people present can't pass for the count.
 */
export const countFollows = (
  snapshots: ReadonlyArray<ReadonlyArray<number>>,
  steps: ReadonlyArray<number>
) => {
  const [first] = snapshots;
  if (first === undefined || snapshots.length !== steps.length || snapshots.length < 2)
    return false;
  return first.some((value, index) =>
    snapshots.every((snapshot, k) => snapshot[index] === value + steps[k]!)
  );
};
