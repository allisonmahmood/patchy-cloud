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
import * as PlatformError from "effect/PlatformError";
import { watch } from "./devServerWatch.js";
import * as DirectoryWatch from "./DirectoryWatch.js";
import toolchain from "./toolchain.json" with { type: "json" };
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

const failure = (_tag: "NotFound" | "Unknown", directory: string) =>
  PlatformError.systemError({ _tag, module: "test", method: "watch", pathOrDescriptor: directory });

/** Watches that report only what a case emits; `start` runs as each one starts, to fail or hold it. */
const scriptedWatches = (
  start: (directory: string) => Effect.Effect<void, PlatformError.PlatformError> = () => Effect.void
) => {
  const started: Array<{
    readonly directory: string;
    readonly listener: Parameters<DirectoryWatch.DirectoryWatch["Service"]["watch"]>[2];
    open: boolean;
  }> = [];
  const service: DirectoryWatch.DirectoryWatch["Service"] = {
    watch: (directory, _options, listener) =>
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

      // Node 22 reports a server/ deleted during its rescan as a watch error.
      yield* fs.writeFileString(path.join(server, "people.ts"), handler("boolean"));
      old!.listener.error(failure("NotFound", server));
      assert.deepStrictEqual((yield* next).modules, ["leads", "people"]);
      const [, current] = watches.of(server);
      assert.deepStrictEqual([old!.open, current!.open], [false, true]);

      const fatal = failure("Unknown", server);
      old!.listener.error(failure("Unknown", server));
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
        return Effect.fail(failure("NotFound", server));
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
  "recovers after import refusals, failed builds, and invalid handler exports",
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
        try: () => buildServer(root, ["leads"], toolchain, []),
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
