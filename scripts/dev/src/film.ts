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
import { overlay } from "./filmOverlay.js";

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

const HEIGHT = 800;

/** A string as a JS literal, to embed in the overlay's source. */
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

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
          content: `(() => { const __name = (f) => f; (${overlay.toString()})({ label: ${encodeString(input.label)} }); })();`
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
        const started = performance.now();
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
        const seconds = (performance.now() - started) / 1000;
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
