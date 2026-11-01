/**
 * Grading a run, after its builder has ended: checks are authoritative, and
 * they look at what was published, not at the builder's working folder.
 *
 * - The target is the patch the run left published in its own company: for a
 *   `create` task, the most recently published one the run didn't stage; for
 *   an `existing` one, the staged patch it names.
 * - `published`: it has a served version, newer than the staged one for an
 *   existing target, at the task's tier when only one is right.
 * - `typechecks`: its published source, pulled into the run's HOME, passes
 *   `pnpm typecheck`.
 * - `opens ready`: a colleague opens it through the instance's keyed personas
 *   door and its frame renders content; console errors, and failed calls the
 *   patch's log records during grading against that version (`failedCalls`:
 *   any but the refusals a check expected), fail it. Desktop
 *   and phone screenshots are kept for the judges.
 * - The task's own checks, each with fresh browsers as the run's people, and
 *   as their agents through Patchy MCP for the people a check names.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Browser, Page } from "@playwright/test";
import { doorAgent, GRADER_AGENT, mintAgents } from "./agent.js";
import { HOME, runSandboxed, type SandboxSpec } from "./sandbox.js";
import type { StagedPatch } from "./stage.js";
import {
  type Agent,
  type CheckContext,
  type CheckOutcome,
  type ExpectedRefusal,
  isGraderTrouble,
  type RunPerson,
  type Target,
  type Task,
  type TaskTarget
} from "./task.js";

/**
 * The grader's own browser failed: it couldn't start, the instance wouldn't
 * sign anyone in, or it stopped somewhere grading doesn't attribute to the
 * patch. The grader's trouble, not the builder's, so it is an infrastructure
 * outcome. The message names the step, and for a call the grader made as
 * one of the run's people, its `GraderTrouble`'s message, which is safe;
 * never an address or what failed underneath.
 */
export class BrowserGradingFailed extends Schema.TaggedError<BrowserGradingFailed>()(
  "BrowserGradingFailed",
  { step: Schema.Literals(["launch", "sign-in", "browse", "call"]), cause: Schema.Defect() }
) {
  override get message() {
    return this.step === "launch"
      ? "The grader's browser couldn't start."
      : this.step === "sign-in"
        ? "The instance wouldn't sign the grader's people in."
        : this.step === "call"
          ? `A call the grader made as one of the run's people failed: ${isGraderTrouble(this.cause) ? this.cause.message : "Patchy didn't answer it."}`
          : "The grader's browser stopped partway.";
  }
}

export class NoGradingBrowser extends Schema.TaggedError<NoGradingBrowser>()(
  "NoGradingBrowser",
  {}
) {
  override get message() {
    return "The grader opens patches in Playwright's Chromium, which didn't start. Run `pnpm exec playwright install chromium`, then run again.";
  }
}

export const CheckResult = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["pass", "fail", "skipped"]),
  detail: Schema.NullOr(Schema.String)
});
export type CheckResult = typeof CheckResult.Type;

export const TargetRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  address: Schema.String,
  tier: Schema.Int,
  version: Schema.Int
});

export const Graded = Schema.Struct({
  target: Schema.NullOr(TargetRecord),
  checks: Schema.Array(CheckResult),
  /** Why grading itself couldn't finish, when it couldn't: the run is then infrastructure, not the builder's. */
  infra: Schema.NullOr(Schema.String),
  /** Inside the run's folder: the published source the judges read, when there is one. */
  source: Schema.NullOr(Schema.String),
  screenshots: Schema.Array(Schema.String)
});
export type Graded = typeof Graded.Type;

/** `patchy list --json`: the run's company's patches. */
export const Listed = Schema.Struct({
  patches: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      address: Schema.String,
      tier: Schema.Int,
      state: Schema.String,
      currentVersion: Schema.NullOr(Schema.Int),
      publishedAt: Schema.NullOr(Schema.String)
    })
  )
});
export const decodeListed = Schema.decodeUnknownOption(Schema.fromJsonString(Listed));

const LogEntry = Schema.Struct({
  startedAt: Schema.String,
  version: Schema.NullOr(Schema.Int),
  handler: Schema.String,
  outcome: Schema.String,
  code: Schema.NullOr(Schema.String),
  viewer: Schema.Struct({ id: Schema.String }),
  agent: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Schema.String })))
});
const LogPage = Schema.Struct({ entries: Schema.Array(LogEntry) });
const decodeLogPage = Schema.decodeUnknownOption(Schema.fromJsonString(LogPage));

/** An expected refusal as the log names its person: by their user id. */
export type LoggedRefusal = Omit<ExpectedRefusal, "person"> & { readonly userId: string };

/** How far apart the log's start of a call and Patchy's answer to it may be. */
const SAME_CALL_MS = 15_000;

const epochMs = (time: string) =>
  Option.getOrUndefined(Option.map(DateTime.make(time), DateTime.toEpochMillis));

/**
 * The calls a patch's log records during grading, against the graded
 * version, that count as failed: crashes and timeouts, and declared
 * refusals, except the grader's agent's, whose every answer its check reads
 * itself, and the ones a check expected. Each expected refusal excuses one
 * entry: the same person's refusal in the same handler with the same code,
 * started within moments of Patchy's answer to the check. Any other
 * refusal, even another of the same kind, still counts.
 */
export const failedCalls = (
  entries: ReadonlyArray<typeof LogEntry.Type>,
  grading: {
    readonly from: string;
    readonly version: number;
    readonly expected: ReadonlyArray<LoggedRefusal>;
  }
) => {
  const unspent = [...grading.expected];
  const excused = (entry: typeof LogEntry.Type) => {
    if (entry.outcome !== "handler_error") return false;
    if (entry.agent?.name === GRADER_AGENT) return true;
    const started = epochMs(entry.startedAt);
    const index = unspent.findIndex((expected) => {
      const answered = expected.at === null ? undefined : epochMs(expected.at);
      return (
        expected.userId === entry.viewer.id &&
        expected.handler === entry.handler &&
        expected.code === entry.code &&
        (answered === undefined ||
          (started !== undefined && Math.abs(answered - started) <= SAME_CALL_MS))
      );
    });
    if (index === -1) return false;
    unspent.splice(index, 1);
    return true;
  };
  return entries
    .filter(
      (entry) =>
        entry.startedAt >= grading.from &&
        entry.version === grading.version &&
        entry.outcome !== "success" &&
        !excused(entry)
    )
    .map((entry) => `${entry.handler}: ${entry.code ?? entry.outcome}`);
};

const served = (patch: (typeof Listed.Type)["patches"][number]): Target | null =>
  patch.state === "live" && patch.currentVersion !== null && patch.publishedAt !== null
    ? {
        id: patch.id,
        name: patch.name,
        address: patch.address,
        tier: patch.tier,
        version: patch.currentVersion
      }
    : null;

/** The staged patch an existing target names; none for a new patch. */
export const stagedTarget = (target: TaskTarget, staged: ReadonlyArray<StagedPatch>) =>
  "existing" in target ? staged.find((patch) => patch.key === target.existing) : undefined;

/**
 * The patch a run is graded on, while it is live and served: for a new patch,
 * the most recently published one in the run's company that it didn't stage;
 * for an existing one, the staged patch the task names, whatever its version.
 */
export const pickTarget = (
  listed: typeof Listed.Type,
  target: TaskTarget = { create: "repo" },
  staged: ReadonlyArray<StagedPatch> = []
): Target | null => {
  if ("existing" in target) {
    const named = stagedTarget(target, staged);
    const found = listed.patches.find((patch) => patch.id === named?.id);
    return found === undefined ? null : served(found);
  }
  const fixtures = new Set(staged.map((patch) => patch.id));
  const latest = listed.patches
    .filter((patch) => !fixtures.has(patch.id))
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .map(served)
    .find((patch) => patch !== null);
  return latest ?? null;
};

const pass = (name: string, detail: string | null = null): CheckResult => ({
  name,
  status: "pass",
  detail
});
const fail = (name: string, detail: string): CheckResult => ({ name, status: "fail", detail });
const skipped = (name: string, detail: string): CheckResult => ({
  name,
  status: "skipped",
  detail
});

/**
 * `published` for a served target. It fails when an existing patch has no
 * version newer than the one staged before the builder started, and then
 * nothing new is there to check (`fresh` is false); or when it is at a tier
 * the task rules out, which still leaves it to check.
 */
export const publishedCheck = (
  task: Pick<Task, "target" | "tier">,
  target: Target,
  staged: ReadonlyArray<StagedPatch>
): { readonly check: CheckResult; readonly fresh: boolean } => {
  const before = stagedTarget(task.target, staged);
  const said = `${target.name} v${target.version}, tier ${target.tier}`;
  if (before !== undefined && target.version <= before.version)
    return {
      check: fail("published", `${said}: no newer version than the one staged before the build.`),
      fresh: false
    };
  if (task.tier !== undefined && target.tier !== task.tier)
    return {
      check: fail("published", `${said}, where this task needs tier ${task.tier}.`),
      fresh: true
    };
  return { check: pass("published", said), fresh: true };
};

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

const READY_MS = 60_000;
const SETTLE_MS = 1_000;

const POLL_MS = 250;

/**
 * Waits until the shell has started the patch and its frame shows something,
 * polling for at most `READY_MS` of waiting. A cold tier 2 start shows the
 * shell's starting cover first.
 */
const waitReady = async (page: Page) => {
  const frame = page.frameLocator("iframe").first();
  for (let waited = 0; waited < READY_MS; waited += POLL_MS) {
    const starting = await page.locator('dialog[data-stream-status="starting"][open]').count();
    const text =
      starting > 0
        ? ""
        : await frame
            .locator("body")
            .innerText({ timeout: POLL_MS })
            .catch(() => "");
    if (text.trim() !== "") {
      await page.waitForTimeout(SETTLE_MS);
      return true;
    }
    await page.waitForTimeout(POLL_MS);
  }
  return false;
};

/** The instance's keyed personas door, which only the grader can open. */
export interface Door {
  readonly apiUrl: string;
  readonly key: string;
}

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 }
} as const;

/**
 * A fresh browser context signed in as `person` through the keyed door, then
 * on `address + path`. Signing in is checked on its own, without following
 * the redirect, so a page that answers an error or breaks is the patch's
 * result, and only a refused sign-in is the grader's trouble.
 */
export const openAs = async (
  browser: Browser,
  door: Door,
  person: RunPerson,
  address: string,
  path = "",
  viewport: { readonly width: number; readonly height: number } = VIEWPORTS.desktop
) => {
  const context = await browser.newContext({ viewport });
  const signedIn = await context.request
    .get(
      `${door.apiUrl}/dev/sign-in?as=${encodeURIComponent(person.email)}&return=%2F&key=${encodeURIComponent(door.key)}`,
      { maxRedirects: 0 }
    )
    .then((response) => response.status() === 303)
    .catch(() => false);
  if (!signedIn) {
    await context.close();
    return { signedIn: false } as const;
  }
  const page = await context.newPage();
  const errors: Array<string> = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  let crashed = false;
  page.on("crash", () => {
    crashed = true;
  });
  const navigated = await page.goto(address + path).then(
    (response) => ({ status: response?.status() ?? null, error: null }),
    (error: unknown) => ({
      status: null,
      error: error instanceof Error ? error.message : String(error)
    })
  );
  const broke =
    navigated.error !== null
      ? `it didn't load (${navigated.error.split("\n")[0]})`
      : navigated.status !== null && navigated.status >= 400
        ? `it answered ${navigated.status}`
        : null;
  // A renderer crash or a wait that throws while the patch comes up is the patch's result.
  const ready = broke === null && (await waitReady(page).catch(() => false));
  const why = broke ?? (crashed ? "its page crashed" : null);
  return { signedIn: true, context, page, errors, ready: ready && !crashed, broke: why } as const;
};

/**
 * The browser half of grading: `opens ready` as a colleague, the screenshots,
 * then the task's checks, each with fresh contexts closed after it. A check
 * whose pages logged a console or page error fails, however it ended.
 */
const inBrowser = (input: {
  readonly task: Task;
  readonly target: Target;
  readonly people: ReadonlyArray<RunPerson>;
  readonly colleague: RunPerson;
  readonly door: Door;
  readonly shots: string;
  /** Agent tokens, by person key, for the people checks act as through Patchy MCP. */
  readonly agents: ReadonlyMap<string, string>;
  readonly code: string;
  /** Where checks note the refusals they provoke and assert. */
  readonly expected: Array<LoggedRefusal>;
}) => {
  // Where it got to, for the error: set from inside the browser code and its callbacks.
  const state = { launched: false, signInRefused: false };
  return Effect.tryPromise({
    try: async () => {
      const { chromium, request } = await import("@playwright/test");
      const browser = await chromium.launch();
      state.launched = true;
      // Agents reach the door over plain HTTP, as any worker agent does.
      const api = input.agents.size === 0 ? undefined : await request.newContext();
      try {
        /** `openAs`, where the instance refusing to sign someone in is the grader's trouble. */
        const signedIn = async (
          person: RunPerson,
          path = "",
          viewport: (typeof VIEWPORTS)[keyof typeof VIEWPORTS] = VIEWPORTS.desktop
        ) => {
          const opened = await openAs(
            browser,
            input.door,
            person,
            input.target.address,
            path,
            viewport
          );
          if (!opened.signedIn) {
            state.signInRefused = true;
            throw new Error("sign-in");
          }
          return opened;
        };
        const screenshots: Array<string> = [];
        const browserErrors: Array<string> = [];
        const unready: Array<string> = [];
        for (const [name, viewport] of Object.entries(VIEWPORTS)) {
          const view = await signedIn(input.colleague, "", viewport);
          try {
            if (view.broke !== null) unready.push(`on ${name}, ${view.broke}`);
            else if (!view.ready) unready.push(`on ${name}, it never showed anything`);
            await view.page.screenshot({ path: `${input.shots}/${name}.png`, fullPage: true });
            screenshots.push(`${input.shots}/${name}.png`);
          } catch (error) {
            // The patch's page breaking the browser is the patch's result, not the grader's.
            unready.push(
              `on ${name}, the page broke (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`
            );
          }
          browserErrors.push(...view.errors);
          await view.context.close().catch(() => undefined);
        }
        const results: Array<CheckResult> = [];
        for (const check of input.task.checks) {
          const agents = new Map<string, Agent>();
          const views: Array<{
            readonly close: () => Promise<void>;
            readonly errors: ReadonlyArray<string>;
          }> = [];
          const person = (key: string) => {
            const found = input.people.find((p) => p.key === key);
            if (found === undefined) throw new Error(`The run has no person ${key}.`);
            return found;
          };
          const ctx: CheckContext = {
            target: input.target,
            people: input.people,
            person,
            code: input.code,
            expectRefusal: ({ person: key, ...refusal }) => {
              input.expected.push({ userId: person(key).id, ...refusal });
            },
            open: async (key, path) => {
              const who = person(key);
              const view = await signedIn(who, path);
              views.push({ close: () => view.context.close(), errors: view.errors });
              if (view.broke !== null) throw new Error(`For ${who.name}, ${view.broke}.`);
              if (!view.ready) throw new Error(`The patch never showed ${who.name} anything.`);
              return {
                page: view.page,
                frame: view.page.frameLocator("iframe").first(),
                close: () => view.context.close().catch(() => undefined)
              };
            },
            agent: (key) => {
              const known = agents.get(key);
              if (known !== undefined) return known;
              const token = input.agents.get(key);
              if (api === undefined || token === undefined || !(check.agents ?? []).includes(key))
                throw new Error(
                  `The check acts as ${key}'s agent without naming them in its agents.`
                );
              // Change keys are new to the person's agent across the whole grading.
              const agent = doorAgent({
                request: api,
                apiUrl: input.door.apiUrl,
                token,
                patch: input.target.id,
                keys: `${input.code}-${results.length}-${key}`
              });
              agents.set(key, agent);
              return agent;
            }
          };
          // The grader's own trouble ends grading as infrastructure; anything else is the check's.
          const outcome: CheckOutcome = await check.run(ctx).catch((error: unknown) => {
            if (isGraderTrouble(error)) throw error;
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
          });
          if (state.signInRefused) throw new Error("sign-in");
          const logged = views.flatMap((view) => view.errors);
          await Promise.all(views.map((view) => view.close().catch(() => undefined)));
          results.push(
            !outcome.ok
              ? fail(check.name, outcome.reason)
              : logged.length > 0
                ? fail(check.name, `It worked, but the page logged: ${logged[0]!.split("\n")[0]}`)
                : pass(check.name, outcome.note ?? null)
          );
        }
        return { unready, browserErrors, results, screenshots };
      } finally {
        await api?.dispose();
        await browser.close();
      }
    },
    catch: (cause) =>
      new BrowserGradingFailed({
        step: gradingStep(cause, state),
        cause
      })
  });
};

/** Where the grader's own browser or calls failed, for `BrowserGradingFailed`. */
export const gradingStep = (
  cause: unknown,
  state: { readonly launched: boolean; readonly signInRefused: boolean }
) =>
  isGraderTrouble(cause)
    ? "call"
    : state.signInRefused
      ? "sign-in"
      : state.launched
        ? "browse"
        : "launch";

/** Fails before any build starts when the grader's browser can't launch. */
export const checkBrowser = Effect.tryPromise({
  try: async () => {
    const { chromium } = await import("@playwright/test");
    await (await chromium.launch()).close();
  },
  catch: () => new NoGradingBrowser()
});

/** Grades a run once its builder has ended. Never fails: a check that can't run says why. */
export const grade = Effect.fn("Eval.grade")(function* (input: {
  readonly task: Task;
  readonly spec: SandboxSpec;
  readonly runDir: string;
  readonly people: ReadonlyArray<RunPerson>;
  readonly publisher: RunPerson;
  readonly door: Door;
  /** The scenario's patches, as published before the builder started. */
  readonly staged: ReadonlyArray<StagedPatch>;
  /** Where credentials grading makes go, for the scorecard's sanitizer. */
  readonly secrets: Ref.Ref<ReadonlyArray<string>>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const listed = yield* runSandboxed(input.spec, "patchy", ["list", "--json"], {
    timeout: "1 minute"
  });
  const names = [
    "published",
    "typechecks",
    "opens ready",
    ...input.task.checks.map((check) => check.name)
  ];
  /** Grading that couldn't finish: what ran so far, the rest skipped, and why. */
  const unfinished = (
    why: string,
    done: ReadonlyArray<CheckResult>,
    target: Target | null,
    source: string | null
  ): Graded => ({
    target,
    checks: [...done, ...names.slice(done.length).map((name) => skipped(name, why))],
    infra: why,
    source,
    screenshots: []
  });
  const decoded = decodeListed(listed.stdout);
  if (listed.exitCode !== 0 || Option.isNone(decoded))
    return unfinished("`patchy list` didn't answer.", [], null, null);
  const target = pickTarget(decoded.value, input.task.target, input.staged);
  const published =
    target === null
      ? {
          check: fail(
            "published",
            "existing" in input.task.target
              ? `${input.task.target.existing} isn't served any more.`
              : "Nothing new is published in the run's company."
          ),
          fresh: false
        }
      : publishedCheck(input.task, target, input.staged);
  if (target === null || !published.fresh)
    return {
      target,
      checks: [
        published.check,
        ...names.slice(1).map((name) => skipped(name, "Nothing new to check."))
      ],
      infra: null,
      source: null,
      screenshots: []
    } satisfies Graded;
  const checks: Array<CheckResult> = [published.check];

  let source: string | null = null;
  const page =
    "create" in input.task.target
      ? input.task.target.create === "page"
      : stagedTarget(input.task.target, input.staged)?.kind === "page";
  if (page) checks.push(skipped("typechecks", "A single-file page has no repo."));
  else {
    // `patchy pull` makes the folder, not its parent, and refuses one that isn't empty: a
    // retried grading starts from a fresh one.
    yield* fs.remove(path.join(input.spec.home, ".eval"), { recursive: true, force: true });
    yield* fs.makeDirectory(path.join(input.spec.home, ".eval"), { recursive: true });
    const pulled = yield* runSandboxed(
      input.spec,
      "patchy",
      ["pull", target.id, `${HOME}/.eval/published`, "--version", String(target.version), "--json"],
      { timeout: "5 minutes" }
    );
    if (pulled.exitCode !== 0)
      return unfinished("`patchy pull` couldn't fetch the published source.", checks, target, null);
    source = path.join("home", ".eval", "published");
    const typecheck = yield* runSandboxed(
      { ...input.spec, cwd: `${HOME}/.eval/published` },
      "pnpm",
      ["typecheck"],
      { timeout: "5 minutes" }
    );
    checks.push(
      typecheck.exitCode === 0
        ? pass("typechecks")
        : fail(
            "typechecks",
            lastLine(`${typecheck.stderr}\n${typecheck.stdout}`) || "It didn't finish."
          )
    );
  }

  const colleague =
    input.people.find((person) => person.key !== input.publisher.key) ?? input.publisher;
  const acting = new Set(input.task.checks.flatMap((check) => check.agents ?? []));
  const agents = yield* mintAgents(
    input.door.apiUrl,
    input.people.filter((person) => acting.has(person.key)),
    (token) => Ref.update(input.secrets, (known) => [...known, token])
  ).pipe(Effect.result);
  if (Result.isFailure(agents)) return unfinished(agents.failure.message, checks, target, source);
  const gradingFrom = DateTime.formatIso(yield* DateTime.now);
  const expected: Array<LoggedRefusal> = [];
  const browsed = yield* inBrowser({
    task: input.task,
    target,
    people: input.people,
    colleague,
    door: input.door,
    shots: input.runDir,
    agents: agents.success,
    code: (yield* Random.next).toString(36).slice(2, 8),
    expected
  }).pipe(Effect.result);
  if (Result.isFailure(browsed)) return unfinished(browsed.failure.message, checks, target, source);

  // Failed calls during grading, against the graded version; a tier 1 patch has no log.
  let failures: ReadonlyArray<string> = [];
  if (target.tier === 2) {
    const logged = yield* runSandboxed(
      input.spec,
      "patchy",
      ["logs", "--patch", target.id, "--failed", "--limit", "25", "--json"],
      { timeout: "1 minute" }
    );
    const page = decodeLogPage(logged.stdout);
    if (logged.exitCode !== 0 || Option.isNone(page))
      return unfinished("The patch's log couldn't be read.", checks, target, source);
    failures = failedCalls(page.value.entries, {
      from: gradingFrom,
      version: target.version,
      expected
    });
  }
  const { unready, browserErrors, results, screenshots } = browsed.success;
  const problems = [
    ...unready.map((problem) => `${colleague.name}'s view ${problem}`),
    ...browserErrors.slice(0, 3).map((error) => `console: ${error.split("\n")[0]}`),
    ...failures.slice(0, 3).map((failure) => `failed call ${failure}`)
  ];
  checks.push(
    problems.length === 0 ? pass("opens ready") : fail("opens ready", problems.join("; "))
  );
  checks.push(...results);
  return {
    target,
    checks,
    infra: null,
    source,
    screenshots: screenshots.map((file) => path.relative(input.runDir, file))
  } satisfies Graded;
});
