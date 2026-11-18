import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { Companies, Teams, Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { registry } from "@patchy/limits/registry";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as AttioSource from "../attio/Source.js";
import * as NotionSource from "../notion/Source.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as GithubDouble from "../test/github.js";
import * as ImapTest from "../test/imap.js";
import * as PatchVisibilityTest from "../test/patchVisibility.js";
import * as Log from "./Log.js";
import * as Operations from "./Operations.js";

/**
 * The reads patch code calls on a GitHub connection, offline over the scripted GitHub: the set
 * check before GitHub hears anything, by-id addressing, answers about another repository, each
 * list's `complete`, cursors, a job log's two range requests and every way its store can answer
 * wrong, and what a refused token does.
 */

const admin = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };

const services = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 6).toString("base64")}`)),
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
  ImapTest.offline
).pipe(
  Layer.provideMerge(PatchVisibilityTest.layer),
  Layer.provideMerge(Teams.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(NodeCryptography.layer)
);

const API = 11;
const SITE = 14;
const DOCS = 13;

/**
 * An organization's installation holding a private `api`, a public `site` and a public `docs`;
 * the connection holds `api` and `site`. A public repository elsewhere, which any token reads.
 */
let scenes = 0;
const scene = () => {
  const base = ++scenes * 1000;
  const installationId = base + 1;
  const id = `conn_github_reads_${scenes}`;
  const handle = `platform${scenes}`;
  const github = GithubDouble.world();
  github.add({
    id: installationId,
    account: { id: 9001, login: "northwind-labs", type: "Organization" },
    repositories: [
      { id: API, name: "api" },
      { id: SITE, name: "site", private: false },
      { id: DOCS, name: "docs", private: false }
    ]
  });
  github.strangers.set(77, { id: 77, name: "elsewhere", private: false });
  return { github, installationId, id, handle };
};
type Scene = ReturnType<typeof scene>;

/** A test's body over a fresh scene, its connection saved, with GitHub's services built for it. */
const within = <A, E, R>(body: (made: Scene) => Effect.Effect<A, E, R>) => {
  const made = scene();
  return Effect.gen(function* () {
    yield* made.github.connection({
      ...admin,
      id: made.id,
      handle: made.handle,
      installationId: made.installationId,
      repositoryIds: [API, SITE]
    });
    return yield* body(made);
  }).pipe(Effect.provide(made.github.layer));
};

type Op = keyof typeof Operations.devReads;
/** One read as the dev door runs it, its caller already admitted. */
const read = (made: Scene, op: Op, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const store = yield* SqlConnectionStore.make;
    const value = yield* Operations.devReads[op]
      .run(
        {
          companyId: admin.companyId,
          connection: { id: made.id, handle: made.handle },
          deadline: (yield* Clock.currentTimeMillis) + 15_000,
          recheck: Effect.void
        },
        args
      )
      .pipe(Effect.provideService(ConnectionStore.ConnectionStore, store));
    return value as Record<string, unknown>;
  });
/** The refusal a read ends in, as the wire says it. */
const refusal = (made: Scene, op: Op, args: Record<string, unknown>) =>
  Effect.map(Effect.flip(read(made, op, args)), (error) => ({
    code: error.code,
    details: "details" in error ? error.details : undefined
  }));

const apiRequests = (made: Scene) =>
  made.github.requests.filter((request) => request.url.pathname.startsWith("/repositories/"));
const storeRequests = (made: Scene) =>
  made.github.requests.filter((request) => request.url.hostname.endsWith(".blob.core.windows.net"));

it.layer(services)("GitHub reads", (it) => {
  it.effect(
    "refuses a repository outside the connection before GitHub hears of it, a public one too",
    () =>
      within((made) =>
        Effect.gen(function* () {
          for (const repo of ["docs", "elsewhere", "nonexistent"])
            assert.deepStrictEqual(yield* refusal(made, "github.getRepo", { repo }), {
              code: "not_found",
              details: { resource: "repository" }
            });
          // Nothing was sent: no mint, no read, for the public `docs` any token could read.
          assert.lengthOf(made.github.requests, 0);
          // The set's own repositories read, by numeric id, never by name.
          const answer = yield* read(made, "github.getRepo", { repo: "SITE" });
          assert.deepInclude(answer, { ok: true });
          assert.deepInclude(answer.repository as object, {
            id: SITE,
            name: "site",
            private: false
          });
          assert.deepStrictEqual(
            apiRequests(made).map((request) => request.url.pathname),
            [`/repositories/${SITE}`]
          );
          const listed = yield* read(made, "github.listRepos", {});
          assert.deepStrictEqual(
            (listed.repositories as Array<{ name: string }>).map((item) => item.name),
            ["api", "site"]
          );
          assert.isTrue(listed.complete);
        })
      )
  );

  it.effect("lists no repositories once every one has left the installation", () =>
    within((made) =>
      Effect.gen(function* () {
        made.github.installations.get(made.installationId)!.repositories = [
          { id: DOCS, name: "docs", private: false }
        ];
        assert.deepStrictEqual(yield* read(made, "github.listRepos", {}), {
          ok: true,
          repositories: [],
          complete: true
        });
      })
    )
  );

  it.effect("finds no run or job of another repository under this one's id", () =>
    within((made) =>
      Effect.gen(function* () {
        const site = made.github.holds(SITE);
        site.runs.push(GithubDouble.run(SITE, 9001));
        site.jobs.set(9001, [GithubDouble.job(9001, 8001)]);
        site.logs.set(8001, "site's log\n");
        assert.deepStrictEqual(
          yield* refusal(made, "github.getRun", { repo: "api", runId: 9001 }),
          {
            code: "not_found",
            details: { resource: "run" }
          }
        );
        assert.deepStrictEqual(
          yield* refusal(made, "github.listJobs", { repo: "api", runId: 9001 }),
          {
            code: "not_found",
            details: { resource: "run" }
          }
        );
        assert.deepStrictEqual(
          yield* refusal(made, "github.getJobLog", { repo: "api", jobId: 8001 }),
          { code: "not_found", details: { resource: "job" } }
        );
        for (const request of apiRequests(made))
          assert.match(request.url.pathname, new RegExp(`^/repositories/${API}/`));
        assert.lengthOf(storeRequests(made), 0);
      })
    )
  );

  it.effect("refuses an answer that names another repository than the one asked for", () =>
    within((made) =>
      Effect.gen(function* () {
        const api = made.github.holds(API);
        api.runs.push(GithubDouble.run(API, 1), GithubDouble.run(SITE, 2));
        api.pulls.push(GithubDouble.pull(SITE, 5));
        assert.strictEqual(
          (yield* refusal(made, "github.listRuns", { repo: "api" })).code,
          "source_unavailable"
        );
        assert.strictEqual(
          (yield* refusal(made, "github.getRun", { repo: "api", runId: 2 })).code,
          "source_unavailable"
        );
        assert.strictEqual(
          (yield* refusal(made, "github.getPull", { repo: "api", number: 5 })).code,
          "source_unavailable"
        );
        // A job names no repository, only its run: one of another run is refused too.
        api.jobs.set(1, [GithubDouble.job(3, 31)]);
        assert.strictEqual(
          (yield* refusal(made, "github.listJobs", { repo: "api", runId: 1 })).code,
          "source_unavailable"
        );
      })
    )
  );

  it.effect("says whether each list is complete, false at GitHub's caps", () =>
    within((made) =>
      Effect.gen(function* () {
        const api = made.github.holds(API);
        const items = registry["github.list.items"].default;
        api.runs.push(GithubDouble.run(API, 1));
        api.runsTotal = 999;
        assert.isTrue((yield* read(made, "github.listRuns", { repo: "api" })).complete);
        api.runsTotal = 1_000;
        assert.isFalse((yield* read(made, "github.listRuns", { repo: "api" })).complete);

        for (let index = 0; index <= items; index++)
          api.workflows.push({
            id: index + 1,
            name: `w${index}`,
            path: `.github/workflows/w${index}.yml`,
            state: "active",
            html_url: "https://github.com/owner/api/actions"
          });
        const workflows = yield* read(made, "github.listWorkflows", { repo: "api" });
        assert.lengthOf(workflows.workflows as Array<unknown>, items);
        assert.isFalse(workflows.complete);

        // One page of jobs and of checks: complete at exactly a page, not one past it.
        const jobs = (count: number) =>
          Array.from({ length: count }, (_, index) => GithubDouble.job(1, 11 + index));
        api.jobs.set(1, jobs(items));
        assert.isTrue((yield* read(made, "github.listJobs", { repo: "api", runId: 1 })).complete);
        api.jobs.set(1, jobs(items + 1));
        assert.isFalse((yield* read(made, "github.listJobs", { repo: "api", runId: 1 })).complete);
        const checks = (count: number) =>
          Array.from({ length: count }, (_, index) => ({
            id: index + 1,
            name: `check-${index}`,
            status: "completed",
            conclusion: "success",
            started_at: null,
            completed_at: null,
            html_url: null,
            app: { slug: "github-actions" }
          }));
        api.checks.set("main", checks(items));
        assert.isTrue(
          (yield* read(made, "github.listChecks", { repo: "api", ref: "main" })).complete
        );
        api.checks.set("main", checks(items + 1));
        assert.isFalse(
          (yield* read(made, "github.listChecks", { repo: "api", ref: "main" })).complete
        );

        api.pulls.push(GithubDouble.pull(API, 1, { changed_files: 3_000 }));
        api.files.set(1, [
          {
            filename: "a.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ -1 +1 @@"
          },
          { filename: "logo.png", status: "added", additions: 0, deletions: 0, changes: 0 }
        ]);
        const files = yield* read(made, "github.listPullFiles", { repo: "api", number: 1 });
        assert.isTrue(files.complete);
        // GitHub sends no patch for a binary file: it reads as null.
        assert.strictEqual((files.files as Array<{ patch: string | null }>)[1]!.patch, null);
        api.pulls[0] = GithubDouble.pull(API, 1, { changed_files: 3_001 });
        assert.isFalse(
          (yield* read(made, "github.listPullFiles", { repo: "api", number: 1 })).complete
        );

        // Reviews: exactly a page is all of them; one more and GitHub names a next page.
        const reviews = (count: number) =>
          Array.from({ length: count }, (_, index) =>
            GithubDouble.review(index + 1, `r${index}`, "COMMENTED")
          );
        const summarized = Effect.map(
          read(made, "github.getPull", { repo: "api", number: 1 }),
          (answer) => (answer.pull as { reviews: { complete: boolean } }).reviews.complete
        );
        api.reviews.set(1, reviews(items));
        assert.isTrue(
          (yield* read(made, "github.listPullReviews", { repo: "api", number: 1 })).complete
        );
        assert.isTrue(yield* summarized);
        api.reviews.set(1, reviews(items + 1));
        assert.isFalse(
          (yield* read(made, "github.listPullReviews", { repo: "api", number: 1 })).complete
        );
        assert.isFalse(yield* summarized);
      })
    )
  );

  it.effect("carries a cursor on only for the call it came from", () =>
    within((made) =>
      Effect.gen(function* () {
        const api = made.github.holds(API);
        api.runs.push(GithubDouble.run(API, 2), GithubDouble.run(API, 1));
        const first = yield* read(made, "github.listRuns", {
          repo: "api",
          branch: "main",
          limit: 1
        });
        assert.isString(first.cursor);
        const second = yield* read(made, "github.listRuns", {
          repo: "api",
          branch: "main",
          limit: 1,
          cursor: first.cursor
        });
        assert.deepStrictEqual(
          (second.runs as Array<{ id: number }>).map((item) => item.id),
          [1]
        );
        assert.isNull(second.cursor);
        for (const other of [
          { repo: "api", branch: "release", limit: 1 },
          { repo: "api", branch: "main", limit: 2 },
          { repo: "site", branch: "main", limit: 1 }
        ])
          assert.strictEqual(
            (yield* refusal(made, "github.listRuns", { ...other, cursor: first.cursor })).code,
            "invalid_cursor"
          );
      })
    )
  );

  it.effect(
    "counts each reviewer's latest approval or request for changes, and reads forks from the base",
    () =>
      within((made) =>
        Effect.gen(function* () {
          const api = made.github.holds(API);
          api.pulls.push(
            GithubDouble.pull(API, 7, { head: { ref: "patch-1", sha: "c".repeat(40), repo: null } })
          );
          api.reviews.set(7, [
            GithubDouble.review(1, "ada", "APPROVED", 1),
            GithubDouble.review(2, "ada", "CHANGES_REQUESTED", 1),
            GithubDouble.review(3, "bo", "DISMISSED", 2),
            GithubDouble.review(4, "cy", "APPROVED", 3),
            GithubDouble.review(5, "cy", "COMMENTED", 3)
          ]);
          const pull = (yield* read(made, "github.getPull", { repo: "api", number: 7 })).pull as {
            reviews: unknown;
            head: { repository: unknown };
            author: unknown;
          };
          assert.deepStrictEqual(pull.reviews, {
            approved: 1,
            changesRequested: 1,
            complete: true
          });
          // The fork is gone: its head repository reads null, and nothing of it was asked.
          assert.isNull(pull.head.repository);
          assert.deepStrictEqual(pull.author, { login: "theo-ng", id: 7002 });
          for (const request of apiRequests(made))
            assert.match(request.url.pathname, new RegExp(`^/repositories/${API}/pulls/7`));
        })
      )
  );

  it.effect(
    "answers the end of a long log, cut on a character, from two closed ranges with no token",
    () =>
      within((made) =>
        Effect.gen(function* () {
          const bound = registry["github.log.bytes"].default;
          // Two-byte characters, so the cut falls inside one.
          const log = `${"é".repeat(bound / 2 + 5)}FINAL LINE\n`;
          made.github.holds(API).logs.set(42, log);
          const answer = yield* read(made, "github.getJobLog", { repo: "api", jobId: 42 });
          const size = new TextEncoder().encode(log).byteLength;
          assert.isTrue(answer.truncated);
          assert.strictEqual(answer.size, size);
          const text = answer.text as string;
          assert.isTrue(text.endsWith("FINAL LINE\n"));
          assert.notInclude(text, "\u{FFFD}");
          assert.isAtMost(new TextEncoder().encode(text).byteLength, bound);
          const ranges = storeRequests(made);
          assert.deepStrictEqual(
            ranges.map((request) => request.headers.range),
            ["bytes=0-0", `bytes=${size - bound}-${size - 1}`]
          );
          assert.strictEqual(ranges[1]!.headers["if-match"], '"0x8D1"');
          // The store's signed URL is its own credential: no token, cookie or trace context goes.
          for (const request of ranges)
            for (const header of ["authorization", "cookie", "traceparent", "b3", "tracestate"])
              assert.notProperty(request.headers, header);

          made.github.holds(API).logs.set(43, "short log\n");
          assert.deepInclude(yield* read(made, "github.getJobLog", { repo: "api", jobId: 43 }), {
            text: "short log\n",
            truncated: false,
            size: 10
          });
        })
      )
  );

  it.effect("reads a zero-length log as empty, with no second request", () =>
    within((made) =>
      Effect.gen(function* () {
        made.github.holds(API).logs.set(44, "");
        assert.deepInclude(yield* read(made, "github.getJobLog", { repo: "api", jobId: 44 }), {
          text: "",
          truncated: false,
          size: 0
        });
        assert.lengthOf(storeRequests(made), 1);
      })
    )
  );

  it.effect("refuses a log store that ignores the range, changes, redirects or answers short", () =>
    within((made) =>
      Effect.gen(function* () {
        made.github.holds(API).logs.set(45, "line one\nline two\n");
        for (const mode of ["whole", "changing", "redirect", "short"] as const) {
          made.github.state.store = mode;
          assert.strictEqual(
            (yield* refusal(made, "github.getJobLog", { repo: "api", jobId: 45 })).code,
            "source_unavailable",
            mode
          );
        }
        // Nothing followed the store's redirect.
        assert.isFalse(
          made.github.requests.some((request) => request.url.hostname === "elsewhere.example")
        );
      })
    )
  );

  it.effect("refuses a log redirect to any other host, and downloads nothing", () =>
    within((made) =>
      Effect.gen(function* () {
        made.github.holds(API).logs.set(46, "log\n");
        for (const host of [
          "productionresultssa.blob.core.windows.net",
          "productionresultssa7.blob.core.windows.net.example.com",
          "evil-productionresultssa7.blob.core.windows.net",
          "productionresultssa7.blob.core.windows.net:8443"
        ]) {
          made.github.state.logHost = host;
          assert.strictEqual(
            (yield* refusal(made, "github.getJobLog", { repo: "api", jobId: 46 })).code,
            "source_unavailable",
            host
          );
        }
        assert.isFalse(
          made.github.requests.some((request) => request.url.origin !== "https://api.github.com")
        );
        assert.isUndefined(Log.logUrl("http://productionresultssa7.blob.core.windows.net/x"));
        assert.isUndefined(
          Log.logUrl("https://user:pass@productionresultssa7.blob.core.windows.net/x")
        );
        assert.isDefined(Log.logUrl("https://productionresultssa12.blob.core.windows.net/x?sig=1"));
      })
    )
  );

  it.effect("drops a cached token GitHub refuses and reads once more with a new one", () =>
    within((made) =>
      Effect.gen(function* () {
        yield* read(made, "github.getRepo", { repo: "api" });
        assert.strictEqual(made.github.state.minted, 1);
        // GitHub stops honouring the cached token, as it does an uninstalled App's at once.
        made.github.tokens.clear();
        assert.deepInclude(yield* read(made, "github.getRepo", { repo: "api" }), { ok: true });
        assert.strictEqual(made.github.state.minted, 2);
      })
    )
  );

  it.effect("ends a call whose fresh token is refused, and mints no more", () =>
    within((made) =>
      Effect.gen(function* () {
        made.github.state.override = (request) =>
          request.url.pathname.startsWith("/repositories/")
            ? new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
                status: 403,
                headers: { "content-type": "application/json" }
              })
            : undefined;
        assert.strictEqual(
          (yield* refusal(made, "github.getRepo", { repo: "api" })).code,
          "source_unavailable"
        );
        assert.strictEqual(made.github.state.minted, 1);
        assert.lengthOf(apiRequests(made), 1);
      })
    )
  );

  it.effect("writes the installation's cooldown on a limit answer, before any token recovery", () =>
    within((made) =>
      Effect.gen(function* () {
        yield* read(made, "github.getRepo", { repo: "api" });
        made.github.state.override = (request) =>
          request.url.pathname.startsWith("/repositories/")
            ? new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
                status: 403,
                headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" }
              })
            : undefined;
        assert.strictEqual(
          (yield* refusal(made, "github.getRepo", { repo: "api" })).code,
          "source_rate_limited"
        );
        // The cached token wasn't taken for refused: nothing more was minted.
        assert.strictEqual(made.github.state.minted, 1);
        made.github.state.override = () => undefined;
        const sent = made.github.requests.length;
        assert.strictEqual(
          (yield* refusal(made, "github.getRepo", { repo: "api" })).code,
          "source_rate_limited"
        );
        assert.lengthOf(made.github.requests, sent);
      })
    )
  );
});
