/**
 * `pnpm dev eval --calibrate`: whether the judges agree with people. A few
 * builds a person has labelled live in `scripts/dev/eval-calibration/`, each
 * its published source and, when it has them, its screenshots; the labels are
 * pairings in `expectations.json`: on these dimensions, this build is better
 * than that one, and why. Each judge scores every build blind, exactly as in a
 * suite, and must rank every pairing the labelled way. A judge that doesn't
 * is not one to trust with a suite's scores until the rubric, the prompt or
 * the labels change.
 */
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { realNode } from "../runtimes.js";
import { installToolchain, readSignIns } from "./home.js";
import {
  type Dimension,
  DIMENSIONS,
  judge,
  JUDGE_IDS,
  JUDGES,
  NO_INSTANCE,
  type Scores
} from "./judges.js";
import { openNetwork } from "./network.js";
import { checkSandbox, readToolchain } from "./sandbox.js";
import { TASKS } from "./tasks/index.js";

export class CalibrationFailed extends Schema.TaggedError<CalibrationFailed>()(
  "CalibrationFailed",
  { missed: Schema.Int, of: Schema.Int }
) {
  override get message() {
    return `The judges ranked ${this.missed} of ${this.of} labelled pairings the other way; read the table above before trusting a suite's scores.`;
  }
}

export const Expectation = Schema.Struct({
  task: Schema.String,
  /** The build that should score higher, by its folder's name. */
  better: Schema.String,
  worse: Schema.String,
  /** The dimensions whose mean must be higher for `better`. */
  on: Schema.NonEmptyArray(Schema.Literals(DIMENSIONS)),
  why: Schema.String
});
export type Expectation = typeof Expectation.Type;
const decodeExpectations = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Expectation))
);

/** The mean of `scores` over `on`. */
const over = (scores: Scores, on: ReadonlyArray<Dimension>) =>
  on.reduce((sum, dimension) => sum + scores[dimension], 0) / on.length;

/** Whether a judge's scores rank a pairing the labelled way; null when it gave either build no verdict. */
export const ranks = (
  expectation: Expectation,
  better: Scores | null,
  worse: Scores | null
): boolean | null =>
  better === null || worse === null
    ? null
    : over(better, expectation.on) > over(worse, expectation.on);

export const runCalibration = Effect.fn("Eval.runCalibration")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* checkSandbox(root);
  const samples = path.join(root, "scripts", "dev", "eval-calibration");
  const expectations = yield* decodeExpectations(
    yield* fs.readFileString(path.join(samples, "expectations.json"))
  );
  const builds = [...new Set(expectations.flatMap((each) => [each.better, each.worse]))];
  const judges = JUDGE_IDS.map((id) => JUDGES[id]);
  const toolchain = yield* readToolchain(root);
  const signIns = yield* readSignIns(judges);
  const stamp = DateTime.formatIso(yield* DateTime.now)
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "");
  const dir = path.join(root, ".local", "evals", `calibrate-${stamp}`);
  yield* fs.makeDirectory(dir, { recursive: true });
  const scores = yield* Effect.scoped(
    Effect.gen(function* () {
      const network = yield* openNetwork({
        node: (yield* realNode()).execPath,
        instancePort: NO_INSTANCE,
        allow: signIns.privateEndpoints
      });
      const template = path.join(dir, "homes", "judges");
      yield* fs.makeDirectory(template, { recursive: true });
      yield* Console.error("  judges  setting up the judges' home");
      yield* installToolchain({ home: template, network }, toolchain, ["claude-code", "codex"]);
      // Each build's folder once, before any judge reads it: both judges of a build share it.
      const shotsOf = new Map<string, ReadonlyArray<string>>();
      for (const build of builds) {
        const runDir = path.join(dir, build);
        yield* fs.makeDirectory(runDir, { recursive: true });
        const shots: Array<string> = [];
        for (const shot of ["desktop.png", "phone.png"])
          if (yield* fs.exists(path.join(samples, build, shot))) {
            yield* fs.copyFile(path.join(samples, build, shot), path.join(runDir, shot));
            shots.push(shot);
          }
        yield* fs.copy(path.join(samples, build, "source"), path.join(runDir, "source"));
        shotsOf.set(build, shots);
      }
      const pairs = builds.flatMap((build) => judges.map((who) => ({ build, who })));
      yield* Console.error(
        `Judging ${builds.length} labelled builds with ${JUDGE_IDS.join(" and ")}`
      );
      return yield* Effect.forEach(
        pairs,
        ({ build, who }) =>
          Effect.gen(function* () {
            const task = expectations.find(
              (each) => each.better === build || each.worse === build
            )!.task;
            const result = yield* judge({
              judge: who,
              task: TASKS.find((each) => each.id === task)!,
              runDir: path.join(dir, build),
              staging: path.join(dir, "judging"),
              instance: null,
              source: "source",
              screenshots: shotsOf.get(build) ?? [],
              checks: [],
              log: null,
              checkout: root,
              template,
              network,
              signIns,
              attribute: false
            });
            yield* Console.error(
              `  ${`${who.id} ${build}`.padEnd(32)}  ${
                result.record.scores === null
                  ? `no verdict: ${result.record.infra}`
                  : DIMENSIONS.map((d) => `${d} ${result.record.scores![d]}`).join(", ")
              }`
            );
            return { build, judge: who.id, scores: result.record.scores };
          }),
        { concurrency: 4 }
      );
    })
  );
  const scoreOf = (build: string, judgeId: string) =>
    scores.find((each) => each.build === build && each.judge === judgeId)?.scores ?? null;
  const lines = [
    "| Better | Worse | On | " + JUDGE_IDS.join(" | ") + " |",
    "| --- | --- | --- | " + JUDGE_IDS.map(() => "---").join(" | ") + " |"
  ];
  let missed = 0;
  for (const expectation of expectations) {
    const cells = JUDGE_IDS.map((judgeId) => {
      const better = scoreOf(expectation.better, judgeId);
      const worse = scoreOf(expectation.worse, judgeId);
      const ranked = ranks(expectation, better, worse);
      if (ranked !== true) missed++;
      return ranked === null
        ? "no verdict"
        : `${ranked ? "✓" : "✗"} ${over(better!, expectation.on).toFixed(1)} vs ${over(worse!, expectation.on).toFixed(1)}`;
    });
    lines.push(
      `| ${expectation.better} | ${expectation.worse} | ${expectation.on.join(", ")} | ${cells.join(" | ")} |`
    );
  }
  yield* Console.log(["", ...lines, ""].join("\n"));
  const of = expectations.length * JUDGE_IDS.length;
  if (missed > 0) return yield* new CalibrationFailed({ missed, of });
  yield* Console.log(
    `Both judges ranked all ${expectations.length} labelled pairings the labelled way.`
  );
});
