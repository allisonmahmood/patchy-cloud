// Repo publish checks: bound targets, bundled resources and size refusals.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateHtml } from "@patchy/core";
import {
  decodePublishRequest,
  projectHandler,
  projectTree,
  publish,
  publishTree,
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

  // repoBuild.test.ts owns what the inspector refuses; this proves Vite's output reaches both
  // checks, and that the tier 0 starter `patchy init` writes builds into a page the policy accepts.
  it("refuses unbundled resources and oversized tier 0 bundles before sending, then publishes the tier 0 starter", async () => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish")
        return respond(201, { ...publish(201, "abcdefghijkl", 1), tier: 0 });
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url, 0);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
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
    expect(validateHtml(sent.html).ok).toBe(true);
  });
});
