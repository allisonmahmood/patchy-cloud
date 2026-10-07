import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { CURRENT_RELEASE, GenerateRequest, MANIFEST_VERSION } from "@patchy/api";
import { Analytics } from "@patchy/analytics";
import { Looks } from "@patchy/companies";
import { Patches } from "@patchy/patches";
import { CompanyDatabases } from "@patchy/company-database";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vitest";
import * as Fixtures from "../../patches/src/test/fixtures.js";
import * as Generation from "./Generation.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const decodeGenerate = Schema.decodeUnknownSync(GenerateRequest);
const generationLayer = Layer.mergeAll(Patches.layer, Looks.layer).pipe(
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provideMerge(Fixtures.database),
  Layer.provideMerge(NodeFileSystem.layer)
);

it.effect(
  "generates callable page and ctx.run types from module names without descriptors",
  () =>
    Effect.gen(function* () {
      const identity = Fixtures.identities.uploader;
      yield* (yield* CompanyDatabases.CompanyDatabases).ensureReady(identity.company.id);
      yield* Fixtures.record(
        Fixtures.recordInput(identity, {
          manifest: {
            ...Fixtures.manifest,
            name: "sdk-store-types",
            files: { assets: { description: "Company assets keyed by filename.", shared: true } }
          },
          patchId: "sdkstoretype",
          title: "Shared store type source"
        })
      );
      const generated = yield* Generation.generate(
        Fixtures.identities.uploader.company.id,
        decodeGenerate({
          release: CURRENT_RELEASE,
          manifest: {
            manifestVersion: MANIFEST_VERSION,
            release: CURRENT_RELEASE,
            tier: 2,
            tables: {},
            files: {},
            uses: { assets: { kind: "sharedStore", patchId: "sdkstoretype", store: "assets" } }
          },
          skills: [],
          serverModules: ["leads"]
        })
      );
      yield* Effect.promise(async () => {
        await mkdir(path.join(root, ".local"), { recursive: true });
        const directory = await mkdtemp(path.join(root, ".local/server-types-"));
        try {
          await mkdir(path.join(directory, "node_modules"));
          await symlink(
            path.join(root, "packages/patchy"),
            path.join(directory, "node_modules/patchy")
          );
          await mkdir(path.join(directory, "server"));
          await mkdir(path.join(directory, "patchy/_generated"), { recursive: true });
          await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
          await writeFile(
            path.join(directory, "tsconfig.json"),
            JSON.stringify({
              compilerOptions: {
                target: "ES2022",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                strict: true,
                noEmit: true,
                skipLibCheck: true
              }
            })
          );
          await writeFile(
            path.join(directory, "patchy.config.ts"),
            `import { defineConfig, sharedStore, table, t } from "patchy/config";
export default defineConfig({name:"contract-test",tier:2,tables:{leads:table("Leads",{name:t.text()})},uses:{assets:sharedStore("sdkstoretype","assets")}});
`
          );
          for (const file of generated.files.filter((file) => file.path.endsWith(".ts"))) {
            await mkdir(path.dirname(path.join(directory, file.path)), { recursive: true });
            await writeFile(path.join(directory, file.path), file.contents);
          }
          const handlers = `import { query, mutation, action, t } from "../patchy/_generated/server.js";
import type { QueryContext } from "../patchy/_generated/server.js";
async function first(ctx: QueryContext) { return (await ctx.tables.leads.list({limit:20})).rows[0]?.name ?? "none"; }
export const find = query({args:{},result:t.text(),errors:["missing"],handler:async(ctx) => {
  await ctx.shared.assets.list({prefix:"logos/"});
  await ctx.shared.assets.stat("logos/company.svg");
  // @ts-expect-error queries cannot read shared bytes
  await ctx.shared.assets.get("logos/company.svg");
  return first(ctx);
}});
export const create = mutation({args:{name:t.text()},result:t.row("leads"),handler:async(ctx,args)=>{
  // @ts-expect-error mutations cannot read shared stores
  await ctx.shared.assets.list();
  return ctx.tables.leads.insert(args);
}});
export const importRows = action({args:{name:t.text()},result:t.text(),handler:async(ctx,args)=>{
  const bytes: Uint8Array = await ctx.shared.assets.get("logos/company.svg");
  await ctx.shared.assets.stat("logos/company.svg");
  // @ts-expect-error shared stores have no writes
  await ctx.shared.assets.put("logos/company.svg",bytes);
  // @ts-expect-error shared stores have no delete
  await ctx.shared.assets.delete("logos/company.svg");
  await ctx.run.leads.create(args);
  return ctx.run.leads.find({});
}});
`;
          await writeFile(path.join(directory, "server/leads.ts"), handlers);
          await writeFile(
            path.join(directory, "page.ts"),
            `import patchy, {isHandlerError} from "./patchy/_generated/client.js";
import {useQuery} from "patchy/preact";
const name: Promise<string> = patchy.server.leads.find({});
patchy.server.leads.create({name:"Ada"});
const unsubscribe: () => void = patchy.server.leads.find.subscribe({}, snapshot => {
  const latest: string | undefined = snapshot.data;
  const error: Error | undefined = snapshot.error;
  const loading: boolean = snapshot.loading;
  void latest; void error; void loading;
});
unsubscribe();
function Screen() {
  const snapshot = useQuery(patchy.server.leads.find, {});
  const latest: string | undefined = snapshot.data;
  // @ts-expect-error mutations cannot be query hooks
  useQuery(patchy.server.leads.create, {name:"Ada"});
  // @ts-expect-error actions cannot be query hooks
  useQuery(patchy.server.leads.importRows, {name:"Ada"});
  return latest;
}
void Screen;
try { await name; } catch(error) { if(isHandlerError(error,"missing")) { const code:"missing" = error.code; void code; } }
// @ts-expect-error only declared business error codes are accepted
isHandlerError(new Error(),"not_declared");
// @ts-expect-error tier 2 has no direct table client
patchy.tables.leads.list();
// @ts-expect-error tier 2 has no direct shared store client
patchy.shared.assets.list();
// @ts-expect-error mutations cannot subscribe
patchy.server.leads.create.subscribe({name:"Ada"},()=>{});
// @ts-expect-error actions cannot subscribe
patchy.server.leads.importRows.subscribe({name:"Ada"},()=>{});
`
          );
          const compile = () =>
            exec(
              process.execPath,
              [path.join(root, "node_modules/typescript/bin/tsc"), "-p", directory],
              { cwd: directory }
            );
          await compile().catch((error: unknown) => {
            throw new Error(
              error instanceof Error && "stdout" in error
                ? String(error.stdout)
                : "Type compilation failed",
              { cause: error }
            );
          });
          await writeFile(
            path.join(directory, "server/leads.ts"),
            handlers
              .replace("export const find", "export const renamed")
              .replace("ctx.run.leads.find", "ctx.run.leads.renamed")
          );
          await expect(compile()).rejects.toMatchObject({
            stdout: expect.stringContaining("Property 'find' does not exist")
          });
          await writeFile(
            path.join(directory, "page.ts"),
            (await readFile(path.join(directory, "page.ts"), "utf8")).replaceAll(
              "patchy.server.leads.find",
              "patchy.server.leads.renamed"
            )
          );
          await compile();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }).pipe(Effect.provide(generationLayer)),
  { timeout: 60_000 }
);
