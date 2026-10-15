import { assert, it } from "@effect/vitest";
import { failureOf } from "./state.js";

const log = [
  "2026-10-14T10:00:00.000Z [dev] supervisor pid=100 worktree=/w",
  "2026-10-14T10:00:01.000Z [dev] error: The dev database failed to migrate: an earlier run",
  "2026-10-14T10:00:02.000Z [dev] postgres stopped",
  "2026-10-15T10:00:00.000Z [dev] supervisor pid=200 worktree=/w",
  '2026-10-15T10:00:01.000Z [postgres] ERROR:  relation "nope" does not exist',
  "2026-10-15T10:00:01.500Z [dev] error: The dev database failed to migrate: this run",
  "2026-10-15T10:00:02.000Z [dev] postgres stopped",
  ""
].join("\n");

it("reads only the failure a supervisor logged in its own run", () => {
  assert.strictEqual(failureOf(log, 200), "The dev database failed to migrate: this run");
  assert.strictEqual(failureOf(log, 100), "The dev database failed to migrate: an earlier run");
  assert.isUndefined(
    failureOf(`${log}2026-10-15T11:00:00.000Z [dev] supervisor pid=300 worktree=/w\n`, 300)
  );
  assert.isUndefined(failureOf(log, 400));
});
