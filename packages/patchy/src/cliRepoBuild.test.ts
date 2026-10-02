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

  it.each([
    { command: "publish", source: 'import "lodash";', aliased: false },
    { command: "dev", source: 'import "lodash";', aliased: false },
    { command: "publish", source: 'import "lodash";', aliased: true },
    { command: "publish", source: 'require("lodash");', aliased: true },
    { command: "publish", source: 'void import.defer("lodash");', aliased: true },
    {
      command: "publish",
      source: 'import value = require("lodash"); console.log(value);',
      aliased: true
    },
    {
      command: "publish",
      source: 'import "vite/modulepreload-polyfill";',
      packageName: "vite"
    },
    {
      command: "publish",
      source: "vite/modulepreload-polyfill",
      packageName: "vite",
      fixture: "html-src"
    },
    { command: "publish", source: 'void import("lodash");', aliased: false },
    { command: "publish", source: 'export { default } from "lodash";', aliased: false },
    { command: "publish", source: 'import "lodash";', aliased: false, nested: true },
    { command: "publish", source: 'import "./style.css";', fixture: "css" },
    { command: "publish", source: 'import "./style.css";', fixture: "nested-css" },
    { command: "dev", source: 'import "./style.css";', fixture: "nested-css" },
    { command: "publish", source: 'import "../node_modules/lodash/index.js";', fixture: "package" },
    { command: "publish", source: 'import "/node_modules/lodash/index.js";', fixture: "package" },
    {
      command: "publish",
      source: 'import {value} from "../server/constants.js"; console.log(value);',
      fixture: "server"
    }
  ])(
    "$command refuses off-SDK page imports ($source, aliased=$aliased, nested=$nested)",
    async ({ command, source, aliased, nested, fixture, packageName }) => {
      const instance = await stubInstance(projectHandler);
      const dir = publishTree(instance.url);
      const entry = nested ? "src/node_modules/company/refused.ts" : "src/refused.ts";
      mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
      writeFileSync(
        path.join(dir, "index.html"),
        `<!doctype html><html><body><script type="module" src="${fixture === "html-src" ? source : `/${entry}`}"></script></body></html>`
      );
      writeFileSync(path.join(dir, entry), source);
      if (fixture === "css" || fixture === "nested-css" || fixture === "package") {
        const dependency = path.join(dir, "node_modules/lodash");
        mkdirSync(dependency);
        writeFileSync(path.join(dependency, "package.json"), '{"name":"lodash","version":"1.0.0"}');
        writeFileSync(path.join(dependency, "index.js"), 'document.body.textContent="Dependency";');
        writeFileSync(path.join(dependency, "style.css"), "body { color: red; }");
        if (fixture === "css")
          writeFileSync(path.join(dir, "src/style.css"), '@import "lodash/style.css";');
        if (fixture === "nested-css") {
          writeFileSync(path.join(dir, "src/style.css"), '@import "./nested.css";');
          writeFileSync(path.join(dir, "src/nested.css"), '@import "lodash/style.css";');
        }
      }
      if (fixture === "server") {
        mkdirSync(path.join(dir, "server"));
        writeFileSync(path.join(dir, "server/constants.ts"), "export const value = 1;");
      }
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
      expect(failure.error).toContain(fixture === "server" ? "server" : (packageName ?? "lodash"));
      const importer =
        fixture === "css"
          ? "src/style.css"
          : fixture === "nested-css"
            ? "src/nested.css"
            : fixture === "html-src"
              ? "index.html"
              : entry;
      expect(failure.error).toContain(importer);
      expect(failure.error).toContain("patchy/preact");
      expect(failure.error).toContain("What the SDK gives you");
      expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
    }
  );

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

  it.each([
    {
      name: "an unset NODE_ENV",
      nodeEnv: undefined,
      envFile: undefined,
      configEnv: "production",
      production: true
    },
    {
      name: "an empty NODE_ENV",
      nodeEnv: "",
      envFile: undefined,
      configEnv: "production",
      production: true
    },
    {
      name: "explicit development",
      nodeEnv: "development",
      envFile: undefined,
      configEnv: "development",
      production: false
    },
    {
      name: "an env-file development override",
      nodeEnv: undefined,
      envFile: "development",
      configEnv: "production",
      production: false
    },
    {
      name: "explicit production over an env file",
      nodeEnv: "production",
      envFile: "development",
      configEnv: "production",
      production: true
    },
    {
      name: "an explicit custom environment over an env file",
      nodeEnv: "staging",
      envFile: "development",
      configEnv: "staging",
      production: false
    }
  ])(
    "publishes Vite's normal build environment with $name",
    async ({ nodeEnv, envFile, configEnv, production }) => {
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
      const options = {
        cwd: dir,
        stateDir: tempDir(),
        env: { ...env, ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }) }
      };
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
        configEnv,
        production,
        mode: "production"
      });
    }
  );

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
