/**
 * `pnpm check` and `pnpm verify`: CI's required checks, run locally.
 *
 *   pnpm check              format, lint, typecheck and the offline tests
 *   pnpm verify             check, then every acceptance suite CI requires except live Clerk
 *   pnpm verify --changed   the same, skipping the acceptance suites when nothing since the
 *                           merge base with origin/main can change what they exercise
 *
 * Suites run one at a time and keep going after a failure, so one run reports
 * everything; the exit code is nonzero if any failed. Keep the acceptance list
 * in step with the jobs in .github/workflows/ci.yml.
 */
import { execFileSync, spawnSync } from "node:child_process";

interface Suite {
  readonly name: string;
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
}

const pnpm = (...args: Array<string>) => ["pnpm", ...args];

const check: ReadonlyArray<Suite> = [
  { name: "format", commands: [pnpm("format:check")] },
  { name: "lint", commands: [pnpm("lint")] },
  { name: "typecheck", commands: [pnpm("typecheck")] },
  { name: "test", commands: [pnpm("test")] }
];

const acceptance: ReadonlyArray<Suite> = [
  { name: "postgres-concurrency", commands: [pnpm("test:postgres-concurrency")] },
  {
    name: "cli-smoke",
    commands: [
      ["node", "scripts/packed-cli-e2e.mjs", "--platform-probes"],
      ["node", "scripts/packed-cli-e2e.mjs", "--lifecycle-probes"],
      ["node", "scripts/packed-cli-e2e.mjs", "--signal-probes"],
      pnpm("test:packed-cli-e2e"),
      pnpm("test:packed-preact-e2e")
    ]
  },
  { name: "tier2-smoke", commands: [pnpm("test:packed-tier2-e2e")] },
  { name: "browser", commands: [pnpm("test:browser")] }
];

/**
 * Changes no acceptance suite can observe: prose, agent wiring and the dev
 * runner, except the Postgres settings the test harnesses share with it.
 */
const outsideProduct = [
  /^docs\//,
  /^scenarios\//,
  /^scripts\/dev\/(?!src\/postgres\.ts$)/,
  /^\.agents\//,
  /^\.claude\//,
  /^\.github\/(ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE\.md$)/,
  /^[^/]+\.md$/,
  /^packages\/[^/]+\/CONTEXT\.md$/,
  /^t3\.json$/
];

const git = (...args: Array<string>) =>
  execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);

/** Committed, staged, unstaged and untracked changes since the merge base with origin/main. */
const changedFiles = () => {
  const base = git("merge-base", "HEAD", "origin/main")[0]!;
  return [
    ...git("diff", "--name-only", base),
    ...git("ls-files", "--others", "--exclude-standard")
  ];
};

const [mode, ...flags] = process.argv.slice(2);
if ((mode !== "check" && mode !== "verify") || flags.some((flag) => flag !== "--changed")) {
  console.error("Usage: pnpm check | pnpm verify [--changed]");
  process.exit(2);
}

const suites: Array<Suite> = [...check];
const skipped: Array<string> = [];
if (mode === "verify") {
  const product = flags.includes("--changed")
    ? changedFiles().filter((file) => !outsideProduct.some((pattern) => pattern.test(file)))
    : undefined;
  if (product === undefined || product.length > 0) suites.push(...acceptance);
  else skipped.push(...acceptance.map((suite) => suite.name));
}

const results: Array<{ name: string; ok: boolean; seconds: number }> = [];
for (const suite of suites) {
  console.log(`\n▶ ${suite.name}`);
  const started = performance.now();
  let ok = true;
  for (const [command, ...args] of suite.commands) {
    if (spawnSync(command!, args, { stdio: "inherit" }).status !== 0) {
      ok = false;
      break;
    }
  }
  results.push({ name: suite.name, ok, seconds: Math.round((performance.now() - started) / 1000) });
}

console.log("");
for (const result of results)
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name.padEnd(22)} ${result.seconds}s`);
for (const name of skipped) console.log(`SKIP  ${name.padEnd(22)} nothing it exercises changed`);
const failed = results.filter((result) => !result.ok).length;
console.log(`\n${failed === 0 ? "All passed." : `${failed} of ${results.length} failed.`}`);
process.exitCode = failed === 0 ? 0 : 1;
