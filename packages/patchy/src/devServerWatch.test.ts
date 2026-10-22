// @effect-diagnostics nodeBuiltinImport:off -- Deep comparison distinguishes repeated watcher results from new observed transitions.
import { isDeepStrictEqual } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { watch } from "./devServerWatch.js";
import * as DirectoryWatch from "./DirectoryWatch.js";
import toolchain from "./toolchain.json" with { type: "json" };
import * as Inspection from "@patchy/execution/inspection";
import { buildServer } from "./serverBuild.js";

const handler = (kind: "text" | "number" | "boolean") => `
import { query, t } from "patchy/server";
export const read = query({
  args: {}, result: t.${kind}(),
  handler: () => ${kind === "text" ? '"ready"' : kind === "number" ? "42" : "true"}
});
`;

const repo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    directory: process.cwd(),
    prefix: ".server-watch-test-"
  });
  yield* fs.writeFileString(path.join(root, "package.json"), '{"type":"module"}');
  yield* fs.makeDirectory(path.join(root, "node_modules"));
  yield* fs.symlink(
    path.join(process.cwd(), "packages/patchy"),
    path.join(root, "node_modules/patchy")
  );
  yield* fs.symlink(
    path.join(process.cwd(), "packages/patchy/node_modules/vite"),
    path.join(root, "node_modules/vite")
  );
  return { root, fs, path };
});

// Rename complete saves into place, rather than testing a truncate followed by a write.
const save = Effect.fnUntraced(function* (file: string, source: string) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${file}.tmp`;
  yield* fs.writeFileString(temporary, source);
  yield* fs.rename(temporary, file);
});

const inspectedChanges = Effect.fn("test.inspectedChanges")(function* (root: string) {
  const next = yield* watch(root, toolchain, []);
  const observed = next.pipe(
    Effect.flatMap(({ inspect, ...build }) =>
      inspect.pipe(Effect.map((handlers) => ({ ...build, handlers })))
    ),
    Effect.result
  );
  let previous: Effect.Success<typeof observed> | undefined;
  return Effect.gen(function* () {
    while (true) {
      const current = yield* observed;
      // A save can cause several Vite rebuilds. Assert each distinct result, not
      // one queue entry per save; unexpected new bundles or errors still fail.
      if (isDeepStrictEqual(current, previous)) continue;
      previous = current;
      return yield* Effect.fromResult(current);
    }
  });
});

/** Watches that report only what a case emits; `start` runs as each one starts, to fail or hold it. */
const scriptedWatches = (
  start: (
    directory: string
  ) => Effect.Effect<void, DirectoryWatch.DirectoryGone | DirectoryWatch.WatchFailed> = () =>
    Effect.void
) => {
  const started: Array<{
    readonly directory: string;
    readonly listener: Parameters<DirectoryWatch.DirectoryWatch["Service"]["watch"]>[1];
    open: boolean;
  }> = [];
  const service: DirectoryWatch.DirectoryWatch["Service"] = {
    watch: (directory, listener) =>
      Effect.acquireRelease(
        start(directory).pipe(
          Effect.map(() => {
            const watch = { directory, listener, open: true };
            started.push(watch);
            return watch;
          })
        ),
        (watch) =>
          Effect.sync(() => {
            watch.open = false;
          })
      ).pipe(Effect.asVoid)
  };
  /** Every watch started on `directory`, oldest first. */
  const of = (directory: string) => started.filter((watch) => watch.directory === directory);
  return { service, of };
};

const leadsRepo = Effect.gen(function* () {
  const { root, fs, path } = yield* repo;
  const server = path.join(root, "server");
  yield* fs.makeDirectory(server);
  yield* fs.writeFileString(path.join(server, "leads.ts"), handler("text"));
  return { root, server, fs, path };
});

it.live(
  "re-discovers added and removed modules, edits descriptors, and ignores page changes",
  () =>
    Effect.gen(function* () {
      const { root, fs, path } = yield* repo;
      const next = yield* inspectedChanges(root);
      assert.deepStrictEqual((yield* next).handlers, {});

      yield* fs.makeDirectory(path.join(root, "server"));
      yield* save(path.join(root, "server/leads.ts"), handler("text"));
      const added = yield* next;
      assert.deepStrictEqual(added.modules, ["leads"]);
      assert.deepStrictEqual(added.handlers, {
        "leads.read": { kind: "query", args: {}, result: { kind: "text" } }
      });

      yield* save(path.join(root, "server/leads.ts"), handler("number"));
      assert.deepStrictEqual((yield* next).handlers["leads.read"]?.result, { kind: "number" });

      yield* save(path.join(root, "server/people.ts"), handler("boolean"));
      assert.deepStrictEqual(Object.keys((yield* next).handlers), ["leads.read", "people.read"]);
      yield* fs.remove(path.join(root, "server/leads.ts"));
      assert.deepStrictEqual((yield* next).handlers, {
        "people.read": { kind: "query", args: {}, result: { kind: "boolean" } }
      });

      yield* fs.makeDirectory(path.join(root, "src"));
      yield* fs.writeFileString(path.join(root, "src/main.ts"), 'console.log("page-only edit");');
      assert.isTrue(Option.isNone(yield* next.pipe(Effect.timeoutOption("150 millis"))));

      yield* fs.remove(path.join(root, "server"), { recursive: true });
      assert.deepStrictEqual((yield* next).handlers, {});
      yield* fs.makeDirectory(path.join(root, "server"));
      yield* save(path.join(root, "server/leads.ts"), handler("text"));
      assert.deepStrictEqual((yield* next).handlers, added.handlers);
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, DirectoryWatch.layer])),
  30_000
);

it.live(
  "re-watches a server directory that vanished while watched and ignores the old watch",
  () =>
    Effect.gen(function* () {
      const { root, server, fs, path } = yield* leadsRepo;
      const watches = scriptedWatches();
      const next = yield* inspectedChanges(root).pipe(
        Effect.provideService(DirectoryWatch.DirectoryWatch, watches.service)
      );
      assert.deepStrictEqual((yield* next).modules, ["leads"]);
      const [old] = watches.of(server);

      yield* fs.writeFileString(path.join(server, "people.ts"), handler("boolean"));
      old!.listener.error(new DirectoryWatch.DirectoryGone({ directory: server, cause: "test" }));
      assert.deepStrictEqual((yield* next).modules, ["leads", "people"]);
      const [, current] = watches.of(server);
      assert.deepStrictEqual([old!.open, current!.open], [false, true]);

      const fatal = new DirectoryWatch.WatchFailed({ directory: server, cause: "test" });
      old!.listener.error(new DirectoryWatch.WatchFailed({ directory: server, cause: "test" }));
      current!.listener.error(fatal);
      const error = yield* next.pipe(Effect.flip);
      assert.strictEqual(error.message, "Could not watch server source files.");
      assert.strictEqual(error.cause, fatal);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000
);

it.live(
  "treats a server directory gone before its watch starts as absent until the root reports it",
  () =>
    Effect.gen(function* () {
      const { root, server, fs, path } = yield* leadsRepo;
      let gone = true;
      const watches = scriptedWatches((directory) => {
        if (directory !== server || !gone) return Effect.void;
        gone = false;
        return Effect.fail(new DirectoryWatch.DirectoryGone({ directory: server, cause: "test" }));
      });
      const next = yield* inspectedChanges(root).pipe(
        Effect.provideService(DirectoryWatch.DirectoryWatch, watches.service)
      );
      assert.deepStrictEqual((yield* next).modules, ["leads"]);
      assert.lengthOf(watches.of(server), 0);

      yield* fs.writeFileString(path.join(server, "people.ts"), handler("boolean"));
      watches.of(root)[0]!.listener.change("server");
      assert.deepStrictEqual((yield* next).modules, ["leads", "people"]);
      assert.lengthOf(watches.of(server), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000
);

it.live(
  "keeps a server directory replacement reported while its watch starts",
  () =>
    Effect.gen(function* () {
      const { root, server } = yield* leadsRepo;
      const starting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Hold the first server/ watch until the root has reported a replacement.
      const watches = scriptedWatches((directory) =>
        directory === server
          ? Effect.gen(function* () {
              if (yield* Deferred.succeed(starting, undefined)) yield* Deferred.await(release);
            })
          : Effect.void
      );
      const next = yield* inspectedChanges(root).pipe(
        Effect.provideService(DirectoryWatch.DirectoryWatch, watches.service)
      );
      const first = yield* Effect.forkChild(next);
      yield* Deferred.await(starting);
      watches.of(root)[0]!.listener.change("server");
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual((yield* Fiber.join(first)).modules, ["leads"]);
      assert.deepStrictEqual(
        watches.of(server).map((watch) => watch.open),
        [false, true]
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000
);

it.live(
  "folds agent/ files into agent tools with no refresh, and refuses a name two files export",
  () =>
    Effect.gen(function* () {
      const { root, fs, path } = yield* leadsRepo;
      const next = yield* inspectedChanges(root);
      assert.deepStrictEqual(Object.keys((yield* next).handlers), ["leads.read"]);

      // The page's handler re-exported for agents, and a tool of its own in another file.
      yield* fs.makeDirectory(path.join(root, "agent"));
      yield* save(path.join(root, "agent/leads.ts"), 'export { read } from "../server/leads.js";');
      yield* save(
        path.join(root, "agent/intake.ts"),
        handler("number").replace("export const read", "export const count")
      );
      let built = yield* next;
      while (built.agentFiles.length < 2) built = yield* next;
      assert.deepStrictEqual(built.agentFiles, ["intake", "leads"]);
      assert.deepStrictEqual(built.handlers, {
        "leads.read": { kind: "query", args: {}, result: { kind: "text" } },
        "agent.count": { kind: "query", args: {}, result: { kind: "number" }, agentTool: true },
        "agent.read": { kind: "query", args: {}, result: { kind: "text" }, agentTool: true }
      });

      // A second file exporting read by name: the build names both files.
      const twice = path.join(root, "agent/more.ts");
      yield* save(twice, 'export { read } from "../server/leads.js";');
      const refusal = {
        code: "invalid_manifest",
        message:
          "read is exported by agent/leads.ts and agent/more.ts; each tool needs its own name."
      };
      assert.deepInclude(yield* next.pipe(Effect.flip), refusal);
      // Publish builds through the same check.
      const publishBuild = Effect.tryPromise({
        try: () => buildServer(root, ["leads"], ["intake", "leads", "more"], toolchain, []),
        catch: (cause) => cause
      });
      assert.deepInclude(yield* publishBuild.pipe(Effect.flip), refusal);
      // One only `export *` gives is left to the guest, which refuses the bundle as it loads.
      yield* save(twice, 'export * from "../server/leads.js";');
      assert.strictEqual((yield* next.pipe(Effect.flip)).code, "invalid_manifest");
      yield* fs.remove(twice);
      assert.deepStrictEqual((yield* next).handlers, built.handlers);

      // A tool's refusals name its own file under agent/.
      const intake = path.join(root, "agent/intake.ts");
      const own = yield* fs.readFileString(intake);
      yield* save(intake, own.replace("args: {}", 'description: " ", args: {}'));
      assert.deepInclude(yield* next.pipe(Effect.flip), {
        code: "invalid_manifest",
        message:
          "agent/intake.ts: agent.count's description is blank. Say what it does, or leave the description out. The last successful binding stays served."
      });
      yield* save(intake, own);
      assert.deepStrictEqual((yield* next).handlers, built.handlers);
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, DirectoryWatch.layer])),
  30_000
);

it.live(
  "keeps a file named __proto__, and never refuses a name that only export * gives",
  () =>
    Effect.gen(function* () {
      const { root, fs, path } = yield* repo;
      yield* fs.makeDirectory(path.join(root, "agent"));
      yield* fs.makeDirectory(path.join(root, "helpers"));
      // two.ts stars one.ts but has its own read, and more.ts stars both. The two reads are
      // different bindings, so ES modules leave read out of more.ts's namespace, and leads.ts's
      // read is the only one; the build must not take it for a duplicate.
      yield* fs.writeFileString(path.join(root, "helpers/one.ts"), handler("text"));
      yield* fs.writeFileString(
        path.join(root, "helpers/two.ts"),
        'export * from "./one.js";\n' + handler("number")
      );
      yield* fs.writeFileString(
        path.join(root, "agent/more.ts"),
        'export * from "../helpers/two.js";\nexport * from "../helpers/one.js";'
      );
      yield* fs.writeFileString(path.join(root, "agent/leads.ts"), handler("boolean"));
      yield* fs.writeFileString(
        path.join(root, "agent/__proto__.ts"),
        handler("text").replace("export const read", "export const count")
      );
      const built = yield* Effect.tryPromise(() =>
        buildServer(root, [], ["__proto__", "leads", "more"], toolchain, [])
      );
      assert.deepStrictEqual(built.agentTools, { count: "__proto__", read: "leads" });

      assert.deepStrictEqual(yield* Inspection.inspect(built.server), {
        "agent.count": { kind: "query", args: {}, result: { kind: "text" }, agentTool: true },
        "agent.read": { kind: "query", args: {}, result: { kind: "boolean" }, agentTool: true }
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000
);

it.live(
  "recovers after import refusals, failed builds, invalid handler exports and descriptions",
  () =>
    Effect.gen(function* () {
      const { root, fs, path } = yield* repo;
      const source = path.join(root, "server/leads.ts");
      yield* fs.makeDirectory(path.join(root, "server"));
      yield* fs.writeFileString(source, handler("text"));
      const next = yield* inspectedChanges(root);
      const initial = yield* next;

      yield* save(source, 'import "node:fs";\n' + handler("text"));
      assert.strictEqual((yield* next.pipe(Effect.flip)).code, "import_refused");
      yield* save(source, handler("number"));
      assert.deepStrictEqual((yield* next).handlers["leads.read"]?.result, { kind: "number" });

      yield* save(source, "export const read = {");
      assert.strictEqual((yield* next.pipe(Effect.flip))._tag, "LocalError");
      yield* save(source, handler("boolean"));
      assert.deepStrictEqual((yield* next).handlers["leads.read"]?.result, { kind: "boolean" });

      yield* save(source, "export const read = 42;");
      assert.strictEqual((yield* next.pipe(Effect.flip)).code, "invalid_manifest");
      yield* save(
        source,
        handler("text").replace("t.text()", `t.text().describe("${"x".repeat(2_001)}")`)
      );
      assert.deepInclude(yield* next.pipe(Effect.flip), {
        code: "invalid_manifest",
        message:
          "server/leads.ts: leads.read's description of result is 2,001 characters; descriptions are at most 2,000. Shorten it. The last successful binding stays served."
      });
      yield* save(source, handler("text"));
      assert.deepStrictEqual((yield* next).handlers, initial.handlers);
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, DirectoryWatch.layer])),
  30_000
);

it.live(
  "rebuilds when an imported company source outside server changes",
  () =>
    Effect.gen(function* () {
      const { root, fs, path } = yield* repo;
      yield* fs.makeDirectory(path.join(root, "server"));
      yield* fs.makeDirectory(path.join(root, "shared"));
      const dependency = path.join(root, "shared/result.ts");
      yield* fs.writeFileString(
        dependency,
        'import { t } from "patchy/server"; export const result = t.text();'
      );
      yield* fs.writeFileString(
        path.join(root, "server/leads.ts"),
        `
import { query } from "patchy/server";
import { result } from "../shared/result.js";
export const read = query({ args: {}, result, handler: () => "ready" });
`
      );
      const next = yield* inspectedChanges(root);
      assert.deepStrictEqual((yield* next).handlers["leads.read"]?.result, { kind: "text" });
      yield* save(
        dependency,
        'import { t } from "patchy/server"; export const result = t.number();'
      );
      assert.deepStrictEqual((yield* next).handlers["leads.read"]?.result, { kind: "number" });
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, DirectoryWatch.layer])),
  30_000
);

it.live(
  "refuses computed imports retained in bundled SDK code and recovers after repair",
  () =>
    Effect.gen(function* () {
      const { root, fs, path } = yield* repo;
      const sdk = path.join(root, "node_modules/patchy");
      const original = yield* fs.readFileString(path.join(sdk, "dist/server.js"));
      const packageJson = yield* fs.readFileString(path.join(sdk, "package.json"));
      yield* fs.remove(sdk);
      yield* fs.makeDirectory(path.join(sdk, "dist"), { recursive: true });
      yield* fs.writeFileString(path.join(sdk, "package.json"), packageJson);
      yield* fs.writeFileString(
        path.join(sdk, "dist/server.js"),
        original + "\nexport const optionalModule = (name) => import(name);"
      );
      yield* fs.makeDirectory(path.join(root, "server"));
      yield* fs.writeFileString(
        path.join(root, "server/leads.ts"),
        `
import { query, t, optionalModule } from "patchy/server";
export const read = query({ args: {}, result: t.json(), handler: () => optionalModule("missing") });
`
      );
      const build = Effect.tryPromise({
        try: () => buildServer(root, ["leads"], [], toolchain, []),
        catch: (cause) => cause
      });
      assert.deepInclude(yield* build.pipe(Effect.flip), { code: "invalid_manifest" });
      yield* fs.writeFileString(
        path.join(sdk, "dist/server.js"),
        original + "\nexport const optionalModule = (name) => ({ import: name });"
      );
      const next = yield* inspectedChanges(root);
      assert.deepStrictEqual((yield* next).handlers["leads.read"], {
        kind: "query",
        args: {},
        result: { kind: "json" }
      });
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, DirectoryWatch.layer])),
  30_000
);
