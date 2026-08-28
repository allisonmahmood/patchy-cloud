/**
 * The long-lived process behind `pnpm dev`: one Effect scope owning every
 * handle. Postgres is an `acquireRelease`, the server a spawned child with
 * SIGTERM-then-SIGKILL teardown, and either one exiting closes the scope so
 * nothing outlives its sibling. `NodeRuntime.runMain` turns SIGTERM from
 * `stop` into interruption, which runs the same finalizers.
 *
 * Every log line lands in `.local/dev/dev.log` with one `[service]` prefix.
 */
import EmbeddedPostgres from "embedded-postgres";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { PostgresPatchyDb } from "@patchy/db";
import { DATABASE_NAME, Plan } from "./plan.js";
import { alive } from "./process.js";
import { PG_FLAGS, PG_PASSWORD, PG_USER, applyDevSeed } from "./seed.js";
import { layout, writeEnv, writePlan } from "./state.js";

export class PostgresError extends Schema.TaggedError<PostgresError>()("PostgresError", {
  stage: Schema.Literals(["start", "create-database"]),
  cause: Schema.Defect()
}) {
  override get message() {
    return `Embedded Postgres failed to ${this.stage}.`;
  }
}

export class PostgresExited extends Schema.TaggedError<PostgresExited>()("PostgresExited", {
  pid: Schema.Int
}) {
  override get message() {
    return `Embedded Postgres (pid ${this.pid}) is gone; closing the instance.`;
  }
}

export class DatabaseSetupError extends Schema.TaggedError<DatabaseSetupError>()(
  "DatabaseSetupError",
  { stage: Schema.Literals(["migrate", "seed"]), cause: Schema.Defect() }
) {
  override get message() {
    return `The dev database failed to ${this.stage}.`;
  }
}

/** The whole instance; returns when the server exits, and tears down on interruption. */
export const supervise = Effect.fn("supervise")(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const files = layout(plan, path);

  yield* fs.makeDirectory(files.postgresDir, { recursive: true });
  yield* fs.makeDirectory(files.storageDir, { recursive: true });

  // Every log line is one `writeAll`, so prefixes never split mid-line.
  // Effect code writes directly; embedded-postgres's plain callbacks cannot,
  // so they enqueue and a fiber appends for them.
  const log = yield* fs.open(files.logFile, { flag: "a" });
  const encoder = new TextEncoder();
  const write = Effect.fn("log")(function* (service: string, line: string) {
    const now = yield* DateTime.now;
    yield* log.writeAll(encoder.encode(`${DateTime.formatIso(now)} [${service}] ${line}\n`));
  });
  const callbackLines = yield* Queue.unbounded<{
    readonly service: string;
    readonly line: string;
  }>();
  const enqueue = (service: string) => (message: unknown) => {
    const text = message instanceof Error ? message.message : String(message);
    for (const line of text.split("\n")) {
      if (line.trim() !== "") Queue.offerUnsafe(callbackLines, { service, line });
    }
  };
  yield* Stream.fromQueue(callbackLines).pipe(
    Stream.runForEach(({ service, line }) => write(service, line)),
    Effect.forkScoped
  );
  const say = (line: string) => write("dev", line);

  yield* say(`supervisor pid=${process.pid} worktree=${plan.worktree}`);

  // Postgres: initdb once per state dir, then a normal start/stop pair. The
  // durability flags are off because a dev database is disposable.
  const postgres = new EmbeddedPostgres({
    databaseDir: files.postgresDir,
    port: plan.ports.postgres,
    user: PG_USER,
    password: PG_PASSWORD,
    persistent: true,
    initdbFlags: ["--no-sync"],
    postgresFlags: [...PG_FLAGS],
    onLog: enqueue("postgres"),
    onError: enqueue("postgres")
  });
  const initialised = yield* fs.exists(path.join(files.postgresDir, "PG_VERSION"));
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        if (!initialised) await postgres.initialise();
        await postgres.start();
      },
      catch: (cause) => new PostgresError({ stage: "start", cause })
    }),
    // Bounded: a hung pg_ctl must not hold the teardown open forever.
    () =>
      Effect.tryPromise(() => postgres.stop()).pipe(
        Effect.timeout("15 seconds"),
        Effect.andThen(say("postgres stopped")),
        Effect.ignore
      )
  );
  yield* Effect.tryPromise({
    try: async () => {
      const client = postgres.getPgClient("postgres");
      await client.connect();
      try {
        const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
          DATABASE_NAME
        ]);
        if (existing.rowCount === 0) await postgres.createDatabase(DATABASE_NAME);
      } finally {
        await client.end();
      }
    },
    catch: (cause) => new PostgresError({ stage: "create-database", cause })
  });
  const postgresPid = Number(
    (yield* fs.readFileString(path.join(files.postgresDir, "postmaster.pid"))).split("\n")[0]
  );
  yield* say(`postgres pid=${postgresPid} port=${plan.ports.postgres}`);

  // Migrations go through today's `packages/db` runner; the `sql` ticket swaps
  // this seam for Effect's Migrator.
  yield* Effect.tryPromise({
    try: async () => {
      const db = new PostgresPatchyDb(plan.databaseUrl);
      try {
        await db.initialize(null);
      } finally {
        await db.close();
      }
    },
    catch: (cause) => new DatabaseSetupError({ stage: "migrate", cause })
  });
  yield* Effect.tryPromise({
    try: () => applyDevSeed(plan.databaseUrl),
    catch: (cause) => new DatabaseSetupError({ stage: "seed", cause })
  });
  yield* say("database migrated and seeded");

  // The server: plain node with the tsx loader so the pid we record is the
  // one signals reach. Its env is closed: the plan plus what a process needs
  // to run at all, so nothing exported in the agent's shell (another
  // DATABASE_URL, a storage driver, a bootstrap token) leaks in.
  const inherited = yield* Config.all({
    PATH: Config.string("PATH"),
    HOME: Config.string("HOME").pipe(Config.withDefault(plan.stateDir))
  });
  const server = yield* spawner.spawn(
    ChildProcess.make(
      process.execPath,
      [
        "--import",
        "tsx",
        "--conditions=development",
        path.join(plan.worktree, "apps", "server", "src", "start.ts")
      ],
      {
        cwd: plan.worktree,
        env: {
          ...inherited,
          PORT: String(plan.ports.server),
          PATCHY_DB_DRIVER: "postgres",
          DATABASE_URL: plan.databaseUrl,
          PATCHY_STORAGE_DIR: files.storageDir,
          PATCHY_PUBLIC_BASE_URL: plan.apiUrl
        },
        extendEnv: false,
        stdin: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: "5 seconds"
      }
    )
  );
  yield* say(`server pid=${server.pid} port=${plan.ports.server}`);
  yield* server.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => write("server", line)),
    Effect.forkScoped
  );

  const running: Plan = {
    ...plan,
    pids: { supervisor: process.pid, server: server.pid, postgres: postgresPid }
  };
  yield* writePlan(running);
  yield* writeEnv(running);

  // The library gives no exit hook for Postgres, so a probe stands in. Whichever
  // ends first ends the supervisor; the scope's finalizers take the other down.
  const postgresGone = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("1 second");
      if (!(yield* alive(postgresPid))) return yield* new PostgresExited({ pid: postgresPid });
    }
  });
  yield* Effect.raceFirst(
    Effect.flatMap(server.exitCode, (code) => say(`server exited code=${code}`)),
    postgresGone
  ).pipe(Effect.catchTags({ PostgresExited: (error) => say(error.message) }));
});
