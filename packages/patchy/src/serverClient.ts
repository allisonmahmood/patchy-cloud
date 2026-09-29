import { canonicalArgs } from "@patchy/api/canonical-args";
import { PatchyError, isPatchyError } from "./clientError.js";
import {
  createPostMessageTransport,
  LostReply,
  type Me,
  type Transport
} from "./clientTransport.js";
import { createQueryRegistry, type QueryDriver } from "./queryRegistry.js";
import type { ServerClient } from "./server.js";

export interface ServerOnlyClient<Modules> {
  readonly server: ServerClient<Modules>;
  readonly route: Transport["route"];
  me(): Promise<Me>;
  close(): void;
}

const unavailableSubscriptions: QueryDriver = {
  subscribe(_request, onFrame) {
    onFrame({
      status: "error",
      permanent: true,
      error: new PatchyError(
        "server_required",
        "This runtime does not admit server subscriptions.",
        {}
      )
    });
    return () => {};
  }
};

const mutationKey = (serverTime: number): string => {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const suffix = btoa(String.fromCharCode(...random))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${Math.floor(serverTime)}-${suffix}`;
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
          const call = async (args: Readonly<Record<string, unknown>>) => {
            const snapshot: unknown = JSON.parse(canonicalArgs(args));
            await transport.ready();
            const kind = transport.handlerKind(name);
            const request = {
              handler: name,
              args: snapshot,
              ...(kind === "mutation"
                ? {
                    mutationKey: mutationKey(
                      transport.serverTime() ?? (await transport.waitForServerTime())
                    )
                  }
                : {})
            };
            let queryRetried = false;
            const send = async (): Promise<unknown> => {
              try {
                return await transport.call("server.call", request);
              } catch (error) {
                if (kind === "mutation" && isPatchyError(error, "unknown_outcome"))
                  throw Object.assign(error, { retry: send });
                if (kind === "query" && error instanceof LostReply && !queryRetried) {
                  queryRetried = true;
                  return send();
                }
                throw error;
              }
            };
            return send();
          };
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
