// Compile-only checks; the generated fixture imports this module as types, just like a patch.
import { t } from "./config.js";
import type { FileHandle, Id, Row, Upload } from "./config.js";
import {
  HandlerError,
  isHandlerError,
  type HandlerArgs,
  type HandlerErrors,
  type HandlerKind,
  type HandlerResult,
  type HandlerErrorGuard,
  type MutationUnknownOutcome,
  type ServerClient
} from "./server.js";
import { action, mutation, query } from "./server.generated.types.js";
import type {
  ActionContext,
  QueryContext,
  MutationContext,
  ServerModules,
  config
} from "./server.generated.types.js";
import { useFileUrl, useQuery } from "./preact.js";
import type { ServerOnlyClient } from "./serverClient.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
const readLeads = (ctx: QueryContext) => ctx.tables.leads.list({ limit: 20 });
const writeLead = (ctx: MutationContext) => ctx.tables.leads.insert({ name: "new" });
const totalSales = (ctx: ActionContext) =>
  ctx.connections.sales.query("select count(*) as total from sales");

export const list = query({
  args: { search: t.text().optional(), stage: t.nullable(t.enum(["open", "closed"])) },
  result: t.array(t.row("leads")),
  errors: ["not_allowed"],
  handler: async (ctx, args) => {
    const viewer: string = ctx.viewer.user.id;
    const stage: "open" | "closed" | null = args.stage;
    const search: string | undefined = args.search;
    await ctx.shared.directory.list({ limit: 20 });
    const ownFile = await ctx.files.documents.stat("invoice.pdf");
    const ownHandle: FileHandle | undefined = ownFile?.handle;
    const ownPage = await ctx.files.documents.list();
    const listedHandle: FileHandle = ownPage.files[0]!.handle;
    const sharedPage = await ctx.shared.assets.list({ prefix: "logos/" });
    const sharedHandle: FileHandle = sharedPage.files[0]!.handle;
    const sharedFile = await ctx.shared.assets.stat("logos/company.svg");
    const statHandle: FileHandle | undefined = sharedFile?.handle;
    void [ownHandle, listedHandle, sharedHandle, statHandle];
    // @ts-expect-error shared bytes require an action
    await ctx.shared.assets.get("logos/company.svg");
    // @ts-expect-error shared stores are read only in queries
    await ctx.shared.assets.put("logo.svg", new Uint8Array());
    // @ts-expect-error browser URL operations are not server callbacks
    await ctx.shared.assets.url("logo.svg");
    // @ts-expect-error query tables cannot write
    await ctx.tables.leads.insert({ name: "forbidden" });
    // @ts-expect-error query file reads expose no bytes
    await ctx.files.documents.get("invoice.pdf");
    // @ts-expect-error a query cannot use a connection
    void ctx.connections;
    // @ts-expect-error a query cannot run handlers
    void ctx.run;
    const page = await readLeads(ctx);
    if (page.rows[0]) {
      // @ts-expect-error query rows are readonly
      page.rows[0].name = "changed";
    }
    ctx.log(viewer, { stage, search: search ?? null });
    return page.rows;
  }
});
export const save = mutation({
  args: { name: t.text(), note: t.nullable(t.text()).optional() },
  result: t.row("leads"),
  errors: ["duplicate"],
  handler: async (ctx, args) => {
    // @ts-expect-error mutations cannot reach connections
    void ctx.connections;
    // @ts-expect-error mutations cannot reach shared data
    void ctx.shared;
    // @ts-expect-error mutations cannot reach file stores, including bytes
    void ctx.files;
    // @ts-expect-error mutations cannot run handlers
    void ctx.run;
    await writeLead(ctx);
    return ctx.tables.leads.insert({ name: args.name, note: args.note ?? null });
  }
});
export const sync = action({
  args: { upload: t.upload(), name: t.text() },
  result: t.nullable(t.fileHandle()),
  handler: async (ctx, args) => {
    const records = await ctx.run.leads.list({ stage: null });
    const saved = await ctx.run.leads.save({ name: args.name });
    // @ts-expect-error nested queries retain argument validation
    void ctx.run.leads.list({ stage: 1 });
    const id: Id<"leads"> = saved.id;
    // @ts-expect-error nested calls reject an action target
    ctx.run.leads.sync({ upload: args.upload, name: args.name });
    // @ts-expect-error nested calls retain argument validation
    void ctx.run.leads.save({ name: 1 });
    // @ts-expect-error nested query results remain readonly
    records.push(saved);
    // @ts-expect-error nested mutation results remain readonly
    saved.name = "changed";
    await totalSales(ctx);
    await ctx.shared.directory.list();
    // @ts-expect-error server shared reads cannot start browser subscriptions
    void ctx.shared.directory.get.subscribe;
    const bytes: Uint8Array = await ctx.shared.assets.get("logos/company.svg");
    await ctx.shared.assets.list();
    await ctx.shared.assets.stat("logos/company.svg");
    // @ts-expect-error actions cannot write shared stores
    await ctx.shared.assets.put("logo.svg", bytes);
    // @ts-expect-error actions cannot delete shared files
    await ctx.shared.assets.delete("logo.svg");
    // @ts-expect-error browser downloads are not server callbacks
    await ctx.shared.assets.download("logo.svg");
    await ctx.files.documents.put(args.name, args.upload);
    await ctx.files.documents.put("bytes.bin", new Uint8Array([1, 2, 3]));
    await ctx.files.documents.get(args.name);
    await ctx.files.documents.delete("obsolete.pdf");
    ctx.log(id);
    return (await ctx.files.documents.stat(args.name))?.handle ?? null;
  }
});

export type ServerAssertions = [
  Assert<Equal<HandlerKind<typeof list>, "query">>,
  Assert<Equal<HandlerErrors<typeof save>, "duplicate">>,
  Assert<Equal<HandlerArgs<typeof list>["search"], string | undefined>>,
  Assert<Equal<HandlerArgs<typeof list>["stage"], "open" | "closed" | null>>,
  Assert<Equal<HandlerArgs<typeof save>["note"], string | null | undefined>>,
  Assert<Equal<HandlerResult<typeof list>[number]["note"], string | null>>,
  Assert<Equal<HandlerResult<typeof list>[number]["id"], Id<"leads">>>,
  Assert<Equal<HandlerResult<typeof sync>, FileHandle | null>>,
  Assert<Equal<HandlerArgs<typeof sync>["upload"], Upload>>
];

const consumer = async (
  client: ServerClient<ServerModules>,
  error: unknown,
  row: Row<typeof config, "leads">
) => {
  const rows = await client.leads.list({ stage: "open" });
  const names: readonly string[] = rows.map((lead) => lead.name);
  // @ts-expect-error result arrays are readonly
  rows.push(row);
  // @ts-expect-error row results are deeply readonly
  rows[0]!.name = "changed";
  // @ts-expect-error nullable does not make the key optional
  void client.leads.list({});
  // @ts-expect-error optional does not make a field nullable
  void client.leads.list({ stage: null, search: null });
  // @ts-expect-error renaming an export breaks a page call
  client.leads.oldList({ stage: null });
  // @ts-expect-error renaming a module breaks a page call
  client.oldLeads.list({ stage: null });
  // @ts-expect-error mutations have no subscription
  client.leads.save.subscribe({ name: "x" }, () => {});
  // @ts-expect-error actions have no subscription
  client.leads.sync.subscribe({}, () => {});
  const snapshot = useQuery(client.leads.list, { stage: "open" });
  const hookName: string | undefined = snapshot.data?.[0]?.name;
  // @ts-expect-error hook results remain readonly
  snapshot.data?.push(row);
  // @ts-expect-error hooks require all non-optional query arguments
  useQuery(client.leads.list, {});
  // @ts-expect-error hooks reject incorrectly typed arguments
  useQuery(client.leads.list, { stage: 7 });
  // @ts-expect-error mutations are not query subscriptions
  useQuery(client.leads.save, { name: "x" });
  // @ts-expect-error actions are not query subscriptions
  useQuery(client.leads.sync, {});
  void hookName;
  const unsubscribe: () => void = client.leads.list.subscribe({ stage: null }, (snapshot) => {
    const name: string | undefined = snapshot.data?.[0]?.name;
    const error: Error | undefined = snapshot.error;
    const loading: boolean = snapshot.loading;
    // @ts-expect-error subscribed results remain deeply readonly
    if (snapshot.data?.[0]) snapshot.data[0].name = "changed";
    void name;
    void error;
    void loading;
  });
  unsubscribe();
  // @ts-expect-error subscriptions require non-optional query arguments
  client.leads.list.subscribe({}, () => {});
  // @ts-expect-error subscription arguments retain descriptor types
  client.leads.list.subscribe({ stage: 7 }, () => {});
  const guard: HandlerErrorGuard<ServerModules> = isHandlerError;
  if (guard(error, "duplicate")) {
    const code: "duplicate" = error.code;
    void code;
  }
  // @ts-expect-error only declared handler error codes are accepted
  guard(error, "undeclared");
  const uncertain = error as MutationUnknownOutcome<HandlerResult<typeof save>>;
  const retried: HandlerResult<typeof save> = await uncertain.retry();
  void names;
  void retried;
};
void consumer;

const fileConsumer = async (client: ServerOnlyClient<ServerModules>, handle: FileHandle) => {
  const url: string = await client.files.url(handle);
  await client.files.download(handle);
  await client.files.download(handle, "invoice.pdf");
  const snapshot = useFileUrl(handle);
  const image: string | undefined = snapshot.url;
  const error: Error | undefined = snapshot.error;
  useFileUrl(null);
  useFileUrl(undefined);
  // @ts-expect-error Tier 2 never accepts a name in place of a handle
  await client.files.url("invoice.pdf");
  // @ts-expect-error Tier 2 never accepts a name-based download
  await client.files.download("invoice.pdf");
  // @ts-expect-error Hooks require authorised handles
  useFileUrl("invoice.pdf");
  // @ts-expect-error Tier 2 pages have no named file store
  await client.files.documents.get("invoice.pdf");
  void [url, image, error];
};
void fileConsumer;

const schemas = () => {
  query({
    args: {},
    result: t.object({ nested: t.array(t.object({ note: t.nullable(t.text()).optional() })) }),
    handler: () => ({ nested: [{}, { note: null }] })
  });
  query({
    // @ts-expect-error refs are table-only, including inside object schemas
    args: { nested: t.object({ id: t.ref("leads") }) },
    result: t.boolean(),
    handler: () => true
  });
  query({
    // @ts-expect-error defaults are table-only
    args: { limit: t.integer().default(20) },
    result: t.boolean(),
    handler: () => true
  });
  query({
    // @ts-expect-error handles are results-only
    args: { file: t.fileHandle() },
    result: t.boolean(),
    handler: () => true
  });
  query({
    // @ts-expect-error uploads are action args only
    args: { file: t.upload() },
    result: t.boolean(),
    handler: () => true
  });
  mutation({
    // @ts-expect-error uploads are not mutation args
    args: { nested: t.array(t.upload()) },
    result: t.boolean(),
    handler: () => true
  });
  action({
    args: {},
    // @ts-expect-error uploads are never results
    result: t.upload(),
    handler: () => "upload" as Upload
  });
  query({
    args: {},
    // @ts-expect-error a row schema must name a configured table
    result: t.row("renamed"),
    handler: () => {
      throw new HandlerError("missing");
    }
  });
  query({
    args: {},
    // @ts-expect-error an array element cannot be optional
    result: t.array(t.text().optional()),
    handler: () => []
  });
  query({
    args: {},
    // @ts-expect-error a nullable inner schema cannot be optional
    result: t.nullable(t.text().optional()),
    handler: () => null
  });
  query({
    args: {},
    // @ts-expect-error optional is only a field modifier, not a result-root modifier
    result: t.text().optional(),
    handler: () => "value"
  });
};
void schemas;
