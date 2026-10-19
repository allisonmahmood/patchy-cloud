import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { acquireLock, clonePlan } from "./evidence.js";

describe("clonePlan", () => {
  it("clones and checks out a side that has no checkout yet", () => {
    assert.deepStrictEqual(clonePlan({ exists: false }, "abc"), {
      clone: true,
      takeDown: false,
      checkout: true
    });
  });

  it("reuses a clean checkout already at the commit", () => {
    assert.deepStrictEqual(
      clonePlan({ exists: true, sha: "abc", dirty: false, leftover: false }, "abc"),
      { clone: false, takeDown: false, checkout: false }
    );
  });

  it("moves a checkout at another commit, taking a leftover instance down first", () => {
    assert.deepStrictEqual(
      clonePlan({ exists: true, sha: "old", dirty: false, leftover: true }, "abc"),
      { clone: false, takeDown: true, checkout: true }
    );
  });

  it("checks out again over stray changes at the same commit", () => {
    assert.deepStrictEqual(
      clonePlan({ exists: true, sha: "abc", dirty: true, leftover: false }, "abc"),
      { clone: false, takeDown: false, checkout: true }
    );
  });
});

it.layer(NodeServices.layer)("the evidence lock", (it) => {
  const dead = `{"pid":${2 ** 30},"command":"compare","started":"2026-10-19T00:00:00.000Z"}`;

  it.effect("refuses a second run while the first holds it, and frees it when the run ends", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(yield* fs.makeTempDirectoryScoped(), "worktree.evidence.lock");

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireLock(dir, "compare");
          const busy = yield* Effect.flip(Effect.scoped(acquireLock(dir, "film")));
          assert.strictEqual(busy._tag, "EvidenceBusy");
          assert.include(busy.message, "`pnpm dev compare`");
        })
      );

      assert.deepStrictEqual(yield* fs.readDirectory(dir), []);
      yield* Effect.scoped(acquireLock(dir, "film"));
    }).pipe(Effect.scoped)
  );

  it.effect("lets at most one of several runs starting together hold it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(yield* fs.makeTempDirectoryScoped(), "worktree.evidence.lock");

      const outcomes = yield* Effect.scoped(
        Effect.all(
          Array.from({ length: 6 }, () => Effect.result(acquireLock(dir, "compare"))),
          { concurrency: "unbounded" }
        )
      );

      assert.isAtMost(outcomes.filter(Result.isSuccess).length, 1);
      assert.deepStrictEqual(yield* fs.readDirectory(dir), []);
    }).pipe(Effect.scoped)
  );

  it.effect("deletes an entry whose process is gone instead of waiting on it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(yield* fs.makeTempDirectoryScoped(), "worktree.evidence.lock");
      yield* fs.makeDirectory(dir);
      yield* fs.writeFileString(path.join(dir, "1073741824-killed.json"), dead);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireLock(dir, "film");
          const [entry] = yield* fs.readDirectory(dir);
          assert.include(yield* fs.readFileString(path.join(dir, entry!)), `"pid":${process.pid}`);
        })
      );
    }).pipe(Effect.scoped)
  );
});
