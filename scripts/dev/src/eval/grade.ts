/**
 * Grading a run, after its builder has ended: checks are authoritative, and
 * they look at what was published, not at the builder's working folder.
 *
 * - The target is the patch the run left published in its own company: for a
 *   `create` task, the most recently published one.
 * - `published`: it has a served version.
 * - `typechecks`: its published source, pulled into the run's HOME, passes
 *   `pnpm typecheck`.
 * - `opens ready`: a colleague opens it through the instance's keyed personas
 *   door and its frame renders content; console errors, and failed calls the
 *   patch's log records during grading against that version, fail it. Desktop
 *   and phone screenshots are kept for the judges.
 * - The task's own checks, each with fresh browsers as the run's people.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Browser, Page } from "@playwright/test";
import { HOME, runSandboxed, type SandboxSpec } from "./sandbox.js";
import type { CheckContext, CheckOutcome, RunPerson, Target, Task } from "./task.js";

/**
 * The grader's own browser failed: it couldn't start, the instance wouldn't
 * sign anyone in, or it stopped somewhere grading doesn't attribute to the
 * patch. The grader's trouble, not the builder's, so it is an infrastructure
 * outcome. The message names the step only, never an address.
 */
export class BrowserGradingFailed extends Schema.TaggedError<BrowserGradingFailed>()(
  "BrowserGradingFailed",
  { step: Schema.Literals(["launch", "sign-in", "browse"]), cause: Schema.Defect() }
) {
  override get message() {
    return this.step === "launch"
      ? "The grader's browser couldn't start."
      : this.step === "sign-in"
        ? "The instance wouldn't sign the grader's people in."
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

const Listed = Schema.Struct({
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
const decodeListed = Schema.decodeUnknownOption(Schema.fromJsonString(Listed));

const LogPage = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      startedAt: Schema.String,
      version: Schema.NullOr(Schema.Int),
      handler: Schema.String,
      outcome: Schema.String,
      code: Schema.NullOr(Schema.String)
    })
  )
});
const decodeLogPage = Schema.decodeUnknownOption(Schema.fromJsonString(LogPage));

/** The patch the run left published: the most recently published live patch in its company. */
export const pickTarget = (listed: typeof Listed.Type): Target | null => {
  const served = listed.patches
    .filter(
      (patch) =>
        patch.state === "live" && patch.currentVersion !== null && patch.publishedAt !== null
    )
    .sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!));
  const latest = served[0];
  return latest === undefined
    ? null
    : {
        id: latest.id,
        name: latest.name,
        address: latest.address,
        tier: latest.tier,
        version: latest.currentVersion!
      };
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

interface Door {
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
const openAs = async (
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
}) => {
  // Where it got to, for the error: set from inside the browser code and its callbacks.
  const state = { launched: false, signInRefused: false };
  return Effect.tryPromise({
    try: async () => {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      state.launched = true;
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
          const views: Array<{
            readonly close: () => Promise<void>;
            readonly errors: ReadonlyArray<string>;
          }> = [];
          const ctx: CheckContext = {
            target: input.target,
            people: input.people,
            open: async (key, path) => {
              const person = input.people.find((p) => p.key === key);
              if (person === undefined) throw new Error(`The run has no person ${key}.`);
              const view = await signedIn(person, path);
              views.push({ close: () => view.context.close(), errors: view.errors });
              if (view.broke !== null) throw new Error(`For ${person.name}, ${view.broke}.`);
              if (!view.ready) throw new Error(`The patch never showed ${person.name} anything.`);
              return {
                page: view.page,
                frame: view.page.frameLocator("iframe").first(),
                close: () => view.context.close().catch(() => undefined)
              };
            }
          };
          const outcome: CheckOutcome = await check.run(ctx).catch((error: unknown) => ({
            ok: false,
            reason: error instanceof Error ? error.message : String(error)
          }));
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
        await browser.close();
      }
    },
    catch: (cause) =>
      new BrowserGradingFailed({
        step: state.signInRefused ? "sign-in" : state.launched ? "browse" : "launch",
        cause
      })
  });
};

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
  const target = pickTarget(decoded.value);
  if (target === null)
    return {
      target: null,
      checks: [
        fail("published", "Nothing is published in the run's company."),
        ...names.slice(1).map((name) => skipped(name, "Nothing to check."))
      ],
      infra: null,
      source: null,
      screenshots: []
    } satisfies Graded;
  const checks: Array<CheckResult> = [
    pass("published", `${target.name} v${target.version}, tier ${target.tier}`)
  ];

  let source: string | null = null;
  if (input.task.target.create === "page")
    checks.push(skipped("typechecks", "A single-file page has no repo."));
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
  const gradingFrom = DateTime.formatIso(yield* DateTime.now);
  const browsed = yield* inBrowser({
    task: input.task,
    target,
    people: input.people,
    colleague,
    door: input.door,
    shots: input.runDir
  }).pipe(Effect.result);
  if (Result.isFailure(browsed)) return unfinished(browsed.failure.message, checks, target, source);

  // Failed calls during grading, against the graded version; a tier 1 patch has no log.
  const failures: Array<string> = [];
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
    for (const entry of page.value.entries)
      if (entry.startedAt >= gradingFrom && entry.version === target.version)
        failures.push(`${entry.handler}: ${entry.code ?? entry.outcome}`);
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
