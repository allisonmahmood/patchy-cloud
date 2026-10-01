export interface ClientTemplateOptions {
  /** Module paths relative to patchy/_generated/client.ts. Each exports createClient(alias, call). */
  readonly shared?: Readonly<Record<string, string>>;
  readonly connections?: Readonly<Record<string, string>>;
  readonly tier?: 0 | 1 | 2 | 3;
}

/** Finished template: importing the config must never execute it in the frame. */
export function generateClient(options: ClientTemplateOptions = {}): string {
  if (options.tier === 2) {
    return `import { createServerClient, isHandlerError as guard } from "patchy/client";
import type { HandlerErrorGuard } from "patchy/client";
import type { ServerModules } from "./server.js";
export { isPatchyError } from "patchy/client";

export const patchy = createServerClient<ServerModules>();
export const isHandlerError: HandlerErrorGuard<ServerModules> = guard;
export default patchy;
`;
  }
  const imports: string[] = [
    'import type config from "../../patchy.config.js";',
    'import manifest from "./manifest.json";',
    'import { createClient } from "patchy/client";',
    'export { isPatchyError } from "patchy/client";'
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
  return `${imports.join("\n")}\n\nconst shared = { ${shared} };\nconst connections = { ${connections} };\nexport const patchy = createClient<typeof config, typeof shared, typeof connections>(manifest, { shared, connections });\nexport default patchy;\n`;
}

export function generateSharedStoreClient(): string {
  return `import { createSharedStore } from "patchy/client";
import type { Call, ReadFileStore } from "patchy/client";
export type Client = ReadFileStore;
export function createClient(alias: string, call: Call): Client { return createSharedStore(alias, call); }
`;
}
