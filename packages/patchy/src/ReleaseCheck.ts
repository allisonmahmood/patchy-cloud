import * as Effect from "effect/Effect";
import { ReleaseMismatch } from "./CliError.js";

/** File publishing supplies only cli; repo publish and dev also supply pin and runtime. */
export const checkRelease = Effect.fn("checkRelease")(function* (
  current: string,
  loaded: { readonly cli: string; readonly pin?: string; readonly runtime?: string }
) {
  for (const component of ["pin", "cli", "runtime"] as const) {
    const release = loaded[component];
    if (release !== undefined && release !== current) {
      return yield* new ReleaseMismatch({ component, loaded: release, current });
    }
  }
});
