/** Node-only local runtime entrypoint. Importing it never starts a session or checks a release. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ReleaseToolchain } from "@patchy/api";
import { Prepared } from "./devPreparation.js";
import { Daemon, atomicJson, readRecord } from "./devState.js";
import * as DevServer from "./devServer.js";
import * as DirectoryWatch from "./DirectoryWatch.js";
import { LocalError } from "./CliError.js";

const decodePrepared = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ ...Prepared.fields, toolchain: ReleaseToolchain }))
);
const decodeDaemon = Schema.decodeUnknownSync(Daemon);
/** A machine token is 35 characters; anything past this is not one. */
const MAX_KEY_BYTES = 4_096;

/**
 * The machine key, handed over on stdin and nowhere else: never argv, the environment, a file
 * or the log. `patchy dev` closes stdin with nothing on it when no integration reads live.
 */
const receiveKey = Effect.tryPromise({
  try: (signal) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const done = (error?: Error) => {
        signal.removeEventListener("abort", aborted);
        process.stdin.off("data", data).off("end", end).off("error", done);
        process.stdin.destroy();
        if (error) reject(error);
        else resolve(Buffer.concat(chunks).toString("utf8").trim());
      };
      const data = (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_KEY_BYTES) done(new Error("The handed-over key is too long."));
        else chunks.push(chunk);
      };
      const end = () => done();
      const aborted = () => done(new Error("Interrupted."));
      signal.addEventListener("abort", aborted, { once: true });
      process.stdin.on("data", data).once("end", end).once("error", done);
    }),
  catch: (cause) =>
    new LocalError({ message: "patchy dev could not receive this machine's key.", cause })
}).pipe(
  Effect.timeoutOrElse({
    duration: "10 seconds",
    orElse: () =>
      Effect.fail(new LocalError({ message: "patchy dev did not receive this machine's key." }))
  })
);

/** Private daemon invocation is nonce-bound to its repo's startup record. */
export function run(): void {
  const stateDir = process.argv[2];
  const nonce = process.argv[3];
  if (!stateDir || !nonce) throw new Error("Start the local runtime with `patchy dev`.");
  Effect.gen(function* () {
    // Drain stdin first, whatever happens next, so the parent's handoff never waits on it.
    const key = yield* receiveKey;
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
    const token = key === "" ? Option.none() : Option.some(Redacted.make(key));
    if (
      Option.isNone(token) &&
      Object.keys(prepared.metadata.posthog).length +
        Object.keys(prepared.metadata.salesforce ?? {}).length >
        0
    )
      return yield* new LocalError({
        message: "patchy dev started without this machine's key, which live integration reads need."
      });
    return yield* DevServer.serve(prepared, stateDir, record, prepared.toolchain, token).pipe(
      Effect.provide([DevServer.layer, DirectoryWatch.layer])
    );
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
