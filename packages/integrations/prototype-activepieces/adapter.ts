import { fork } from "node:child_process";

/** Throwaway server-only adapter. Module paths and action admission belong to the host. */
export interface Module {
  readonly modulePath: string;
  readonly exportName: string;
  /** Explicit selection for pieces that offer both OAuth and API-key authentication. */
  readonly authType?: "CUSTOM_AUTH" | "SECRET_TEXT";
}
interface Metadata {
  readonly authType: string;
  readonly actions: ReadonlyArray<string>;
}

/**
 * A fresh process per invocation keeps module globals, environment writes and console output
 * away from Patchy and other tenants. Credentials travel over IPC, never argv or environment.
 * This is process separation for reviewed code, not an untrusted-code sandbox.
 */
const execute = (
  module: Module,
  invocation?:
    | { kind: "run"; name: string; auth: unknown; propsValue: unknown }
    | { kind: "validate"; auth: unknown },
  testPreload?: string
) =>
  new Promise<unknown>((resolve, reject) => {
    const child = fork(new URL("./worker.cjs", import.meta.url), [], {
      env: {},
      execArgv: testPreload ? ["--require", testPreload] : [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      timeout: 5_000
    });
    let reply: { ok: boolean; value?: unknown; code?: string } | undefined;
    child.once("message", (message) => {
      reply = message as typeof reply;
    });
    child.once("error", () => reject(new Error("Module worker unavailable.")));
    child.once("exit", (code) => {
      if (code !== 0 || reply?.ok !== true)
        reject(
          new Error(
            reply?.code === "unsupported_context"
              ? "Unsupported action context capability."
              : "Module action failed."
          )
        );
      else resolve(reply.value);
    });
    child.send({ ...module, invocation }, (error) => {
      if (error) {
        child.kill();
        reject(new Error("Module worker unavailable."));
      }
    });
  });

export async function loadPiece(
  module: Module,
  allowedActions: ReadonlyArray<string>,
  testPreload?: string
) {
  // A host-only test preload redirects provider transport to a loopback double. Never a wire input.
  const metadata = (await execute(module, undefined, testPreload)) as Metadata;
  if (metadata.authType !== "CUSTOM_AUTH" && metadata.authType !== "SECRET_TEXT") {
    throw new Error("Prototype supports API-key authentication only.");
  }
  for (const name of allowedActions) {
    if (!metadata.actions.includes(name)) throw new Error("Action not present in pinned module.");
  }
  return {
    actions: metadata.actions,
    validate: async (auth: unknown) =>
      (await execute(module, { kind: "validate", auth }, testPreload)) === true,
    run: (name: string, auth: unknown, propsValue: Readonly<Record<string, unknown>>) => {
      if (!allowedActions.includes(name))
        return Promise.reject(new Error("Action not enabled by host."));
      return execute(module, { kind: "run", name, auth, propsValue }, testPreload);
    }
  };
}
