import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { installCommand } from "@patchy/api";
import { checkRelease } from "./ReleaseCheck.js";

it.effect("refuses a stale pin even when the executing CLI and runtime are current", () =>
  Effect.gen(function* () {
    const error = yield* checkRelease("2.0.0", {
      pin: "1.0.0",
      cli: "2.0.0",
      runtime: "2.0.0"
    }).pipe(Effect.flip);
    assert.strictEqual(error.code, "release_mismatch");
    assert.match(error.message, /1\.0\.0.*2\.0\.0.*Run: pnpm patchy refresh/);
  })
);

it.effect("refuses an old loaded runtime independently of the pin and CLI", () =>
  Effect.gen(function* () {
    const error = yield* checkRelease("2.0.0", {
      pin: "2.0.0",
      cli: "2.0.0",
      runtime: "1.0.0"
    }).pipe(Effect.flip);
    assert.strictEqual(error.code, "release_mismatch");
    assert.match(error.message, /Runtime release 1\.0\.0.*2\.0\.0.*Run: pnpm patchy refresh/);
  })
);

it.effect("points a stale global CLI outside a repo at its instance's installer", () =>
  Effect.gen(function* () {
    const error = yield* checkRelease(
      "2.0.0",
      { cli: "1.0.0" },
      { instanceUrl: "https://patchy.example" }
    ).pipe(Effect.flip);
    assert.strictEqual(error.code, "release_mismatch");
    assert.include(error.message, "CLI release 1.0.0 does not match instance release 2.0.0.");
    assert.include(
      error.message,
      installCommand(
        "https://patchy.example",
        process.platform === "win32" ? "powershell" : "posix"
      )
    );
    assert.notInclude(error.message, "refresh");
  })
);
