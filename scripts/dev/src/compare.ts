/**
 * `pnpm dev compare`: full-page PNGs of pages on both evidence instances, as
 * one person, and the PR section that lays them out. This worktree's code
 * drives the browser for both sides; the instances only serve.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { Page } from "@playwright/test";
import { type Provenance, provenanceLines, type SideName } from "./evidence.js";
import type { Person } from "./scenario.js";

export class CaptureFailed extends Schema.TaggedError<CaptureFailed>()("CaptureFailed", {
  what: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `${this.what} failed: ${String(this.cause)}`;
  }
}

export class NoChromium extends Schema.TaggedError<NoChromium>()("NoChromium", {
  executable: Schema.String
}) {
  override get message() {
    return `Playwright's Chromium is not installed (looked for ${this.executable}). Install it with \`pnpm exec playwright install chromium\`.`;
  }
}

/** Fails before any instance starts when Playwright has no Chromium to drive. */
export const checkChromium = Effect.fn("Compare.checkChromium")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const executable = yield* Effect.tryPromise({
    try: async () => (await import("@playwright/test")).chromium.executablePath(),
    catch: (cause) => new CaptureFailed({ what: "Finding Playwright's Chromium", cause })
  });
  if (!(yield* fs.exists(executable))) return yield* new NoChromium({ executable });
});

/** One side's view of one page at one width. `file` is relative to the worktree root. */
export const Capture = Schema.Struct({
  side: Schema.Literals(["before", "after"]),
  target: Schema.String,
  width: Schema.Int,
  url: Schema.String,
  status: Schema.NullOr(Schema.Int),
  file: Schema.String,
  errors: Schema.Array(Schema.String),
  /** Why a patch page may be cut short, when it may be. */
  clipped: Schema.NullOr(Schema.String)
});
export type Capture = typeof Capture.Type;

/** At or below this width, before and after fit side by side in a PR. */
export const PHONE = 480;

/** A patch frame grows to its content up to this height, in CSS pixels. */
const MAX_FRAME_HEIGHT = 8_000;

const slug = (target: string) =>
  target.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "home";

/** Where one side's PNG of a page at a width lands, relative to the worktree root. */
export const shotFile = (runDir: string, side: SideName, target: string, width: number) =>
  `${runDir}/${side}-${slug(target)}-${width}.png`;

/**
 * A patch scrolls inside its sandboxed frame while the shell pins the document
 * to the viewport, so a full-page shot would stop at the fold. This measures
 * the frame's content through Playwright and grows the frame and the shell
 * around it, a few rounds until the height holds, bounded. Returns why the
 * shot may still be cut short: content that scrolls inside an element, a
 * height that keeps following the viewport, or one past the bound. Pages
 * without a patch frame are left alone. The functions sent to the page declare
 * no named inner functions: tsx would wrap them in `__name`, which pages lack.
 */
const growPatchFrame = async (page: Page): Promise<string | null> => {
  const element = await page.$("iframe#patch");
  if (element === null) return null;
  const frame = await element.contentFrame();
  if (frame === null) return "the patch frame never loaded, so the shot stops at the fold";
  let height = 0;
  let inner = false;
  for (let round = 0; round < 4; round++) {
    let measured: { readonly height: number; readonly inner: boolean };
    try {
      measured = await frame.evaluate(() => {
        let scrolls = false;
        for (const element of document.querySelectorAll("*")) {
          const overflow = getComputedStyle(element).overflowY;
          if (
            (overflow === "auto" || overflow === "scroll") &&
            element.clientHeight > 0 &&
            element.scrollHeight > element.clientHeight + 4
          ) {
            scrolls = true;
            break;
          }
        }
        return {
          height: Math.max(
            document.documentElement.scrollHeight,
            document.body === null ? 0 : document.body.scrollHeight
          ),
          inner: scrolls
        };
      });
    } catch (error) {
      return `the patch frame could not be measured (${String(error).split("\n")[0]}), so the shot stops at the fold`;
    }
    inner = measured.inner;
    if (Math.abs(measured.height - height) <= 1) break;
    if (round === 3)
      return `its height follows the viewport, so the shot is cut at ${height}px of its content`;
    height = Math.min(measured.height, MAX_FRAME_HEIGHT);
    await page.evaluate((grown) => {
      document.documentElement.style.height = "auto";
      document.body.style.height = "auto";
      document.body.style.overflow = "visible";
      const patch = document.getElementById("patch");
      if (patch !== null) patch.style.height = `${grown}px`;
    }, height);
    await page.waitForTimeout(250);
    if (measured.height > MAX_FRAME_HEIGHT)
      return `it is ${measured.height}px tall, so the shot is cut at ${MAX_FRAME_HEIGHT}px`;
  }
  return inner
    ? "part of it scrolls inside the page, so what is below that fold isn't shown"
    : null;
};

/**
 * Full-page PNGs of every target at every width on each side, signed in as
 * `email`, at device scale 2 so text stays sharp when zoomed. One browser, a
 * fresh context per shot. A page holding a live stream never goes network-idle,
 * so settling waits at most five seconds.
 */
export const shootAll = Effect.fn("Compare.shootAll")(function* (input: {
  readonly root: string;
  readonly sides: ReadonlyArray<{ readonly side: SideName; readonly apiUrl: string }>;
  readonly email: string;
  readonly targets: ReadonlyArray<string>;
  readonly widths: ReadonlyArray<number>;
  readonly runDir: string;
}) {
  const path = yield* Path.Path;
  return yield* Effect.tryPromise({
    try: async () => {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      const shots: Array<Capture> = [];
      try {
        for (const target of input.targets)
          for (const width of input.widths)
            for (const { side, apiUrl } of input.sides) {
              const context = await browser.newContext({
                viewport: { width, height: 800 },
                deviceScaleFactor: 2
              });
              const page = await context.newPage();
              const errors: Array<string> = [];
              page.on("console", (message) => {
                if (message.type() === "error") errors.push(message.text());
              });
              page.on("pageerror", (error) => errors.push(error.message));
              const response = await page.goto(
                `${apiUrl}/dev/sign-in?as=${encodeURIComponent(input.email)}&return=${encodeURIComponent(target)}`
              );
              await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
              await page.evaluate(() => document.fonts.ready.then(() => undefined));
              const clipped = await growPatchFrame(page);
              const file = shotFile(input.runDir, side, target, width);
              await page.screenshot({ path: path.join(input.root, file), fullPage: true });
              shots.push({
                side,
                target,
                width,
                url: page.url(),
                status: response?.status() ?? null,
                file,
                errors,
                clipped
              });
              await context.close();
            }
      } finally {
        await browser.close();
      }
      return shots;
    },
    catch: (cause) => new CaptureFailed({ what: "Taking the screenshots", cause })
  });
});

/** One page at one width: each side's capture, and whether their PNGs are the same bytes. */
export interface Pair {
  readonly target: string;
  readonly width: number;
  readonly before: Capture | undefined;
  readonly after: Capture;
  readonly identical: boolean;
}

const capturesOf = (pair: Pair) =>
  pair.before === undefined ? [pair.after] : [pair.before, pair.after];

const image = (capture: Capture) =>
  `![${capture.side === "before" ? "Before" : "After"}: ${capture.target} at ${capture.width}px](${capture.file})`;

/** What went wrong on a page, if anything: a status other than 200, browser errors, a cut-short shot. */
const problems = (capture: Capture) => {
  const found: Array<string> = [];
  if (capture.status !== 200) found.push(`answered ${capture.status ?? "nothing"}`);
  if (capture.errors.length > 0)
    found.push(
      `${capture.errors.length} browser error(s): ${capture.errors
        .slice(0, 5)
        .map((error) => `\`${(error.split("\n")[0] ?? "").slice(0, 200)}\``)
        .join("; ")}`
    );
  if (capture.clipped !== null) found.push(capture.clipped);
  return found;
};

/**
 * The compare section, per page. A desktop width puts "after" at the full
 * width of the PR column, readable without clicking, with "before" in a
 * `<details>`: table cells would shrink a 1280px page to about 340px. Phone
 * widths sit side by side in a Width | Before | After table at about true
 * size. A width whose two PNGs are identical says "No visible change" and
 * leaves "before" out, so it isn't uploaded.
 */
export const compareMarkdown = (input: {
  readonly provenance: Provenance;
  readonly person: Person;
  readonly pairs: ReadonlyArray<Pair>;
}) => {
  const lines = [
    `#### Before and after, as ${input.person.name} (${input.person.role})`,
    "",
    ...provenanceLines(input.provenance),
    ""
  ];
  if (input.pairs.flatMap(capturesOf).every((capture) => problems(capture).length === 0))
    lines.push("Every page answered 200 with no browser errors.", "");
  for (const target of [...new Set(input.pairs.map((pair) => pair.target))]) {
    const pairs = input.pairs.filter((pair) => pair.target === target);
    lines.push(`##### \`${target}\``, "");
    for (const pair of pairs.filter((pair) => pair.width > PHONE)) {
      lines.push(`**${pair.width}px, after**`, "", image(pair.after), "");
      if (pair.before === undefined) continue;
      lines.push(
        pair.identical
          ? `No visible change at ${pair.width}px.`
          : `<details><summary>${pair.width}px, before</summary>\n\n${image(pair.before)}\n\n</details>`,
        ""
      );
    }
    const phones = pairs.filter((pair) => pair.width <= PHONE);
    if (phones.length > 0) {
      lines.push("| Width | Before | After |", "| --- | --- | --- |");
      for (const pair of phones)
        lines.push(
          `| ${pair.width}px | ${pair.before === undefined ? "—" : pair.identical ? "No visible change" : image(pair.before)} | ${image(pair.after)} |`
        );
      lines.push("");
    }
    for (const capture of pairs.flatMap(capturesOf)) {
      const found = problems(capture);
      if (found.length > 0)
        lines.push(
          `- ${capture.side === "before" ? "Before" : "After"} at ${capture.width}px ${found.join("; ")}.`
        );
    }
    if (lines.at(-1) !== "") lines.push("");
  }
  return lines.join("\n").trim();
};
