// @effect-diagnostics nodeBuiltinImport:off -- PROTOTYPE (#1090): finding a browser executable and writing screenshots are filesystem work beside a Promise browser driver.
// @effect-diagnostics globalDate:off -- PROTOTYPE (#1090): the Promise browser driver times its own waits.
// @effect-diagnostics globalDateInEffect:off -- PROTOTYPE (#1090): as above, and names its run folder by the wall clock.
/**
 * PROTOTYPE for #1090, never merged: `patchy dev act` opens the running dev session's pages in a
 * headless browser as dev people and runs steps on them, the way a person would, through the real
 * shell around the patch frame. It answers what the supported way for a builder's agent to press
 * keys and click in its dev page should look like; see the PR for what it showed.
 *
 * Steps are words in order: `press <keys>`, `click <name>`, `type <field> <text>`, `wait <text>`,
 * `gone <text>`,
 * `open <route>`, `shot`, and `as <person>` to move the next steps to another person's page.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright-core";
import { LocalError } from "./CliError.js";
import { colleague, guest } from "./devMembers.js";
import type { Daemon } from "./devState.js";

const people = ["you", "colleague", "guest"] as const;
type Person = (typeof people)[number];
const isPerson = (word: string): word is Person => (people as readonly string[]).includes(word);

/** One step, as an agent writes it on the command line. */
type Step =
  | { readonly verb: "press"; readonly keys: string }
  | { readonly verb: "click"; readonly target: string }
  | { readonly verb: "type"; readonly field: string; readonly text: string }
  | { readonly verb: "wait" | "gone"; readonly text: string }
  | { readonly verb: "open"; readonly route: string }
  | { readonly verb: "shot" }
  | { readonly verb: "as"; readonly person: Person };

const arity = { press: 1, click: 1, type: 2, wait: 1, gone: 1, open: 1, shot: 0, as: 1 } as const;
type Verb = keyof typeof arity;
const isVerb = (word: string): word is Verb => Object.hasOwn(arity, word);

const usage =
  "Steps are words in order: press <keys>, click <name>, type <field> <text>, wait <text>, gone <text>, open <route>, shot, as <you|colleague|guest>. For example: patchy dev act press 'G H' wait 'Home' as colleague click 'Save'.";

/** Reads the step words, or says which word doesn't fit. */
export const parseSteps = (words: readonly string[]): Step[] | LocalError => {
  const steps: Step[] = [];
  for (let index = 0; index < words.length;) {
    const verb = words[index]!;
    if (!isVerb(verb))
      return new LocalError({
        message: `\`${verb}\` isn't a step. ${usage}`,
        code: "invalid_steps"
      });
    const args = words.slice(index + 1, index + 1 + arity[verb]);
    if (args.length < arity[verb])
      return new LocalError({
        message: `\`${verb}\` needs ${arity[verb]} word${arity[verb] === 1 ? "" : "s"} after it. ${usage}`,
        code: "invalid_steps"
      });
    index += 1 + arity[verb];
    switch (verb) {
      case "press":
        steps.push({ verb, keys: args[0]! });
        break;
      case "click":
        steps.push({ verb, target: args[0]! });
        break;
      case "type":
        steps.push({ verb, field: args[0]!, text: args[1]! });
        break;
      case "wait":
      case "gone":
        steps.push({ verb, text: args[0]! });
        break;
      case "open":
        steps.push({ verb, route: args[0]!.startsWith("/") ? args[0]! : `/${args[0]!}` });
        break;
      case "shot":
        steps.push({ verb });
        break;
      case "as": {
        const person = args[0]!;
        if (!isPerson(person))
          return new LocalError({
            message: `\`as ${person}\`: the dev people are you, colleague and guest.`,
            code: "invalid_steps"
          });
        steps.push({ verb, person });
        break;
      }
    }
  }
  return steps;
};

const describeStep = (step: Step) =>
  step.verb === "press"
    ? `press ${step.keys}`
    : step.verb === "click"
      ? `click ${step.target}`
      : step.verb === "type"
        ? `type ${step.field} ${step.text}`
        : step.verb === "wait" || step.verb === "gone"
          ? `${step.verb} ${step.text}`
          : step.verb === "open"
            ? `open ${step.route}`
            : step.verb === "as"
              ? `as ${step.person}`
              : "shot";

/**
 * Hotkey notation to Playwright's: `Mod` is ⌘ on a Mac and Ctrl elsewhere, a letter never implies
 * Shift, and a sequence is chords separated by single spaces, so `G H` is two presses.
 */
export const chords = (keys: string): string[] =>
  keys
    .split(" ")
    .filter((chord) => chord !== "")
    .map((chord) => {
      const parts = chord.endsWith("++")
        ? [...chord.slice(0, -2).split("+"), "+"]
        : chord.split("+");
      const key = parts.pop()!;
      const modifiers = parts.map((part) => {
        const name = part.toLowerCase();
        return name === "mod"
          ? "ControlOrMeta"
          : name === "ctrl" || name === "control"
            ? "Control"
            : name === "alt" || name === "option"
              ? "Alt"
              : name === "cmd" || name === "meta"
                ? "Meta"
                : name === "shift"
                  ? "Shift"
                  : part;
      });
      const named: Record<string, string> = { esc: "Escape", space: "Space", return: "Enter" };
      const resolved =
        named[key.toLowerCase()] ??
        (/^[a-z]$/i.test(key)
          ? modifiers.includes("Shift")
            ? key.toUpperCase()
            : key.toLowerCase()
          : key);
      return [...modifiers, resolved].join("+");
    });

// --- the browser --------------------------------------------------------------------------------

interface FoundBrowser {
  /** `env` for PATCHY_BROWSER, `system` for an installed Chrome-family browser, `playwright` for a downloaded one. */
  readonly source: "env" | "system" | "playwright";
  readonly path?: string;
}

const envKeys = [
  "PATCHY_BROWSER",
  "PATH",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "LOCALAPPDATA"
] as const;
/** The environment the browser search reads: where browsers live, and PATCHY_BROWSER's override. */
type Env = Partial<Record<(typeof envKeys)[number], string>>;

/** Chrome-family browsers a machine may already have, most likely first. */
const systemCandidates = (env: Env): string[] => {
  const onPath = (name: string) =>
    (env.PATH ?? "")
      .split(path.delimiter)
      .filter((dir) => dir !== "")
      .map((dir) => path.join(dir, name));
  if (process.platform === "darwin")
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    ];
  if (process.platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (root) => root !== undefined
    );
    return roots.flatMap((root) => [
      path.join(root, "Google/Chrome/Application/chrome.exe"),
      path.join(root, "Microsoft/Edge/Application/msedge.exe")
    ]);
  }
  return [
    "/opt/google/chrome/chrome",
    ...[
      "google-chrome-stable",
      "google-chrome",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
      "brave-browser"
    ].flatMap(onPath)
  ];
};

const noBrowser = (tried: readonly string[]) =>
  new LocalError({
    message: `No Chrome-family browser found, so patchy dev act can't open the page. Install Google Chrome or Chromium, set PATCHY_BROWSER to one, or rerun with --install-browser to download Playwright's headless Chromium (about 110 MB) once. Looked for: ${tried.join(", ")}.`,
    code: "no_browser"
  });

/** Downloads Playwright's headless Chromium for this release, its progress on stderr. */
const installBrowser = () =>
  new Promise<void>((resolve, reject) => {
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
    const child = spawn(process.execPath, [cli, "install", "chromium-headless-shell"], {
      stdio: ["ignore", process.stderr, process.stderr]
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`The browser download exited ${code}.`))
    );
  });

/**
 * PATCHY_BROWSER, then a browser the machine has, then Playwright's own download if present.
 * `install` skips the machine's browsers for Playwright's own, downloading it first if missing.
 */
const findBrowser = async (
  chromium: typeof import("playwright-core").chromium,
  install: boolean,
  env: Env
): Promise<FoundBrowser | LocalError> => {
  // Playwright keeps each browser in a folder named for its revision, finished when it holds this.
  const own = chromium.executablePath();
  const revision = own.match(/chromium-(\d+)/)?.[1] ?? "";
  const shell = path.join(
    own.slice(0, own.indexOf(`chromium-${revision}`)),
    `chromium_headless_shell-${revision}`,
    "INSTALLATION_COMPLETE"
  );
  if (install) {
    if (!existsSync(shell)) await installBrowser();
    return { source: "playwright" };
  }
  const configured = env.PATCHY_BROWSER;
  if (configured !== undefined && configured !== "")
    return existsSync(configured)
      ? { source: "env", path: configured }
      : new LocalError({
          message: `PATCHY_BROWSER names ${configured}, which doesn't exist.`,
          code: "no_browser"
        });
  const candidates = systemCandidates(env);
  const system = candidates.find((candidate) => existsSync(candidate));
  if (system !== undefined) return { source: "system", path: system };
  // Playwright launches its headless shell when one is downloaded for this release.
  if (existsSync(shell)) return { source: "playwright" };
  return noBrowser([...candidates, path.dirname(shell)]);
};

// --- what runs in the shell ---------------------------------------------------------------------

/**
 * Watches the shell's side of the patch's port, before the shell's own scripts run: which calls
 * the patch made, which Patchy or a handler refused, and when the starting cover was up. It only
 * observes; the broker's messages pass through unchanged.
 */
const shellProbe = `(() => {
  if (window.top !== window) return;
  const act = (window.__patchyAct = { calls: {}, pending: 0, refused: [], cover: [] });
  const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
  Object.defineProperty(MessagePort.prototype, "onmessage", {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(handler) {
      descriptor.set.call(this, typeof handler !== "function" ? handler : function (event) {
        const data = event.data;
        if (data && typeof data.id === "string" && typeof data.op === "string") {
          act.calls[data.id] = { op: data.op, handler: data.args && typeof data.args.handler === "string" ? data.args.handler : undefined };
          if (data.op !== "subscriptions.subscribe") act.pending++;
        }
        return handler.call(this, event);
      });
    }
  });
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message, ...rest) {
    const call = message && typeof message.id === "string" ? act.calls[message.id] : undefined;
    if (call && (message.kind === "result" || message.kind === "error")) {
      if (call.op !== "subscriptions.subscribe" && !call.settled) { act.pending--; call.settled = true; }
      if (message.kind === "error") {
        const error = message.error || {};
        act.refused.push({ op: call.op, ...(call.handler ? { handler: call.handler } : {}), source: error.source || "patchy", code: error.code, message: error.message });
      }
    }
    return post.call(this, message, ...rest);
  };
  addEventListener("DOMContentLoaded", () => {
    new MutationObserver(() => {
      const cover = document.querySelector("dialog[data-stream-status]");
      const open = cover !== null && cover.open;
      const last = act.cover[act.cover.length - 1];
      if (open && (!last || last.closed !== undefined)) act.cover.push({ opened: Date.now() });
      if (!open && last && last.closed === undefined) last.closed = Date.now();
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
  });
})();`;

interface Probe {
  readonly pending: number;
  readonly refused: ReadonlyArray<Record<string, unknown>>;
  readonly cover: ReadonlyArray<{ readonly opened: number; readonly closed?: number }>;
}

const readProbe = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __patchyAct: Probe }).__patchyAct);

// --- one person's page --------------------------------------------------------------------------

interface ConsoleLine {
  readonly step: number;
  readonly where: "patch" | "Patchy";
  readonly type: string;
  readonly text: string;
}

interface Viewer {
  readonly person: Person;
  readonly name: string;
  readonly url: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly console: ConsoleLine[];
  readonly refused: Array<Record<string, unknown> & { step: number }>;
  seenRefusals: number;
  readyMs: number;
}

const patchFrame = async (page: Page): Promise<Frame | null> =>
  (await page.$("#patch"))?.contentFrame() ?? null;

/** Waits as a person does: the frame loaded, the starting cover gone and the first calls answered. */
const settle = async (page: Page, timeoutMs: number) => {
  const started = Date.now();
  // Quiet for 150 ms, so calls the page makes just after it loads count too.
  let quiet = 0;
  for (;;) {
    const frame = await patchFrame(page);
    const loaded =
      frame !== null &&
      (await frame.evaluate(() => document.readyState).catch(() => "")) === "complete";
    const probe = await readProbe(page);
    const covered = probe.cover.some((entry) => entry.closed === undefined);
    quiet = loaded && !covered && probe.pending <= 0 ? quiet + 1 : 0;
    if (quiet >= 3) break;
    if (Date.now() - started > timeoutMs) break;
    await page.waitForTimeout(50);
  }
  // Two frames, so what the answers rendered is painted.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
};

/** What has focus, in the patch or in Patchy's own shell, as role and name. */
const focusOf = async (page: Page): Promise<string> => {
  const shellFocus = await page.evaluate(() => {
    const active = document.activeElement;
    return active === null || active === document.body
      ? "body"
      : active.id === "patch"
        ? "frame"
        : "other";
  });
  if (shellFocus === "other") {
    const snapshot = await page
      .locator(":focus")
      .ariaSnapshot()
      .catch(() => "");
    return `Patchy: ${firstLine(snapshot) || "its own controls"}`;
  }
  if (shellFocus === "body") return "nothing: keys go to Patchy's page, not the patch";
  const frame = await patchFrame(page);
  if (frame === null) return "the patch frame";
  const inner = await frame.evaluate(() => {
    const active = document.activeElement;
    return active === null || active === document.body ? "body" : "element";
  });
  if (inner === "body") return "patch: the page (no control focused)";
  const snapshot = await frame
    .locator(":focus")
    .ariaSnapshot()
    .catch(() => "");
  return `patch: ${firstLine(snapshot) || "an element with no accessible role"}`;
};

const firstLine = (snapshot: string) =>
  (snapshot.split("\n")[0] ?? "")
    .replace(/^- /, "")
    .replace(/ \[ref=[^\]]+\]/g, "")
    .replace(/:$/, "");

/** The screen as text: the shell and its patch frame, without per-run element refs. */
const screenText = async (page: Page, limit = 6_000) => {
  const text = (await page.ariaSnapshot({ mode: "ai" }).catch(() => ""))
    .replace(/ \[ref=[^\]]+\]/g, "")
    .replace(/ \[cursor=pointer\]/g, "");
  return text.length > limit
    ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`
    : text;
};

/** The first match for a name, in the patch first and then in Patchy's shell; waits up to `timeoutMs`. */
const find = async (
  page: Page,
  candidates: (
    scope: Pick<Page, "getByRole" | "getByLabel" | "getByText" | "getByPlaceholder">
  ) => Locator[],
  timeoutMs: number
): Promise<{ locator: Locator; where: "patch" | "Patchy"; matches: number } | undefined> => {
  const started = Date.now();
  for (;;) {
    const scopes = [
      { where: "patch" as const, scope: page.frameLocator("#patch") },
      { where: "Patchy" as const, scope: page }
    ];
    for (const { where, scope } of scopes)
      for (const locator of candidates(scope)) {
        const visible = locator.filter({ visible: true });
        const matches = await visible.count().catch(() => 0);
        if (matches > 0) return { locator: visible.first(), where, matches };
      }
    if (Date.now() - started > timeoutMs) return undefined;
    await page.waitForTimeout(100);
  }
};

const clickable = [
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option"
] as const;
const fields = ["textbox", "searchbox", "combobox", "spinbutton"] as const;

/**
 * New-headless Chrome runs the sandboxed patch frame in its own process and doesn't move keyboard
 * focus into it when the shell calls `frame.focus()`, so a key pressed before any click never
 * reaches the patch. A person's browser does move it; this does the same, and only when the shell
 * itself focused the frame, so Patchy's own focus (the starting cover, its bar) is left alone.
 */
const followShellFocus = async (page: Page) => {
  if (!(await page.evaluate(() => document.activeElement?.id === "patch"))) return;
  await (await patchFrame(page))?.evaluate(() => window.focus());
};

class StepFailed extends Error {}

/** What a step adds to its outcome: a remark, or the screenshot `shot` took. */
interface StepExtra {
  readonly note?: string;
  readonly screenshot?: string;
}

/** Runs one step on a person's page; throws StepFailed with what a person would have noticed. */
const runStep = async (
  viewer: Viewer,
  step: Exclude<Step, { verb: "as" }>,
  timeoutMs: number,
  shotPath: () => string
): Promise<StepExtra> => {
  const { page } = viewer;
  const covered = async () =>
    (await readProbe(page)).cover.some((entry) => entry.closed === undefined);
  switch (step.verb) {
    case "press": {
      if (await covered())
        throw new StepFailed(
          "Patchy's starting cover is up and holds the keys until the tools start."
        );
      await followShellFocus(page);
      for (const chord of chords(step.keys)) await page.keyboard.press(chord);
      return {};
    }
    case "click": {
      const name = step.target;
      const found = await find(
        page,
        (scope) => [
          ...clickable.map((role) => scope.getByRole(role, { name, exact: true })),
          scope.getByLabel(name, { exact: true }),
          scope.getByText(name, { exact: true }),
          ...clickable.map((role) => scope.getByRole(role, { name })),
          scope.getByText(name)
        ],
        timeoutMs
      );
      if (found === undefined) throw new StepFailed(`Nothing on screen is called "${name}".`);
      try {
        await found.locator.click({ timeout: timeoutMs });
      } catch (error) {
        throw new StepFailed(
          (await covered())
            ? "Patchy's starting cover is over the page, so the click didn't reach it."
            : `"${name}" is on screen but couldn't be clicked: ${String(error).split("\n")[0]}`
        );
      }
      return {
        ...(found.where === "Patchy" ? { note: `"${name}" is Patchy's, not the patch's.` } : {}),
        ...(found.matches > 1
          ? { note: `${found.matches} things match "${name}"; clicked the first.` }
          : {})
      };
    }
    case "type": {
      const name = step.field;
      const found = await find(
        page,
        (scope) => [
          scope.getByLabel(name, { exact: true }),
          scope.getByPlaceholder(name, { exact: true }),
          ...fields.map((role) => scope.getByRole(role, { name, exact: true })),
          scope.getByLabel(name),
          scope.getByPlaceholder(name),
          ...fields.map((role) => scope.getByRole(role, { name }))
        ],
        timeoutMs
      );
      if (found === undefined) throw new StepFailed(`No field on screen is labelled "${name}".`);
      // Clicked and typed key by key, as a person does, so the page hears every key.
      await found.locator.click({ timeout: timeoutMs });
      await found.locator.press("ControlOrMeta+A");
      await found.locator.press("Backspace");
      await found.locator.pressSequentially(step.text);
      return found.matches > 1
        ? { note: `${found.matches} fields match "${name}"; typed in the first.` }
        : {};
    }
    case "wait": {
      const found = await find(page, (scope) => [scope.getByText(step.text)], timeoutMs);
      if (found === undefined)
        throw new StepFailed(`"${step.text}" didn't appear within ${timeoutMs / 1000} s.`);
      return {};
    }
    case "gone": {
      const started = Date.now();
      while ((await find(page, (scope) => [scope.getByText(step.text)], 0)) !== undefined) {
        if (Date.now() - started > timeoutMs)
          throw new StepFailed(`"${step.text}" is still on screen after ${timeoutMs / 1000} s.`);
        await page.waitForTimeout(100);
      }
      return {};
    }
    case "open": {
      await page.goto(new URL(viewer.url).origin + new URL(viewer.url).pathname + step.route, {
        waitUntil: "load"
      });
      await settle(page, timeoutMs);
      return {};
    }
    case "shot": {
      const file = shotPath();
      await page.screenshot({ path: file });
      return { screenshot: file };
    }
  }
};

// --- the run ------------------------------------------------------------------------------------

export interface ActOptions {
  readonly width: number;
  readonly height: number;
  readonly timeoutMs: number;
  /** Use Playwright's own headless Chromium, downloading it first if this machine lacks it. */
  readonly installBrowser: boolean;
}

/**
 * Runs the steps against the session's pages and returns the report: each step's outcome and
 * focus, and for each person a screenshot, the console, refused calls, focus and screen text.
 */
export const act = Effect.fn("Dev.act")(function* (
  session: { readonly root: string; readonly stateDir: string; readonly record: Daemon },
  steps: readonly Step[],
  options: ActOptions
) {
  const { record, root, stateDir } = session;
  const env: Env = {};
  for (const key of envKeys) {
    const value = yield* Config.option(Config.String(key)).pipe(
      Effect.mapError((cause) => new LocalError({ message: `Could not read ${key}.`, cause }))
    );
    if (Option.isSome(value)) env[key] = value.value;
  }
  const urls: Record<Person, string | undefined> = {
    you: record.url,
    colleague: record.colleagueUrl,
    guest: record.guestUrl
  };
  const names: Record<Person, string> = {
    you: record.identity.user.name,
    colleague: colleague.name,
    guest: guest.name
  };
  const first: Person = steps[0]?.verb === "as" ? steps[0].person : "you";
  const involved = [
    ...new Set<Person>([
      first,
      ...steps.flatMap((step) => (step.verb === "as" ? [step.person] : []))
    ])
  ];
  for (const person of involved)
    if (urls[person] === undefined)
      return yield* new LocalError({
        message: `This session has no ${person} page.`,
        code: "not_running"
      });

  const run = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(stateDir, "act", run);
  const started = Date.now();
  const result = yield* Effect.tryPromise({
    try: async () => {
      const { chromium } = await import("playwright-core");
      const findStarted = Date.now();
      const found = await findBrowser(chromium, options.installBrowser, env);
      const findMs = Date.now() - findStarted;
      if ("_tag" in found) return found;
      await fs.mkdir(dir, { recursive: true });
      await prune(path.join(stateDir, "act"), 10);
      const launchStarted = Date.now();
      let browser: Browser;
      try {
        browser = await chromium.launch({
          headless: true,
          ...(found.path === undefined ? {} : { executablePath: found.path })
        });
      } catch (error) {
        return new LocalError({
          message: `The browser at ${found.path ?? "Playwright's download"} wouldn't start: ${String(error).split("\n")[0]}`,
          code: "no_browser"
        });
      }
      const launchMs = Date.now() - launchStarted;
      try {
        let step = 0;
        const viewers = new Map<Person, Viewer>();
        const open = async (person: Person) => {
          const context = await browser.newContext({
            viewport: { width: options.width, height: options.height },
            deviceScaleFactor: 1
          });
          await context.addInitScript(shellProbe);
          const page = await context.newPage();
          const viewer: Viewer = {
            person,
            name: names[person],
            url: urls[person]!,
            context,
            page,
            console: [],
            refused: [],
            seenRefusals: 0,
            readyMs: 0
          };
          page.on("console", (message) => {
            viewer.console.push({
              step,
              where: message.location().url.includes("/~content/") ? "patch" : "Patchy",
              type: message.type(),
              text: message.text()
            });
          });
          page.on("pageerror", (error) => {
            viewer.console.push({
              step,
              where: "patch",
              type: "error",
              text: `Uncaught ${error.message}`
            });
          });
          const opened = Date.now();
          await page.goto(viewer.url, { waitUntil: "load", timeout: options.timeoutMs * 4 });
          await settle(page, options.timeoutMs * 4);
          viewer.readyMs = Date.now() - opened;
          viewers.set(person, viewer);
          return viewer;
        };
        await Promise.all(involved.map(open));
        const collectRefusals = async (viewer: Viewer) => {
          const probe = await readProbe(viewer.page);
          for (const entry of probe.refused.slice(viewer.seenRefusals))
            viewer.refused.push({ ...entry, step });
          viewer.seenRefusals = probe.refused.length;
        };
        for (const viewer of viewers.values()) await collectRefusals(viewer);

        let active = viewers.get(first)!;
        const outcomes: Array<Record<string, unknown>> = [];
        let failure: { step: number; error: string } | undefined;
        let shots = 0;
        for (const [index, current] of steps.entries()) {
          step = index + 1;
          const stepStarted = Date.now();
          if (current.verb === "as") {
            active = viewers.get(current.person)!;
            outcomes.push({ step, as: active.person, do: describeStep(current), ok: true, ms: 0 });
            continue;
          }
          try {
            const extra = await runStep(active, current, options.timeoutMs, () =>
              path.join(dir, `${active.person}-${++shots}.png`)
            );
            // Let what the step started settle before reading the page, as a person glances.
            await settle(active.page, 1_000);
            await collectRefusals(active);
            outcomes.push({
              step,
              as: active.person,
              do: describeStep(current),
              ok: true,
              ms: Date.now() - stepStarted,
              focus: await focusOf(active.page),
              ...(extra.screenshot === undefined
                ? {}
                : { screenshot: path.relative(root, extra.screenshot) }),
              ...(extra.note === undefined ? {} : { note: extra.note }),
              ...(active.refused.some((entry) => entry.step === step)
                ? { refused: active.refused.filter((entry) => entry.step === step).length }
                : {})
            });
          } catch (error) {
            await collectRefusals(active).catch(() => undefined);
            const message =
              error instanceof StepFailed ? error.message : String(error).split("\n")[0]!;
            failure = { step, error: message };
            outcomes.push({
              step,
              as: active.person,
              do: describeStep(current),
              ok: false,
              ms: Date.now() - stepStarted,
              error: message,
              focus: await focusOf(active.page).catch(() => "unknown")
            });
            break;
          }
        }

        const report = [];
        for (const viewer of involved.map((person) => viewers.get(person)!)) {
          const file = path.join(dir, `${viewer.person}.png`);
          await viewer.page.screenshot({ path: file });
          const probe = await readProbe(viewer.page);
          const frame = await patchFrame(viewer.page);
          const tier = await viewer.page.$eval(
            "#patch",
            (element) => (element as HTMLElement).dataset["tier"]
          );
          report.push({
            as: viewer.person,
            name: viewer.name,
            url: viewer.page.url(),
            tier: Number(tier),
            readyMs: viewer.readyMs,
            screenshot: path.relative(root, file),
            focus: await focusOf(viewer.page),
            cover: probe.cover.map((entry) => ({
              ms: (entry.closed ?? Date.now()) - entry.opened,
              ...(entry.closed === undefined ? { stillUp: true } : {})
            })),
            console: viewer.console,
            refused: viewer.refused,
            route: frame === null ? undefined : new URL(viewer.page.url()).pathname,
            screen: await screenText(viewer.page)
          });
        }
        // Problems a person wouldn't see but the agent should, even when every step passed.
        const when = (step: number) => (step === 0 ? "while opening" : `at step ${step}`);
        const warnings = report.flatMap((person) => [
          ...person.refused.map(
            (entry) =>
              `${person.as}: Patchy refused ${String(entry["handler"] ?? entry["op"])} ${when(entry.step)} (${String(entry["code"])}): ${String(entry["message"])}`
          ),
          ...person.console
            .filter((line) => line.text.startsWith("Uncaught "))
            .map((line) => `${person.as}: ${line.text} ${when(line.step)}`)
        ]);
        return {
          ok: failure === undefined,
          ...(failure === undefined ? {} : { failed: failure }),
          warnings,
          browser: {
            source: found.source,
            ...(found.path === undefined ? {} : { path: found.path }),
            version: browser.version(),
            ...(findMs > 1_000 ? { installMs: findMs } : {}),
            launchMs
          },
          ms: Date.now() - started,
          steps: outcomes,
          people: report
        };
      } finally {
        await browser.close();
      }
    },
    catch: (cause) =>
      new LocalError({ message: `patchy dev act failed: ${String(cause).split("\n")[0]}`, cause })
  });
  if ("_tag" in result) return yield* result;
  return result;
});

/** Keeps the newest `keep` run folders, so screenshots don't pile up in the repo's local state. */
const prune = async (dir: string, keep: number) => {
  const runs = (await fs.readdir(dir).catch(() => [])).sort();
  for (const name of runs.slice(0, Math.max(0, runs.length - keep)))
    await fs.rm(path.join(dir, name), { recursive: true, force: true });
};

/** The report as text lines, for a person or an agent not using --json. */
export const textReport = (report: Effect.Success<ReturnType<typeof act>>): string[] => [
  ...report.steps.map(
    (step) =>
      `${step["ok"] ? "✓" : "✗"} ${String(step["step"])}. [${String(step["as"])}] ${String(step["do"])}${step["ok"] ? "" : ` — ${String(step["error"])}`}${step["focus"] === undefined ? "" : `\n    focus: ${String(step["focus"])}`}${step["note"] === undefined ? "" : `\n    note: ${String(step["note"])}`}`
  ),
  ...report.people.flatMap((person) => [
    "",
    `${person.as} (${person.name}) — ${person.url}`,
    `  screenshot: ${person.screenshot}`,
    `  focus: ${person.focus}`,
    ...(person.cover.length === 0
      ? []
      : [
          `  starting cover: ${person.cover.map((entry) => `${entry.ms} ms${entry.stillUp ? ", still up" : ""}`).join(", ")}`
        ]),
    ...person.refused.map(
      (entry) =>
        `  refused (${entry.step === 0 ? "opening" : `step ${entry.step}`}): ${String(entry["op"])}${entry["handler"] === undefined ? "" : ` ${String(entry["handler"])}`} ${String(entry["code"])}: ${String(entry["message"])}`
    ),
    ...person.console.map(
      (line) =>
        `  console ${line.type} (${line.where}, ${line.step === 0 ? "opening" : `step ${line.step}`}): ${line.text}`
    ),
    "  screen:",
    ...person.screen.split("\n").map((line) => `    ${line}`)
  ]),
  "",
  `${report.browser.source} browser ${report.browser.version}${report.browser.path === undefined ? "" : ` at ${report.browser.path}`}; launched in ${report.browser.launchMs} ms, ran in ${report.ms} ms.`
];
