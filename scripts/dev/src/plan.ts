/**
 * The dev runner's plan: which worktree, which ports, where state lives.
 *
 * Everything else in the runner is derived from a `Plan`. Computing one is
 * pure apart from the port probe passed in, so `--dry-run --json` and the
 * tests share this module with the real `start`.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DEV_SEED } from "@patchy/auth/seed";
import { PG_PASSWORD, PG_USER } from "./postgres.js";

/**
 * The processes recorded in `plan.json`. `start` records the supervisor the
 * moment it is spawned — that is the lock against a second start — and the
 * supervisor fills in the rest once they exist.
 */
export const Pids = Schema.Struct({
  supervisor: Schema.Int,
  server: Schema.optionalKey(Schema.Int),
  postgres: Schema.optionalKey(Schema.Int)
});

/**
 * An environment (`pnpm dev up`): people sign in as dev personas instead of
 * through Clerk, the instance serves on its own `<worktree>.localhost` host,
 * and the scenario names the seeded company, people and patches.
 */
export const Environment = Schema.Struct({ scenario: Schema.String });
export type Environment = typeof Environment.Type;

export const Plan = Schema.Struct({
  worktree: Schema.String,
  /** `<worktree>/.local/dev` — Postgres data, logs, `env`, `plan.json`. */
  stateDir: Schema.String,
  ports: Schema.Struct({ server: Schema.Int, postgres: Schema.Int }),
  apiUrl: Schema.String,
  databaseUrl: Schema.String,
  /** The seeded API token; `env` exports it as `PATCHY_API_TOKEN`. */
  token: Schema.String,
  /** Absent until `start` has spawned a supervisor. */
  pids: Schema.optionalKey(Pids),
  /** Present when this worktree's instance is an environment rather than plain `pnpm dev`. */
  environment: Schema.optionalKey(Environment)
});
export type Plan = typeof Plan.Type;

/** `plan.json` is exactly a `Plan`. */
export const PlanJson = Schema.fromJsonString(Plan, { space: 2 });

export class WorktreeNotFound extends Schema.TaggedError<WorktreeNotFound>()("WorktreeNotFound", {
  from: Schema.String
}) {
  override get message() {
    return `${this.from} is not inside a git worktree.`;
  }
}

export class NoFreePorts extends Schema.TaggedError<NoFreePorts>()("NoFreePorts", {
  from: Schema.Int,
  tried: Schema.Int
}) {
  override get message() {
    return `No free port pair in the ${this.tried} pairs from ${this.from}.`;
  }
}

export const DATABASE_NAME = "patchy";

/**
 * Even ports in 20000-39998 keep clear of the well-known range and leave
 * `base + 1` for Postgres. The hash is Effect's own, so it is the same in
 * every process that looks at the same path.
 */
export const basePort = (worktree: string): number =>
  20000 + (Math.abs(Hash.string(worktree)) % 10000) * 2;

/**
 * The worktree's DNS label: an environment serves on `<label>.localhost`, so
 * its cookies never reach another worktree's instance on the same machine.
 */
export const hostLabel = (worktree: string): string =>
  (worktree.split(/[\\/]/).filter(Boolean).at(-1) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "") || "patchy";

/** How many pairs `computePlan` tries above the hashed base before giving up. */
const SCAN_PAIRS = 50;

/** The worktree root: the nearest ancestor of `from` holding `.git` (a directory, or a file in a linked worktree). */
export const findWorktree = Effect.fn("findWorktree")(function* (from: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = path.resolve(from);
  while (true) {
    if (yield* fs.exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return yield* new WorktreeNotFound({ from });
    dir = parent;
  }
});

/**
 * The plan for a worktree, with the first free port pair at or above the
 * hashed base. `isFree` is the only side effect; tests pass a stub.
 */
export const computePlan = Effect.fn("computePlan")(function* <E, R>(
  worktree: string,
  isFree: (port: number) => Effect.Effect<boolean, E, R>,
  environment?: Environment
) {
  const path = yield* Path.Path;
  const from = basePort(worktree);
  for (let pair = 0; pair < SCAN_PAIRS; pair++) {
    const server = from + pair * 2;
    const postgres = server + 1;
    if ((yield* isFree(server)) && (yield* isFree(postgres))) {
      const plan: Plan = {
        worktree,
        stateDir: path.join(worktree, ".local", "dev"),
        ports: { server, postgres },
        apiUrl: `http://${environment === undefined ? "127.0.0.1" : `${hostLabel(worktree)}.localhost`}:${server}`,
        databaseUrl: `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${postgres}/${DATABASE_NAME}`,
        token: DEV_SEED.token,
        ...(environment === undefined ? {} : { environment })
      };
      return plan;
    }
  }
  return yield* new NoFreePorts({ from, tried: SCAN_PAIRS });
});
