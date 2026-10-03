import * as Effect from "effect/Effect";
import { installCommand } from "@patchy/api";
import { ReleaseMismatch } from "./CliError.js";

/**
 * File publishing supplies only cli, with `outsideRepo` naming the instance whose
 * installer upgrades the global CLI; repo publish and dev also supply pin and runtime.
 */
export const checkRelease = Effect.fn("checkRelease")(function* (
  current: string,
  loaded: { readonly cli: string; readonly pin?: string; readonly runtime?: string },
  outsideRepo?: { readonly instanceUrl: string }
) {
  for (const component of ["pin", "cli", "runtime"] as const) {
    const release = loaded[component];
    if (release !== undefined && release !== current) {
      return yield* new ReleaseMismatch({
        component,
        loaded: release,
        current,
        ...(outsideRepo === undefined
          ? {}
          : {
              installer: installCommand(
                outsideRepo.instanceUrl,
                process.platform === "win32" ? "powershell" : "posix"
              )
            })
      });
    }
  }
});
