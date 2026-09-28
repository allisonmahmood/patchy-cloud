// @effect-diagnostics nodeBuiltinImport:off -- Real filesystem permissions exercise cleanup after child reaping.
import { chmod, rm } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { sampleProcess, startWorkerd } from "./process.js";

it.live.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "reaps a child and releases its scope when temporary-directory removal is denied",
  () =>
    Effect.gen(function* () {
      const childScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(childScope, Exit.void));
      const child = yield* startWorkerd().pipe(Effect.provideService(Scope.Scope, childScope));
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await chmod(child.directory, 0o700);
          await rm(child.directory, { recursive: true, force: true });
        })
      );
      const pid = child.child.pid!;
      expect((yield* sampleProcess(pid))!.rssBytes).toBeGreaterThan(0);
      yield* Effect.promise(() => chmod(child.directory, 0o500));
      const closed = yield* Scope.close(childScope, Exit.void).pipe(Effect.exit);
      expect(closed._tag).toBe("Success");
      expect(child.child.signalCode).toBe("SIGKILL");
      expect(yield* sampleProcess(pid)).toBeUndefined();
      expect(() => process.kill(pid, 0)).toThrow();
    }).pipe(Effect.scoped),
  15_000
);
