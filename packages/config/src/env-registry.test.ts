import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getServerConfig } from "./index.js";

const SELF_HOSTING_GUIDE = new URL("../../../docs/SELF_HOSTING.md", import.meta.url);

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

    expect(documentedVariables.sort()).toEqual([...readVariables].sort());
  });
});
