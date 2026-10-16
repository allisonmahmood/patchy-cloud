/**
 * `pnpm dev film`: a flow, recorded on the base and on this worktree.
 *
 * A flow is a module whose default export drives a signed-in Playwright page:
 *
 *   export default async ({ page, step }) => {
 *     await step("Open New Business");
 *     await page.getByRole("link", { name: "New Business" }).click();
 *   };
 *
 * Relative URLs resolve against the side's instance. `step` captions the
 * video and holds long enough to read. The recording
 * shows a cursor, a ring wherever it clicks and which side it is, then
 * becomes an H.264 mp4 (what GitHub's player plays everywhere). When both
 * sides record, a third video puts them side by side, the shorter one held
 * on its last frame. A flow that fails keeps its video up to the failure,
 * captioned with the error, so a flow for a new feature still films the
 * base: it shows the feature was not there.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { pathToFileURL } from "node:url";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Page } from "@playwright/test";
import { StepExited, StepUnavailable } from "./environment.js";
import { CaptureFailed } from "./compare.js";

/** What a flow's default export receives. */
export interface FlowContext {
  readonly page: Page;
  /** Captions the video with `text` and holds it long enough to read. */
  readonly step: (text: string) => Promise<void>;
}

export const Take = Schema.Struct({
  side: Schema.Literals(["before", "after"]),
  file: Schema.String,
  seconds: Schema.Number,
  /** Where the flow stopped, when it did not finish. */
  failure: Schema.NullOr(Schema.Struct({ step: Schema.String, message: Schema.String }))
});
export type Take = typeof Take.Type;

declare global {
  interface Window {
    __film?: { caption: (text: string, failed?: boolean) => void };
  }
}

/**
 * Runs in every frame before the page's own scripts. The top frame gets the
 * side's label and the caption bar; every frame gets a cursor and click
 * rings, since a patch's sandboxed frame keeps its pointer events to itself.
 * The portal navigates on most clicks, so the pointer and the last click are
 * kept in sessionStorage and replayed on the next page; a sandboxed frame
 * has no storage and just starts fresh. Styles go through CSSOM so page CSPs
 * that block inline styles allow them.
 */
const overlay = ({ label }: { readonly label: string }) => {
  const top = window === window.top;
  const CAPTION = "__filmCaption";
  const POINTER = "__filmPointer";
  const load = (key: string) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const save = (key: string, value: string) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // A sandboxed frame has no storage.
    }
  };
  const mount = () => {
    const root = document.createElement("div");
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
      font: "500 18px/1.35 system-ui, -apple-system, sans-serif"
    });
    const cursor = document.createElement("div");
    Object.assign(cursor.style, {
      position: "absolute",
      left: "-12px",
      top: "-12px",
      width: "24px",
      height: "24px",
      borderRadius: "50%",
      background: "rgba(255, 196, 0, 0.45)",
      border: "2px solid rgba(20, 20, 20, 0.85)",
      boxShadow: "0 0 0 2px rgba(255, 255, 255, 0.8)",
      transition: "transform 220ms ease-out",
      display: "none"
    });
    root.append(cursor);
    const move = (x: number, y: number) => {
      cursor.style.display = "block";
      cursor.style.transform = `translate(${x}px, ${y}px)`;
    };
    const ring = (x: number, y: number) => {
      const shape = document.createElement("div");
      Object.assign(shape.style, {
        position: "absolute",
        left: `${x - 20}px`,
        top: `${y - 20}px`,
        width: "40px",
        height: "40px",
        borderRadius: "50%",
        border: "3px solid rgba(255, 140, 0, 0.95)",
        transform: "scale(0.4)",
        opacity: "1",
        transition: "transform 600ms ease-out, opacity 600ms ease-out"
      });
      root.append(shape);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          shape.style.transform = "scale(1.8)";
          shape.style.opacity = "0";
        })
      );
      setTimeout(() => shape.remove(), 800);
    };
    document.addEventListener(
      "mousemove",
      (event) => {
        move(event.clientX, event.clientY);
        save(POINTER, JSON.stringify({ x: event.clientX, y: event.clientY, at: 0 }));
      },
      true
    );
    document.addEventListener(
      "mouseout",
      (event) => {
        if (event.relatedTarget === null || (event.relatedTarget as Element).tagName === "IFRAME")
          cursor.style.display = "none";
      },
      true
    );
    document.addEventListener(
      "mousedown",
      (event) => {
        move(event.clientX, event.clientY);
        ring(event.clientX, event.clientY);
        save(POINTER, JSON.stringify({ x: event.clientX, y: event.clientY, at: Date.now() }));
      },
      true
    );
    const last = load(POINTER);
    if (last !== null) {
      const pointer = JSON.parse(last) as { x: number; y: number; at: number };
      move(pointer.x, pointer.y);
      if (Date.now() - pointer.at < 1_500) ring(pointer.x, pointer.y);
    }
    if (top) {
      const chip = document.createElement("div");
      chip.textContent = label;
      Object.assign(chip.style, {
        position: "absolute",
        left: "12px",
        bottom: "12px",
        padding: "4px 10px",
        borderRadius: "999px",
        background: "rgba(20, 20, 20, 0.8)",
        color: "#fff",
        fontSize: "13px"
      });
      const bar = document.createElement("div");
      Object.assign(bar.style, {
        position: "absolute",
        left: "50%",
        bottom: "44px",
        transform: "translateX(-50%)",
        maxWidth: "80%",
        padding: "10px 18px",
        borderRadius: "12px",
        background: "rgba(20, 20, 20, 0.88)",
        color: "#fff",
        textAlign: "center",
        display: "none"
      });
      const caption = (text: string, failed = false) => {
        save(CAPTION, text);
        bar.textContent = text;
        bar.style.display = text === "" ? "none" : "block";
        bar.style.background = failed ? "rgba(160, 20, 20, 0.92)" : "rgba(20, 20, 20, 0.88)";
      };
      root.append(chip, bar);
      window.__film = { caption };
      caption(load(CAPTION) ?? "");
    }
    document.documentElement.append(root);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
};

const HEIGHT = 800;

/**
 * Signs in as `email` at `start`, runs the flow and returns the raw WebM
 * Playwright recorded. Failures inside the flow are part of the take, not
 * errors: the video shows them.
 */
const recordTake = (input: {
  readonly apiUrl: string;
  readonly email: string;
  readonly start: string;
  readonly flowFile: string;
  readonly width: number;
  readonly label: string;
  readonly videoDir: string;
}) =>
  Effect.tryPromise({
    try: async () => {
      const { chromium } = await import("@playwright/test");
      const module: { default?: unknown } = await import(pathToFileURL(input.flowFile).href);
      const flow = module.default;
      if (typeof flow !== "function")
        throw new Error(`${input.flowFile} has no default export to run`);
      const browser = await chromium.launch({ slowMo: 120 });
      try {
        const size = { width: input.width, height: HEIGHT };
        const context = await browser.newContext({
          viewport: size,
          baseURL: input.apiUrl,
          recordVideo: { dir: input.videoDir, size }
        });
        // tsx wraps named inner functions in `__name(...)`, which the page
        // lacks, so the overlay goes in as source with a local stand-in.
        await context.addInitScript({
          content: `(() => { const __name = (f) => f; (${overlay.toString()})(${JSON.stringify({ label: input.label })}); })();`
        });
        const page = await context.newPage();
        // A local instance answers fast: a missing element should end the take, not hold it 30s.
        page.setDefaultTimeout(5_000);
        page.setDefaultNavigationTimeout(15_000);
        let current = "";
        let failure: Take["failure"] = null;
        const caption = (text: string, failed = false) =>
          page
            .evaluate(([t, f]) => window.__film?.caption(t, f), [text, failed] as const)
            .catch(() => undefined);
        const step = async (text: string) => {
          current = text;
          await caption(text);
          await page.waitForTimeout(1_200);
        };
        const started = Date.now();
        try {
          await page.goto(
            `${input.apiUrl}/dev/sign-in?as=${encodeURIComponent(input.email)}&return=${encodeURIComponent(input.start)}`
          );
          await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
          await page.waitForTimeout(800);
          await (flow as (context: FlowContext) => Promise<void>)({ page, step });
          await page.waitForTimeout(1_500);
        } catch (error) {
          const message =
            (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
          failure = { step: current, message };
          await caption(`Stopped${current === "" ? "" : ` at "${current}"`}: ${message}`, true);
          await page.waitForTimeout(2_500);
        }
        const seconds = (Date.now() - started) / 1000;
        const video = page.video();
        await context.close();
        if (video === null) throw new Error("Playwright recorded no video");
        return { webm: await video.path(), seconds, failure };
      } finally {
        await browser.close();
      }
    },
    catch: (cause) => new CaptureFailed({ what: "Recording the flow", cause })
  });

const ffmpeg = Effect.fn("Film.ffmpeg")(function* (step: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
          extendEnv: true
        })
      );
      const exitCode = yield* handle.exitCode;
      if (exitCode !== 0) return yield* new StepExited({ step, exitCode });
    })
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new StepUnavailable({ step, cause }))
    })
  );
});

const H264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "28", "-preset", "veryfast"];

/** One side's take, as `<dir>/<side>.mp4`. */
export const film = Effect.fn("Film.film")(function* (input: {
  readonly side: "before" | "after";
  readonly apiUrl: string;
  readonly email: string;
  readonly start: string;
  readonly flowFile: string;
  readonly width: number;
  readonly label: string;
  readonly dir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const videoDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-film-" });
  const take = yield* recordTake({ ...input, videoDir });
  const file = path.join(input.dir, `${input.side}.mp4`);
  yield* ffmpeg(`Encoding the ${input.side} video`, [
    "-i",
    take.webm,
    ...H264,
    "-movflags",
    "+faststart",
    file
  ]);
  return { side: input.side, file, seconds: take.seconds, failure: take.failure } satisfies Take;
}, Effect.scoped);

/** Before and after in one frame, left and right, the shorter held on its last frame. */
export const sideBySide = Effect.fn("Film.sideBySide")(function* (
  before: Take,
  after: Take,
  file: string
) {
  const pad = (take: Take) =>
    `tpad=stop_mode=clone:stop_duration=${Math.max(0, Math.max(before.seconds, after.seconds) - take.seconds + 1).toFixed(2)}`;
  yield* ffmpeg("Joining the videos", [
    "-i",
    before.file,
    "-i",
    after.file,
    "-filter_complex",
    `[0:v]${pad(before)}[b];[1:v]${pad(after)}[a];[b][a]hstack=inputs=2[v]`,
    "-map",
    "[v]",
    ...H264,
    "-movflags",
    "+faststart",
    "-t",
    `${(Math.max(before.seconds, after.seconds) + 1).toFixed(2)}`,
    file
  ]);
  return file;
});

/** Encoded size in MB, to warn before GitHub's 10 MB video limit does. */
export const sizeMb = Effect.fn("Film.sizeMb")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file);
  return Number(info.size) / 1_000_000;
});
