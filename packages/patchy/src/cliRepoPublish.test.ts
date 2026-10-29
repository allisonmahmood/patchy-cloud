// Repo publish checks: bound targets, the release pin and the tier 0 refusal.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  projectHandler,
  projectTree,
  publishTree,
  runCli,
  stubInstance,
  tempDir
} from "./test/cli.js";

describe("repo publish checks", () => {
  // Instance.test.ts resolves every target source; this proves refresh and publish both check it.
  it("refuses a foreign flag target before refreshing or publishing a bound repo", async () => {
    const stored = await stubInstance(projectHandler);
    const foreign = await stubInstance(projectHandler);
    const dir = projectTree(stored.url);
    const file = path.join(dir, "patchy.json");
    const original = JSON.stringify({
      instance: stored.url,
      patch: "abcdefghijkl",
      authorField: 7
    });
    writeFileSync(file, original);
    const pin = readFileSync(path.join(dir, "package.json"));
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: stored.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    for (const command of ["refresh", "publish"]) {
      const result = await runCli([command, "--json", "--api-url", foreign.url], options);
      expect(result).toMatchObject({ status: 1, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        kind: "local",
        code: "instance_mismatch",
        error: expect.stringContaining(stored.url)
      });
      expect(JSON.parse(result.stderr).error).toContain(foreign.url);
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(readFileSync(path.join(dir, "package.json"))).toEqual(pin);
    }
    expect(stored.requests).toEqual([]);
    expect(foreign.requests).toEqual([]);
    expect(existsSync(path.join(dir, ".patchy/publish"))).toBe(false);
  });

  it("names pnpm patchy refresh when the instance moved past a repo's current pin", async () => {
    const instance = await stubInstance(projectHandler, () => "9.9.9");
    const dir = projectTree(instance.url);
    const result = await runCli(["publish", "--json"], {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_TOKEN: "pp_owner" }
    });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    const failure = JSON.parse(result.stderr);
    expect(failure).toMatchObject({ ok: false, kind: "local", code: "release_mismatch" });
    expect(failure.error).toContain("9.9.9");
    expect(failure.error).toContain("Run: pnpm patchy refresh");
    expect(failure.error).not.toContain("install.mjs");
  });

  // Tier 0 is now tier 1: a repo still configured at tier 0 is refused before it builds, generates
  // or sends anything, and init no longer makes one.
  it("refuses a tier 0 repo by publish and dev before building, and init at tier 0", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const env = { PATCHY_API_TOKEN: "pp_owner" };
    const refreshed = await runCli(["refresh", "--json"], { cwd: dir, env });
    expect(refreshed.status, refreshed.stderr).toBe(0);
    const config = path.join(dir, "patchy.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("tier: 1", "tier: 0"));
    const refreshes = instance.requests.length;
    for (const command of ["publish", "dev"]) {
      const result = await runCli([command, "--json"], { cwd: dir, env, stateDir: tempDir() });
      expect(result).toMatchObject({ status: 1, stdout: "" });
      expect(JSON.parse(result.stderr)).toEqual({
        ok: false,
        kind: "local",
        code: "tier_mismatch",
        error: "Tier 0 is now tier 1. Set `tier: 1` and run `patchy refresh`."
      });
    }
    expect(existsSync(path.join(dir, "dist"))).toBe(false);
    expect(existsSync(path.join(dir, ".patchy/publish"))).toBe(false);
    expect(
      instance.requests
        .slice(refreshes)
        .filter((request) => ["/api/publish", "/api/sdk/generate"].includes(request.url))
    ).toEqual([]);

    const before = instance.requests.length;
    const init = await runCli(
      ["init", "static-page", "--tier", "0", "--purpose", "A static page", "--json"],
      { cwd: tempDir(), env: { ...env, PATCHY_API_URL: instance.url } }
    );
    // Usage still prints on stdout for a flag error, as ADR-0004 records.
    expect(init.status).toBe(1);
    expect(init.stdout).toContain("(choices: 1, 2)");
    expect(JSON.parse(init.stderr)).toEqual({
      ok: false,
      kind: "local",
      error: 'Invalid value for flag --tier: "0". Expected: "1" | "2"'
    });
    expect(instance.requests.length).toBe(before);
  });
});
