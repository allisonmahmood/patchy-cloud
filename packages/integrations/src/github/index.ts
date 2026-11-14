import { GithubSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { defineIntegration } from "../definition.js";
import * as Access from "./Access.js";
import * as Connection from "./Connection.js";
import * as Flows from "./Flows.js";
import { generate } from "./Generate.js";
import { operations } from "./Operations.js";
import * as Source from "./Source.js";

/** Discovery from a connection's credentials: the check, and its repositories read by id. */
const metadata = {
  schema: GithubSnapshot,
  discover: Effect.fn("Github.metadata.discover")(function* (credentials: Connection.Credentials) {
    const access = yield* Access.Access;
    const inspected = yield* access.inspect(
      credentials.installationId,
      credentials.repositoryIds,
      "the account"
    );
    return {
      version: 1,
      account: inspected.account,
      repositories: inspected.repositories
    } satisfies GithubSnapshot;
  })
};

// Keep declaration emission pointed at the modules' public types.
export const github: {
  readonly name: "github";
  readonly modes: readonly ["company"];
  readonly credentials: typeof Connection.Credentials;
  readonly metadata?: typeof metadata;
  readonly operations: typeof operations;
  readonly generate: typeof generate;
  readonly live?: ReadonlyArray<keyof typeof operations>;
} = defineIntegration({
  name: "github",
  modes: ["company"],
  credentials: Connection.Credentials,
  metadata,
  operations,
  generate,
  // Invented CI runs, logs and pull requests never resemble a company's: dev reads the real
  // repositories, and nothing on GitHub can be changed through Patchy.
  live: [
    "listRepos",
    "getRepo",
    "listWorkflows",
    "listRuns",
    "getRun",
    "listJobs",
    "getJobLog",
    "listChecks",
    "listPulls",
    "getPull",
    "listPullFiles",
    "listPullReviews"
  ]
});

/** GitHub's source, its call seam and its sign-in flows, sharing one source and its slots. */
export const layer = Layer.mergeAll(Access.layer, Flows.layer).pipe(
  Layer.provideMerge(Source.layer)
);

// What `layer` refuses to start with, nameable from here wherever the layer's type is spelled out.
export { AppIncomplete, AppKeyInvalid } from "./Source.js";
