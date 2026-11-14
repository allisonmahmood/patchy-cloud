/**
 * GitHub's dev binding is the real connection (ADR-0013): invented CI runs, logs and pull requests
 * never resemble a company's. `patchy dev` sends each read to the instance's dev door as the
 * machine token's person, whichever local viewer asked, and the instance reads the connection's
 * current set, so no revision rides along. GitHub can't be written through Patchy, so every
 * operation reads live.
 */
import {
  GithubGetJobLog,
  GithubGetPull,
  GithubGetRepo,
  GithubGetRun,
  GithubListChecks,
  GithubListJobs,
  GithubListPullFiles,
  GithubListPullReviews,
  GithubListPulls,
  GithubListRepos,
  GithubListRuns,
  GithubListWorkflows,
  githubReads,
  type GithubRead
} from "@patchy/api";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as DevDoor from "../DevDoor.js";
import { ConnectionNotDeclared } from "./Errors.js";

/** Each read's answer held to that read's wire before the patch sees it. */
const answers: {
  readonly [K in GithubRead]: (value: unknown) => Option.Option<typeof Schema.Json.Type>;
} = {
  listRepos: Schema.decodeUnknownOption(githubReads.listRepos.output),
  getRepo: Schema.decodeUnknownOption(githubReads.getRepo.output),
  listWorkflows: Schema.decodeUnknownOption(githubReads.listWorkflows.output),
  listRuns: Schema.decodeUnknownOption(githubReads.listRuns.output),
  getRun: Schema.decodeUnknownOption(githubReads.getRun.output),
  listJobs: Schema.decodeUnknownOption(githubReads.listJobs.output),
  getJobLog: Schema.decodeUnknownOption(githubReads.getJobLog.output),
  listChecks: Schema.decodeUnknownOption(githubReads.listChecks.output),
  listPulls: Schema.decodeUnknownOption(githubReads.listPulls.output),
  getPull: Schema.decodeUnknownOption(githubReads.getPull.output),
  listPullFiles: Schema.decodeUnknownOption(githubReads.listPullFiles.output),
  listPullReviews: Schema.decodeUnknownOption(githubReads.listPullReviews.output)
};

/** The twelve reads for `patchy dev`: the local manifest routes, the instance reads. */
export const handlers = Effect.fn("GithubDev.handlers")(function* (instance: DevDoor.Instance) {
  const http = yield* HttpClient.HttpClient;
  const read =
    <K extends GithubRead>(name: K) =>
    ({ connection: alias, ...args }: { readonly connection: string }) =>
      Effect.gen(function* () {
        const binding = yield* Binding.Binding;
        const declaration = binding.manifest.uses[alias];
        if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "github")
          return yield* new ConnectionNotDeclared({});
        return yield* DevDoor.read(
          instance,
          {
            op: `github.${name}`,
            connection: { id: declaration.id, handle: declaration.handle },
            args
          },
          answers[name]
        ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      });
  const handler = <I extends Schema.Top & Schema.Codec<unknown, unknown>>(
    input: I,
    run: (
      args: I["Type"]
    ) => Effect.Effect<typeof Schema.Json.Type, Runtime.RuntimeError, Binding.Binding>
  ) => Runtime.handler({ kind: "integration", input, output: Schema.Json }, run);
  return {
    "github.listRepos": handler(GithubListRepos, read("listRepos")),
    "github.getRepo": handler(GithubGetRepo, read("getRepo")),
    "github.listWorkflows": handler(GithubListWorkflows, read("listWorkflows")),
    "github.listRuns": handler(GithubListRuns, read("listRuns")),
    "github.getRun": handler(GithubGetRun, read("getRun")),
    "github.listJobs": handler(GithubListJobs, read("listJobs")),
    "github.getJobLog": handler(GithubGetJobLog, read("getJobLog")),
    "github.listChecks": handler(GithubListChecks, read("listChecks")),
    "github.listPulls": handler(GithubListPulls, read("listPulls")),
    "github.getPull": handler(GithubGetPull, read("getPull")),
    "github.listPullFiles": handler(GithubListPullFiles, read("listPullFiles")),
    "github.listPullReviews": handler(GithubListPullReviews, read("listPullReviews"))
  };
});
