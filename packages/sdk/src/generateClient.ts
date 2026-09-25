export interface ClientTemplateOptions {
  /** Module paths relative to patchy/_generated/client.ts. Each exports createClient(alias, call). */
  readonly shared?: Readonly<Record<string, string>>;
  readonly connections?: Readonly<Record<string, string>>;
  /** PROTOTYPE for #314: `server/*.ts` names; each is a type-only import on the client. */
  readonly serverModules?: readonly string[];
}

/** Finished template: importing the config must never execute it in the frame. */
export function generateClient(options: ClientTemplateOptions = {}): string {
  const imports: string[] = [
    'import type config from "../../patchy.config.js";',
    'import manifest from "./manifest.json";',
    'import { createClient } from "patchy/client";'
  ];
  const factories = (modules: Readonly<Record<string, string>>, prefix: string) => {
    return Object.entries(modules)
      .map(([alias, path], index) => {
        const name = `${prefix}${index}`;
        imports.push(`import { createClient as ${name} } from ${JSON.stringify(path)};`);
        return `[${JSON.stringify(alias)}]: ${name}`;
      })
      .join(", ");
  };
  const shared = factories(options.shared ?? {}, "shared");
  const connections = factories(options.connections ?? {}, "connection");
  const modules = options.serverModules ?? [];
  // A handler's types come from the server module itself (#296 point 10): a rename or schema
  // edit in server/ is a compile error here with no regeneration; only a new file needs refresh.
  for (const [index, name] of modules.entries())
    imports.push(
      `import type * as server${index} from ${JSON.stringify(`../../server/${name}.js`)};`
    );
  imports.push('export { isHandlerError, HandlerError, isPatchyError } from "patchy/client";');
  const serverTypes = modules
    .map((name, index) => `${JSON.stringify(name)}: typeof server${index}`)
    .join("; ");
  return `${imports.join("\n")}\n\nconst shared = { ${shared} };\nconst connections = { ${connections} };\ntype ServerModules = { ${serverTypes} };\nexport const patchy = createClient<typeof config, typeof shared, typeof connections, ServerModules>(manifest, { shared, connections, serverModules: ${JSON.stringify(modules)} });\nexport default patchy;\n`;
}
