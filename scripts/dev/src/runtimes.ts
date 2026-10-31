/**
 * Which runtime runs what. `pnpm dev` runs this runner on the Bun that
 * `package.json` pins, and the supervisor and server it starts run on that same
 * Bun, as production's server does. People run the CLI on their own Node, so
 * the CLI and whatever stands in for a person's machine (an environment's
 * `bin/node` and `bin/patchy`, its agent workspace, scenario publishes) run on
 * real Node, and so do the repo's build scripts. Under Bun, `process.execPath`
 * is Bun, so Node is never taken from it: it is always `realNode`.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The Bun running this runner, for the supervisor and the server. */
export const bun = process.execPath;

export class NodeMissing extends Schema.TaggedError<NodeMissing>()("NodeMissing", {
  cause: Schema.optional(Schema.Defect())
}) {
  override get message() {
    return "The CLI and the builds run on Node, as on people's machines, but the `node` on PATH is missing or is Bun. Put Node 22.22.0 or later first on PATH.";
  }
}

const NodeFacts = Schema.fromJsonString(
  Schema.Struct({
    execPath: Schema.String,
    version: Schema.String,
    bun: Schema.optional(Schema.String)
  })
);
const decodeNodeFacts = Schema.decodeUnknownEffect(NodeFacts);

const REPORT =
  "process.stdout.write(JSON.stringify({ execPath: process.execPath, version: process.versions.node, bun: process.versions.bun }))";

/**
 * The `node` first on PATH, as a person's shell finds it, asked for its own
 * binary and version. Asking resolves a version manager's shim to the binary
 * it runs, and refuses a `node` that is really Bun, such as Bun's own shim.
 */
export const realNode = Effect.fn("realNode")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const PATH = yield* Config.String("PATH").pipe(Config.withDefault(""));
  const facts = yield* spawner
    .string(
      ChildProcess.make("node", ["-e", REPORT], { env: { PATH }, extendEnv: true, stdin: "ignore" })
    )
    .pipe(
      Effect.flatMap(decodeNodeFacts),
      Effect.mapError((cause) => new NodeMissing({ cause }))
    );
  if (facts.bun !== undefined) return yield* new NodeMissing({});
  return { execPath: facts.execPath, version: facts.version };
});
