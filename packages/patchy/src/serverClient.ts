import { PatchyError } from "./clientError.js";
import { createPostMessageTransport, type Me, type Transport } from "./clientTransport.js";
import { createQueryRegistry, type QueryDriver } from "./queryRegistry.js";
import type { ServerClient } from "./server.js";

export interface ServerOnlyClient<Modules> {
  readonly server: ServerClient<Modules>;
  readonly route: Transport["route"];
  me(): Promise<Me>;
  close(): void;
}

/** The stream ticket replaces this refusal with its document-bound subscription driver. */
const unavailableSubscriptions: QueryDriver = {
  subscribe(_query, onFrame) {
    onFrame({
      status: "error",
      revision: 0,
      error: new PatchyError(
        "server_required",
        "This runtime does not admit server subscriptions.",
        {}
      )
    });
    return () => {};
  }
};

/** Properties follow the type-only module imports, without a generated export inventory. */
export function createServerClient<Modules>(
  options: { readonly transport?: Transport; readonly queries?: QueryDriver } = {}
): ServerOnlyClient<Modules> {
  const transport = options.transport ?? createPostMessageTransport();
  const registry = createQueryRegistry(options.queries ?? unavailableSubscriptions);
  const modules: Record<string, Record<string, unknown>> = Object.create(null);
  const server = new Proxy(modules, {
    get(target, module: string | symbol) {
      if (typeof module !== "string") return undefined;
      return (target[module] ??= new Proxy(Object.create(null) as Record<string, unknown>, {
        get(handlers, exported: string | symbol) {
          if (typeof exported !== "string") return undefined;
          if (Object.hasOwn(handlers, exported)) return handlers[exported];
          const name = `${module}.${exported}`;
          const call = (args: Readonly<Record<string, unknown>>) =>
            transport.call("server.call", { handler: name, args });
          // Types expose subscriptions only for queries. The host validates the loaded kind.
          return (handlers[exported] = Object.assign(call, {
            subscribe: (
              args: Readonly<Record<string, unknown>>,
              listener: Parameters<typeof registry.subscribe>[2]
            ) => registry.subscribe(name, args, listener),
            __patchyQueryStore: (canonical: string) => registry.getQuery(name, canonical)
          }));
        }
      }));
    }
  });
  let identity: Promise<Me> | undefined;
  return {
    server: server as ServerClient<Modules>,
    route: transport.route,
    me: () =>
      (identity ??= transport.call("me", {}).then((value) => {
        if (value === null)
          throw new PatchyError("tier2_not_public", "Tier 2 requires a company viewer.", {});
        return value as Me;
      })),
    close() {
      registry.close();
      transport.close();
    }
  };
}
