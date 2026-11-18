import { afterAll, assert, describe, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { Companies, Teams, Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ConnectionStore from "../src/ConnectionStore.js";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as AttioSource from "../src/attio/Source.js";
import * as NotionSource from "../src/notion/Source.js";
import * as Access from "../src/github/Access.js";
import * as Github from "../src/github/index.js";
import * as Operations from "../src/github/Operations.js";
import * as PidgeonSource from "../src/pidgeon/Source.js";
import * as PostgresSource from "../src/postgres/Source.js";
import * as PostHogSource from "../src/posthog/Source.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";
import * as GithubDouble from "../src/test/github.js";
import * as ImapTest from "../src/test/imap.js";
import * as Live from "./githubHarness.js";
import * as PatchVisibilityTest from "../src/test/patchVisibility.js";

/**
 * GitHub's reads against GitHub itself, through the CI App, "Patchy Cloud CI": a Patchy-owned
 * test repository, read on every by-id route the reads use, its job log through the log store's
 * redirect. It notices a route or the log host changing only when it runs; it is not monitoring,
 * and the offline tests (`src/github`) carry correctness.
 *
 * It needs the CI App's five `PATCHY_GITHUB_APP_*` settings, `PATCHY_GITHUB_LIVE_INSTALLATION_ID`, the
 * App's installation on the account holding the test repository, and `PATCHY_GITHUB_LIVE_REPOSITORY_IDS`,
 * comma-separated repository ids in it: the first with at least one finished workflow run whose
 * job has a log, a check run on that run's commit and a pull request; a second, when given, is
 * where a run of the first must be `not_found`. It skips without them. Nothing here prints a
 * token, a log's text, a signed URL or the installation's id.
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const id = `conn_github_live_${Date.now().toString(36)}`;
const handle = `live${Date.now().toString(36)}`;

const keys = CredentialKeys.layerFromKeys(
  Redacted.make(`test:${Buffer.alloc(32, 8).toString("base64")}`)
);
const services = Layer.mergeAll(
  keys,
  RuntimeLog.layer,
  Companies.layer,
  Users.layer,
  // Never called: these connections reach no database, PostHog project, Pidgeon or Attio.
  Layer.succeed(
    PostgresSource.Source,
    PostgresSource.Source.of({
      test: () => Effect.die("no Postgres here"),
      inspect: () => Effect.die("no Postgres here")
    })
  ),
  PostHogSource.layer,
  PidgeonSource.layer,
  AttioSource.layer,
  NotionSource.layer,
  ImapTest.offline,
  // Production's GitHub, configured from the host settings this run was given.
  Github.layer.pipe(Layer.provide(keys))
).pipe(
  Layer.provideMerge(PatchVisibilityTest.layer),
  Layer.provideMerge(Teams.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(NodeCryptography.layer)
);

afterAll(Live.summary);

/** The test repositories, checked and discovered as connect does, saved as the connection. */
const connected = Effect.gen(function* () {
  const access = yield* Access.Access;
  const inspected = yield* access.inspect(
    Number(Live.INSTALLATION),
    Live.REPOSITORIES,
    "the test account"
  );
  yield* GithubDouble.save({
    ...who,
    id,
    handle,
    installationId: Number(Live.INSTALLATION),
    account: inspected.account,
    repositories: inspected.repositories
  });
  return inspected.repositories;
});

type Op = keyof typeof Operations.devReads;
const read = (op: Op, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const store = yield* SqlConnectionStore.make;
    Live.counts.reads++;
    return (yield* Operations.devReads[op]
      .run(
        {
          companyId: who.companyId,
          connection: { id, handle },
          deadline: (yield* Clock.currentTimeMillis) + 15_000,
          recheck: Effect.void
        },
        args
      )
      .pipe(Effect.provideService(ConnectionStore.ConnectionStore, store))) as Record<
      string,
      unknown
    >;
  });

describe.skipIf(!Live.configured)("GitHub reads live", () => {
  it.layer(services, { timeout: "180 seconds", excludeTestServices: true })("the CI App", (it) => {
    it.effect(
      "answers every read on its by-id route, the job log through the log store",
      () =>
        Effect.gen(function* () {
          const [first, second] = yield* connected;
          const repo = first!.name;
          const listed = yield* read("github.listRepos", {});
          assert.includeMembers(
            (listed.repositories as Array<{ id: number }>).map((item) => item.id),
            Live.REPOSITORIES
          );
          assert.strictEqual(
            ((yield* read("github.getRepo", { repo })).repository as { id: number }).id,
            first!.id
          );
          assert.isBoolean((yield* read("github.listWorkflows", { repo })).complete);

          const runs = (yield* read("github.listRuns", { repo, status: "completed", limit: 5 }))
            .runs as Array<{ id: number; headSha: string }>;
          assert.isNotEmpty(runs, "the test repository has a finished workflow run");
          const run = runs[0]!;
          assert.strictEqual(
            ((yield* read("github.getRun", { repo, runId: run.id })).run as { id: number }).id,
            run.id
          );
          const jobs = (yield* read("github.listJobs", { repo, runId: run.id })).jobs as Array<{
            id: number;
          }>;
          assert.isNotEmpty(jobs);
          // The log store's host still matches, and still answers closed ranges.
          const log = yield* read("github.getJobLog", { repo, jobId: jobs[0]!.id });
          assert.isAbove(log.size as number, 0);
          assert.isString(log.text);
          assert.isBoolean((yield* read("github.listChecks", { repo, ref: run.headSha })).complete);

          const pulls = (yield* read("github.listPulls", { repo, state: "all", limit: 5 }))
            .pulls as Array<{ number: number }>;
          assert.isNotEmpty(pulls, "the test repository has a pull request");
          const number = pulls[0]!.number;
          assert.strictEqual(
            ((yield* read("github.getPull", { repo, number })).pull as { number: number }).number,
            number
          );
          assert.isBoolean((yield* read("github.listPullFiles", { repo, number })).complete);
          assert.isBoolean((yield* read("github.listPullReviews", { repo, number })).complete);

          // A run of the first repository is nobody's under the second's id.
          if (second !== undefined) {
            const refused = yield* Effect.flip(
              read("github.getRun", { repo: second.name, runId: run.id })
            );
            assert.strictEqual(refused.code, "not_found");
          }
        }),
      180_000
    );
  });
});
