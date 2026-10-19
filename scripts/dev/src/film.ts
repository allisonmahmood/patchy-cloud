/**
 * `pnpm dev film`: a flow, recorded on both evidence instances.
 *
 * A flow is a module whose default export drives a signed-in Playwright page:
 *
 *   import type { Flow } from "<this checkout>/scripts/dev/src/film.ts";
 *
 *   export default (async ({ page, step }) => {
 *     await step("Open New Business");
 *     await page.getByRole("link", { name: "New Business" }).click();
 *   }) satisfies Flow;
 *
 * Relative URLs resolve against the side's instance. `step` captions the
 * video and holds long enough to read. The overlay marks the recording with
 * its side, a cursor and a ring wherever it clicks; each take becomes an H.264
 * mp4, and with both sides a third video puts them side by side, the shorter
 * held on its last frame. A take that fails keeps its video up to the failure,
 * captioned with the error in red: a flow for a new feature still films its
 * base, showing the feature wasn't there.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { CaptureFailed, launchBrowser } from "./compare.js";
import type { SideName } from "./evidence.js";
import { overlay } from "./filmOverlay.js";
import { stepOutput } from "./steps.js";

/** What a flow's default export receives. */
export interface FlowContext {
  readonly page: Page;
  /** Captions the video with `text` and holds it long enough to read. */
  readonly step: (text: string) => Promise<void>;
}

/** A flow file's default export. */
export type Flow = (context: FlowContext) => Promise<void>;

export class NoFfmpeg extends Schema.TaggedError<NoFfmpeg>()("NoFfmpeg", {
  found: Schema.Boolean
}) {
  override get message() {
    return this.found
      ? "This ffmpeg has no H.264 encoder (libx264). Install a build that has one, such as `brew install ffmpeg` or `sudo apt install ffmpeg`."
      : "ffmpeg is not on PATH. Install one built with libx264, such as `brew install ffmpeg` or `sudo apt install ffmpeg`.";
  }
}

export class NoFlow extends Schema.TaggedError<NoFlow>()("NoFlow", { file: Schema.String }) {
  override get message() {
    return `${this.file} has no default export to run. A flow is \`export default async ({ page, step }) => {}\`.`;
  }
}

/** Fails before any instance starts when ffmpeg is missing or can't write H.264. */
export const checkFfmpeg = Effect.fn("Film.checkFfmpeg")(function* (root: string) {
  const encoders = yield* stepOutput("Checking ffmpeg", "ffmpeg", ["-hide_banner", "-encoders"], {
    cwd: root,
    prefix: "ffmpeg"
  }).pipe(Effect.catchTags({ StepUnavailable: () => Effect.fail(new NoFfmpeg({ found: false })) }));
  if (!/\blibx264\b/.test(encoders)) return yield* new NoFfmpeg({ found: true });
});

/** Loads a flow file once, before any instance starts, so a typo fails fast. */
export const loadFlow = Effect.fn("Film.loadFlow")(function* (file: string) {
  const module = yield* Effect.tryPromise({
    try: (): Promise<{ readonly default?: unknown }> => import(pathToFileURL(file).href),
    catch: (cause) => new CaptureFailed({ what: `Loading ${file}`, cause })
  });
  const flow = module.default;
  if (typeof flow !== "function") return yield* new NoFlow({ file });
  // The flow's parameters are this file's contract; its body is the author's.
  return flow as Flow;
});

export const Take = Schema.Struct({
  side: Schema.Literals(["before", "after"]),
  /** Relative to the worktree root. */
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
 * Signs in as `email` at `start`, runs the flow and returns the WebM
 * Playwright recorded. Failures inside the flow are part of the take, not
 * errors: the video shows them.
 */
const recordTake = Effect.fn("Film.recordTake")(function* (input: {
  readonly apiUrl: string;
  readonly email: string;
  readonly start: string;
  readonly flow: Flow;
  readonly width: number;
  readonly label: string;
  readonly videoDir: string;
}) {
  const browser = yield* launchBrowser({ slowMo: 120 });
  return yield* Effect.tryPromise({
    try: async () => {
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
        await input.flow({ page, step });
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
    },
    catch: (cause) => new CaptureFailed({ what: "Recording the flow", cause })
  });
}, Effect.scoped);

const ffmpeg = (root: string, step: string, args: ReadonlyArray<string>) =>
  stepOutput(step, "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    cwd: root,
    prefix: "ffmpeg"
  });

/** What GitHub's player plays everywhere: H.264 in yuv420p, its index up front. */
const H264 = [
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-crf",
  "28",
  "-preset",
  "veryfast",
  "-movflags",
  "+faststart"
];

/** One side's take, as `<runDir>/<side>.mp4`. */
export const filmSide = Effect.fn("Film.filmSide")(function* (input: {
  readonly root: string;
  readonly side: SideName;
  readonly apiUrl: string;
  readonly email: string;
  readonly start: string;
  readonly flow: Flow;
  readonly width: number;
  readonly label: string;
  readonly runDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const videoDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-film-" });
  const take = yield* recordTake({ ...input, videoDir });
  const file = `${input.runDir}/${input.side}.mp4`;
  yield* ffmpeg(input.root, `Encoding the ${input.side} video`, [
    "-i",
    take.webm,
    ...H264,
    path.join(input.root, file)
  ]);
  return { side: input.side, file, seconds: take.seconds, failure: take.failure } satisfies Take;
}, Effect.scoped);

/** Before and after in one frame, left and right, the shorter held on its last frame. */
export const sideBySide = Effect.fn("Film.sideBySide")(function* (
  root: string,
  before: Take,
  after: Take,
  file: string
) {
  const path = yield* Path.Path;
  const longest = Math.max(before.seconds, after.seconds) + 1;
  const pad = (take: Take) =>
    `tpad=stop_mode=clone:stop_duration=${Math.max(0, longest - take.seconds).toFixed(2)}`;
  yield* ffmpeg(root, "Joining the videos", [
    "-i",
    path.join(root, before.file),
    "-i",
    path.join(root, after.file),
    "-filter_complex",
    `[0:v]${pad(before)}[b];[1:v]${pad(after)}[a];[b][a]hstack=inputs=2[v]`,
    "-map",
    "[v]",
    ...H264,
    "-t",
    longest.toFixed(2),
    path.join(root, file)
  ]);
  return file;
});

/** The film section: the commits, how each take ended, and the video. */
export const filmMarkdown = (input: {
  readonly name: string;
  readonly person: { readonly name: string; readonly role: string };
  readonly provenance: ReadonlyArray<string>;
  readonly takes: ReadonlyArray<Take>;
  readonly video: string;
}) => {
  const ending = (take: Take) =>
    take.failure === null
      ? `finished in ${take.seconds.toFixed(1)}s`
      : `stopped${take.failure.step === "" ? "" : ` at "${take.failure.step}"`} after ${take.seconds.toFixed(1)}s: \`${take.failure.message.slice(0, 200)}\``;
  return [
    `#### Flow \`${input.name}\`, as ${input.person.name} (${input.person.role})`,
    "",
    ...input.provenance,
    "",
    ...input.takes.map(
      (take) => `- ${take.side === "before" ? "Before" : "After"}: ${ending(take)}`
    ),
    "",
    ...(input.takes.length === 2 ? ["Before is on the left, after on the right.", ""] : []),
    // gh rewrites an image reference to a video into a bare URL, which GitHub plays inline.
    `![${input.name}](${input.video})`
  ].join("\n");
};
