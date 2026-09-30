// Compile-only fixture matching the generated module's type-only dependency cycle.
import { defineConfig, files, postgres, sharedStore, sharedTable, t, table } from "./config.js";
import type { Id } from "./config.js";
import type { ReadFileStore, ReadTable } from "./client.js";
import {
  bindServer,
  type ActionBuilder,
  type ActionContext as BoundActionContext,
  type MutationBuilder,
  type MutationContext as BoundMutationContext,
  type QueryBuilder,
  type QueryContext as BoundQueryContext
} from "./server.js";
import type * as leads from "./server.types.js";

export const config = defineConfig({
  name: "server-contract",
  tier: 2,
  tables: {
    leads: table("Leads keyed by id.", {
      name: t.text(),
      note: t.text().optional(),
      active: t.boolean().default(true)
    })
  },
  files: { documents: files("Lead attachments keyed by filename.") },
  uses: {
    directory: sharedTable("abcdefghijkl", "people"),
    assets: sharedStore("abcdefghijkl", "assets"),
    sales: postgres("warehouse")
  }
});
export type ServerModules = { readonly leads: typeof leads };
type Shared = {
  readonly directory: ReadTable<{ readonly id: Id<"people">; readonly name: string }>;
  readonly assets: ReadFileStore;
};
type Connections = {
  readonly sales: { query(sql: string): Promise<readonly { readonly total: number }[]> };
};
const bound = bindServer<typeof config, ServerModules, Shared, Connections>();
// Explicit annotations stop inference from following the module list back into its own builders.
export const query: QueryBuilder<typeof config, Shared> = bound.query;
export const mutation: MutationBuilder<typeof config> = bound.mutation;
export const action: ActionBuilder<typeof config, ServerModules, Shared, Connections> =
  bound.action;
export type QueryContext = BoundQueryContext<typeof config, Shared>;
export type MutationContext = BoundMutationContext<typeof config>;
export type ActionContext = BoundActionContext<typeof config, ServerModules, Shared, Connections>;
