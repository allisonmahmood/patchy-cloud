// Repo publish checks: bound targets, bundled resources and size refusals.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  packageDir,
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
  it.each(["flag", "dev-env", "env"])(
    "refuses a foreign %s target before refreshing or publishing a bound repo",
    async (source) => {
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
        env: { PATCHY_API_URL: foreign.url, PATCHY_API_TOKEN: "pp_owner" }
      };
      if (source === "dev-env") {
        mkdirSync(path.join(dir, ".local/dev"), { recursive: true });
        writeFileSync(
          path.join(dir, ".local/dev/env"),
          `PATCHY_API_URL=${foreign.url}\nPATCHY_API_TOKEN=dev-token\n`
        );
        options.env.PATCHY_API_URL = stored.url;
      }
      for (const command of ["refresh", "publish"]) {
        const result = await runCli(
          [command, "--json", ...(source === "flag" ? ["--api-url", foreign.url] : [])],
          options
        );
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
    }
  );

  it.each([0, 1])(
    "tier %s accepts shared navigation fixtures but refuses unbundled resources",
    async (tier) => {
      const instance = await stubInstance((request, respond, disconnect) => {
        if (request.url === "/api/publish")
          return respond(201, { ...publish(201, "abcdefghijkl", 1), tier });
        projectHandler(request, respond, disconnect);
      });
      const dir = publishTree(instance.url);
      const config = path.join(dir, "patchy.config.ts");
      writeFileSync(config, readFileSync(config, "utf8").replace("tier: 1", `tier: ${tier}`));
      const options = {
        cwd: dir,
        stateDir: tempDir(),
        env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
      };
      expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
      const fixtures = path.join(packageDir, "../core/fixtures/accept");
      const entry = path.join(dir, "index.html");
      writeFileSync(entry, readFileSync(path.join(fixtures, "portfolio.html")));
      const accepted = await runCli(["publish", "--json"], options);
      expect(accepted, accepted.stderr).toMatchObject({ status: 0, stderr: "" });
      const sent = instance.requests.filter((request) => request.url === "/api/publish");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toMatchObject({ manifest: { tier } });
      for (const href of ["https://example.com/case-study", "/reports", "reports/weekly", "#work"])
        expect(JSON.stringify(sent[0]!.body)).toContain(href);

      writeFileSync(entry, readFileSync(path.join(fixtures, "remote-image.html")));
      const refused = await runCli(["publish", "--json"], options);
      expect(refused).toMatchObject({ status: 1, stdout: "" });
      expect(JSON.parse(refused.stderr)).toMatchObject({ ok: false, kind: "local" });
      expect(instance.requests.filter((request) => request.url === "/api/publish")).toHaveLength(1);
    }
  );

  it.each([
    [0, 512 * 1024],
    [1, 10 * 1024 * 1024]
  ])("tier %s size refusals report too_large and the offending resource", async (tier, cap) => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish")
        return respond(201, { ...publish(201, "abcdefghijkl", 1), tier });
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const config = path.join(dir, "patchy.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("tier: 1", `tier: ${tier}`));
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const entry = path.join(dir, "index.html");
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

    writeFileSync(entry, validHtml);
    const reduced = await runCli(["publish", "--json"], options);
    expect(reduced, reduced.stderr).toMatchObject({ status: 0, stderr: "" });
  });

  it.each([
    '<img src="blob:https://example.test/temporary">',
    '<object data="blob:https://example.test/temporary"></object>',
    `<iframe srcdoc="&lt;img src='blob:https://example.test/temporary'&gt;"></iframe>`,
    '<style>body { background-image: url("blob:https://example.test/temporary"); }</style>'
  ])("refuses document-local blob assets in built HTML: %s", async (asset) => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") return respond(201, publish(201, "abcdefghijkl", 1));
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const entry = path.join(dir, "index.html");
    writeFileSync(entry, readFileSync(entry, "utf8").replace("</body>", `${asset}</body>`));
    const result = await runCli(["publish", "--json"], options);
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
  });

  it.each([
    ["image-set", 'image-set("https://example.test/pixel.png" 1x)'],
    ["-webkit-image-set", '-webkit-image-set("blob:https://example.test/pixel" 1x)'],
    ["escaped image-set", String.raw`image\2d set("\68 ttps://example.test/pixel.png" 1x)`],
    ["escaped url", String.raw`\75rl("\62 lob:https://example.test/pixel")`]
  ])("refuses external %s resources in inline CSS", async (_, value) => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const entry = path.join(dir, "index.html");
    writeFileSync(
      entry,
      readFileSync(entry, "utf8").replace(
        "</body>",
        `<div style='background-image: ${value}'></div></body>`
      )
    );
    const result = await runCli(["publish", "--json"], options);
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
  });

  it("publishes harmless CSS strings and embedded image candidates", async () => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") return respond(201, publish(201, "abcdefghijkl", 1));
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const entry = path.join(dir, "index.html");
    writeFileSync(
      entry,
      readFileSync(entry, "utf8")
        .replace(
          "</head>",
          '<style>body::after { content: "@import url(foo) /* literal text */"; }</style></head>'
        )
        .replace(
          "</body>",
          String.raw`<div style='--label: "@import url(foo)"; background-image: image-set("data:image/png;base64,AA==" 1x type("image/png")); mask-image: -webkit-image-set("\23 icon" 1x); filter: url(#icon)'></div></body>`
        )
    );
    const result = await runCli(["publish", "--json"], options);
    expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
    const requests = instance.requests.filter((request) => request.url === "/api/publish");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toMatchObject({
      html: expect.stringContaining("@import url(foo)")
    });
  });

  it.each([
    String.raw`<style>@\69mport "https://example.test/external.css";</style>`,
    `<div style='color: red; broken; background-image: image-set("https://example.test/pixel.png" 1x)'></div>`
  ])("refuses CSS imports or parse failures without hiding dependencies: %s", async (asset) => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const entry = path.join(dir, "index.html");
    writeFileSync(entry, readFileSync(entry, "utf8").replace("</body>", `${asset}</body>`));
    const result = await runCli(["publish", "--json"], options);
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
  });

  it("inspects active noscript resources in a tier 0 bundle", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const config = path.join(dir, "patchy.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("tier: 1", "tier: 0"));
    writeFileSync(
      path.join(dir, "index.html"),
      validHtml.replace(
        "</body>",
        '<noscript><img src="https://example.test/pixel.png"></noscript></body>'
      )
    );
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const result = await runCli(["publish", "--json"], options);
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
  });
});
