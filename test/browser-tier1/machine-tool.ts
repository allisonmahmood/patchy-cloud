import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../../packages/api/src/index.js";

/** A normal tier 2 Tool whose declared mutations exercise the machine door. */
export async function machineTool() {
  const handlers: NonNullable<(typeof Manifest.Type)["handlers"]> = {
    "rows.get": {
      kind: "query",
      args: { id: { kind: "text" } },
      result: { kind: "nullable", value: { kind: "row", table: "rows" } }
    },
    "rows.list": {
      kind: "query",
      args: {},
      result: { kind: "array", element: { kind: "row", table: "rows" } }
    },
    "rows.add": {
      kind: "mutation",
      args: { label: { kind: "text" }, reject: { kind: "boolean", optional: true } },
      result: { kind: "row", table: "rows" },
      errors: ["rejected"]
    },
    "rows.update": {
      kind: "mutation",
      args: { id: { kind: "text" }, label: { kind: "text" } },
      result: { kind: "row", table: "rows" }
    },
    "rows.remove": {
      kind: "mutation",
      args: { id: { kind: "text" } },
      result: { kind: "boolean" }
    },
    "rows.admin": {
      kind: "mutation",
      args: {},
      result: { kind: "boolean" },
      errors: ["admin_only"]
    },
    "rows.invalid": { kind: "mutation", args: {}, result: { kind: "integer" } },
    "rows.send": { kind: "action", args: {}, result: { kind: "boolean" } }
  };
  const resolveDir = fileURLToPath(new URL("../../packages/patchy", import.meta.url));
  const server = await build({
    stdin: {
      contents: `import { createGuest, query, mutation, action, HandlerError, t } from "patchy/server";
const list = query({args:{}, result:t.array(t.row("rows")), handler:async ctx => (await ctx.tables.rows.list({order:"asc"})).rows});
const get = query({args:{id:t.text()},result:t.nullable(t.row("rows")),handler:(ctx,args)=>ctx.tables.rows.get(args.id)});
const add = mutation({args:{label:t.text(), reject:t.boolean().optional()}, result:t.row("rows"), errors:["rejected"], handler:async (ctx,args) => {
  const row = await ctx.tables.rows.insert({label:args.label});
  if(args.reject) throw new HandlerError("rejected", {});
  return row;
}});
const update = mutation({args:{id:t.text(),label:t.text()}, result:t.row("rows"), handler:(ctx,args)=>ctx.tables.rows.update(args.id,{label:args.label})});
const remove = mutation({args:{id:t.text()}, result:t.boolean(), handler:async (ctx,args)=>{await ctx.tables.rows.delete(args.id);return true;}});
const admin = mutation({args:{},result:t.boolean(),errors:["admin_only"],handler:ctx=>{
  if(!ctx.viewer.admin) throw new HandlerError("admin_only",{});
  return true;
}});
const invalid = mutation({args:{},result:t.integer(),handler:async ctx=>{
  await ctx.tables.rows.insert({label:"must roll back"}); return "invalid";
}});
const send = action({args:{},result:t.boolean(),handler:()=>true});
export default createGuest({rows:{list,get,add,update,remove,admin,invalid,send}});`,
      sourcefile: "machine-tool-server.ts",
      resolveDir
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    conditions: ["development"]
  });
  const page = await build({
    stdin: {
      contents: `import {createServerClient} from "patchy/client";
import {render,useQuery} from "patchy/preact";
const client=createServerClient();
function App(){const result=useQuery(client.server.rows.list,{});return <main><h1>Machine mutation test Tool</h1><output id="status">{result.status}</output><output id="rows">{JSON.stringify(result.data??[])}</output></main>}
render(<App/>,document.getElementById("app"));`,
      sourcefile: "machine-tool-page.tsx",
      resolveDir,
      loader: "tsx"
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    jsxImportSource: "patchy/preact",
    define: { "import.meta.env.DEV": "false" }
  });
  return {
    handlers,
    server: server.outputFiles[0]!.text,
    html: `<!doctype html><html><head><title>Machine mutation test Tool</title></head><body><div id="app"></div><script>${page.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`
  };
}
