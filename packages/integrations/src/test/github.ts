import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as CredentialKeys from "../CredentialKeys.js";
import * as Access from "../github/Access.js";
import * as Connection from "../github/Connection.js";
import * as Flows from "../github/Flows.js";
import * as Source from "../github/Source.js";

/**
 * GitHub for offline tests: the production GitHub source over an injected HTTP client that
 * answers in-process from a small world of installations, people and tokens, in the shapes the
 * probe was answered with (hand-written, never its output). Refusals follow the probe's table:
 * a mint for a repository outside the installation answers 422, a suspended installation 403, a
 * removed one 404, a deleted key 401. A repository's CI and pull requests answer on their by-id
 * routes, a run or job of another repository 404 there, and a public repository answers any
 * token (shown); a job's log redirects to a log store this world also plays. Nothing reaches the
 * network.
 */

export interface Repository {
  readonly id: number;
  readonly name: string;
  readonly private?: boolean;
  readonly archived?: boolean;
}
export interface Installation {
  readonly id: number;
  readonly account: { readonly id: number; readonly login: string; readonly type: string };
  repositories: Array<Repository>;
  suspended?: boolean;
  permissions?: Record<string, string>;
}
export interface Person {
  readonly id: number;
  readonly login: string;
  /** Installations they can see. */
  readonly sees: Set<number>;
  /** Repositories GitHub says they administer. */
  readonly admin: Set<number>;
  /** Repositories they can see but whose listing carries no `permissions` at all. */
  readonly silent?: Set<number>;
}
export interface Request {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A GitHub body as its API answers it, hand-written. */
export type Body = Record<string, unknown>;
/** What a repository holds on its by-id routes, in GitHub's shapes. */
export interface Contents {
  readonly workflows: Array<Body>;
  readonly runs: Array<Body & { readonly id: number }>;
  /** GitHub's `total_count` for run listings, when it differs from the runs held. */
  runsTotal?: number;
  /** Each run's jobs, by run id. */
  readonly jobs: Map<number, Array<Body & { readonly id: number }>>;
  /** Each job's log, by job id. */
  readonly logs: Map<number, string>;
  /** Each ref's check runs. */
  readonly checks: Map<string, Array<Body>>;
  readonly pulls: Array<Body & { readonly number: number }>;
  readonly files: Map<number, Array<Body>>;
  readonly reviews: Map<number, Array<Body>>;
}

/**
 * How the log store answers: by range as shown (`ranged`), ignoring the range with the whole log
 * (`whole`, as it does a suffix range), with a log that grows after its first answer
 * (`changing`), with a redirect (`redirect`), or with fewer bytes than asked (`short`).
 */
export type StoreMode = "ranged" | "whole" | "changing" | "redirect" | "short";

/** A run as GitHub lists it, for `repositoryId`. */
export const run = (repositoryId: number, id: number, extra: Body = {}): Body & { id: number } => ({
  id,
  name: "CI",
  display_title: `Run ${id}`,
  run_number: id,
  html_url: `https://github.com/owner/repo/actions/runs/${id}`,
  workflow_id: 501,
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "main",
  head_sha: "a".repeat(40),
  run_attempt: 1,
  status: "completed",
  conclusion: "success",
  actor: { login: "theo-ng", id: 7002 },
  pull_requests: [],
  created_at: "2026-11-14T09:00:00Z",
  run_started_at: "2026-11-14T09:00:05Z",
  updated_at: "2026-11-14T09:04:00Z",
  repository: { id: repositoryId, name: "repo" },
  ...extra
});
/** A job as GitHub lists it. */
export const job = (runId: number, id: number, extra: Body = {}): Body & { id: number } => ({
  id,
  run_id: runId,
  run_attempt: 1,
  run_url: `https://api.github.com/repos/owner/repo/actions/runs/${runId}`,
  name: "test",
  html_url: `https://github.com/owner/repo/actions/runs/${runId}/job/${id}`,
  status: "completed",
  conclusion: "failure",
  started_at: "2026-11-14T09:00:10Z",
  completed_at: "2026-11-14T09:03:00Z",
  steps: [
    {
      number: 1,
      name: "Run tests",
      status: "completed",
      conclusion: "failure",
      started_at: "2026-11-14T09:00:12Z",
      completed_at: "2026-11-14T09:02:59Z"
    }
  ],
  ...extra
});
/** A pull request as GitHub answers it, its base in `repositoryId`. */
export const pull = (
  repositoryId: number,
  number: number,
  extra: Body = {}
): Body & { number: number } => ({
  number,
  html_url: `https://github.com/owner/repo/pull/${number}`,
  title: `Change ${number}`,
  user: { login: "theo-ng", id: 7002 },
  draft: false,
  state: "open",
  merged_at: null,
  labels: [{ name: "ci" }],
  requested_reviewers: [{ login: "mira-okafor" }],
  requested_teams: [],
  base: { ref: "main", repo: { id: repositoryId, full_name: "owner/repo" } },
  head: {
    ref: `change-${number}`,
    sha: "b".repeat(40),
    repo: { id: repositoryId, full_name: "owner/repo" }
  },
  created_at: "2026-11-13T09:00:00Z",
  updated_at: "2026-11-14T09:00:00Z",
  closed_at: null,
  additions: 10,
  deletions: 2,
  changed_files: 1,
  ...extra
});
/** A review as GitHub lists it. */
export const review = (id: number, login: string, state: string, userId = id): Body => ({
  id,
  user: { login, id: userId },
  state,
  submitted_at: "2026-11-14T10:00:00Z",
  commit_id: "b".repeat(40),
  html_url: `https://github.com/owner/repo/pull/1#pullrequestreview-${id}`
});

/** The log store's host GitHub redirects to by default, one of the numbered hosts shown. */
export const LOG_HOST = "productionresultssa7.blob.core.windows.net";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** The App this world knows: its key is the one tests configure the source with. */
export const app: Source.App = {
  id: "1001",
  slug: "patchy-cloud-test",
  clientId: "Iv23test",
  clientSecret: Redacted.make("test-secret"),
  privateKey: Redacted.make(privateKey.export({ type: "pkcs1", format: "pem" }).toString())
};

const json = (status: number, body: unknown, headers: Readonly<Record<string, string>> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
const message = (status: number, text: string) => json(status, { message: text });
const encodeDisplay = Schema.encodeSync(Schema.fromJsonString(Connection.Display));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A world of installations and people, and what was minted and revoked in it. */
export const world = () => {
  const installations = new Map<number, Installation>();
  const people = new Map<string, Person>();
  const codes = new Map<
    string,
    { readonly person: string; readonly challenge: string; used: boolean }
  >();
  const userTokens = new Map<string, string>();
  const tokens = new Map<
    string,
    { readonly installationId: number; readonly ids: ReadonlyArray<number> | "all" }
  >();
  const revoked: Array<string> = [];
  const requests: Array<Request> = [];
  const contents = new Map<number, Contents>();
  /** Public repositories on accounts that never installed the App: any token reads them (shown). */
  const strangers = new Map<number, Repository>();
  const answerAsWorld: (
    request: Request
  ) => Response | Promise<Response | undefined> | undefined = () => undefined;
  const state = {
    keyDeleted: false,
    /**
     * Answers before anything else, such as a limit answer, or a refusal held until a test lets
     * it go; undefined lets the world answer, and a promise of undefined holds the request until
     * it settles, then lets the world answer it.
     */
    override: answerAsWorld,
    minted: 0,
    /** Calls that asked for GitHub's slots, counted as each begins to wait for them. */
    admissions: 0,
    /** Where a job log's redirect points. */
    logHost: LOG_HOST,
    store: "ranged" as StoreMode,
    /** The log store's version of each log, which its ETag names. */
    versions: new Map<number, number>()
  };
  let serial = 0;

  const add = (installation: Installation) => {
    installations.set(installation.id, installation);
    return installation;
  };
  /** What repository `id` holds, made empty on first use. */
  const holds = (id: number): Contents => {
    let found = contents.get(id);
    if (found === undefined) {
      found = {
        workflows: [],
        runs: [],
        jobs: new Map(),
        logs: new Map(),
        checks: new Map(),
        pulls: [],
        files: new Map(),
        reviews: new Map()
      };
      contents.set(id, found);
    }
    return found;
  };
  const person = (login: string, value: Person) => {
    people.set(login, value);
    return value;
  };
  /** GitHub's authorization page, as the person `login` finishes it: a code for the callback. */
  const authorize = (login: string, url: string) => {
    const authorizeUrl = new URL(url);
    const code = `code-${++serial}`;
    codes.set(code, {
      person: login,
      challenge: authorizeUrl.searchParams.get("code_challenge") ?? "",
      used: false
    });
    return { code, state: authorizeUrl.searchParams.get("state") ?? "" };
  };

  const jwtValid = (authorization: string | undefined) => {
    const [head, claims, signature] = (authorization ?? "").replace(/^Bearer /, "").split(".");
    if (head === undefined || claims === undefined || signature === undefined) return false;
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString()) as { iss?: string };
    return (
      payload.iss === app.clientId &&
      createVerify("RSA-SHA256")
        .update(`${head}.${claims}`)
        .verify(publicKey, Buffer.from(signature, "base64url"))
    );
  };
  const repositoryBody = (item: Repository, admin: boolean | undefined) => ({
    id: item.id,
    name: item.name,
    full_name: `owner/${item.name}`,
    html_url: `https://github.com/owner/${item.name}`,
    private: item.private ?? true,
    archived: item.archived ?? false,
    disabled: false,
    default_branch: "main",
    ...(admin === undefined ? {} : { permissions: { admin, push: admin, pull: true } })
  });
  const installationBody = (item: Installation) => ({
    id: item.id,
    account: item.account,
    suspended_at: item.suspended === true ? "2026-11-14T10:00:00Z" : null,
    permissions: item.permissions ?? { ...Source.permissions }
  });
  const page = <A>(items: ReadonlyArray<A>, url: URL) => {
    const size = Number(url.searchParams.get("per_page") ?? "30");
    const at = Number(url.searchParams.get("page") ?? "1");
    return items.slice((at - 1) * size, at * size);
  };

  const handle = (request: Request): Response | Promise<Response> => {
    requests.push(request);
    const early = state.override(request);
    if (early === undefined) return answer(request);
    return Promise.resolve(early).then((held) => held ?? answer(request));
  };
  const located = (id: number) => {
    for (const installation of installations.values()) {
      const found = installation.repositories.find((item) => item.id === id);
      if (found !== undefined) return { repository: found, installationId: installation.id };
    }
    const stranger = strangers.get(id);
    return stranger === undefined ? undefined : { repository: stranger, installationId: undefined };
  };
  const listed = <A>(items: ReadonlyArray<A>, url: URL) => {
    const size = Number(url.searchParams.get("per_page") ?? "30");
    const at = Number(url.searchParams.get("page") ?? "1");
    return items.slice((at - 1) * size, at * size);
  };
  /** A GET at `/repositories/{id}{rest}` with an installation token, as GitHub answers it. */
  const repositoryRead = (bearer: string, id: number, rest: string, url: URL): Response => {
    const held = tokens.get(bearer);
    const installation = held === undefined ? undefined : installations.get(held.installationId);
    if (held === undefined || installation === undefined) return message(401, "Bad credentials");
    if (installation.suspended === true)
      return message(403, "This installation has been suspended");
    const found = located(id);
    if (found === undefined) return message(404, "Not Found");
    const open = found.repository.private === false;
    const reached =
      found.installationId === installation.id && (held.ids === "all" || held.ids.includes(id));
    if (!open && !reached) return message(404, "Not Found");
    const data = holds(id);
    if (rest === "")
      return json(200, {
        ...repositoryBody(found.repository, undefined),
        description: null,
        html_url: `https://github.com/owner/${found.repository.name}`,
        pushed_at: null
      });
    if (rest === "/actions/workflows")
      return json(200, {
        total_count: data.workflows.length,
        workflows: listed(data.workflows, url)
      });
    const runs = /^\/actions(?:\/workflows\/([^/]+))?\/runs$/.exec(rest);
    if (runs !== null) {
      if (
        runs[1] !== undefined &&
        !data.workflows.some(
          (item) => String(item.id) === runs[1] || String(item.path).endsWith(`/${runs[1]}`)
        )
      )
        return message(404, "Not Found");
      const branch = url.searchParams.get("branch");
      const matching = data.runs.filter((item) => branch === null || item.head_branch === branch);
      return json(200, {
        total_count: data.runsTotal ?? matching.length,
        workflow_runs: listed(matching, url)
      });
    }
    const oneRun = /^\/actions\/runs\/(\d+)(\/jobs)?$/.exec(rest);
    if (oneRun !== null) {
      const found = data.runs.find((item) => item.id === Number(oneRun[1]));
      if (found === undefined) return message(404, "Not Found");
      if (oneRun[2] === undefined) return json(200, found);
      const jobs = data.jobs.get(found.id) ?? [];
      return json(200, { total_count: jobs.length, jobs: listed(jobs, url) });
    }
    const log = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest);
    if (log !== null) {
      const jobId = Number(log[1]);
      if (!data.logs.has(jobId)) return message(404, "Not Found");
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://${state.logHost}/logs/job-${jobId}.txt?sv=2025&sig=signed-secret`
        }
      });
    }
    const checks = /^\/commits\/(.+)\/check-runs$/.exec(rest);
    if (checks !== null) {
      const found = data.checks.get(decodeURIComponent(checks[1] ?? ""));
      if (found === undefined) return message(422, "No commit found for SHA");
      return json(200, { total_count: found.length, check_runs: listed(found, url) });
    }
    if (rest === "/pulls") {
      const wanted = url.searchParams.get("state") ?? "open";
      return json(
        200,
        listed(
          data.pulls.filter((item) => wanted === "all" || item.state === wanted),
          url
        )
      );
    }
    const onePull = /^\/pulls\/(\d+)(\/files|\/reviews)?$/.exec(rest);
    if (onePull !== null) {
      const number = Number(onePull[1]);
      const found = data.pulls.find((item) => item.number === number);
      if (found === undefined) return message(404, "Not Found");
      if (onePull[2] === "/files") return json(200, listed(data.files.get(number) ?? [], url));
      if (onePull[2] === "/reviews") return json(200, listed(data.reviews.get(number) ?? [], url));
      return json(200, found);
    }
    return message(404, "Not Found");
  };
  /** The log store a job's redirect points at: its signed URL is its own credential. */
  const logStore = (request: Request): Response => {
    if (state.store === "redirect")
      return new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/log.txt" }
      });
    const match = /^\/logs\/job-(\d+)\.txt$/.exec(request.url.pathname);
    const jobId = match === null ? undefined : Number(match[1]);
    let text: string | undefined;
    for (const data of contents.values())
      if (jobId !== undefined && data.logs.has(jobId)) text = data.logs.get(jobId);
    if (jobId === undefined || text === undefined)
      return new Response("BlobNotFound", { status: 404 });
    const version = state.versions.get(jobId) ?? 1;
    const etag = `"0x8D${version}"`;
    const bytes = new TextEncoder().encode(text);
    // A log still being written: each answer finds it longer, under a new version.
    if (state.store === "changing") {
      for (const data of contents.values())
        if (data.logs.has(jobId)) data.logs.set(jobId, `${text}more output\n`);
      state.versions.set(jobId, version + 1);
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (state.store === "whole" || range === null)
      return new Response(bytes, { status: 200, headers: { etag, "content-type": "text/plain" } });
    if (bytes.byteLength === 0)
      return new Response(null, { status: 416, headers: { "content-range": "bytes */0" } });
    const ifMatch = request.headers["if-match"];
    if (ifMatch !== undefined && ifMatch !== etag) return new Response(null, { status: 412 });
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), bytes.byteLength - 1);
    if (start > end)
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${bytes.byteLength}` }
      });
    const body = bytes.subarray(start, state.store === "short" ? Math.max(start, end) : end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        etag,
        "content-type": "text/plain",
        "content-range": `bytes ${start}-${end}/${bytes.byteLength}`
      }
    });
  };

  const answer = (request: Request): Response => {
    const { url, method } = request;
    const bearer = request.authorization?.replace(/^Bearer /, "") ?? "";
    if (url.origin === Source.WEB_URL && url.pathname === "/login/oauth/access_token") {
      const params = new URLSearchParams(request.body);
      const found = codes.get(params.get("code") ?? "");
      // A used code answers 200 with an error (shown); a wrong verifier, 400 and burns the code.
      if (found === undefined || found.used) return json(200, { error: "bad_verification_code" });
      found.used = true;
      const verifier = params.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== found.challenge)
        return json(400, { error: "invalid_grant" });
      const token = `ghu_${++serial}`;
      userTokens.set(token, found.person);
      return json(200, {
        access_token: token,
        refresh_token: "ghr_never_read",
        token_type: "bearer"
      });
    }
    if (url.origin !== Source.API_URL && url.origin !== Source.WEB_URL) return logStore(request);
    if (url.origin !== Source.API_URL) return message(404, "Not Found");
    const path = url.pathname;
    if (method === "DELETE" && path === `/applications/${app.clientId}/token`) {
      const token = (JSON.parse(request.body) as { access_token: string }).access_token;
      revoked.push(token);
      userTokens.delete(token);
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE" && path === "/installation/token") {
      revoked.push(bearer);
      tokens.delete(bearer);
      return new Response(null, { status: 204 });
    }
    if (path === "/user" || path.startsWith("/user/")) {
      const login = userTokens.get(bearer);
      const who = login === undefined ? undefined : people.get(login);
      if (who === undefined) return message(401, "Bad credentials");
      if (path === "/user") return json(200, { id: who.id, login: who.login });
      if (path === "/user/installations") {
        const seen = [...who.sees].flatMap((id) => {
          const found = installations.get(id);
          return found === undefined ? [] : [installationBody(found)];
        });
        return json(200, { total_count: seen.length, installations: page(seen, url) });
      }
      const match = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
      const found = match === null ? undefined : installations.get(Number(match[1]));
      if (found === undefined || !who.sees.has(found.id)) return message(404, "Not Found");
      return json(200, {
        total_count: found.repositories.length,
        repositories: page(found.repositories, url).map((item) =>
          repositoryBody(
            item,
            who.silent?.has(item.id) === true ? undefined : who.admin.has(item.id)
          )
        )
      });
    }
    if (path.startsWith("/app/")) {
      if (state.keyDeleted || !jwtValid(request.authorization))
        return message(401, "A JSON web token could not be decoded");
      const read = /^\/app\/installations\/(\d+)$/.exec(path);
      if (read !== null && method === "GET") {
        const found = installations.get(Number(read[1]));
        return found === undefined ? message(404, "Not Found") : json(200, installationBody(found));
      }
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (mint !== null && method === "POST") {
        const found = installations.get(Number(mint[1]));
        if (found === undefined) return message(404, "Not Found");
        if (found.suspended === true) return message(403, "This installation has been suspended");
        const asked = JSON.parse(request.body) as {
          repository_ids?: ReadonlyArray<number>;
          permissions?: Record<string, string>;
        };
        const held = found.permissions ?? Source.permissions;
        if (
          Object.entries(asked.permissions ?? {}).some(
            ([name, level]) => held[name as keyof typeof held] !== level
          )
        )
          return message(422, "The permissions requested are not granted to this installation.");
        const inside = new Set(found.repositories.map((item) => item.id));
        if ((asked.repository_ids ?? []).some((id) => !inside.has(id)))
          return message(
            422,
            "There is at least one repository that does not exist or is not accessible to the parent installation."
          );
        const token = `ghs_${++serial}`;
        state.minted++;
        tokens.set(token, { installationId: found.id, ids: asked.repository_ids ?? "all" });
        return json(201, {
          token,
          expires_at: "2099-01-01T00:00:00Z",
          permissions: asked.permissions
        });
      }
      return message(404, "Not Found");
    }
    const byId = /^\/repositories\/(\d+)(\/.*)?$/.exec(path);
    if (byId !== null && method === "GET")
      return repositoryRead(bearer, Number(byId[1]), byId[2] ?? "", url);
    if (path === "/installation/repositories") {
      const held = tokens.get(bearer);
      const found = held === undefined ? undefined : installations.get(held.installationId);
      if (held === undefined || found === undefined) return message(401, "Bad credentials");
      if (found.suspended === true) return message(403, "This installation has been suspended");
      const reached = found.repositories.filter(
        (item) => held.ids === "all" || held.ids.includes(item.id)
      );
      return json(200, {
        total_count: reached.length,
        repositories: page(reached, url).map((item) => repositoryBody(item, undefined))
      });
    }
    return message(404, "Not Found");
  };

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
      const body = yield* Effect.promise(() => web.text());
      const answer = yield* Effect.promise(async () =>
        handle({
          method: request.method,
          url: new URL(web.url),
          authorization: request.headers.authorization,
          headers: request.headers,
          body
        })
      );
      return HttpClientResponse.fromWeb(request, answer);
    })
  );
  /**
   * The production source, seam and flows, configured with `app`, over this world. Each call for
   * slots is counted in `state.admissions` first, so a test can tell one has begun to wait.
   */
  const source = Layer.effect(
    Source.Source,
    Effect.map(Source.makeWith(Option.some(app)), (made) =>
      Source.Source.of({
        ...made,
        withSlot:
          (installationId: number, deadline: number) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.suspend(() => {
              state.admissions++;
              return made.withSlot(installationId, deadline)(effect);
            }),
        withHost:
          (deadline: number) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.suspend(() => {
              state.admissions++;
              return made.withHost(deadline)(effect);
            })
      })
    )
  ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));
  const layer = Layer.mergeAll(Access.layer, Flows.layer).pipe(Layer.provideMerge(source));
  /**
   * A connection saved as connect saves one, with `repositoryIds` of installation `installationId`,
   * straight into the database: what the reads' tests start from.
   */
  const connection = Effect.fn("GithubDouble.connection")(function* (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly id: string;
    readonly handle: string;
    readonly installationId: number;
    readonly repositoryIds: ReadonlyArray<number>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const keys = yield* CredentialKeys.CredentialKeys;
    const installation = installations.get(input.installationId)!;
    const account = {
      id: installation.account.id,
      login: installation.account.login,
      type: installation.account.type === "User" ? ("User" as const) : ("Organization" as const)
    };
    const repositories = input.repositoryIds.map((id) =>
      installation.repositories.find((item) => item.id === id)!
    );
    const display: Connection.Display = {
      installationId: input.installationId,
      account,
      repositories: repositories.map((item) => ({
        id: item.id,
        name: item.name,
        private: item.private ?? true
      })),
      successes: 1
    };
    const sealed = yield* keys.encrypt(
      { companyId: input.companyId, id: input.id, integration: "github" },
      Connection.credentials({
        installationId: input.installationId,
        repositoryIds: input.repositoryIds
      })
    );
    const snapshot = {
      version: 1,
      account,
      repositories: repositories.map((item) => ({
        id: item.id,
        name: item.name,
        defaultBranch: "main",
        private: item.private ?? true,
        archived: item.archived ?? false,
        disabled: false
      }))
    };
    yield* sql`INSERT INTO github_installations (installation_id) VALUES (${input.installationId})
      ON CONFLICT DO NOTHING`;
    yield* sql`INSERT INTO github_installation_claims (installation_id, company_id)
      VALUES (${input.installationId}, ${input.companyId}) ON CONFLICT DO NOTHING`;
    yield* sql`INSERT INTO connections
      (id, company_id, integration, handle, description, mode, status, display, credentials, key_id,
       credential_revision, metadata_revision, created_by, last_tested_at, last_discovered_at)
      VALUES (${input.id}, ${input.companyId}, 'github', ${input.handle}, 'Repositories', 'company',
        'connected', ${encodeDisplay(display)}::jsonb, ${sealed.credentials}, ${sealed.keyId}, 1, 1,
        ${input.userId}, now(), now())`;
    yield* sql`INSERT INTO connection_snapshots
      (company_id, connection_id, integration, revision, snapshot, created_at)
      VALUES (${input.companyId}, ${input.id}, 'github', 1, ${encodeJson(snapshot)}::jsonb, now())`;
  });
  return {
    installations,
    people,
    tokens,
    contents,
    strangers,
    holds,
    connection,
    revoked,
    requests,
    state,
    add,
    person,
    authorize,
    layer
  };
};

/**
 * GitHub on an instance whose App isn't configured: nothing about it is offered. It brings its own
 * keyring, so a fixture that has a database and `Cryptography` can add it beside anything else.
 */
export const unconfigured = Layer.mergeAll(Access.layer, Flows.layer).pipe(
  Layer.provideMerge(
    Layer.effect(Source.Source, Source.makeWith(Option.none())).pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("GitHub isn't configured here"))
        )
      )
    )
  ),
  Layer.provide(
    CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 9).toString("base64")}`))
  )
);
