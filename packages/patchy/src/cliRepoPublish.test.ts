// Repo publish checks: bound targets, the tier 0 refusal and bundled resources.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE } from "@patchy/api";
import {
  decodePublishRequest,
  embeddedFontLook,
  generateProjectResponse,
  localPackageRegistry,
  packageDir,
  projectHandler,
  projectTree,
  publish,
  publishTree,
  releaseArtifact,
  runCli,
  stubInstance,
  tempDir,
  validHtml
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

  // repoBuild.test.ts owns what the inspector refuses and the cap; this proves Vite's output
  // reaches the check, and that `patchy init` produces a repo whose page publishes, in the company
  // look with its embedded font.
  it("refuses unbundled resources before sending, then publishes the starter", async () => {
    const registry = await localPackageRegistry();
    const instance = await stubInstance(
      (request, respond, disconnect) => {
        if (request.url === "/api/publish")
          return respond(201, { ...publish(201, "abcdefghijkl", 1), tier: 1 });
        if (request.url === "/api/sdk/generate")
          return respond(200, generateProjectResponse(request.body, embeddedFontLook));
        projectHandler(request, respond, disconnect);
      },
      () => CURRENT_RELEASE,
      readFileSync(
        path.join(packageDir, `artifacts/patchy-${CURRENT_RELEASE}-${releaseArtifact.digest}.tgz`)
      )
    );
    const parent = tempDir();
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    const initialized = await runCli(
      ["init", "notes-page", "--purpose", "A page of notes", "--json"],
      { cwd: parent, env: { ...env, ...registry } }
    );
    expect(initialized, initialized.stderr).toMatchObject({ status: 0, stderr: "" });
    const dir = path.join(parent, "notes-page");
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      ok: true,
      dir,
      tier: 1,
      installed: true
    });
    const options = { cwd: dir, stateDir: tempDir(), env };
    const entry = path.join(dir, "index.html");
    const starter = readFileSync(entry, "utf8");
    writeFileSync(
      entry,
      validHtml.replace("</body>", '<img src="https://example.test/pixel.png"></body>')
    );
    const external = await runCli(["publish", "--json"], options);
    expect(external).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(external.stderr)).toMatchObject({
      ok: false,
      kind: "local",
      error: expect.stringContaining("<img> src is not embedded")
    });
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
    expect(existsSync(path.join(dir, ".patchy/publish"))).toBe(false);

    writeFileSync(entry, starter);
    const published = await runCli(["publish", "--json"], options);
    expect(published, published.stderr).toMatchObject({ status: 0, stderr: "" });
    const sent = decodePublishRequest(
      instance.requests.find((request) => request.url === "/api/publish")?.body
    );
    expect(sent.manifest.tier).toBe(1);
    expect(sent.html).toContain(embeddedFontLook.font);
    expect(sent.html).toMatch(/main\{[^}]*max-width:960px/);
  }, 120_000); // An offline install of the real release archive can exceed 30 seconds.
});
