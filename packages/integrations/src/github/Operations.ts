/**
 * The twelve reads patch code calls on a GitHub connection: repositories, CI and pull requests,
 * and a job's log, read and never written. Each call holds one of its installation's slots, has
 * its caller checked again, looks the repository's name up in the connection's current set before
 * GitHub hears anything, and reads it by numeric id with a token minted for the set. Patchy builds
 * every path; an answer that carries a repository's id must carry the one asked for. Results
 * leave the host through their wire schema only.
 */
import {
  GithubGetJobLog,
  GithubGetPull,
  GithubGetRepo,
  GithubGetRun,
  GithubListChecks,
  GithubListJobs,
  GithubListPullFiles,
  GithubListPullReviews,
  GithubListPulls,
  GithubListRepos,
  GithubListRuns,
  GithubListWorkflows,
  GithubRepoName,
  githubReads,
  type GithubRead
} from "@patchy/api";
import { canonicalArgs } from "@patchy/api/canonical-args";
import { Cryptography } from "@patchy/core";
import { registry } from "@patchy/limits/registry";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ConnectionStore from "../ConnectionStore.js";
import {
  connectionRecheck,
  operation,
  ownerCheck,
  ViewerRefusal,
  type DevRead,
  type Target
} from "../definition.js";
import * as Access from "./Access.js";
import * as Connection from "./Connection.js";
import { ConnectionNotDeclared, InvalidCursor, NeedsAttention, NotFound } from "./Errors.js";
import * as Log from "./Log.js";
import { answers, summary } from "./Records.js";
import * as Source from "./Source.js";

export { ConnectionNotDeclared } from "./Errors.js";

const DEADLINE_MS = registry["integration.deadline"].default;
const MAX_RESULT = registry["runtime.result.bytes"].default;
/** What one page of a list without a cursor holds. */
const ITEMS = registry["github.list.items"].default;
const LOG_BYTES = registry["github.log.bytes"].default;
/** GitHub's own caps: a run listing reaches its first 1,000 runs, a pull request's files 3,000. */
const RUNS_CAP = 1_000;
const FILES_CAP = 3_000;
/** The last page a cursor names: no list is followed past it, and none is issued a cursor that is. */
const PAGES_CAP = 100_000;
const LIMIT = 30;

type Json = typeof Schema.Json.Type;
type Inputs = { readonly [K in GithubRead]: (typeof githubReads)[K]["input"]["Type"] };
type Outputs = { readonly [K in GithubRead]: (typeof githubReads)[K]["output"]["Type"] };

export const Errors = Schema.Union([
  ConnectionNotDeclared,
  NotFound,
  InvalidCursor,
  NeedsAttention,
  Connection.RepositoryNotFound,
  Source.RateLimited,
  Source.Unavailable,
  Source.Timeout,
  Source.Busy,
  Source.Overflow,
  Runtime.InvalidRequest,
  ...ViewerRefusal.members,
  Runtime.TooLarge
]);

const encoder = new TextEncoder();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

// ---------- reading GitHub's answers ----------

/** GitHub's success, decoded and made a record, or unavailable when it doesn't read as one. */
const decoded = <A, B>(
  answer: Source.Answer,
  shape: { readonly decode: (value: unknown) => Option.Option<A> },
  make: (body: A) => B
) =>
  Option.match(Option.flatMap(decodeJson(answer.text), shape.decode), {
    onNone: () => Effect.fail(new Source.Unavailable({ stage: "response", upstreamStatus: 200 })),
    onSome: (body) => Effect.succeed(make(body))
  });

/** A 200 to read, a 404 as `missing`, anything else unavailable. */
const success = (answer: Source.Answer, missing: NotFound["resource"], also: number[] = []) =>
  answer.status === 200
    ? Effect.succeed(answer)
    : answer.status === 404 || also.includes(answer.status)
      ? Effect.fail(new NotFound({ resource: missing }))
      : Effect.fail(new Source.Unavailable({ stage: "status", upstreamStatus: answer.status }));

/**
 * Refuses an answer about another repository than the one asked for, which by-id addressing
 * should never give: GitHub changed something, and nothing it said is used.
 */
const same = (asked: number, found: ReadonlyArray<number>) =>
  found.every((id) => id === asked)
    ? Effect.void
    : Effect.logWarning("GitHub answered for another repository than the one asked; refused.").pipe(
        Effect.andThen(Effect.fail(new Source.Unavailable({ stage: "response" })))
      );

const query = (params: Readonly<Record<string, string | number | undefined>>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) search.set(key, String(value));
  return search.toString();
};
/** A ref as a path: its slashes kept, each part encoded. */
const refPath = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");
/** GitHub's date-range syntax for `created`, built from its two ends. */
const created = (span: Inputs["listRuns"]["created"]) =>
  span === undefined || (span.from === undefined && span.to === undefined)
    ? undefined
    : span.from !== undefined && span.to !== undefined
      ? `${span.from}..${span.to}`
      : span.from !== undefined
        ? `>=${span.from}`
        : `<=${span.to}`;

// ---------- cursors ----------

const CursorJson = Schema.fromJsonString(
  Schema.Struct({
    v: Schema.Literal(1),
    page: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: PAGES_CAP })),
    binding: Schema.String
  })
);
const encodeCursor = Schema.encodeSync(CursorJson);
const decodeCursor = Schema.decodeUnknownEffect(CursorJson, { onExcessProperty: "error" });

/**
 * What a cursor is bound to: the connection, the repository's id, the operation and every
 * argument but the cursor. Stateless and unsealed, as Attio's and IMAP's are: a forged one names
 * only another page of a list its caller may read.
 */
const binding = Effect.fnUntraced(function* (
  connectionId: string,
  repositoryId: number,
  name: GithubRead,
  args: Readonly<Record<string, unknown>>
) {
  // The repository by its id, which a rename keeps; the cursor isn't part of the call.
  const rest = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "cursor" && key !== "repo")
  );
  return yield* (yield* Cryptography.Cryptography).sha256(
    canonicalArgs(["github", 1, connectionId, repositoryId, name, rest])
  );
});
const pageOf = Effect.fnUntraced(function* (cursor: string | undefined, bound: string) {
  if (cursor === undefined) return 1;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return yield* new InvalidCursor({});
  const decoded = yield* decodeCursor(Buffer.from(cursor, "base64url").toString("utf8")).pipe(
    Effect.mapError(() => new InvalidCursor({}))
  );
  if (decoded.binding !== bound) return yield* new InvalidCursor({});
  return decoded.page;
});
const cursorFor = (bound: string, page: number) =>
  Buffer.from(encodeCursor({ v: 1, page, binding: bound }), "utf8").toString("base64url");
/** Whether GitHub says a page follows this one, for a list whose answer carries no total. */
const hasNext = (answer: Source.Answer) => /rel="next"/.test(answer.headers["link"] ?? "");

// ---------- the twelve reads ----------

interface Call {
  readonly reading: Access.Reading;
  readonly connectionId: string;
}
type Failure =
  NotFound | InvalidCursor | Source.AppError | Access.TokenRefused | Runtime.SourceUnavailable;

/** The repository a named call is on: `call` looked it up in the set before anything was sent. */
const repositoryOf = (reading: Access.Reading) => reading.repository?.id ?? 0;

/** A paged list's page and how its cursor is bound. */
const paged = Effect.fnUntraced(function* <K extends "listRuns" | "listPulls" | "listPullFiles">(
  call: Call,
  name: K,
  input: Inputs[K]
) {
  const bound = yield* binding(call.connectionId, repositoryOf(call.reading), name, input);
  return { bound, page: yield* pageOf(input.cursor, bound), limit: input.limit ?? LIMIT };
});

const reads: {
  readonly [K in GithubRead]: (
    call: Call,
    input: Inputs[K]
  ) => Effect.Effect<Outputs[K], Failure, Cryptography.Cryptography>;
} = {
  listRepos: ({ reading }) =>
    Effect.gen(function* () {
      // A token minted for the set lists exactly the set's repositories still in the installation.
      const answer = yield* reading.get(`/installation/repositories?${query({ per_page: 100 })}`);
      if (answer.status !== 200)
        return yield* new Source.Unavailable({ stage: "status", upstreamStatus: answer.status });
      const body = yield* decoded(answer, answers.installationRepos, (value) => value);
      const ids = new Set(reading.set.map((item) => item.id));
      return {
        ok: true,
        repositories: body.repositories
          .filter((item) => ids.has(item.id))
          .map(answers.installationRepos.make),
        complete: body.total_count <= body.repositories.length
      } as const;
    }),
  getRepo: ({ reading }) =>
    Effect.gen(function* () {
      const id = repositoryOf(reading);
      const answer = yield* success(yield* reading.get(`/repositories/${id}`), "repository");
      const repository = yield* decoded(answer, answers.repo, answers.repo.make);
      yield* same(id, [repository.id]);
      return { ok: true, repository } as const;
    }),
  listWorkflows: ({ reading }) =>
    Effect.gen(function* () {
      const id = repositoryOf(reading);
      const answer = yield* success(
        yield* reading.get(`/repositories/${id}/actions/workflows?${query({ per_page: ITEMS })}`),
        "repository"
      );
      const body = yield* decoded(answer, answers.workflows, (value) => value);
      return {
        ok: true,
        workflows: body.workflows.map(answers.workflows.make),
        complete: body.total_count <= body.workflows.length
      } as const;
    }),
  listRuns: (call, input) =>
    Effect.gen(function* () {
      const { reading } = call;
      const id = repositoryOf(reading);
      const { bound, page, limit } = yield* paged(call, "listRuns", input);
      const base =
        input.workflow === undefined
          ? `/repositories/${id}/actions/runs`
          : `/repositories/${id}/actions/workflows/${encodeURIComponent(String(input.workflow))}/runs`;
      const answer = yield* success(
        yield* reading.get(
          `${base}?${query({
            branch: input.branch,
            head_sha: input.sha,
            event: input.event,
            status: input.status,
            created: created(input.created),
            per_page: limit,
            page
          })}`
        ),
        input.workflow === undefined ? "repository" : "workflow"
      );
      const body = yield* decoded(answer, answers.runs, (value) => value);
      yield* same(
        id,
        body.workflow_runs.map((item) => item.repository.id)
      );
      const reachable = Math.min(body.total_count, RUNS_CAP);
      return {
        ok: true,
        runs: body.workflow_runs.map((item) => answers.runs.make(item, id)),
        cursor:
          body.workflow_runs.length === limit && page * limit < reachable
            ? cursorFor(bound, page + 1)
            : null,
        complete: body.total_count < RUNS_CAP
      } as const;
    }),
  getRun: ({ reading }, input) =>
    Effect.gen(function* () {
      const id = repositoryOf(reading);
      const answer = yield* success(
        yield* reading.get(`/repositories/${id}/actions/runs/${input.runId}`),
        "run"
      );
      const body = yield* decoded(answer, answers.run, (value) => value);
      yield* same(id, [body.repository.id]);
      if (body.id !== input.runId) return yield* new Source.Unavailable({ stage: "response" });
      return { ok: true, run: answers.run.make(body, id) } as const;
    }),
  listJobs: ({ reading }, input) =>
    Effect.gen(function* () {
      const id = repositoryOf(reading);
      const answer = yield* success(
        yield* reading.get(
          `/repositories/${id}/actions/runs/${input.runId}/jobs?${query({ filter: "latest", per_page: ITEMS })}`
        ),
        "run"
      );
      const body = yield* decoded(answer, answers.jobs, (value) => value);
      // A job names no repository, only its run: each must be the run asked for.
      if (body.jobs.some((item) => item.run_id !== input.runId))
        return yield* new Source.Unavailable({ stage: "response" });
      return {
        ok: true,
        jobs: body.jobs.map(answers.jobs.make),
        complete: body.total_count <= body.jobs.length
      } as const;
    }),
  getJobLog: ({ reading }, input) =>
    Effect.map(
      Log.read(reading, repositoryOf(reading), input.jobId, LOG_BYTES),
      (log) => ({ ok: true, ...log }) as const
    ),
  listChecks: ({ reading }, input) =>
    Effect.gen(function* () {
      const id = repositoryOf(reading);
      // An unknown ref answers 422 on GitHub's check runs, as an unknown commit.
      const answer = yield* success(
        yield* reading.get(
          `/repositories/${id}/commits/${refPath(input.ref)}/check-runs?${query({ per_page: ITEMS })}`
        ),
        "commit",
        [422]
      );
      const body = yield* decoded(answer, answers.checks, (value) => value);
      return {
        ok: true,
        checks: body.check_runs.map(answers.checks.make),
        complete: body.total_count <= body.check_runs.length
      } as const;
    }),
  listPulls: (call, input) =>
    Effect.gen(function* () {
      const { reading } = call;
      const id = repositoryOf(reading);
      const { bound, page, limit } = yield* paged(call, "listPulls", input);
      const head =
        input.head === undefined || input.head.includes(":")
          ? input.head
          : `${reading.account.login}:${input.head}`;
      const answer = yield* success(
        yield* reading.get(
          `/repositories/${id}/pulls?${query({
            state: input.state,
            base: input.base,
            head,
            sort: input.orderBy?.field,
            direction:
              input.orderBy?.direction ?? (input.orderBy === undefined ? undefined : "desc"),
            per_page: limit,
            page
          })}`
        ),
        "repository"
      );
      const body = yield* decoded(answer, answers.pulls, (value) => value);
      yield* same(
        id,
        body.map((item) => item.base.repo.id)
      );
      // A full page may have more behind it; past the last page a cursor names, Patchy stops.
      const more = body.length === limit;
      return {
        ok: true,
        pulls: body.map(answers.pulls.make),
        cursor: more && page < PAGES_CAP ? cursorFor(bound, page + 1) : null,
        complete: !more || page < PAGES_CAP
      } as const;
    }),
  getPull: ({ reading }, input) =>
    Effect.gen(function* () {
      const id = repositoryOf(reading);
      const answer = yield* success(
        yield* reading.get(`/repositories/${id}/pulls/${input.number}`),
        "pull_request"
      );
      const body = yield* decoded(answer, answers.pull, (value) => value);
      yield* same(id, [body.base.repo.id]);
      const reviewed = yield* success(
        yield* reading.get(
          `/repositories/${id}/pulls/${input.number}/reviews?${query({ per_page: ITEMS })}`
        ),
        "pull_request"
      );
      const reviews = yield* decoded(reviewed, answers.reviews, (value) =>
        value.map(answers.reviews.make)
      );
      return {
        ok: true,
        pull: {
          ...answers.pull.make(body),
          additions: body.additions,
          deletions: body.deletions,
          changedFiles: body.changed_files,
          reviews: { ...summary(reviews), complete: !hasNext(reviewed) }
        }
      } as const;
    }),
  listPullFiles: (call, input) =>
    Effect.gen(function* () {
      const { reading } = call;
      const id = repositoryOf(reading);
      const { bound, page, limit } = yield* paged(call, "listPullFiles", input);
      // The pull request says how many files it changed, so every page can say whether the
      // listing reaches them all.
      const pull = yield* decoded(
        yield* success(
          yield* reading.get(`/repositories/${id}/pulls/${input.number}`),
          "pull_request"
        ),
        answers.pull,
        (value) => value
      );
      yield* same(id, [pull.base.repo.id]);
      const answer = yield* success(
        yield* reading.get(
          `/repositories/${id}/pulls/${input.number}/files?${query({ per_page: limit, page })}`
        ),
        "pull_request"
      );
      const files = yield* decoded(answer, answers.files, (value) => value.map(answers.files.make));
      const reachable = Math.min(pull.changed_files, FILES_CAP);
      return {
        ok: true,
        files,
        cursor:
          files.length === limit && page * limit < reachable ? cursorFor(bound, page + 1) : null,
        complete: pull.changed_files <= FILES_CAP
      } as const;
    }),
  listPullReviews: ({ reading }, input) =>
    Effect.gen(function* () {
      const id = repositoryOf(reading);
      const answer = yield* success(
        yield* reading.get(
          `/repositories/${id}/pulls/${input.number}/reviews?${query({ per_page: ITEMS })}`
        ),
        "pull_request"
      );
      const reviews = yield* decoded(answer, answers.reviews, (value) =>
        value.map(answers.reviews.make)
      );
      return { ok: true, reviews, complete: !hasNext(answer) } as const;
    })
};

/** Each result through its own wire schema, so nothing outside it leaves the host. */
const outputs: {
  readonly [K in GithubRead]: (value: Outputs[K]) => Effect.Effect<Json, Schema.SchemaError>;
} = {
  listRepos: Schema.encodeEffect(githubReads.listRepos.output),
  getRepo: Schema.encodeEffect(githubReads.getRepo.output),
  listWorkflows: Schema.encodeEffect(githubReads.listWorkflows.output),
  listRuns: Schema.encodeEffect(githubReads.listRuns.output),
  getRun: Schema.encodeEffect(githubReads.getRun.output),
  listJobs: Schema.encodeEffect(githubReads.listJobs.output),
  getJobLog: Schema.encodeEffect(githubReads.getJobLog.output),
  listChecks: Schema.encodeEffect(githubReads.listChecks.output),
  listPulls: Schema.encodeEffect(githubReads.listPulls.output),
  getPull: Schema.encodeEffect(githubReads.getPull.output),
  listPullFiles: Schema.encodeEffect(githubReads.listPullFiles.output),
  listPullReviews: Schema.encodeEffect(githubReads.listPullReviews.output)
};
const result = <K extends GithubRead>(name: K, value: Outputs[K]) =>
  outputs[name](value).pipe(
    Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })),
    Effect.flatMap((encoded) =>
      encoder.encode(encodeJson(encoded)).byteLength > MAX_RESULT
        ? Effect.fail(
            new Runtime.TooLarge({ maxBytes: MAX_RESULT, limitId: "runtime.result.bytes" })
          )
        : Effect.succeed(encoded)
    )
  );

/** The door refused its caller once the call held a slot; `atConnection` hands on what it said. */
class CallerRefused extends Schema.TaggedError<CallerRefused>()("GithubCallerRefused", {}) {
  override get message() {
    return "The caller was refused once the call held a slot; nothing was sent.";
  }
}

/** The connection's own refusals, as a call says them. */
const refusals = {
  GithubConnectionMissing: (companyId: string, id: string) =>
    new ConnectionStore.ConnectionNotFound({ companyId, lookup: { id } }),
  GithubNotConnected: () => new ConnectionStore.ConnectionNotConnected({})
};

/**
 * One read on the connection its door admitted: the repository it names, its caller checked
 * again once it holds a slot. The door's refusal of its caller and the connection's absence come
 * back as they are, for the door to say; a pause Patchy made during the call is said as such.
 */
const atConnection = Effect.fnUntraced(function* <K extends GithubRead, E>(
  target: Target<E>,
  name: K,
  input: Inputs[K]
) {
  const access = yield* Access.Access;
  const cryptography = yield* Cryptography.Cryptography;
  const caller = yield* Ref.make(Option.none<E>());
  const repository = "repo" in input && typeof input.repo === "string" ? input.repo : null;
  const read = reads[name];
  const answered = yield* access
    .call(
      {
        companyId: target.companyId,
        id: target.connection.id,
        repository,
        deadline: Math.min(target.deadline, (yield* Clock.currentTimeMillis) + DEADLINE_MS),
        recheck: target.recheck.pipe(
          Effect.tapError((error) => Ref.set(caller, Option.some(error))),
          Effect.mapError(() => new CallerRefused({}))
        )
      },
      (reading) =>
        read({ reading, connectionId: target.connection.id }, input).pipe(
          Effect.provideService(Cryptography.Cryptography, cryptography)
        )
    )
    .pipe(
      Effect.flatMap((value) => result(name, value)),
      // Every repository of the set left: a read of the whole set is an empty list, not a refusal.
      Effect.catchIf(
        (error) => repository === null && error._tag === "GithubRepositoryNotFound",
        () => result("listRepos", { ok: true, repositories: [], complete: true })
      ),
      Effect.catchTags({
        GithubConnectionMissing: () =>
          Effect.fail(refusals.GithubConnectionMissing(target.companyId, target.connection.id)),
        GithubNotConnected: () => Effect.fail(refusals.GithubNotConnected()),
        GithubStorageFailed: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
        CredentialDecryptionFailed: (cause) =>
          Effect.fail(new Runtime.SourceUnavailable({ cause })),
        GithubNotOffered: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
        GithubInstallationGone: (error) =>
          Effect.fail(new NeedsAttention({ reason: "uninstalled", account: error.account })),
        GithubPermissionsChanged: (error) =>
          Effect.fail(new NeedsAttention({ reason: "permissions", account: error.account }))
      }),
      Effect.result
    );
  if (answered._tag === "Success") return answered.success;
  const failure = answered.failure;
  if (failure._tag === "GithubCallerRefused") {
    const refused = yield* Ref.get(caller);
    return Option.isSome(refused)
      ? yield* Effect.fail(refused.value)
      : yield* new Runtime.SourceUnavailable({ cause: failure });
  }
  return yield* Effect.fail(failure);
});

/**
 * One read as a loaded version's door admitted it: the declared connection and its viewer, the
 * patch's owner able to build with it now and again once the call holds its slot.
 */
const perform = Effect.fn("GithubOperations.perform")(function* <K extends GithubRead>(
  connection: string,
  name: K,
  input: Inputs[K]
) {
  const binding = yield* Binding.Binding;
  const declaration = binding.manifest.uses[connection];
  if (!Object.hasOwn(binding.manifest.uses, connection) || declaration?.kind !== "github")
    return yield* new ConnectionNotDeclared({});
  const { identity, principal, companyId } = binding;
  if (
    binding.scope === "public" ||
    identity === null ||
    principal === null ||
    identity.company.id !== companyId ||
    identity.user.id !== principal.userId
  )
    return yield* new Runtime.AccessDenied({});
  const deadline = binding.deadline ?? (yield* Clock.currentTimeMillis) + DEADLINE_MS;
  yield* ownerCheck(binding, declaration.id);
  const recheck = connectionRecheck(binding, declaration.id).pipe(
    Effect.provideService(ConnectionStore.ConnectionStore, yield* ConnectionStore.ConnectionStore)
  );
  return yield* atConnection(
    {
      companyId,
      connection: { id: declaration.id, handle: declaration.handle },
      deadline,
      recheck
    },
    name,
    input
  ).pipe(
    Effect.catchTags({
      ConnectionNotFound: (cause) => Effect.fail(new Runtime.AccessDenied({ cause })),
      ConnectionNotConnected: (cause) => Effect.fail(new Runtime.AccessDenied({ cause }))
    })
  );
});

export const operations = {
  listRepos: operation({
    input: GithubListRepos,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection }: typeof GithubListRepos.Type) => perform(connection, "listRepos", {})
  }),
  getRepo: operation({
    input: GithubGetRepo,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection, ...input }: typeof GithubGetRepo.Type) =>
      perform(connection, "getRepo", input)
  }),
  listWorkflows: operation({
    input: GithubListWorkflows,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection, ...input }: typeof GithubListWorkflows.Type) =>
      perform(connection, "listWorkflows", input)
  }),
  listRuns: operation({
    input: GithubListRuns,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection, ...input }: typeof GithubListRuns.Type) =>
      perform(connection, "listRuns", input)
  }),
  getRun: operation({
    input: GithubGetRun,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection, ...input }: typeof GithubGetRun.Type) =>
      perform(connection, "getRun", input)
  }),
  listJobs: operation({
    input: GithubListJobs,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection, ...input }: typeof GithubListJobs.Type) =>
      perform(connection, "listJobs", input)
  }),
  getJobLog: operation({
    input: GithubGetJobLog,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection, ...input }: typeof GithubGetJobLog.Type) =>
      perform(connection, "getJobLog", input)
  }),
  listChecks: operation({
    input: GithubListChecks,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection, ...input }: typeof GithubListChecks.Type) =>
      perform(connection, "listChecks", input)
  }),
  listPulls: operation({
    input: GithubListPulls,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection, ...input }: typeof GithubListPulls.Type) =>
      perform(connection, "listPulls", input)
  }),
  getPull: operation({
    input: GithubGetPull,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection, ...input }: typeof GithubGetPull.Type) =>
      perform(connection, "getPull", input)
  }),
  listPullFiles: operation({
    input: GithubListPullFiles,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection, ...input }: typeof GithubListPullFiles.Type) =>
      perform(connection, "listPullFiles", input)
  }),
  listPullReviews: operation({
    input: GithubListPullReviews,
    output: Schema.Json,
    errors: Errors,
    run: ({ connection, ...input }: typeof GithubListPullReviews.Type) =>
      perform(connection, "listPullReviews", input)
  })
};

const connectionId = (args: unknown, binding: Binding.Binding["Service"]): string | null => {
  if (
    !Predicate.isObject(args) ||
    typeof args.connection !== "string" ||
    !Object.hasOwn(binding.manifest.uses, args.connection)
  )
    return null;
  const declaration = binding.manifest.uses[args.connection];
  return declaration?.kind === "github" ? declaration.id : null;
};

const isRepoName = Schema.is(GithubRepoName);
/** The array a read answers rows in, if it answers any. */
const rowsOf: { readonly [K in GithubRead]: string | null } = {
  listRepos: "repositories",
  getRepo: null,
  listWorkflows: "workflows",
  listRuns: "runs",
  getRun: null,
  listJobs: "jobs",
  getJobLog: null,
  listChecks: "checks",
  listPulls: "pulls",
  getPull: null,
  listPullFiles: "files",
  listPullReviews: "reviews"
};
/**
 * How a call reads in recent calls: the repository it named and how many rows came back, or one
 * for a read of one thing. Never a filter, an id, a branch, code or a log. It runs on arguments
 * not yet checked, so it keeps only a name shaped like a repository's.
 */
const recordedBy = (name: GithubRead) => ({
  resource: (args: unknown): string | null =>
    Predicate.isObject(args) && isRepoName(args.repo) ? args.repo : null,
  rowCount: (value: unknown): number | null => {
    const key = rowsOf[name];
    if (name === "getJobLog" || !Predicate.isObject(value)) return null;
    if (key === null) return 1;
    const rows = value[key];
    return Array.isArray(rows) ? rows.length : null;
  }
});
export const recorded: { readonly [K in GithubRead]: ReturnType<typeof recordedBy> } = {
  listRepos: recordedBy("listRepos"),
  getRepo: recordedBy("getRepo"),
  listWorkflows: recordedBy("listWorkflows"),
  listRuns: recordedBy("listRuns"),
  getRun: recordedBy("getRun"),
  listJobs: recordedBy("listJobs"),
  getJobLog: recordedBy("getJobLog"),
  listChecks: recordedBy("listChecks"),
  listPulls: recordedBy("listPulls"),
  getPull: recordedBy("getPull"),
  listPullFiles: recordedBy("listPullFiles"),
  listPullReviews: recordedBy("listPullReviews")
};

/**
 * One read for `patchy dev` through the instance's dev door (ADR-0013): the caller is the
 * door's, never a loaded version's. A GitHub read needs no revision: what it reaches is the
 * connection's current set.
 */
const devRead = <K extends GithubRead>(
  name: K,
  input: Schema.Decoder<Inputs[K]>
): DevRead<Access.Access | Cryptography.Cryptography> => {
  const decode = Schema.decodeUnknownEffect(input, { onExcessProperty: "error" });
  return {
    ...recorded[name],
    run: (target, args) =>
      decode(args).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })),
        Effect.flatMap((decodedArgs) => atConnection(target, name, decodedArgs))
      )
  };
};
export const devReads = {
  "github.listRepos": devRead("listRepos", githubReads.listRepos.input),
  "github.getRepo": devRead("getRepo", githubReads.getRepo.input),
  "github.listWorkflows": devRead("listWorkflows", githubReads.listWorkflows.input),
  "github.listRuns": devRead("listRuns", githubReads.listRuns.input),
  "github.getRun": devRead("getRun", githubReads.getRun.input),
  "github.listJobs": devRead("listJobs", githubReads.listJobs.input),
  "github.getJobLog": devRead("getJobLog", githubReads.getJobLog.input),
  "github.listChecks": devRead("listChecks", githubReads.listChecks.input),
  "github.listPulls": devRead("listPulls", githubReads.listPulls.input),
  "github.getPull": devRead("getPull", githubReads.getPull.input),
  "github.listPullFiles": devRead("listPullFiles", githubReads.listPullFiles.input),
  "github.listPullReviews": devRead("listPullReviews", githubReads.listPullReviews.input)
};

/**
 * Published patches, the dev door and connection administration share one Access, so an
 * installation's slots and token cache span them all.
 */
export const makeHandlers = Effect.gen(function* () {
  const access = yield* Access.Access;
  const connections = yield* ConnectionStore.ConnectionStore;
  const cryptography = yield* Cryptography.Cryptography;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Access.Access, access),
      Effect.provideService(ConnectionStore.ConnectionStore, connections),
      Effect.provideService(Cryptography.Cryptography, cryptography)
    );
  const handler = <I extends Schema.Top & Schema.Codec<unknown, unknown>>(
    definition: {
      readonly input: I;
      readonly output: typeof Schema.Json;
      readonly run: (
        args: I["Type"]
      ) => Effect.Effect<
        Json,
        Runtime.RuntimeError,
        | Binding.Binding
        | Access.Access
        | ConnectionStore.ConnectionStore
        | Cryptography.Cryptography
      >;
    },
    record: ReturnType<typeof recordedBy>
  ) =>
    Runtime.handler({ kind: "integration", ...definition, ...record, connectionId }, (args) =>
      provide(definition.run(args))
    );
  return {
    "github.listRepos": handler(operations.listRepos, recorded.listRepos),
    "github.getRepo": handler(operations.getRepo, recorded.getRepo),
    "github.listWorkflows": handler(operations.listWorkflows, recorded.listWorkflows),
    "github.listRuns": handler(operations.listRuns, recorded.listRuns),
    "github.getRun": handler(operations.getRun, recorded.getRun),
    "github.listJobs": handler(operations.listJobs, recorded.listJobs),
    "github.getJobLog": handler(operations.getJobLog, recorded.getJobLog),
    "github.listChecks": handler(operations.listChecks, recorded.listChecks),
    "github.listPulls": handler(operations.listPulls, recorded.listPulls),
    "github.getPull": handler(operations.getPull, recorded.getPull),
    "github.listPullFiles": handler(operations.listPullFiles, recorded.listPullFiles),
    "github.listPullReviews": handler(operations.listPullReviews, recorded.listPullReviews)
  };
});
