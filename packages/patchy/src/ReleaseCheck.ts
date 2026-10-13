import * as Effect from "effect/Effect";
import { installCommand } from "@patchy/api";
import * as Api from "./Api.js";
import { ReleaseMismatch } from "./CliError.js";
import * as Instance from "./Instance.js";
import { RELEASE } from "./release.js";

/**
 * Outside a repo only cli is supplied, with `outsideRepo` naming the instance whose
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

/**
 * New work outside a repo (a file or look publish, a new repo) runs only the global CLI, so
 * one whose release differs from its instance's is refused with the installer line that
 * replaces it, along with the global skill it carries. Returns the instance's release for
 * callers that install it.
 */
export const requireCurrentCli = Effect.fn("requireCurrentCli")(function* (client: Api.Client) {
  const instance = yield* Instance.Instance;
  const release = yield* client
    .release()
    .pipe(Effect.catch((error) => Api.classify(error, "Could not read the instance release.")));
  yield* checkRelease(release.release, { cli: RELEASE }, { instanceUrl: instance.apiUrl });
  return release;
});
