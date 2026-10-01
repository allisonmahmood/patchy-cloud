// @effect-diagnostics nodeBuiltinImport:off -- ECS exposes its task interface through the OS.
import { networkInterfaces } from "node:os";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PrivateInterfaceError extends Schema.TaggedError<PrivateInterfaceError>()(
  "PrivateInterfaceError",
  { addresses: Schema.Number }
) {
  override get message() {
    return `Expected one private IPv4 task interface, found ${this.addresses}.`;
  }
}

/** Resolve the task's own interface, never wildcard-bind a private listener. */
export const resolve = Effect.fn("PrivateInterface.resolve")(function* (host: string) {
  if (host !== "auto") return host;
  const addresses = yield* Effect.sync(() => [
    ...new Set(
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? [])
          .filter((entry) => {
            if (entry.internal || entry.family !== "IPv4") return false;
            const [a, b] = entry.address.split(".").map(Number);
            return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
          })
          .map((entry) => entry.address)
      )
    )
  ]);
  if (addresses.length !== 1)
    return yield* new PrivateInterfaceError({ addresses: addresses.length });
  return addresses[0]!;
});
