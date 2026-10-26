import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { build } from "esbuild";
import { CURRENT_RELEASE, Identity, agentTools, openPatchAnswer, toolAnswer } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as Inspection from "@patchy/execution/inspection";
import { Wakes } from "@patchy/runtime/core";
import type { Invocation } from "@patchy/runtime/dev";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as DevAgent from "./devAgent.js";
import { colleague } from "./devMembers.js";
import type { Prepared } from "./devPreparation.js";
import * as DevResources from "./devResources.js";
import type { AgentRequest } from "./devState.js";

const identity = new Identity({
  user: { id: "usr_dev", name: "Builder", email: "dev@patchy.local" },
  company: { id: "cmp_dev", name: "Dev", handle: "dev" },
  role: "admin",
  machine: { id: "machine_dev", name: "Dev machine" }
});
const viewer = { person: { user: identity.user, company: identity.company, admin: true } };
const peer = { person: { user: colleague, company: identity.company, admin: false } };
const prepared: Prepared = {
  patchId: "localdev0000",
  identity,
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    name: "notes",
    description: "Team notes.",
    tier: 2,
    tables: {
      notes: { description: "Notes", columns: { title: { kind: "text" } }, indexes: {} }
    },
    files: {},
    uses: {}
  },
  metadata: { postgres: {}, posthog: {}, pidgeon: {}, shared: {} }
};
const patch = { name: "notes", description: "Team notes.", owner: "Builder" };

// The page lists notes; agents read them, add one and meet a failing action.
const server = Effect.gen(function* () {
  const source = (yield* Effect.promise(() =>
    build({
      stdin: {
        resolveDir: new URL("..", import.meta.url).pathname,
        sourcefile: "dev-agent-fixture.ts",
        contents: `import { query, mutation, action, createGuest, t, HandlerError } from "patchy/server";
const list = query({args:{},result:t.array(t.text()),handler:async ctx => (await ctx.tables.notes.list()).rows.map(row => row.title)});
const notes = query({description:"Every note's title, and who asked.",args:{},result:t.json(),handler:async ctx => ({viewer:ctx.viewer.user.id, agent:ctx.agent, titles:(await ctx.tables.notes.list()).rows.map(row => row.title).sort()})});
const addNote = mutation({description:"Adds a note. Refuses a blank title.",args:{title:t.text().describe("The note's title")},result:t.json(),errors:["blank"],handler:async (ctx,args) => {
  if (args.title.trim() === "") throw new HandlerError("blank", {message:"give the note a title"});
  await ctx.tables.notes.insert({title:args.title});
  return {viewer:ctx.viewer.user.id, agent:ctx.agent};
}});
const broken = action({description:"Always fails.",args:{},result:t.text(),handler:async () => { throw new Error("dev agent failure"); }});
const dump = query({description:"Every note, at length.",args:{},result:t.text(),handler:async () => "x".repeat(100000)});
export default createGuest({notes:{list}}, [], {tools:{notes, addNote, broken, dump}});`
      },
      alias: { "patchy/server": new URL("./server.ts", import.meta.url).pathname },
      external: ["./executeConfig.js"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2022",
      conditions: ["development"]
    })
  )).outputFiles[0]!.text;
  return { bytes: new TextEncoder().encode(source), handlers: yield* Inspection.inspect(source) };
});

it.live(
  "answers open_patch and calls tools as each dev person, waking open pages, with the door's refusals",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-dev-agent-" });
      const settlements: Invocation.DevSettlement[] = [];
      const resources = yield* DevResources.prepare(prepared, root, `${root}/.patchy/dev`, {
        instance: { apiUrl: "http://127.0.0.1:1", token: Option.none() },
        server: yield* server,
        observe: (settlement) =>
          Effect.sync(() => {
            settlements.push(settlement);
          })
      });
      const dev: DevAgent.Dev = {
        binding: () => ({
          version: resources.version,
          build: resources.build,
          rebuildFailed: false
        }),
        patch
      };
      const ask = (mount: typeof viewer, request: AgentRequest) =>
        DevAgent.answer(dev, { ...mount, address: "http://127.0.0.1:4000/dev/x" }, request).pipe(
          Effect.provideContext(resources.context)
        );
      const call = (mount: typeof viewer, tool: string, args: Record<string, string> = {}) =>
        ask(mount, { call: { tool, args } }).pipe(
          Effect.map((reply) => {
            assert.isTrue(reply.ok);
            return reply.ok ? reply.answer : undefined;
          })
        );

      assert.deepStrictEqual(yield* ask(viewer, {}), {
        ok: true,
        person: "Builder",
        build: 1,
        rebuildFailed: false,
        answer: toolAnswer(
          openPatchAnswer(
            { ...patch, address: "http://127.0.0.1:4000/dev/x" },
            agentTools(resources.version.manifest)
          )
        )
      });

      // Open pages re-run their queries on the wakes a write publishes, an agent's as a page's.
      const wakes = yield* Queue.unbounded<readonly string[]>();
      yield* Context.get(resources.context, Wakes.Wakes).subscribe((keys) =>
        Queue.offer(wakes, keys)
      );
      const agent = { name: "patchy dev" };
      for (const [mount, title] of [
        [viewer, "From the viewer's agent"],
        [peer, "From the colleague's agent"]
      ] as const) {
        assert.deepStrictEqual((yield* call(mount, "addNote", { title }))?.structuredContent, {
          result: { viewer: mount.person.user.id, agent },
          version: 1
        });
        assert.deepStrictEqual(yield* Queue.take(wakes), [`table:${prepared.patchId}:notes`]);
      }
      assert.deepStrictEqual((yield* call(peer, "notes"))?.structuredContent, {
        result: {
          viewer: colleague.id,
          agent,
          titles: ["From the colleague's agent", "From the viewer's agent"]
        },
        version: 1
      });
      assert.deepInclude(
        settlements.find(
          (entry) => entry.handler === "agent.addNote" && entry.initiatingViewerId === colleague.id
        )!,
        { agent, outcome: "success" }
      );

      const refused = (tool: string, args?: Record<string, string>) =>
        call(viewer, tool, args).pipe(
          Effect.map((answer) => {
            assert.strictEqual(answer?.isError, true);
            return answer?.structuredContent["error"];
          })
        );
      assert.deepStrictEqual(yield* refused("addNote", { title: " " }), {
        code: "blank",
        from: "patch",
        message: "notes refused addNote (blank): give the note a title.",
        details: { message: "give the note a title" }
      });
      assert.deepStrictEqual(yield* refused("addNote"), {
        code: "invalid_args",
        from: "patchy",
        message:
          "addNote's arguments don't fit its schema: Missing key at [\"title\"]. Its tools now: addNote, broken, dump, notes. Call open_patch to see what each does and takes."
      });
      // The page's own handler is not a tool.
      assert.deepStrictEqual(yield* refused("list"), {
        code: "unknown_tool",
        from: "patchy",
        message:
          "notes has no tool list. Its tools now: addNote, broken, dump, notes. Call open_patch to see what each does and takes."
      });
      assert.include(yield* refused("broken"), { code: "handler_failed", from: "patchy" });
      // A read longer than an agent reads in one answer is refused, as the door refuses it.
      assert.deepStrictEqual(yield* refused("dump"), {
        code: "too_large",
        from: "patchy",
        message:
          "notes's dump answered with 100,025 characters, more than the 100,000 an agent reads in one answer, so nothing was sent. Narrow the call; the patch's owner, Builder, can add paging."
      });

      // Below tier 2 there is nothing to call through; a tier 2 patch may have no tools yet.
      const noTools = yield* DevAgent.answer(
        {
          ...dev,
          binding: () => ({
            version: {
              ...resources.version,
              manifest: {
                ...resources.version.manifest,
                handlers: { "notes.list": resources.version.manifest.handlers!["notes.list"]! }
              }
            },
            build: 1,
            rebuildFailed: false
          })
        },
        { ...viewer, address: "" },
        {}
      ).pipe(Effect.provideContext(resources.context));
      assert.include(noTools, { ok: false, code: "no_agent_tools" });
      const tierOne = yield* DevAgent.answer(
        {
          ...dev,
          binding: () => ({
            version: { ...resources.version, manifest: { ...prepared.manifest, tier: 1 } },
            build: 0,
            rebuildFailed: false
          })
        },
        { ...viewer, address: "" },
        {}
      );
      assert.include(tierOne, { ok: false, code: "no_agent_tools" });
      if (!tierOne.ok) assert.match(tierOne.error, /tier 1/);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 60_000 }
);
