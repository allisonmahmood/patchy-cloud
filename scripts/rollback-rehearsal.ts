/**
 * The rollback rehearsal: deploying this commit and rolling back to the live
 * release, rehearsed on one set of data.
 *
 *   pnpm test:rollback-rehearsal               against the commit production runs
 *   pnpm test:rollback-rehearsal --live <sha>  against another commit
 *
 * CI's `rollback-rehearsal` job runs it when a pull request changes a
 * capability's `src/migrations.ts`, the handler descriptor schemas
 * (`packages/api/src/handlers.ts`) or the CLI code that writes descriptors. It
 * rehearses HEAD, so commit first. On a scratch worktree:
 *
 *   1. The live commit's `pnpm dev up brightline` starts fresh, migrates, seeds
 *      the scenario and loads its sample data, and the step is exercised.
 *   2. HEAD's server starts on that data, migrates it and is exercised.
 *   3. The live commit's server starts on that data again and is exercised.
 *
 * Steps 2 and 3 swap only the server build. Step 1 leaves the data in the
 * worktree's `.local/dev`: the Postgres cluster (the platform database and
 * every company database), the stored files and the credential keys. A
 * checkout keeps it, and this file starts each build's server on it the way the
 * dev runner's supervisor does, without the supervisor's seeding, which would
 * repair rows a migration broke.
 *
 * The exercise is the same at every step: the deep health check, the build's
 * own CLI (whoami, list, a publish), and in Chromium, as the scenario's admin,
 * the portal and every patch. Each page must answer with no server error or
 * uncaught exception and settle; a patch with code must have the server deliver
 * its first live queries, every one step 1 saw; a patch with sample data must
 * not show its empty state. Meanwhile the server must log no failed request,
 * call or live query.
 *
 * From step 2 on, the exercise also covers what HEAD's CLI writes into handler
 * descriptors, once it writes read-only actions: step 2 publishes a tier 2
 * patch with a read-only action that forces a write and, once HEAD builds
 * them, an agent tool. Every later step must serve it, refuse the write and
 * refuse the page's call to the agent tool. Before HEAD's CLI writes them, the
 * patch isn't published, so a release that can't read the fields is never
 * asked to.
 *
 * The live commit is the revision production's `/healthz/deep` names. When a
 * Deploy run is unfinished, or the one updated last did not succeed, the
 * rehearsal fails rather than guess (`gh` reads the runs).
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { hostLabel, PlanJson } from "./dev/src/plan.js";
import { PG_FLAGS, PG_PASSWORD, PG_USER } from "./dev/src/postgres.js";
import { publisherToken, Scenario } from "./dev/src/scenario.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const SCENARIO = "brightline";
const LIVE_HEALTH = "https://cloud.patchyhq.com/healthz/deep";

// Each decoder reads only the fields this file uses; the rest of the JSON is ignored.
const decodeScenario = Schema.decodeUnknownSync(Schema.fromJsonString(Scenario));
const decodePlan = Schema.decodeUnknownSync(PlanJson);
/** What `pnpm dev up --json` prints. */
const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      apiUrl: Schema.String,
      patches: Schema.Array(Schema.Struct({ key: Schema.String, address: Schema.String }))
    })
  )
);
const decodeRelease = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ package: Schema.Struct({ tarball: Schema.String }) }))
);
const decodeHealth = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ revision: Schema.String }))
);
const decodeIdentity = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      user: Schema.Struct({ id: Schema.String }),
      company: Schema.Struct({ handle: Schema.String })
    })
  )
);
const decodeList = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      patches: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
    })
  )
);
const decodePublish = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ patchId: Schema.String, versionNumber: Schema.Int, address: Schema.String })
  )
);
const decodeRepoPublish = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      patchId: Schema.String,
      versionId: Schema.String,
      address: Schema.String,
      handlers: Schema.Array(Schema.Struct({ name: Schema.String }))
    })
  )
);
/** A runtime call's reply: its value, or the refusal's code. */
const decodeRuntimeReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
      Schema.Struct({ ok: Schema.Literal(false), code: Schema.String })
    ])
  )
);
/** A server wide event; the server writes each one to stdout as a JSON line. */
const decodeServerEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      outcome: Schema.String,
      route: Schema.optionalKey(Schema.String),
      handler: Schema.optionalKey(Schema.String),
      code: Schema.optionalKey(Schema.String),
      patchId: Schema.optionalKey(Schema.String),
      trigger: Schema.optionalKey(Schema.String),
      disposition: Schema.optionalKey(Schema.String)
    })
  )
);
/** `gh run list --json`; an unfinished run's conclusion is empty. */
const decodeRuns = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        status: Schema.String,
        conclusion: Schema.String,
        updatedAt: Schema.String,
        url: Schema.String
      })
    )
  )
);

/** The live commit cannot be known right now; the message says why. */
class Uncertain extends Error {}

interface Step {
  readonly number: 1 | 2 | 3;
  readonly title: string;
  readonly commit: string;
}

/** A step failed; the message names it and what it was doing, `problems` say why. */
class StepFailed extends Error {
  constructor(
    step: Step,
    phase: string,
    readonly problems: ReadonlyArray<string>
  ) {
    super(`Step ${step.number} of 3, ${step.title}, failed while ${phase}.`);
  }
}

// ---- Processes --------------------------------------------------------------

/** The inherited environment without any PATCHY_ setting, which could point a CLI at production. */
const closedEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PATCHY_"))
  ),
  ...extra
});

/** Every child leads its own process group: these groups may still have members. */
const groups = new Set<number>();

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stops a child's whole process group, whether or not its leader is still
 * there: SIGTERM, then SIGKILL while anything in it is left ten seconds later.
 */
const stopGroup = async (pid: number) => {
  for (const [signal, waitMs] of [
    ["SIGTERM", 10_000],
    ["SIGKILL", 5_000]
  ] as const) {
    if (!groupAlive(pid)) break;
    try {
      process.kill(-pid, signal);
    } catch {
      // It emptied in between.
    }
    for (const deadline = Date.now() + waitMs; groupAlive(pid) && Date.now() < deadline;)
      await sleep(200);
  }
  groups.delete(pid);
};

/** What a step holds once started, undone newest first by its stop or by cleanup. */
const finalizers: Array<() => Promise<unknown>> = [];

const release = async () => {
  for (let finalize = finalizers.pop(); finalize; finalize = finalizers.pop())
    await finalize().catch((error: unknown) => console.error(String(error)));
};

/**
 * The signal that stopped the rehearsal. Once set, nothing new starts outside
 * cleanup and running children are stopped, so the current step unwinds into
 * the one cleanup path.
 */
let cancelled: NodeJS.Signals | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    cancelled = signal;
    for (const pid of groups) void stopGroup(pid);
  });

/** Throws once the rehearsal is stopping; called before anything is started. */
const proceed = () => {
  if (cancelled !== undefined) throw new Error(`Stopped by ${cancelled}.`);
};

interface RunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs?: number;
  /** Cleanup's own commands still run once the rehearsal is stopping. */
  readonly cleanup?: boolean;
}

/** Runs a command to completion and answers its stdout; a failure carries the tail of its output. */
const run = (command: string, args: ReadonlyArray<string>, options: RunOptions) =>
  new Promise<string>((resolve, reject) => {
    if (!options.cleanup) proceed();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? closedEnv(),
      detached: true
    });
    const pid = child.pid;
    if (pid !== undefined) groups.add(pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end(options.input);
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) void stopGroup(pid);
    }, options.timeoutMs ?? 120_000);
    // Whatever the command leaves in its group is stopped, so its output always closes.
    child.once("exit", () => pid !== undefined && void stopGroup(pid));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      const output = (stderr.trim() || stdout.trim()).split("\n").slice(-20).join("\n");
      const ended = timedOut ? "timed out" : `exited ${code ?? signal}`;
      reject(new Error(`\`${[command, ...args].join(" ")}\` ${ended}\n${output}`));
    });
  });

const git = (...args: Array<string>) => run("git", args, { cwd: repoRoot });

/**
 * GETs `url` from the instance on a connection of its own, within `timeoutMs`.
 * A starting server accepts connections before it can answer them, and a pooled
 * connection could still lead to the previous step's server.
 */
const get = (url: string, timeoutMs = 15_000) =>
  new Promise<{ readonly status: number; readonly body: Buffer }>((resolve, reject) => {
    const request = http.get(url, { agent: false, timeout: timeoutMs }, (response) => {
      const chunks: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) })
      );
      response.on("error", reject);
    });
    request.on("timeout", () =>
      request.destroy(new Error(`${url} did not answer within ${timeoutMs / 1000}s`))
    );
    request.on("error", reject);
  });

// ---- The live commit --------------------------------------------------------

/**
 * The Deploy run updated last, once every run has finished and that one
 * succeeded: the rule AGENTS.md › Deploying pins the live commit by, so a
 * deploy and this check never disagree. Otherwise a release may be half
 * promoted, and the live commit is `Uncertain`.
 */
const settledDeploy = async () => {
  const runs = decodeRuns(
    await run(
      "gh",
      [
        ...["run", "list", "--workflow", "deploy.yml", "--limit", "1000"],
        ...["--json", "number,status,conclusion,updatedAt,url"]
      ],
      { cwd: repoRoot }
    )
  );
  const unfinished = runs.find((run) => run.status !== "completed");
  if (unfinished)
    throw new Uncertain(
      `Deploy run #${unfinished.number} is ${unfinished.status} (${unfinished.url}).`
    );
  // A re-run keeps its old place in the list, so the run updated last decides.
  const last = runs.toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
  if (last === undefined) throw new Uncertain("No Deploy run is on record.");
  if (last.conclusion !== "success")
    throw new Uncertain(
      `The Deploy run updated last, #${last.number} (${last.url}), ended ${last.conclusion}, so a release may be half promoted.`
    );
  return last;
};

/**
 * The commit production runs: `/healthz/deep`'s revision without a rotation
 * step's suffix, read between two settled looks at the Deploy runs. Anything
 * else is `Uncertain`; it never guesses.
 */
const liveCommit = async () => {
  const before = await settledDeploy();
  let revision: string;
  try {
    // A 503 still names the running build.
    const response = await fetch(LIVE_HEALTH, { signal: AbortSignal.timeout(15_000) });
    revision = decodeHealth(await response.text()).revision;
  } catch (error) {
    throw new Uncertain(`${LIVE_HEALTH} did not name a revision: ${String(error)}`);
  }
  const commit = /^([0-9a-f]{40})(?:-(?:overlap|seal)-\d+)?$/.exec(revision)?.[1];
  if (commit === undefined)
    throw new Uncertain(`${LIVE_HEALTH} names ${JSON.stringify(revision)}, which is not a commit.`);
  const after = await settledDeploy();
  if (after.url !== before.url || after.updatedAt !== before.updatedAt)
    throw new Uncertain("A Deploy run finished while the live commit was being read.");
  return commit;
};

/** The full sha of `ref`, fetched from origin when this clone lacks it (CI checks out shallow). */
const resolveCommit = async (ref: string) => {
  const local = () => git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  const found = await local().catch(() =>
    git("fetch", "--quiet", "--no-tags", "--depth=1", "origin", ref).then(local, () => {
      throw new Error(`${ref} is not a commit here or on origin.`);
    })
  );
  return found.trim();
};

// ---- A build's server on the retained data -----------------------------------

/** A line of a dev-runner env file, such as `.local/dev/dev.env`. */
const envFileValue = async (file: string, name: string) => {
  const value = new RegExp(`^${name}=(.*)$`, "m").exec(await readFile(file, "utf8"))?.[1];
  if (value === undefined) throw new Error(`${file} has no ${name}.`);
  return value;
};

/**
 * The worktree's server on the data in its `.local/dev`, started as
 * scripts/dev/src/supervisor.ts starts it but with nothing seeded: Postgres on
 * the retained cluster, the build's own broker and CLI release, then the
 * server, which migrates before it listens. Its output and Postgres's go to
 * `log`. Each is registered with `finalizers` before it starts.
 */
const serve = async (worktree: string, log: string) => {
  const state = path.join(worktree, ".local", "dev");
  const plan = decodePlan(await readFile(path.join(state, "plan.json"), "utf8"));
  const secrets = {
    PATCHY_DEV_PERSONAS_SECRET: await envFileValue(
      path.join(state, "personas.env"),
      "PATCHY_DEV_PERSONAS_SECRET"
    ),
    PATCHY_CREDENTIAL_KEYS: await envFileValue(
      path.join(state, "dev.env"),
      "PATCHY_CREDENTIAL_KEYS"
    )
  };
  for (const script of [
    ["build-serving-broker.mjs"],
    ["build-patchy-package.mjs", "--stage-for-server"]
  ])
    await run(process.execPath, [path.join("scripts", script[0]!), ...script.slice(1)], {
      cwd: worktree,
      timeoutMs: 600_000
    });
  const logLine = (service: string) => (message: unknown) =>
    void appendFile(log, `[${service}] ${String(message).trimEnd()}\n`);
  // Imported here: embedded-postgres installs process-exiting signal handlers as
  // it loads, which would pre-empt this file's own cleanup, so they come out again.
  const listening = new Set(process.listeners("SIGINT").concat(process.listeners("SIGTERM")));
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  for (const name of ["SIGINT", "SIGTERM"] as const)
    for (const listener of process.listeners(name))
      if (!listening.has(listener)) process.removeListener(name, listener);
  const cluster = path.join(state, "postgres");
  const postgres = new EmbeddedPostgres({
    databaseDir: cluster,
    port: plan.ports.postgres,
    user: PG_USER,
    password: PG_PASSWORD,
    persistent: true,
    postgresFlags: [...PG_FLAGS],
    onLog: logLine("postgres"),
    onError: logLine("postgres")
  });
  finalizers.push(async () => {
    const stopped = await Promise.race([
      postgres.stop().then(() => true),
      sleep(15_000).then(() => false)
    ]);
    if (stopped) return;
    // The postmaster of this scratch cluster, which ignored the shutdown.
    const pid = Number(
      (await readFile(path.join(cluster, "postmaster.pid"), "utf8")).split("\n")[0]
    );
    if (pid > 0) process.kill(pid, "SIGKILL");
  });
  proceed();
  // Bounded, and abandoned on a signal; the finalizer above stops whatever it started.
  const starting = postgres.start().then(() => true);
  starting.catch(() => undefined);
  const waiting = async () => {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && !cancelled;)
      await sleep(200);
    return false;
  };
  if (!(await Promise.race([starting, waiting()]))) {
    proceed();
    throw new Error("Postgres did not start within a minute.");
  }
  const output = await open(log, "a");
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "--conditions=development", path.join("apps", "server", "src", "start.ts")],
    {
      cwd: worktree,
      detached: true,
      stdio: ["ignore", output.fd, output.fd],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "development",
        ...secrets,
        PORT: String(plan.ports.server),
        DATABASE_URL: plan.databaseUrl,
        PATCHY_COMPANY_DB_ADMIN_URL: plan.databaseUrl,
        PATCHY_COMPANY_DB_URL: plan.databaseUrl,
        PATCHY_STORAGE_DIR: path.join(state, "storage"),
        PATCHY_PUBLIC_BASE_URL: plan.apiUrl
      }
    }
  );
  await output.close();
  const pid = server.pid;
  if (pid !== undefined) {
    groups.add(pid);
    finalizers.push(() => stopGroup(pid));
  }
  // Migrating can take a while, and a probe that lands before the routes exist
  // hangs, so each is bounded. A server that exits instead is reported with its log.
  const local = `http://127.0.0.1:${plan.ports.server}/healthz`;
  for (const deadline = Date.now() + 180_000; Date.now() < deadline; await sleep(500)) {
    proceed();
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error(
        `The server exited ${server.exitCode ?? server.signalCode} before it served.`
      );
    if ((await get(local, 2_000).catch(() => undefined))?.status !== 200) continue;
    // Listening, so the environment's own address must reach it too.
    const health = await get(`${plan.apiUrl}/healthz`).catch((error: unknown) => String(error));
    if (typeof health !== "string" && health.status === 200) return;
    throw new Error(
      `The server answers ${local} but not ${plan.apiUrl}/healthz: ${typeof health === "string" ? health : health.status}`
    );
  }
  throw new Error(`${local} did not answer within three minutes.`);
};

// ---- The server's log ---------------------------------------------------------

/** `log` from byte `offset` on; empty while it does not exist yet. */
const logSince = async (log: string, offset: number) => {
  const file = await open(log).catch(() => undefined);
  if (file === undefined) return "";
  try {
    const { size } = await file.stat();
    const bytes = Buffer.alloc(Math.max(0, size - offset));
    await file.read(bytes, 0, bytes.length, offset);
    return bytes.toString("utf8");
  } finally {
    await file.close();
  }
};

const logSize = (log: string) =>
  stat(log).then(
    (file) => file.size,
    () => 0
  );

/** The server's wide events in `text`: bare JSON lines, or `[server]` lines in the dev runner's dev.log. */
const serverEvents = (text: string) =>
  text.split("\n").flatMap((line) => {
    const marker = line.indexOf("[server] {");
    if (!line.startsWith("{") && marker === -1) return [];
    const event = decodeServerEvent(
      line.startsWith("{") ? line : line.slice(marker + "[server] ".length)
    );
    return Option.isSome(event) ? [event.value] : [];
  });

/**
 * Every failed event: a request, a call, or a live query's re-run that no page shows. The agent
 * area's refusals are what the exercise asks for, so they don't count.
 */
const serverFailures = (text: string, agentArea: AgentArea | undefined) =>
  serverEvents(text)
    .filter(
      (event) =>
        event.outcome === "failure" &&
        !(event.patchId === agentArea?.patchId && event.code === "access_denied")
    )
    .map(
      ({ type, route, handler, code }) =>
        `the server's ${[type, route ?? handler, code].filter(Boolean).join(" ")} failed`
    );

// ---- The exercise -------------------------------------------------------------

interface Environment {
  readonly apiUrl: string;
  readonly scenario: Scenario;
  /** Each scenario patch's address, keyed by its repo or file-patch name. */
  readonly addresses: ReadonlyMap<string, string>;
}

/** The page every step publishes a new version of; step 1 creates it. */
interface RehearsalPage {
  readonly patchId: string;
  readonly address: string;
}

/** The tier 2 patch step 2 publishes once HEAD's CLI writes read-only actions. */
interface AgentArea {
  readonly patchId: string;
  readonly versionId: string;
  readonly address: string;
  /** Whether HEAD's build marked the agent tool, which it does once it builds `agent/`. */
  readonly agentTool: boolean;
}

/** The read-only action that forces a write, and the agent tool, as the patch's handlers. */
const FORCED_WRITE = "rehearsal.forcedWrite";
const AGENT_TOOL = "agent.countNotes";
/** The runtime wire every release speaks, `WIRE_VERSION` in `@patchy/api`. */
const WIRE_VERSION = 1;

/**
 * Whether the CLI installed in `dir` writes read-only actions into the descriptors it builds.
 * Its builders drop a key they don't know, so an older CLI's descriptor has none.
 */
const writesReadOnly = async (dir: string) => {
  const sdk = pathToFileURL(path.join(dir, "node_modules", "patchy", "dist", "server.js")).href;
  const probe = `import { action, t } from ${JSON.stringify(sdk)};
const built = action({ readOnly: true, description: "Probe.", args: {}, result: t.json(), handler: async () => null });
process.stdout.write(String(built.descriptor.readOnly === true));`;
  const answer = await run(process.execPath, ["--input-type=module", "-e", probe], { cwd: dir });
  return answer.trim() === "true";
};

/**
 * HEAD's CLI starts a tier 2 repo beside its own install and adds a described read-only action
 * that forces a write past its types, and a described agent tool in `agent/`, then publishes it.
 * Its starter page and `notes` table come from `patchy init`.
 */
const publishAgentArea = async (dir: string, env: NodeJS.ProcessEnv): Promise<AgentArea> => {
  const repo = path.join(dir, "agent-area");
  // Init installs the release into the new repo.
  await run(
    path.join(dir, "node_modules", ".bin", "patchy"),
    [
      "init",
      repo,
      "--tier",
      "2",
      "--purpose",
      "The rollback rehearsal's read-only action and agent tool.",
      "--json"
    ],
    { cwd: dir, env, timeoutMs: 600_000 }
  );
  await writeFile(
    path.join(repo, "server", "rehearsal.ts"),
    `import { action, t } from "../patchy/_generated/server.js";

/** Its context has no writes; this one is forced past the types, so Patchy must refuse it. */
export const forcedWrite = action({
  readOnly: true,
  description: "Tries to add a note, which a read-only action may not.",
  args: {},
  result: t.json(),
  handler: async (ctx) =>
    (ctx as unknown as { tables: { notes: { insert(row: { title: string }): Promise<unknown> } } })
      .tables.notes.insert({ title: "Written by a read-only action" })
});
`
  );
  await mkdir(path.join(repo, "agent"), { recursive: true });
  await writeFile(
    path.join(repo, "agent", "notes.ts"),
    `import { query, t } from "../patchy/_generated/server.js";

export const countNotes = query({
  description: "Counts the notes. Changes nothing.",
  args: {},
  result: t.integer(),
  handler: async (ctx) => (await ctx.tables.notes.list({ limit: 100 })).rows.length
});
`
  );
  // The repo's pinned CLI, as `pnpm dev up` runs it: it finds the repo's workerd for inspection.
  const pinned = path.join(repo, "node_modules", "patchy", "dist", "index.js");
  await run(process.execPath, [pinned, "refresh", "--json"], {
    cwd: repo,
    env,
    timeoutMs: 300_000
  });
  const published = decodeRepoPublish(
    await run(process.execPath, [pinned, "publish", "--json"], {
      cwd: repo,
      env,
      timeoutMs: 300_000
    })
  );
  return {
    patchId: published.patchId,
    versionId: published.versionId,
    address: published.address,
    agentTool: published.handlers.some((handler) => handler.name === AGENT_TOOL)
  };
};

/**
 * The agent area's calls as the signed-in publisher's page makes them: its query answers, so the
 * release serves the patch; its read-only action's write is refused and leaves no note; and,
 * when HEAD built one, its agent tool is refused. Answers what went wrong.
 */
const exerciseAgentArea = async (
  context: BrowserContext,
  apiUrl: string,
  agentArea: AgentArea,
  userId: string
) => {
  const principal = { userId };
  const call = async (handler: string) => {
    const response = await context.request.post(`${apiUrl}/api/runtime/call`, {
      headers: {
        origin: apiUrl,
        "x-patchy-wire": String(WIRE_VERSION),
        "x-patchy-principal": JSON.stringify(principal)
      },
      data: {
        patchId: agentArea.patchId,
        versionId: agentArea.versionId,
        wire: WIRE_VERSION,
        principal,
        op: "server.call",
        args: { handler, args: {} }
      }
    });
    return decodeRuntimeReply(await response.text());
  };
  const problems: Array<string> = [];
  const expectRefused = async (handler: string, what: string) => {
    const reply = await call(handler);
    if (reply.ok || reply.code !== "access_denied")
      problems.push(`${what} answered ${reply.ok ? "ok" : reply.code}, not access_denied`);
  };
  await expectRefused(FORCED_WRITE, "the read-only action's forced write");
  if (agentArea.agentTool) await expectRefused(AGENT_TOOL, "the page's call to the agent tool");
  const notes = await call("notes.list");
  if (!notes.ok) problems.push(`the patch's own query answered ${notes.code}`);
  else if (!Array.isArray(notes.value) || notes.value.length !== 0)
    problems.push("a note was written, so the read-only action's write went through");
  return problems;
};

/**
 * The build's own CLI from the release its server serves, logged in as the
 * scenario's publisher: who it is, every scenario patch listed, and a new
 * version of the rehearsal page, numbered by the step. At step 2, HEAD's CLI
 * also publishes the agent area once it writes read-only actions. Answers the
 * patch ids `list` named and the publisher's user id, too.
 */
const exerciseCli = async (
  step: Step,
  environment: Environment,
  rehearsalPage: RehearsalPage | undefined,
  scratch: string
) => {
  const dir = path.join(scratch, `cli-${step.number}`);
  const release = await get(`${environment.apiUrl}/api/release`);
  const { tarball } = decodeRelease(release.body.toString("utf8")).package;
  // From a file: the pinned npm refuses to fetch a remote tarball itself.
  const file = path.join(scratch, `patchy-${step.number}.tgz`);
  await writeFile(file, (await get(tarball, 120_000)).body);
  await run(
    "npm",
    ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", file],
    { cwd: scratch, timeoutMs: 180_000 }
  );
  const env = closedEnv({ PATCHY_STATE_DIR: path.join(dir, "state") });
  const patchy = (args: Array<string>, input?: string) =>
    run(path.join(dir, "node_modules", ".bin", "patchy"), args, { cwd: dir, env, input });
  const problems: Array<string> = [];
  const token = publisherToken(environment.scenario);
  await patchy(["auth", "set", "--token-stdin", "--api-url", environment.apiUrl], token);
  const identity = decodeIdentity(await patchy(["whoami", "--json"]));
  if (identity.company.handle !== environment.scenario.company.handle)
    problems.push(`patchy whoami names company ${identity.company.handle}`);
  const listed = new Map(
    decodeList(await patchy(["list", "--json"])).patches.map((patch) => [patch.name, patch.id])
  );
  for (const name of environment.addresses.keys())
    if (!listed.has(name)) problems.push(`patchy list is missing ${name}`);
  const page = path.join(dir, "rollback-rehearsal.html");
  await writeFile(
    page,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rollback rehearsal</title></head><body><h1>Published at step ${step.number}</h1></body></html>\n`
  );
  const target =
    rehearsalPage === undefined
      ? ["--name", "rollback-rehearsal", "--description", "A version from each rehearsal step."]
      : ["--patch", rehearsalPage.patchId];
  const published = decodePublish(await patchy(["publish", page, ...target, "--json"]));
  if (published.versionNumber !== step.number)
    problems.push(
      `patchy publish made version ${published.versionNumber} of the rehearsal page, not ${step.number}`
    );
  const agentArea =
    step.number === 2 && (await writesReadOnly(dir)) ? await publishAgentArea(dir, env) : undefined;
  if (step.number === 2 && agentArea === undefined)
    console.log("  HEAD's CLI writes no read-only actions yet, so it publishes no agent area.");
  return {
    problems,
    patchIds: listed,
    userId: identity.user.id,
    rehearsalPage: { patchId: published.patchId, address: published.address },
    agentArea
  };
};

/** What step 1 saw, which later steps must see again. */
interface Baseline {
  readonly rehearsalPage: RehearsalPage;
  /** Published by HEAD at step 2, when its CLI writes read-only actions. */
  readonly agentArea?: AgentArea;
  /** The snapshots the server delivered to each patch's page, by address, then by handler. */
  readonly delivered: ReadonlyMap<string, Deliveries>;
}

interface PageExpectation {
  /** A tier 1 or 2 patch's id: the server must deliver its first live queries. */
  readonly patchId?: string;
  /** What step 1 saw delivered, which must be delivered again. */
  readonly delivers?: Deliveries;
  /** Its sample data was loaded in step 1, so its empty state must not show. */
  readonly sampleData: boolean;
}

/**
 * How many snapshots of each live query, by handler, the server delivered.
 * Events name no subscription, so a page with three `tables.list` queries
 * counts three; each subscription delivers once on a page nothing writes to.
 */
type Deliveries = ReadonlyMap<string, number>;

/** The snapshots the server delivered to `patchId`'s page in `log`, whatever re-ran them. */
const deliveries = (log: string, patchId: string): Deliveries => {
  const counts = new Map<string, number>();
  for (const event of serverEvents(log))
    if (event.type === "re-run" && event.patchId === patchId && event.disposition === "delivered") {
      const query = event.handler ?? event.type;
      counts.set(query, (counts.get(query) ?? 0) + 1);
    }
  return counts;
};

/**
 * Opens `url` and waits for it to settle: a tier 2 patch's tools started, its
 * stream not reconnecting, and for a patch with code, its live queries
 * delivered (as many of each as step 1 saw) and `/api/runtime/` quiet for a
 * second and a half. Answers what went wrong and what was delivered.
 */
const exercisePage = async (page: Page, url: string, expect: PageExpectation, log: string) => {
  const problems: Array<string> = [];
  const origin = new URL(url).origin;
  const opened = await logSize(log);
  let delivered: Deliveries = new Map();
  let lastRuntimeCall = 0;
  page.on("response", (response) => {
    const target = new URL(response.url());
    if (target.origin !== origin) return;
    if (response.status() >= 500)
      problems.push(
        `${response.request().method()} ${target.pathname} answered ${response.status()}`
      );
    if (target.pathname.startsWith("/api/runtime/") && target.pathname !== "/api/runtime/stream")
      lastRuntimeCall = Date.now();
  });
  page.on("pageerror", (error) => problems.push(`uncaught ${error.message}`));
  const response = await page.goto(url);
  if (response?.status() !== 200)
    return { problems: [...problems, `answered ${response?.status() ?? "nothing"}`], delivered };
  const unsettled = async () => {
    const reasons: Array<string> = [];
    if ((await page.locator('dialog[data-stream-status="starting"][open]').count()) > 0)
      reasons.push("its tools never started");
    if ((await page.locator('[data-stream-status="reconnecting"]:not([hidden])').count()) > 0)
      reasons.push("its stream kept reconnecting");
    if (expect.patchId === undefined) return reasons;
    delivered = deliveries(await logSince(log, opened), expect.patchId);
    const missing = [...(expect.delivers ?? [])].flatMap(([query, count]) => {
      const seen = delivered.get(query) ?? 0;
      return seen < count ? [`${seen} of the ${count} ${query} snapshots`] : [];
    });
    if (delivered.size === 0) reasons.push("the server never delivered a live query");
    else if (missing.length > 0)
      reasons.push(`the server delivered ${missing.join(", ")} step 1 saw`);
    else if (Date.now() - lastRuntimeCall < 1_500) reasons.push("its calls never went quiet");
    return reasons;
  };
  // A cold tier 2 start waits for its tools, as long as the shell's own cover allows.
  const deadline = Date.now() + 60_000;
  let reasons = await unsettled();
  while (reasons.length > 0 && Date.now() < deadline) {
    await page.waitForTimeout(250);
    proceed();
    reasons = await unsettled();
  }
  problems.push(...reasons);
  const emptyState = page
    .frameLocator("iframe")
    .first()
    .getByRole("button", { name: /load sample data/i });
  if (expect.sampleData && (await emptyState.count()) > 0)
    problems.push("it shows its empty state, so the sample data step 1 loaded is gone");
  return { problems, delivered };
};

/**
 * The portal, every scenario patch, the rehearsal page and any agent area in
 * Chromium, as the scenario's publisher, then the agent area's calls. Answers
 * the problems and each patch page's delivered live queries.
 */
const exercisePages = async (
  browser: Browser,
  environment: Environment,
  patchIds: ReadonlyMap<string, string>,
  rehearsalPage: RehearsalPage,
  agentArea: { readonly patch: AgentArea; readonly userId: string } | undefined,
  baseline: Baseline | undefined,
  log: string
) => {
  const { apiUrl, scenario } = environment;
  const publisher = scenario.people.find((person) => person.key === scenario.publisher)!;
  const none: PageExpectation = { sampleData: false };
  const targets: Array<readonly [string, PageExpectation]> = [
    ...["/", "/patches", "/company"].map((page) => [`${apiUrl}${page}`, none] as const),
    ...scenario.patches.map((patch) => {
      if (!("repo" in patch)) return [environment.addresses.get(patch.name)!, none] as const;
      const url = environment.addresses.get(patch.repo)!;
      const patchId = patch.tier > 0 ? patchIds.get(patch.repo) : undefined;
      const delivers = baseline?.delivered.get(url);
      return [
        url,
        {
          ...(patchId === undefined ? {} : { patchId }),
          ...(delivers === undefined ? {} : { delivers }),
          sampleData: patch.sampleData === true
        }
      ] as const;
    }),
    [rehearsalPage.address, none],
    ...(agentArea === undefined ? [] : [[agentArea.patch.address, none] as const])
  ];
  const context = await browser.newContext();
  const problems: Array<string> = [];
  const delivered = new Map<string, Deliveries>();
  try {
    const signIn = await context.newPage();
    const signedIn = await signIn.goto(
      `${apiUrl}/dev/sign-in?as=${encodeURIComponent(publisher.email)}&return=/`
    );
    await signIn.close();
    // Every page after a failed sign-in would only answer 401.
    if (signedIn?.status() !== 200)
      return {
        problems: [`signing in as ${publisher.email} answered ${signedIn?.status() ?? "nothing"}`],
        delivered
      };
    for (const [url, expect] of targets) {
      const page = await context.newPage();
      try {
        const visit = await exercisePage(page, url, expect, log);
        problems.push(...visit.problems.map((problem) => `${new URL(url).pathname}: ${problem}`));
        if (expect.patchId !== undefined) delivered.set(url, visit.delivered);
      } finally {
        await page.close();
      }
    }
    if (agentArea !== undefined)
      problems.push(
        ...(await exerciseAgentArea(context, apiUrl, agentArea.patch, agentArea.userId)).map(
          (problem) => `${new URL(agentArea.patch.address).pathname}: ${problem}`
        )
      );
  } finally {
    await context.close();
  }
  return { problems, delivered };
};

/**
 * Everything a step checks against the server writing to `log`. Answers every
 * problem, and step 1's baseline or the one it was given.
 */
const exercise = async (
  step: Step,
  environment: Environment,
  baseline: Baseline | undefined,
  scratch: string,
  log: string
) => {
  const started = await logSize(log);
  const problems: Array<string> = [];
  const health = await get(`${environment.apiUrl}/healthz/deep`);
  if (health.status !== 200) problems.push(`/healthz/deep answered ${health.status}`);
  const cli = await exerciseCli(step, environment, baseline?.rehearsalPage, scratch);
  problems.push(...cli.problems);
  const agentArea = cli.agentArea ?? baseline?.agentArea;
  proceed();
  // The harness owns shutdown; Playwright's own handlers would exit before cleanup.
  const browser = await chromium.launch({
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false
  });
  try {
    const pages = await exercisePages(
      browser,
      environment,
      cli.patchIds,
      cli.rehearsalPage,
      agentArea === undefined ? undefined : { patch: agentArea, userId: cli.userId },
      baseline,
      log
    );
    problems.push(...pages.problems, ...serverFailures(await logSince(log, started), agentArea));
    const seen = baseline ?? { rehearsalPage: cli.rehearsalPage, delivered: pages.delivered };
    return {
      problems,
      baseline: cli.agentArea === undefined ? seen : { ...seen, agentArea: cli.agentArea }
    };
  } finally {
    await browser.close();
  }
};

// ---- The rehearsal ------------------------------------------------------------

const summary = async (lines: ReadonlyArray<string>) => {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) await appendFile(file, `### Rollback rehearsal\n\n${lines.join("\n")}\n`);
};

/** Prints a failure, annotates it in GitHub Actions and adds it to the job summary. */
const report = async (message: string, details: ReadonlyArray<string> = []) => {
  console.error(`\n${message}`);
  for (const detail of details) console.error(`  ${detail}`);
  if (process.env.GITHUB_ACTIONS) console.error(`::error title=Rollback rehearsal::${message}`);
  await summary([
    `**${message}**`,
    ...(details.length === 0 ? [] : ["", "```", ...details, "```"])
  ]);
};

const short = (commit: string) => commit.slice(0, 7);

/** The three steps on a scratch worktree, which it removes again, instance and all. */
const rehearse = async (live: string, head: string) => {
  const steps: ReadonlyArray<Step> = [
    { number: 1, title: `the live commit (${short(live)}) seeds the data`, commit: live },
    { number: 2, title: `HEAD (${short(head)}) upgrades it`, commit: head },
    { number: 3, title: `the live commit (${short(live)}) comes back`, commit: live }
  ];
  console.log(`Rehearsing ${short(live)} → ${short(head)} → ${short(live)} on one set of data.`);
  const started = Date.now();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "patchy-rollback-rehearsal-"));
  const worktree = path.join(scratch, "repo");
  const dev = (args: Array<string>, timeoutMs: number, cleanup = false) =>
    run("pnpm", ["dev", ...args], { cwd: worktree, timeoutMs, cleanup });
  let added = false;
  /** Step 1's dev-runner instance, between `up` and a `stop` that finished. */
  let devRunning = false;
  let cleaning: Promise<void> | undefined;
  const cleanUp = () =>
    (cleaning ??= (async () => {
      await Promise.all([...groups].map(stopGroup));
      await release();
      if (devRunning)
        await dev(["down"], 120_000, true).catch((error: unknown) =>
          console.error(`pnpm dev down: ${String(error)}`)
        );
      // What `pnpm dev down` removes besides the worktree's own `.local/dev`.
      const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
      await rm(path.join(data, "patchy-dev", hostLabel(worktree)), {
        recursive: true,
        force: true
      });
      if (added)
        await run("git", ["worktree", "remove", "--force", worktree], {
          cwd: repoRoot,
          cleanup: true
        }).catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
    })());
  let environment: Environment | undefined;
  let baseline: Baseline | undefined;
  try {
    for (const step of steps) {
      console.log(`\n▶ Step ${step.number}: ${step.title}`);
      const stepStarted = Date.now();
      // Step 1's server writes to the dev runner's log; later ones to their own.
      const log =
        step.number === 1
          ? path.join(worktree, ".local", "dev", "dev.log")
          : path.join(scratch, `server-${step.number}.log`);
      const logStart = await logSize(log);
      /** What went wrong, and the server's log lines since this step began. */
      const fail = async (phase: string, problems: ReadonlyArray<string>) => {
        const tail = (await logSince(log, logStart))
          .trimEnd()
          .split("\n")
          .filter(Boolean)
          .slice(-40)
          .map((line) => (line.length > 400 ? `${line.slice(0, 400)}…` : line));
        return new StepFailed(step, phase, [
          ...problems,
          ...(tail.length === 0 ? [] : [`${path.basename(log)}:`, ...tail])
        ]);
      };
      const phase = async <A>(name: string, work: () => Promise<A>) => {
        try {
          return await work();
        } catch (error) {
          throw await fail(name, [error instanceof Error ? error.message : String(error)]);
        }
      };

      await phase("checking out and installing", async () => {
        if (added)
          await run("git", ["checkout", "--quiet", "--force", "--detach", step.commit], {
            cwd: worktree
          });
        else {
          await git("worktree", "add", "--quiet", "--detach", worktree, step.commit);
          added = true;
        }
        await run("pnpm", ["install", "--frozen-lockfile"], {
          cwd: worktree,
          env: closedEnv({ SKIP_INSTALL_SIMPLE_GIT_HOOKS: "1" }),
          timeoutMs: 600_000
        });
      });
      const previous = environment;
      const current: Environment =
        previous === undefined
          ? await phase("starting, migrating and seeding brightline", async () => {
              // `up` loads sample data with this build's Playwright, which may be another version.
              await run("pnpm", ["exec", "playwright", "install", "chromium"], {
                cwd: worktree,
                timeoutMs: 300_000
              });
              devRunning = true;
              const manifest = decodeManifest(await dev(["up", SCENARIO, "--json"], 900_000));
              const scenario = path.join(worktree, "scenarios", SCENARIO, "scenario.json");
              return {
                apiUrl: manifest.apiUrl,
                scenario: decodeScenario(await readFile(scenario, "utf8")),
                addresses: new Map(manifest.patches.map((patch) => [patch.key, patch.address]))
              };
            })
          : await phase("starting and migrating", async () => {
              await serve(worktree, log);
              return previous;
            });
      environment = current;
      const exercised = await phase("exercising", () =>
        exercise(step, current, baseline, scratch, log)
      );
      if (exercised.problems.length > 0) throw await fail("exercising", exercised.problems);
      baseline = exercised.baseline;
      await phase("stopping", async () => {
        if (devRunning) {
          await dev(["stop"], 120_000);
          devRunning = false;
        }
        await release();
      });
      console.log(`  passed in ${Math.round((Date.now() - stepStarted) / 1000)}s`);
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const passed = `Exercised rollback paths passed: ${short(live)} → ${short(head)} → ${short(live)}, in ${seconds}s.`;
    console.log(`\n${passed}`);
    await summary([passed]);
  } catch (error) {
    if (!(error instanceof StepFailed) || cancelled !== undefined) throw error;
    await report(error.message, error.problems);
    process.exitCode = 1;
  } finally {
    await cleanUp();
  }
};

const { values } = parseArgs({ options: { live: { type: "string" } } });
try {
  const head = (await git("rev-parse", "HEAD")).trim();
  if ((await git("status", "--porcelain")).trim() !== "")
    console.log(`Rehearsing HEAD (${short(head)}); uncommitted changes are not part of it.`);
  const live = await resolveCommit(values.live ?? (await liveCommit()));
  if (live === head) console.log(`HEAD is the live commit (${short(live)}); nothing to rehearse.`);
  else await rehearse(live, head);
} catch (error) {
  if (cancelled === undefined && !(error instanceof Uncertain)) throw error;
  if (error instanceof Uncertain) {
    await report(
      `The live commit is uncertain, so there is no release to rehearse against. ${error.message}`
    );
    process.exitCode = 1;
  }
}
// A signal is the outcome even when the step it interrupted, or cleanup, finished anyway.
if (cancelled !== undefined) {
  console.error(`\nStopped by ${cancelled}; the scratch worktree and its instance are gone.`);
  process.exit(128 + os.constants.signals[cancelled]);
}
