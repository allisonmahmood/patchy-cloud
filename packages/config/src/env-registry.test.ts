import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getServerConfig } from "./index.js";

const SELF_HOSTING_GUIDE = new URL("../../../docs/SELF_HOSTING.md", import.meta.url);

/**
 * Variables a ported package reads through Effect `Config` instead of here.
 * Still the server's to document, so the fence covers them too. The list goes
 * with this package when the last capability moves.
 */
const PORTED_VARIABLES = [
  "PATCHY_POSTHOG_API_KEY",
  "PATCHY_POSTHOG_HOST",
  "AZURE_STORAGE_ACCOUNT",
  "AZURE_STORAGE_CONTAINER",
  "AZURE_STORAGE_CONNECTION_STRING"
];

describe("server environment registry", () => {
  it("documents exactly the variables read by getServerConfig", () => {
    const readVariables = new Set<string>();
    const env = new Proxy<NodeJS.ProcessEnv>(
      {},
      {
        get: (_target, property) => {
          if (typeof property === "string") {
            readVariables.add(property);
          }

          return undefined;
        }
      }
    );

    getServerConfig(env);

    const guide = readFileSync(SELF_HOSTING_GUIDE, "utf8");
    const envFence = guide.match(/```env\n([\s\S]*?)\n```/)?.[1];
    expect(envFence, "SELF_HOSTING.md must contain an env fence").toBeDefined();

    const documentedVariables = [...envFence!.matchAll(/^(?:#\s*)?([A-Z][A-Z0-9_]*)=/gm)].map(
      (match) => match[1]
    );

    expect(documentedVariables.sort()).toEqual([...readVariables, ...PORTED_VARIABLES].sort());
  });
});
