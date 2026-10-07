// Patch-repo builds: what dev and publish refuse or accept from Vite.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE } from "@patchy/api";
import { starterFiles } from "./initProject.js";
import toolchain from "./toolchain.json" with { type: "json" };
import {
  decodePublishRequest,
  embeddedFontLook,
  generateProjectResponse,
  lookRevision,
  patchyLookFiles,
  projectHandler,
  publish,
  publishTree,
  runCli,
  stubInstance,
  tarballPath,
  tempDir
} from "./test/cli.js";

describe("patch-repo builds", () => {
  const env = { PATCHY_API_TOKEN: "pp_project" };

  // Module syntaxes and paths are pageImports.test.ts's; these rows prove the plugin is wired
  // into the production publish and dev builders, through a builder alias and authored HTML.
  it.each([
    { command: "publish", source: 'import "lodash";', aliased: false },
    { command: "dev", source: 'import "lodash";', aliased: false },
    { command: "publish", source: 'import "lodash";', aliased: true },
    { command: "publish", source: "vite/modulepreload-polyfill", htmlSrc: true }
  ])(
    "$command refuses off-SDK page imports ($source, aliased=$aliased)",
    async ({ command, source, aliased, htmlSrc }) => {
      const instance = await stubInstance(projectHandler);
      const dir = publishTree(instance.url);
      const entry = "src/refused.ts";
      writeFileSync(
        path.join(dir, "index.html"),
        `<!doctype html><html><body><script type="module" src="${htmlSrc ? source : `/${entry}`}"></script></body></html>`
      );
      writeFileSync(path.join(dir, entry), source);
      if (aliased) {
        writeFileSync(path.join(dir, "src/local.ts"), "export default 1;");
        const configPath = path.join(dir, "vite.config.ts");
        writeFileSync(
          configPath,
          readFileSync(configPath, "utf8").replace(
            "plugins:",
            `resolve: { alias: { lodash: ${JSON.stringify(path.join(dir, "src/local.ts"))} } }, plugins:`
          )
        );
      }
      const options = { cwd: dir, env, stateDir: tempDir() };
      expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
      const result = await runCli([command, "--json"], options);
      expect(result).toMatchObject({ status: 1, stdout: "" });
      const failure = JSON.parse(result.stderr);
      expect(failure).toMatchObject({ kind: "local", code: "import_refused" });
      expect(failure.error).toContain(htmlSrc ? "vite" : "lodash");
      expect(failure.error).toContain(htmlSrc ? "index.html" : entry);
      expect(failure.error).toContain("patchy/preact");
      expect(failure.error).toContain("What the SDK gives you");
      expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
    }
  );

  it("builds the starter page in the company look, its embedded font included", async () => {
    const response = { ...publish(201, "abcdefghijkl", 1), tier: 1 };
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") return respond(201, response);
      if (request.url === "/api/sdk/generate")
        return respond(200, generateProjectResponse(request.body, embeddedFontLook));
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = { cwd: dir, env, stateDir: tempDir() };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const result = await runCli(["publish", "--json"], options);
    expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
    const { html } = decodePublishRequest(
      instance.requests.find((request) => request.url === "/api/publish")?.body
    );
    expect(html).toContain(embeddedFontLook.font);
    expect(html).toContain("--look-bg:#08090a");
  });

  it("publishes a repo behind the company's look with its own revision, and warns only a page that imports it", async () => {
    const response = { ...publish(201, "abcdefghijkl", 1), tier: 1 };
    const current = {
      ...lookRevision(8, "darker green"),
      files: { "look.css": embeddedFontLook["look.css"], "LOOK.md": "# Darker\n" }
    };
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") return respond(201, response);
      if (request.url === "/api/look") return respond(200, { current, revisions: [current] });
      if (request.url === "/api/sdk/generate")
        return respond(
          200,
          generateProjectResponse(request.body, {
            ...patchyLookFiles,
            revision: lookRevision(7, "first green")
          })
        );
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = { cwd: dir, env, stateDir: tempDir() };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const behind = await runCli(["publish", "--json"], options);
    expect(behind, behind.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(behind.stdout).warnings).toContain(
      "This repo has Patchy Dev's look rev 7, but the current look is rev 8 by Sam: darker green. This version keeps the repo's look; run patchy refresh to bring it up to date."
    );
    const sent = () =>
      decodePublishRequest(
        instance.requests.findLast((request) => request.url === "/api/publish")?.body
      ).html;
    expect(sent()).toContain("--look-bg:#fffdf4");
    expect(sent()).not.toContain(embeddedFontLook.font);

    // A page with its own stylesheet instead publishes without asking for the look.
    const main = path.join(dir, "src/main.tsx");
    writeFileSync(
      main,
      readFileSync(main, "utf8").replace(/^import "[^"]+look\.css";\n/, 'import "./styles.css";\n')
    );
    writeFileSync(path.join(dir, "src/styles.css"), "body { background: #fff0f5; }\n");
    const looks = instance.requests.filter((request) => request.url === "/api/look").length;
    const own = await runCli(["publish", "--json"], options);
    expect(own, own.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(own.stdout).warnings).toEqual(response.warnings);
    expect(instance.requests.filter((request) => request.url === "/api/look")).toHaveLength(looks);
    expect(sent()).not.toContain("--look-bg:#fffdf4");
  });

  it("publishes a vanilla page with default Vite module preloading", async () => {
    const response = { ...publish(201, "abcdefghijkl", 1), tier: 1 };
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") return respond(201, response);
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    writeFileSync(
      path.join(dir, "vite.config.ts"),
      starterFiles({
        instance: instance.url,
        name: "cli-project",
        tier: 0,
        purpose: "Synthetic notes",
        tarball: `${instance.url}${tarballPath}`
      })["vite.config.ts"]!
    );
    writeFileSync(path.join(dir, "src/main.tsx"), 'document.body.textContent = "Vanilla page";');
    const options = { cwd: dir, env, stateDir: tempDir() };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const result = await runCli(["publish", "--json"], options);
    expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
    const request = instance.requests.find((request) => request.url === "/api/publish");
    expect(decodePublishRequest(request?.body).html).toContain("Vanilla page");
  });

  // The CLI preloads config ahead of Vite; Vite's own NODE_ENV precedence is not restated here.
  it.each([
    { name: "an unset NODE_ENV", envFile: undefined, production: true },
    { name: "an env-file development override", envFile: "development", production: false }
  ])("publishes Vite's normal build environment with $name", async ({ envFile, production }) => {
    const response = { ...publish(201, "abcdefghijkl", 1), tier: 1 };
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") return respond(201, response);
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    writeFileSync(
      path.join(dir, "vite.config.ts"),
      `import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
console.log("Builder config progress");
export default defineConfig({
  define: { __BUILDER_NODE_ENV__: JSON.stringify(process.env.NODE_ENV ?? "unset") },
  build: { modulePreload: false },
  plugins: [
    viteSingleFile(),
    {
      name: "builder-diagnostics",
      configResolved(config) { config.logger.info("Builder plugin progress"); }
    }
  ]
});
`
    );
    if (envFile !== undefined)
      writeFileSync(path.join(dir, ".env.production"), `NODE_ENV=${envFile}\n`);
    writeFileSync(
      path.join(dir, "src/main.tsx"),
      `declare const __BUILDER_NODE_ENV__: string;
document.body.textContent = JSON.stringify({
  configEnv: __BUILDER_NODE_ENV__,
  production: import.meta.env.PROD,
  mode: import.meta.env.MODE
});
`
    );
    const options = { cwd: dir, stateDir: tempDir(), env };
    const refreshed = await runCli(["refresh", "--json"], options);
    expect(refreshed, refreshed.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(refreshed.stdout)).toMatchObject({ ok: true, warnings: [] });
    const published = await runCli(["publish", "--json"], options);
    expect(published, published.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(published.stdout)).toEqual(response);
    const request = instance.requests.find((request) => request.url === "/api/publish");
    const { html } = decodePublishRequest(request?.body);
    const document = { body: { textContent: "" } };
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))
      runInNewContext(script[1]!, { document }, { timeout: 1_000 });
    expect(JSON.parse(document.body.textContent)).toEqual({
      configEnv: "production",
      production,
      mode: "production"
    });
  });

  it.each([
    { name: "vite", delayed: false },
    { name: "vite-plugin-singlefile", delayed: false },
    { name: "vite-plugin-singlefile", delayed: true }
  ] as const)(
    "dev and publish refuse unsupported loaded $name with delayed=$delayed while refresh only warns",
    async ({ name, delayed }) => {
      const required = {
        ...toolchain,
        [name]: { testedAgainst: "99.0.0", accepted: "^99.0.0" }
      };
      const instance = await stubInstance(
        projectHandler,
        () => CURRENT_RELEASE,
        undefined,
        required
      );
      const dir = publishTree(instance.url);
      // Resolve the plugin through an imported config, not the root's declared range.
      const nested = path.join(dir, "builder");
      mkdirSync(path.join(nested, "node_modules"), { recursive: true });
      renameSync(path.join(dir, "vite.config.ts"), path.join(nested, "vite.config.ts"));
      renameSync(
        path.join(dir, "node_modules/vite-plugin-singlefile"),
        path.join(nested, "node_modules/vite-plugin-singlefile")
      );
      writeFileSync(
        path.join(dir, "vite.config.ts"),
        'export { default } from "./builder/vite.config";\n'
      );
      if (delayed) {
        writeFileSync(
          path.join(nested, "vite.config.ts"),
          `export default { plugins: [{
  then(resolve: (plugin: unknown) => void, reject: (cause: unknown) => void) {
    return import("vite-plugin-singlefile")
      .then(({ viteSingleFile }) => viteSingleFile())
      .then(resolve, reject);
  }
}] };\n`
        );
      }
      const file = path.join(dir, "package.json");
      const source = readFileSync(file, "utf8").replace(
        JSON.stringify(toolchain[name].accepted),
        JSON.stringify(required[name].accepted)
      );
      writeFileSync(file, source);
      for (const json of [false, true]) {
        const result = await runCli(["refresh", ...(json ? ["--json"] : [])], { cwd: dir, env });
        expect(result.status, result.stderr).toBe(0);
        const notice = json ? JSON.parse(result.stdout).warnings.join("\n") : result.stdout;
        expect(notice).toContain(`Loaded ${name} ${toolchain[name].testedAgainst} is unsupported`);
        expect(notice).toContain(`'${name}@^99.0.0'`);
        expect(notice).toContain("pnpm add --save-dev");
        expect(readFileSync(file, "utf8")).toBe(source);
      }
      for (const command of ["publish", "dev"]) {
        const result = await runCli([command, "--json"], { cwd: dir, env });
        expect(result).toMatchObject({ status: 1, stdout: "" });
        expect(JSON.parse(result.stderr)).toMatchObject({
          ok: false,
          kind: "local",
          code: "toolchain_unsupported",
          error: expect.stringContaining(`Loaded ${name} ${toolchain[name].testedAgainst}`)
        });
        expect(JSON.parse(result.stderr).error).toContain(`'${name}@^99.0.0'`);
      }
      expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(source);
    }
  );
});
