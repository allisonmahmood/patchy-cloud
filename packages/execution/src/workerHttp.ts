import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/http/HttpClient";

/**
 * The client a supervisor sends to its own workerd processes with, on loopback: binds, invokes
 * and health probes. Callbacks forwarded to the host keep the runtime's fetch. Under Bun,
 * `node:http` does not share fetch's queue (256 at once), so neither a probe nor an invoke ever
 * waits behind callbacks the host holds open.
 */
export class WorkerHttp extends Context.Service<WorkerHttp, HttpClient.HttpClient>()(
  "@patchy/execution/workerHttp"
) {}

/**
 * `node:http` with a connection for each request, never pooled: none lands on a socket a reaped
 * process closed, or on a port its replacement now listens on. Sockets are not capped.
 */
export const layer = Layer.effect(WorkerHttp, NodeHttpClient.makeNodeHttp).pipe(
  Layer.provide(NodeHttpClient.layerAgentOptions({ keepAlive: false }))
);
