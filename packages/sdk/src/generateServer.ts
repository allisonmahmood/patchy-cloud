export interface ServerTemplateOptions {
  readonly modules: readonly string[];
  readonly shared?: Readonly<Record<string, string>>;
  readonly connections?: Readonly<Record<string, string>>;
}

/** Module imports carry types only; importing a builder never loads its sibling handlers. */
export function generateServer(options: ServerTemplateOptions): string {
  const imports = [
    'import type config from "../../patchy.config.js";',
    'import { bindServer } from "patchy/server";',
    'import type { QueryBuilder, MutationBuilder, ActionBuilder, QueryContext as BoundQueryContext, MutationContext as BoundMutationContext, ActionContext as BoundActionContext } from "patchy/server";'
  ];
  const modules = [...new Set(options.modules)].sort();
  for (const [index, module] of modules.entries()) {
    imports.push(
      `import type * as module${index} from ${JSON.stringify(`../../server/${module}.js`)};`
    );
  }
  const dependencies = (entries: Readonly<Record<string, string>>, prefix: string) =>
    Object.entries(entries)
      .map(([alias, path], index) => {
        const name = `${prefix}${index}`;
        imports.push(`import type { Client as ${name} } from ${JSON.stringify(path)};`);
        return `readonly [${JSON.stringify(alias)}]: ${name}`;
      })
      .join("; ");
  const shared = dependencies(options.shared ?? {}, "shared");
  const connections = dependencies(options.connections ?? {}, "connection");
  return `${imports.join("\n")}

export type ServerModules = { ${modules.map((module, index) => `readonly [${JSON.stringify(module)}]: typeof module${index}`).join("; ")} };
type Shared = { ${shared} };
type Connections = { ${connections} };
const builders = bindServer<typeof config, ServerModules, Shared, Connections>();
export const query: QueryBuilder<typeof config, Shared> = builders.query;
export const mutation: MutationBuilder<typeof config> = builders.mutation;
export const action: ActionBuilder<typeof config, ServerModules, Shared, Connections> = builders.action;
export type QueryContext = BoundQueryContext<typeof config, Shared>;
export type MutationContext = BoundMutationContext<typeof config>;
export type ActionContext = BoundActionContext<typeof config, ServerModules, Shared, Connections>;
export { HandlerError, t } from "patchy/server";
`;
}
