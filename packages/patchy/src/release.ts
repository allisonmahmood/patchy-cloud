import metadata from "../package.json" with { type: "json" };

/** One release for the CLI, config, client and dev runtime. */
export const RELEASE = metadata.version;
// Build checks these against the API's supported manifest and runtime wire.
export const MANIFEST_VERSION = 1;
export const WIRE_VERSION = 1;
