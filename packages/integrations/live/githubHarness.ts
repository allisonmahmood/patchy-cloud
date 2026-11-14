/**
 * What GitHub's live tier reads from its environment, and its count of reads: the CI App's
 * installation and test repositories. The App's own five settings reach `Github.layer` through
 * Effect `Config`, as on a host. The tier skips when any is missing.
 */

/** The CI App's installation on the account holding the test repositories. */
export const INSTALLATION = process.env.PATCHY_GITHUB_LIVE_INSTALLATION_ID;
/** The test repositories' ids, comma-separated: the first has runs, logs, checks and a pull request. */
export const REPOSITORIES = (process.env.PATCHY_GITHUB_LIVE_REPOSITORY_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value !== "")
  .map(Number);
export const configured =
  INSTALLATION !== undefined &&
  REPOSITORIES.length > 0 &&
  process.env.PATCHY_GITHUB_APP_PRIVATE_KEY !== undefined;

/** How many reads this run sent: the installation's hourly budget is shared. */
export const counts = { reads: 0 };
export const summary = () => console.log(`GitHub live run: ${counts.reads} reads.`);
