export interface ClientTemplateOptions {
  readonly tier?: 1 | 2 | 3;
}

/**
 * Finished template: importing the config must never execute it in the frame. Below tier 2 the
 * client reaches only the patch's own tables and files; tier 2 reaches everything else through
 * its handlers.
 */
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
  return `import type config from "../../patchy.config.js";
import manifest from "./manifest.json";
import { createClient } from "patchy/client";
export { isPatchyError } from "patchy/client";

export const patchy = createClient<typeof config>(manifest);
export default patchy;
`;
}

export function generateSharedStoreClient(): string {
  return `import { createSharedStore } from "patchy/client";
import type { Call, ReadFileStore } from "patchy/client";
export type Client = ReadFileStore;
export function createClient(alias: string, call: Call): Client { return createSharedStore(alias, call); }
`;
}
