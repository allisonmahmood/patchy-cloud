// @effect-diagnostics effect/nodeBuiltinImport:off
/**
 * The one place the runner touches a socket directly: Effect has no TCP
 * client in this RC, and binding is the only honest test of "free".
 */
import { createServer } from "node:net";
import * as Effect from "effect/Effect";

/** Whether `port` can be bound on every interface, which is where the server listens. */
export const isPortFree = (port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const server = createServer();
    server.once("error", () => resume(Effect.succeed(false)));
    server.listen(port, () => server.close(() => resume(Effect.succeed(true))));
  });
