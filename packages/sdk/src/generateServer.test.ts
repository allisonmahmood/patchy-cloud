import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { generateClient } from "./generateClient.js";
import { generateServer } from "./generateServer.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));

it("compiles generated bound helpers and rejects page calls after a server export rename", async () => {
  await mkdir(path.join(root, ".local"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".local/server-types-"));
  try {
    await mkdir(path.join(directory, "node_modules"));
    await symlink(path.join(root, "packages/patchy"), path.join(directory, "node_modules/patchy"));
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
      `import { defineConfig, table, t } from "patchy/config";
export default defineConfig({name:"contract-test",tier:2,tables:{leads:table("Leads",{name:t.text()})}});
`
    );
    await writeFile(
      path.join(directory, "patchy/_generated/server.ts"),
      generateServer({ modules: ["leads"] })
    );
    await writeFile(
      path.join(directory, "patchy/_generated/client.ts"),
      generateClient({ tier: 2 })
    );
    const handlers = `import { query, mutation, action, t } from "../patchy/_generated/server.js";
import type { QueryContext } from "../patchy/_generated/server.js";
async function first(ctx: QueryContext) { return (await ctx.tables.leads.list()).rows[0]?.name ?? "none"; }
export const find = query({args:{},result:t.text(),errors:["missing"],handler:async(ctx) => first(ctx)});
export const create = mutation({args:{name:t.text()},result:t.row("leads"),handler:async(ctx,args)=>ctx.tables.leads.insert(args)});
export const importRows = action({args:{name:t.text()},result:t.text(),handler:async(ctx,args)=>{await ctx.run.leads.create(args);return ctx.run.leads.find({});}});
`;
    await writeFile(path.join(directory, "server/leads.ts"), handlers);
    await writeFile(
      path.join(directory, "page.ts"),
      `import patchy, {isHandlerError} from "./patchy/_generated/client.js";
const name: Promise<string> = patchy.server.leads.find({});
patchy.server.leads.create({name:"Ada"});
try { await name; } catch(error) { if(isHandlerError(error,"missing")) { const code:"missing" = error.code; void code; } }
// @ts-expect-error only declared business error codes are accepted
isHandlerError(new Error(),"not_declared");
// @ts-expect-error tier 2 has no direct table client
patchy.tables.leads.list();
// @ts-expect-error mutations cannot subscribe
patchy.server.leads.create.subscribe({name:"Ada"},()=>{});
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
      (await readFile(path.join(directory, "page.ts"), "utf8")).replace(
        "patchy.server.leads.find",
        "patchy.server.leads.renamed"
      )
    );
    await compile();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
