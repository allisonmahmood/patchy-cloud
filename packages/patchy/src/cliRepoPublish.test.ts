// Repo publish checks: bound targets, bundled resources and size refusals.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE } from "@patchy/api";
import { validateHtml } from "@patchy/core";
import {
  decodePublishRequest,
  embeddedFontLook,
  generateProjectResponse,
  localPackageRegistry,
  packageDir,
  projectHandler,
  projectTree,
  publish,
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

  // repoBuild.test.ts owns what the inspector refuses; this proves Vite's output reaches both
  // checks, and that `patchy init --tier 0` produces a repo whose page the policy accepts, in the
  // company look with its embedded font.
  it("refuses unbundled resources and oversized tier 0 bundles before sending, then publishes the tier 0 starter", async () => {
    const registry = await localPackageRegistry();
    const instance = await stubInstance(
      (request, respond, disconnect) => {
        if (request.url === "/api/publish")
          return respond(201, { ...publish(201, "abcdefghijkl", 1), tier: 0 });
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
      ["init", "static-page", "--tier", "0", "--purpose", "A static page", "--json"],
      // Publishing runs Vite, whose native binding is an optional dependency of this platform.
      { cwd: parent, env: { ...env, ...registry, pnpm_config_optional: "true" } }
    );
    expect(initialized, initialized.stderr).toMatchObject({ status: 0, stderr: "" });
    const dir = path.join(parent, "static-page");
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      ok: true,
      dir,
      tier: 0,
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

    const cap = 512 * 1024;
    const oversizedImage = `data:image/png;base64,${"A".repeat(cap)}`;
    writeFileSync(entry, validHtml.replace("</body>", `<img src="${oversizedImage}"></body>`));
    const refused = await runCli(["publish", "--json"], options);
    expect(refused).toMatchObject({ status: 1, stdout: "" });
    const error = JSON.parse(refused.stderr);
    expect(error).toMatchObject({ ok: false, kind: "local", code: "too_large" });
    expect(error.error).toContain(`${cap} bytes`);
    expect(error.error).toContain(`<img> src: ${Buffer.byteLength(oversizedImage)} bytes`);
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
    expect(existsSync(path.join(dir, ".patchy/publish"))).toBe(false);

    writeFileSync(entry, starter);
    const published = await runCli(["publish", "--json"], options);
    expect(published, published.stderr).toMatchObject({ status: 0, stderr: "" });
    const sent = decodePublishRequest(
      instance.requests.find((request) => request.url === "/api/publish")?.body
    );
    expect(sent.manifest.tier).toBe(0);
    expect(sent.html).toContain("<h1>My patch</h1>");
    expect(sent.html).toContain(embeddedFontLook.font);
    expect(validateHtml(sent.html).ok).toBe(true);
  }, 120_000); // An offline install of the real release archive can exceed 30 seconds.
});
