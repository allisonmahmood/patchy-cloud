import * as Context from "effect/Context";
/** Temporary assembly barrier shared by patch and connection audiences. Removed by final assembly. */
export const AudienceActivation = Context.Reference<boolean>("@patchy/patches/AudienceActivation", {
  defaultValue: () => false
});
