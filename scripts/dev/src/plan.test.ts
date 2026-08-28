import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, expect } from "vitest";
import { PlanJson, basePort, computePlan, findWorktree } from "./plan.js";

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const free = () => Effect.succeed(true);

describe("basePort", () => {
  it("is a stable even port in the 20000-39999 range", () => {
    const port = basePort("/home/someone/Dev/patchy-cloud");
    expect(port).toBe(basePort("/home/someone/Dev/patchy-cloud"));
    expect(port % 2).toBe(0);
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThan(40000);
  });

  it("differs between worktrees", () => {
    expect(basePort("/w/a")).not.toBe(basePort("/w/b"));
  });
});

describe("computePlan", () => {
  it.effect("pairs the server with the next port and derives every URL from them", () =>
    Effect.gen(function* () {
      const plan = yield* computePlan("/w/a", free);
      const base = basePort("/w/a");
      expect(plan.ports).toEqual({ server: base, postgres: base + 1 });
      expect(plan.apiUrl).toBe(`http://127.0.0.1:${base}`);
      expect(plan.databaseUrl).toBe(`postgresql://postgres:postgres@127.0.0.1:${base + 1}/patchy`);
      expect(plan.stateDir).toBe("/w/a/.local/dev");
      expect(plan.worktree).toBe("/w/a");
      expect(plan.pids).toBeUndefined();
    }).pipe(Effect.provide(Platform))
  );

  it.effect("scans upward by pairs until both ports are free", () =>
    Effect.gen(function* () {
      const base = basePort("/w/a");
      const busy = new Set([base, base + 3]);
      const plan = yield* computePlan("/w/a", (port) => Effect.succeed(!busy.has(port)));
      expect(plan.ports).toEqual({ server: base + 4, postgres: base + 5 });
    }).pipe(Effect.provide(Platform))
  );

  it.effect("gives up with NoFreePorts after the scan window", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(computePlan("/w/a", () => Effect.succeed(false)));
      expect(error._tag).toBe("NoFreePorts");
    }).pipe(Effect.provide(Platform))
  );

  it.effect("round-trips through plan.json", () =>
    Effect.gen(function* () {
      const plan = yield* computePlan("/w/a", free);
      const text = Schema.encodeSync(PlanJson)(plan);
      expect(text).toContain('"ports"');
      expect(Schema.decodeUnknownSync(PlanJson)(text)).toEqual(plan);
    }).pipe(Effect.provide(Platform))
  );
});

describe("findWorktree", () => {
  it.effect("walks up to the directory holding .git, whether a directory or a file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const worktree = path.join(root, "linked");
      yield* fs.makeDirectory(path.join(worktree, "packages", "cli"), { recursive: true });
      yield* fs.writeFileString(path.join(worktree, ".git"), "gitdir: /elsewhere\n");
      expect(yield* findWorktree(path.join(worktree, "packages", "cli"))).toBe(worktree);
      expect(yield* findWorktree(worktree)).toBe(worktree);
    }).pipe(Effect.scoped, Effect.provide(Platform))
  );

  it.effect("fails with WorktreeNotFound outside any repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const error = yield* Effect.flip(findWorktree(root));
      expect(error._tag).toBe("WorktreeNotFound");
    }).pipe(Effect.scoped, Effect.provide(Platform))
  );
});
