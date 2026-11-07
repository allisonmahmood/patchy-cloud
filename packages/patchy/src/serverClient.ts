import { canonicalArgs } from "@patchy/api/canonical-args";
import { PatchyError, isPatchyError } from "./clientError.js";
import {
  createClientTransport,
  getDocumentTransport,
  LostReply,
  type Me,
  type Transport
} from "./clientTransport.js";
import { createQueryRegistry } from "./queryRegistry.js";
import type { HandlerKindName, ServerClient } from "./server.js";
import { createServerFiles, type ServerFiles } from "./serverFiles.js";
import { createDownload, type Download } from "./download.js";

export interface ServerOnlyClient<Modules> {
  readonly server: ServerClient<Modules>;
  readonly files: ServerFiles;
  readonly route: Transport["route"];
  readonly download: Download;
  me(): Promise<Me>;
  close(): void;
}

// What a handler call sends.
type Request = { readonly handler: string; readonly args: unknown; readonly mutationKey?: string };

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
  options: { readonly transport?: Transport } = {}
): ServerOnlyClient<Modules> {
  const transport = createClientTransport(options.transport ?? getDocumentTransport());
  const files = createServerFiles(transport);
  const registry = createQueryRegistry({
    subscribe: ({ handler, args }, onFrame) =>
      transport.queries.subscribe({ handler: "server.call", args: { handler, args } }, onFrame)
  });
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
            let kind: HandlerKindName | undefined;
            let request: Request | undefined;
            // Sends `prepared` on `target` in its turn, kept for a retry.
            const post = (target: Transport, prepared: Request) => {
              request = prepared;
              return target.call("server.call", prepared);
            };
            let queryRetried = false;
            // A lost query reply is asked again once, and an uncertain mutation offers its same
            // request again. A call that never went out has nothing to retry.
            const settle = async (reply: Promise<unknown>): Promise<unknown> => {
              try {
                return await reply;
              } catch (error) {
                const sent = request;
                if (sent === undefined) throw error;
                const again = () => settle(transport.turn((target) => post(target, sent)));
                if (kind === "mutation" && isPatchyError(error, "unknown_outcome"))
                  throw Object.assign(error, { retry: again });
                if (kind === "query" && error instanceof LostReply && !queryRetried) {
                  queryRetried = true;
                  return again();
                }
                throw error;
              }
            };
            // It takes its turn now, and is prepared when the turn comes, from the descriptors
            // the bootstrap brought. A mutation's key needs the server's clock: without it yet,
            // the mutation steps out of line and takes a new turn once the clock is known.
            return settle(
              transport.turn((target) => {
                kind = target.handlerKind(name);
                if (kind !== "mutation") return post(target, { handler: name, args: snapshot });
                const time = target.serverTime();
                if (time !== undefined)
                  return post(target, {
                    handler: name,
                    args: snapshot,
                    mutationKey: mutationKey(time)
                  });
                return transport
                  .waitForServerTime()
                  .then((clock) =>
                    transport.turn((next) =>
                      post(next, { handler: name, args: snapshot, mutationKey: mutationKey(clock) })
                    )
                  );
              })
            );
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
    files,
    route: transport.route,
    download: createDownload(transport.call),
    me: () =>
      (identity ??= transport.call("me", {}).then((value) => {
        if (value === null)
          throw new PatchyError("tier2_not_public", "Tier 2 requires a company viewer.", {});
        return value as Me;
      })),
    close() {
      files.close();
      registry.close();
      transport.close();
    }
  };
}
