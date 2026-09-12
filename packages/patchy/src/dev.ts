/** Node-only local runtime entrypoint. Importing it never starts a session or checks a release. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Prepared } from "./devPreparation.js";
import { Daemon, atomicJson, readRecord } from "./devState.js";
import * as DevServer from "./devServer.js";
import { LocalError } from "./CliError.js";

const decodePrepared = Schema.decodeUnknownSync(Schema.fromJsonString(Prepared));
const decodeDaemon = Schema.decodeUnknownSync(Daemon);

/** Private daemon invocation is nonce-bound to its repo's startup record. */
export function run(): void {
  const stateDir = process.argv[2];
  const nonce = process.argv[3];
  if (!stateDir || !nonce) throw new Error("Start the local runtime with `patchy dev`.");
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const record = yield* Effect.tryPromise({
      try: async () => decodeDaemon(await readRecord(stateDir)),
      catch: (cause) => new LocalError({ message: "Could not read the dev startup record.", cause })
    });
    if (record.nonce !== nonce)
      return yield* new LocalError({
        message: "The dev startup record belongs to another invocation."
      });
    const text = yield* fs.readFileString(path.join(stateDir, "prepared.json"));
    const prepared = yield* Effect.try({
      try: () => decodePrepared(text),
      catch: (cause) => new LocalError({ message: "Could not read local runtime metadata.", cause })
    });
    return yield* DevServer.serve(prepared, stateDir, record).pipe(Effect.provide(DevServer.layer));
  }).pipe(
    Effect.scoped,
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          atomicJson(stateDir, "failure.json", {
            error: error.message,
            ...("code" in error ? { code: error.code } : {})
          })
        );
        yield* Console.error(error.message);
        return yield* Effect.fail(error);
      })
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain
  );
}
export { RELEASE } from "./release.js";
