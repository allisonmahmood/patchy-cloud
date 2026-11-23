import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/http/HttpClient";

/**
 * The client a supervisor sends to its own workerd processes with, on loopback: binds, invokes
 * and health probes. Callbacks forwarded to the host keep the runtime's fetch. Under Bun,
 * `node:http` does not share fetch's queue (256 at once), so a probe, a startup check or a bind
 * never waits behind callbacks the host holds open. Invokes wait only for the slots they share
 * with those callbacks in the supervisor.
 */
export class WorkerHttp extends Context.Service<WorkerHttp, HttpClient.HttpClient>()(
  "@patchy/execution/workerHttp"
) {}

/**
 * `node:http` with a fresh connection for each request, never pooled, so none reuses a socket a
 * reaped process half-closed. A request can still connect to a replacement now listening on the
 * same port; the generation, callback and scope fencing are what keep stale work from it. Sockets
 * are not capped here: the supervisor's slots bound how many invokes are sent at once.
 */
export const layer = Layer.effect(WorkerHttp, NodeHttpClient.makeNodeHttp).pipe(
  Layer.provide(NodeHttpClient.layerAgentOptions({ keepAlive: false }))
);
