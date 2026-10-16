import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type GuestProtocol } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { Limits, OperatingLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as AgentCalls from "./AgentCalls.js";
import * as Executor from "./Executor.js";
import * as Invocation from "./Invocation.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as MutationTransaction from "./MutationTransaction.js";
import * as QuerySnapshot from "./QuerySnapshot.js";
import * as Runtime from "./Runtime.js";
import * as ServerBundles from "./ServerBundles.js";
import { mutations, snapshot } from "./test/callbacks.js";

const viewer = {
  user: { id: DEV_SEED.userId, email: "dev@patchy.local", name: "Dev" },
  company: { id: DEV_SEED.companyId, name: "Patchy Dev", handle: "patchy-dev" },
  admin: false
};
const agent = { name: "Claude Code" };
const version: LoadedVersions.LoadedVersion = {
  patchId: "agentcalls01",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  companyId: DEV_SEED.companyId,
  wireVersion: WIRE_VERSION,
  scope: "company",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {},
    handlers: {
      "agent.addNote": {
        kind: "mutation",
        description: "Adds a note to the board.",
        args: { title: { kind: "text" } },
        result: { kind: "json" }
      },
      "agent.draft": { kind: "query", args: {}, result: { kind: "json" } },
      "notes.add": {
        kind: "mutation",
        description: "Adds a note from the page.",
        args: {},
        result: { kind: "json" }
      }
    }
  }
};
const bundle: GuestProtocol.Bundle = {
  companyId: version.companyId,
  patchId: version.patchId,
  versionId: version.versionId,
  sha256: "0".repeat(64),
  bundle: "recording-executor"
};
const bound: Executor.BoundVersion = {
  binding: {
    companyId: bundle.companyId,
    patchId: bundle.patchId,
    versionId: bundle.versionId,
    sha256: bundle.sha256
  },
  processGeneration: 1
};
/** Commits every write it is given; company storage and wakes have their own suites. */
const committing = MutationTransaction.MutationTransaction.of({
  ...mutations,
  open: () =>
    Effect.succeed({
      context: Context.empty(),
      uncertain: false,
      save: (_key, reply) => Effect.succeed(reply),
      commit: Effect.void,
      rollback: Effect.void,
      publish: Effect.void,
      destroy: () => {}
    })
});

const services = Layer.mergeAll(
  InvocationLog.layer,
  OperatingLimits.layer,
  Limits.layer,
  InvocationCapabilities.layer
).pipe(Layer.provideMerge(Testing.layer()));

/** Both doors over one runtime and one invocation, whose executor records each Invoke. */
const doors = Effect.gen(function* () {
  const invokes: Array<GuestProtocol.Invoke> = [];
  const invocations = yield* Invocation.make({ callbackUrl: "http://127.0.0.1:1/callback" }).pipe(
    Effect.provideService(QuerySnapshot.QuerySnapshot, { open: () => Effect.succeed(snapshot) }),
    Effect.provideService(MutationTransaction.MutationTransaction, committing),
    Effect.provideService(Executor.Executor, {
      bind: () => Effect.succeed(bound),
      invoke: (request) =>
        Effect.sync(() => {
          invokes.push(request);
          return {
            outcome: "returned" as const,
            reply: { ok: true as const, value: { saved: true } },
            guestMs: 1
          };
        })
    }),
    Effect.provideService(ServerBundles.ServerBundles, { load: () => Effect.succeed(bundle) })
  );
  const runtime = yield* Runtime.make(
    {},
    {
      origin: "http://localhost",
      bootstrapIdentity: Effect.fail(new Runtime.AccessDenied({})),
      identity: Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
    }
  ).pipe(Effect.provideService(Invocation.Invocation, invocations));
  const agents = yield* AgentCalls.make.pipe(
    Effect.provideService(Runtime.Runtime, runtime),
    Effect.provideService(Invocation.Invocation, invocations)
  );
  return { invokes, runtime, agents };
}).pipe(
  Effect.provideService(LoadedVersions.LoadedVersions, {
    find: () => Effect.succeed(Option.some({ ...version, patchTier: 2 }))
  })
);

it.layer(services)("AgentCalls", (it) => {
  it.effect("runs a described agent tool as the person and logs the agent beside them", () =>
    Effect.gen(function* () {
      const { invokes, agents } = yield* doors;
      const reply = yield* agents.call({
        identity: viewer,
        reauthorize: Effect.succeed(viewer),
        agent,
        patchId: version.patchId,
        handler: "agent.addNote",
        args: { title: "From the agent" }
      });
      assert.deepStrictEqual(reply, { ok: true, value: { saved: true } });
      const [request] = invokes;
      assert.deepStrictEqual(request?.agent, agent);
      assert.deepStrictEqual(request?.viewer, viewer);
      const row = yield* (yield* InvocationLog.InvocationLog).find({
        companyId: version.companyId,
        invocationId: request!.invocationId
      });
      assert.strictEqual(row?.initiatingViewerId, viewer.user.id);
      assert.strictEqual(row?.agentName, agent.name);
      assert.strictEqual(row?.outcome, "success");
    })
  );

  it.effect("refuses undescribed and non-agent handlers alike, before any code runs", () =>
    Effect.gen(function* () {
      const { invokes, agents } = yield* doors;
      for (const handler of ["agent.draft", "notes.add", "agent.missing"]) {
        const error = yield* agents
          .call({
            identity: viewer,
            reauthorize: Effect.succeed(viewer),
            agent,
            patchId: version.patchId,
            handler,
            args: {}
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, AgentCalls.UnknownTool);
      }
      assert.deepStrictEqual(invokes, []);
      assert.deepStrictEqual(
        AgentCalls.agentTools(version.manifest).map(({ name }) => name),
        ["addNote"]
      );
    })
  );

  it.effect("leaves the agent off a page's call and its log entry", () =>
    Effect.gen(function* () {
      const { invokes, runtime } = yield* doors;
      const reply = yield* runtime
        .call({
          patchId: version.patchId,
          versionId: version.versionId,
          wire: WIRE_VERSION,
          principal: { userId: viewer.user.id },
          op: "server.call",
          args: {
            handler: "agent.addNote",
            args: { title: "From the page" },
            mutationKey: yield* MutationTransaction.mint
          }
        })
        .pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/api/runtime/call", {
                method: "POST",
                headers: {
                  origin: "http://localhost",
                  "x-patchy-wire": String(WIRE_VERSION),
                  "x-patchy-principal": JSON.stringify({ userId: viewer.user.id })
                }
              })
            )
          )
        );
      assert.deepStrictEqual(reply, { ok: true, value: { saved: true } });
      const [request] = invokes;
      assert.isFalse(Object.hasOwn(request!, "agent"));
      const row = yield* (yield* InvocationLog.InvocationLog).find({
        companyId: version.companyId,
        invocationId: request!.invocationId
      });
      assert.strictEqual(row?.outcome, "success");
      assert.strictEqual(row?.agentName, null);
    })
  );
});
