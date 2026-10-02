// Patch-repo declarations, refresh and init through the bundled CLI.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE } from "@patchy/api";
import { workerdVersion } from "@patchy/api/guest";
import {
  coreProjectSkills,
  exec,
  localPackageRegistry,
  packageDir,
  projectConfig,
  projectConnections,
  projectHandler,
  projectSource,
  projectTree,
  publishTree,
  readJson,
  releaseArtifact,
  requestBarrier,
  require,
  runCli,
  stubInstance,
  tarballPath,
  tempDir,
  treeBytes
} from "./test/cli.js";
import toolchain from "./toolchain.json" with { type: "json" };

describe("patch-repo commands", () => {
  const env = { PATCHY_API_TOKEN: "pp_project" };

  it.each([
    ["init", "--purpose", "Synthetic notes"],
    ["refresh"],
    ["list"],
    ["add", "postgres/sales-db"],
    ["remove", "salesDb"]
  ])("refuses %s without a key before making a request", async (...args) => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    const result = await runCli([...args, "--api-url", instance.url, "--json"], { cwd: dir });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(JSON.parse(result.stderr).error).toContain("Run: patchy login");
    expect(instance.requests).toEqual([]);
  });

  it("refuses ambiguous Postgres selection with discovered choices and leaves config unchanged", async () => {
    const connections = [
      projectConnections.connections[0],
      {
        ...projectConnections.connections[0],
        id: "conn-other",
        handle: "other-db",
        description: "Other database",
        hint: "patchy add postgres/other-db"
      }
    ];
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url.split("?")[0] === "/api/connections") return respond(200, { connections });
      projectHandler(request, respond, disconnect);
    });
    const dir = projectTree(instance.url);
    const result = await runCli(["add", "postgres", "--json"], { cwd: dir, env });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    const failure = JSON.parse(result.stderr);
    expect(failure.kind).toBe("local");
    expect(failure.error).toContain("patchy list connections");
    expect(failure.error).toContain("patchy add postgres/sales-db");
    expect(failure.error).toContain("patchy add postgres/other-db");
    expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toBe(projectConfig);
    expect(instance.requests.some((request) => request.url === "/api/sdk/generate")).toBe(false);
  });

  it("refuses a disconnected Postgres target without modifying the project", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    const result = await runCli(["add", "postgres/archive-db", "--json"], { cwd: dir, env });
    expect(result).toMatchObject({ status: 2, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      kind: "rejected",
      code: "connection_not_connected"
    });
    expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toBe(projectConfig);
    expect(instance.requests.some((request) => request.url === "/api/sdk/generate")).toBe(false);
  });

  it.each([
    { status: 404, exit: 2, kind: "rejected", code: "patch_not_openable" },
    { status: 401, exit: 2, kind: "rejected", code: undefined },
    { status: 503, exit: 3, kind: "unreachable", code: undefined }
  ])(
    "preserves shared-source repair guidance without disguising HTTP $status",
    async ({ status, exit, kind, code }) => {
      const instance = await stubInstance((request, respond, disconnect) => {
        if (request.url.split("?")[0] === "/api/patches/directory")
          return respond(status, {
            ok: false,
            error: status === 401 ? "Missing or invalid API token." : "Patch not found."
          });
        projectHandler(request, respond, disconnect);
      });
      const dir = projectTree(instance.url);
      const result = await runCli(["add", "shared-table", "directory/people", "--json"], {
        cwd: dir,
        env
      });
      expect(result).toMatchObject({ status: exit, stdout: "" });
      const failure = JSON.parse(result.stderr);
      expect(failure).toMatchObject({ ok: false, kind });
      expect(failure.code).toBe(code);
      if (status === 404) expect(failure.error).toContain(`${instance.url}/company`);
      expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toBe(projectConfig);
    }
  );

  it.each([
    { availability: "missing", inventory: { tables: [], stores: [] }, code: "patch_not_openable" },
    {
      availability: "unshared",
      inventory: {
        tables: [
          {
            ...projectSource.inventory.tables[0],
            shared: false,
            declarable: false,
            reason: "not_shared"
          }
        ],
        stores: []
      },
      code: "patch_not_openable"
    },
    {
      availability: "retired",
      inventory: {
        tables: [{ ...projectSource.inventory.tables[0], declarable: false, reason: "source_off" }],
        stores: []
      },
      code: "patch_not_openable"
    },
    {
      availability: "file store",
      inventory: {
        tables: [],
        stores: [
          {
            name: "people",
            description: "Directory files.",
            shared: true,
            declarable: true,
            hint: "patchy add shared-store abcdefghijkl/people"
          }
        ]
      },
      code: "patch_not_openable"
    },
    { availability: "unavailable", inventory: null, code: "source_unavailable" }
  ])(
    "refuses a $availability shared source without enumerating connections",
    async ({ availability, inventory, code }) => {
      const instance = await stubInstance((request, respond, disconnect) => {
        if (request.url.split("?")[0] === "/api/patches/directory")
          return respond(200, {
            ...projectSource,
            ...(availability === "retired"
              ? { state: "retired", retiredAt: "2026-09-02T00:00:00.000Z" }
              : {}),
            inventory
          });
        projectHandler(request, respond, disconnect);
      });
      const dir = projectTree(instance.url);
      const result = await runCli(["add", "shared-table", "directory/people", "--json"], {
        cwd: dir,
        env
      });
      expect(result).toMatchObject({ status: inventory === null ? 3 : 2, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        kind: inventory === null ? "unreachable" : "rejected",
        code
      });
      expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toBe(projectConfig);
      expect(instance.requests.map((request) => request.url)).toEqual([
        "/api/patches/directory?state=all"
      ]);
    }
  );

  it("refreshes the generated client and reports the managed changes as JSON", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    mkdirSync(path.join(dir, "patchy/_generated"), { recursive: true });
    writeFileSync(
      path.join(dir, "patchy/_generated/metadata.json"),
      '{"postgres":{},"shared":{}}\n'
    );
    const result = await runCli(["refresh", "--json"], { cwd: dir, env });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      release: { from: CURRENT_RELEASE, to: CURRENT_RELEASE },
      changed: {
        pin: false,
        generated: expect.arrayContaining([
          "patchy/_generated/client.ts",
          "patchy/_generated/index.json",
          "patchy/_generated/manifest.json",
          "patchy/_generated/metadata.json"
        ]),
        skills: coreProjectSkills,
        fixtures: []
      }
    });
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toMatchObject({
      release: CURRENT_RELEASE,
      tier: 1,
      tables: {
        notes: {
          description: "One note per id, with a title.",
          columns: { title: { kind: "text" } }
        }
      },
      uses: {}
    });
    expect(existsSync(path.join(dir, "patchy/_generated/metadata.json"))).toBe(false);
    expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toBe(projectConfig);
  });

  it("announces newly available capabilities once without rewriting company source", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const options = { cwd: dir, env, stateDir: tempDir() };
    const app = path.join(dir, "src/App.tsx");
    const source = readFileSync(app, "utf8");
    const first = await runCli(["refresh", "--json"], options);
    expect(first, first.stderr).toMatchObject({ status: 0 });
    expect(JSON.parse(first.stdout).addedCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "core.preact",
          runs: expect.any(String),
          limits: expect.any(String)
        })
      ])
    );
    const repeated = await runCli(["refresh", "--json"], options);
    expect(repeated, repeated.stderr).toMatchObject({ status: 0 });
    expect(JSON.parse(repeated.stdout).addedCapabilities).toEqual([]);
    const indexPath = path.join(dir, "patchy/_generated/index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    index.capabilities = index.capabilities.filter(
      (entry: { id: string }) => entry.id !== "core.preact"
    );
    writeFileSync(indexPath, JSON.stringify(index));
    const upgrade = await runCli(["refresh", "--json"], options);
    expect(upgrade, upgrade.stderr).toMatchObject({ status: 0 });
    expect(JSON.parse(upgrade.stdout).addedCapabilities).toEqual([
      expect.objectContaining({ id: "core.preact", runs: "Page", limits: expect.any(String) })
    ]);
    expect(readFileSync(app, "utf8")).toBe(source);
  });

  it("adds the sole connected Postgres declaration without overwriting fixtures", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    mkdirSync(path.join(dir, "fixtures"));
    const fixture = "-- Builder-owned synthetic rows.\n";
    writeFileSync(path.join(dir, "fixtures/postgres-sales-db.sql"), fixture);
    const result = await runCli(["add", "postgres", "--json"], { cwd: dir, env });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      alias: "salesDb",
      declaration: { kind: "postgres", handle: "sales-db" },
      generated: expect.arrayContaining([
        "patchy/_generated/client.ts",
        "patchy/_generated/manifest.json",
        "patchy/_generated/uses/salesDb.ts",
        "patchy/_generated/context/salesDb.md"
      ]),
      skills: [...coreProjectSkills, "patchy-postgres"].sort()
    });
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toMatchObject({
      uses: {
        salesDb: { kind: "postgres", handle: "sales-db", id: "conn-sales", revision: 1 }
      }
    });
    expect(readFileSync(path.join(dir, "fixtures/postgres-sales-db.sql"), "utf8")).toBe(fixture);
  });

  it("adds the unstamped member directory and refuses removal until member columns are gone", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    const added = await runCli(["add", "members", "--json"], { cwd: dir, env });
    expect(added).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(added.stdout)).toMatchObject({
      alias: "members",
      declaration: { kind: "members" },
      skills: expect.arrayContaining(["patchy-members"])
    });
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toHaveProperty("uses", {
      members: { kind: "members" }
    });
    expect(readJson(path.join(dir, "patchy/_generated/index.json"))).toHaveProperty("uses", []);
    const configPath = path.join(dir, "patchy.config.ts");
    const memberColumns = `import { defineConfig, members, table, t } from "patchy/config";
export default defineConfig({ name: "member-assignments", tier: 1, uses: { members: members() },
tables: { tasks: table("Assigned tasks.", { owner: t.member().optional() }) } });`;
    writeFileSync(configPath, memberColumns);
    const refused = await runCli(["remove", "members", "--json"], { cwd: dir, env });
    expect(refused).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(refused.stderr)).toMatchObject({ kind: "local", code: "invalid_manifest" });
    expect(readFileSync(configPath, "utf8")).toBe(memberColumns);
    expect(existsSync(path.join(dir, ".agents/skills/patchy-members/SKILL.md"))).toBe(true);
    writeFileSync(
      configPath,
      memberColumns.replace("t.member().optional()", "t.text().optional()")
    );
    const removed = await runCli(["remove", "members", "--json"], { cwd: dir, env });
    expect(removed).toMatchObject({ status: 0, stderr: "" });
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toHaveProperty("uses", {});
    expect(existsSync(path.join(dir, ".agents/skills/patchy-members"))).toBe(false);
    expect(instance.requests.some((request) => request.url.startsWith("/api/connections"))).toBe(
      false
    );
  });

  it("refuses a renamed member directory before generation", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    const result = await runCli(["add", "members", "--as", "people", "--json"], { cwd: dir, env });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(instance.requests.some((request) => request.url === "/api/sdk/generate")).toBe(false);
  });

  it("adds and stamps a shared store by canonical id, then removes it without touching fixtures", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    const fixture = path.join(dir, "fixtures/shared-assets");
    mkdirSync(path.join(fixture, "nested"), { recursive: true });
    const invented = Buffer.from([0, 255, 10]);
    writeFileSync(path.join(fixture, "nested/photo.bin"), invented);
    const added = await runCli(
      ["add", "shared-store", "directory/photos", "--as", "assets", "--json"],
      { cwd: dir, env }
    );
    expect(added).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(added.stdout)).toMatchObject({
      alias: "assets",
      declaration: { kind: "sharedStore", patchId: "abcdefghijkl", store: "photos" }
    });
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toMatchObject({
      uses: {
        assets: {
          kind: "sharedStore",
          patchId: "abcdefghijkl",
          store: "photos",
          id: "abcdefghijkl/photos",
          revision: 3
        }
      }
    });
    expect(existsSync(path.join(fixture, "README.md"))).toBe(false);
    expect(readFileSync(path.join(fixture, "nested/photo.bin"))).toEqual(invented);
    const removed = await runCli(["remove", "assets", "--json"], { cwd: dir, env });
    expect(removed).toMatchObject({ status: 0, stderr: "" });
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toMatchObject({ uses: {} });
    expect(existsSync(path.join(dir, "patchy/_generated/uses/assets.ts"))).toBe(false);
    expect(existsSync(path.join(dir, ".agents/skills/patchy-shared-stores"))).toBe(false);
    expect(readFileSync(path.join(fixture, "nested/photo.bin"))).toEqual(invented);
    expect(instance.requests.some((request) => request.url.startsWith("/api/connections"))).toBe(
      false
    );
  });

  it.each(["not_shared", "source_off"])(
    "refuses a shared store marked %s before generation",
    async (reason) => {
      const instance = await stubInstance((request, respond, disconnect) => {
        if (request.url.split("?")[0] === "/api/patches/directory")
          return respond(200, {
            ...projectSource,
            inventory: {
              tables: [],
              stores: [
                {
                  ...projectSource.inventory.stores[0],
                  shared: reason !== "not_shared",
                  declarable: false,
                  reason
                }
              ]
            }
          });
        projectHandler(request, respond, disconnect);
      });
      const dir = projectTree(instance.url);
      const result = await runCli(["add", "shared-store", "directory/photos", "--json"], {
        cwd: dir,
        env
      });
      expect(result).toMatchObject({ status: 2, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({ code: "patch_not_openable" });
      expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toBe(projectConfig);
      expect(instance.requests.map((request) => request.url)).toEqual([
        "/api/patches/directory?state=all"
      ]);
    }
  );

  it("removes the declaration, generated surface and last integration skill, but keeps its fixture", async () => {
    const instance = await stubInstance(projectHandler);
    const source = projectConfig.replace(
      "uses: {}",
      'uses: { salesDb: { kind: "postgres", handle: "sales-db" } }'
    );
    const dir = projectTree(instance.url, source);
    for (const name of ["patchy/_generated/uses", ".agents/skills/patchy-postgres", "fixtures"])
      mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, "patchy/_generated/uses/salesDb.ts"), "old generated surface");
    writeFileSync(path.join(dir, ".agents/skills/patchy-postgres/SKILL.md"), "old project skill");
    const fixture = "-- Builder-owned synthetic rows.\n";
    writeFileSync(path.join(dir, "fixtures/postgres-sales-db.sql"), fixture);
    const result = await runCli(["remove", "salesDb", "--json"], { cwd: dir, env });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      alias: "salesDb",
      removed: ["salesDb"]
    });
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toMatchObject({ uses: {} });
    expect(existsSync(path.join(dir, "patchy/_generated/uses/salesDb.ts"))).toBe(false);
    expect(existsSync(path.join(dir, ".agents/skills/patchy-postgres"))).toBe(false);
    expect(readFileSync(path.join(dir, "fixtures/postgres-sales-db.sql"), "utf8")).toBe(fixture);
  });

  it.each([
    {
      args: ["postgres/sales-db"],
      declaration: '"salesDb": {"kind":"postgres","handle":"sales-db"},'
    },
    {
      args: ["shared-store", "directory/photos"],
      declaration: '"photos": {"kind":"sharedStore","patchId":"abcdefghijkl","store":"photos"},'
    },
    {
      args: ["shared-table", "directory/people"],
      declaration: '"people": {"kind":"sharedTable","patchId":"abcdefghijkl","table":"people"},'
    }
  ])(
    "refuses add $args on a spread with a canonical copy-ready insertion",
    async ({ args, declaration }) => {
      const instance = await stubInstance(projectHandler);
      const source =
        'import { defineConfig } from "patchy/config";\n' +
        "const existing = {};\n" +
        'export default defineConfig({ name: "cli-project", tier: 1, tables: {}, files: {},\n' +
        "  uses: {\n" +
        "    ...existing // Builder-owned declarations.\n" +
        "  }\n});\n";
      const dir = projectTree(instance.url, source);
      const result = await runCli(["add", ...args, "--json"], { cwd: dir, env });
      expect(result).toMatchObject({ status: 1, stdout: "" });
      const failure = JSON.parse(result.stderr);
      expect(failure).toMatchObject({ ok: false, kind: "local" });
      expect(failure.error).toContain("patchy.config.ts:5:");
      expect(failure.error.split("\n")).toContain("    ...existing // Builder-owned declarations.");
      expect(failure.error).toContain(declaration);
      expect(failure.error).toContain("patchy refresh");
      expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toBe(source);
      expect(instance.requests.some((request) => request.url === "/api/sdk/generate")).toBe(false);
      if (args[0] === "shared-table" || args[0] === "shared-store")
        expect(
          instance.requests.some((request) => request.url.startsWith("/api/connections"))
        ).toBe(false);
    }
  );

  it.each([false, true])(
    "preserves generated bytes and concurrent author edits after refused refresh (pin changes: %s)",
    async (pinChanges) => {
      const barrier = requestBarrier();
      const tarball = readFileSync(
        path.join(packageDir, `artifacts/patchy-${CURRENT_RELEASE}-${releaseArtifact.digest}.tgz`)
      );
      const instance = await stubInstance(
        (request, respond, disconnect) => {
          if (request.url === "/api/sdk/generate")
            return barrier.handler(request, respond, disconnect);
          projectHandler(request, respond, disconnect);
        },
        () => CURRENT_RELEASE,
        tarball
      );
      const dir = projectTree(instance.url);
      const originalPin = `${instance.url}${pinChanges ? `/sdk/patchy-${CURRENT_RELEASE}-${"0".repeat(64)}.tgz` : tarballPath}`;
      const originalPackage = {
        name: "cli-project",
        private: true,
        type: "module",
        devDependencies: { patchy: originalPin }
      };
      writeFileSync(path.join(dir, "package.json"), JSON.stringify(originalPackage) + "\n");
      mkdirSync(path.join(dir, "patchy/_generated/uses"), { recursive: true });
      writeFileSync(path.join(dir, "patchy/_generated/client.ts"), "previous generated client\n");
      writeFileSync(
        path.join(dir, "patchy/_generated/uses/previous.ts"),
        Buffer.from([0, 255, 10])
      );
      const generatedBefore = treeBytes(path.join(dir, "patchy/_generated"));
      const running = runCli(["refresh", "--json"], {
        cwd: dir,
        env: {
          ...env,
          pnpm_config_registry: instance.url,
          pnpm_config_store_dir: path.join(tempDir(), "store"),
          pnpm_config_cache_dir: path.join(tempDir(), "cache"),
          pnpm_config_update_notifier: "false"
        }
      });
      const held = await barrier.wait(running);
      const authoredConfig = `${projectConfig}\n// A new author edit while generation is pending.\n`;
      writeFileSync(path.join(dir, "patchy.config.ts"), authoredConfig);
      const authoredPackage = {
        ...originalPackage,
        scripts: { typecheck: "tsc --noEmit", notes: "echo builder-owned" },
        description: "An author edit made after the release pin changed",
        devDependencies: { patchy: `${instance.url}${tarballPath}` }
      };
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify(authoredPackage, null, 2) + "\n"
      );
      held.respond(422, {
        ok: false,
        error: "Source access was revoked.",
        code: "patch_not_openable"
      });
      const result = await running;
      expect(result).toMatchObject({ status: 2, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        kind: "rejected",
        code: "patch_not_openable"
      });
      expect(treeBytes(path.join(dir, "patchy/_generated"))).toEqual(generatedBefore);
      expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toBe(authoredConfig);
      expect(readJson(path.join(dir, "package.json"))).toEqual({
        ...authoredPackage,
        devDependencies: { patchy: originalPin }
      });
    }
  );

  it("relays pnpm's first error line when refresh cannot install the release", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    const originalPin = `${instance.url}/sdk/patchy-${CURRENT_RELEASE}-${"0".repeat(64)}.tgz`;
    const originalPackage = JSON.stringify({ devDependencies: { patchy: originalPin } }) + "\n";
    writeFileSync(path.join(dir, "package.json"), originalPackage);
    const result = await runCli(["refresh", "--json"], {
      cwd: dir,
      env: {
        ...env,
        pnpm_config_registry: instance.url,
        pnpm_config_store_dir: path.join(tempDir(), "store"),
        pnpm_config_cache_dir: path.join(tempDir(), "cache"),
        pnpm_config_update_notifier: "false"
      }
    });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      kind: "local",
      error: expect.stringMatching(
        /^Dependency installation failed; the previous project set is preserved\.\npnpm: .*ERR_PNPM_FETCH_404/
      )
    });
    expect(readFileSync(path.join(dir, "package.json"), "utf8")).toBe(originalPackage);
  });

  it("checks the toolchain with the newly installed release, whichever CLI refreshes across a digest change", async () => {
    const required = { ...toolchain, vite: { testedAgainst: "99.0.0", accepted: "^99.0.0" } };
    const instance = await stubInstance(
      projectHandler,
      () => CURRENT_RELEASE,
      readFileSync(
        path.join(packageDir, `artifacts/patchy-${CURRENT_RELEASE}-${releaseArtifact.digest}.tgz`)
      ),
      required
    );
    const previousPin = `${instance.url}/sdk/patchy-${CURRENT_RELEASE}-${"1".repeat(64)}.tgz`;
    const vite = path.dirname(require.resolve("vite/package.json", { paths: [packageDir] }));
    const store = tempDir();
    const pnpm = {
      pnpm_config_registry: instance.url,
      pnpm_config_store_dir: path.join(store, "store"),
      pnpm_config_cache_dir: path.join(store, "cache"),
      pnpm_config_update_notifier: "false"
    };
    const refreshed = async (cli: "installed" | "workspace") => {
      const dir = projectTree(instance.url);
      rmSync(path.join(dir, "node_modules"), { recursive: true });
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "cli-project",
          private: true,
          type: "module",
          devDependencies: { patchy: previousPin, vite: `link:${vite}` }
        }) + "\n"
      );
      await exec(
        "pnpm",
        ["install", "--ignore-workspace", "--ignore-scripts", "--loglevel=error"],
        {
          cwd: dir,
          env: { PATH: process.env.PATH, HOME: store, ...pnpm }
        }
      );
      // pnpm names the installed CLI's real folder after the previous pin; refresh replaces it.
      const result = await runCli(["refresh", "--json"], {
        cwd: dir,
        env: { ...env, ...pnpm },
        ...(cli === "installed" ? { cli: path.join(dir, "node_modules/patchy/dist/index.js") } : {})
      });
      expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
      expect(readJson(path.join(dir, "package.json"))).toMatchObject({
        devDependencies: { patchy: `${instance.url}${tarballPath}` }
      });
      return JSON.parse(result.stdout);
    };
    const installed = await refreshed("installed");
    expect(installed).toMatchObject({
      ok: true,
      changed: { pin: true },
      warnings: expect.arrayContaining([
        expect.stringContaining(`Loaded vite ${toolchain.vite.testedAgainst} is unsupported`)
      ])
    });
    expect(await refreshed("workspace")).toEqual(installed);
  }, 60_000); // Four isolated pnpm installs of the real release archive.

  it.each([
    {
      args: ["init", "new-project", "--purpose", "Synthetic notes"],
      route: "/api/me",
      status: 401,
      exit: 2,
      kind: "rejected"
    },
    {
      args: ["list", "connections"],
      route: "/api/connections",
      status: 403,
      exit: 2,
      kind: "rejected"
    },
    {
      args: ["add", "postgres/sales-db"],
      route: "/api/connections",
      status: 503,
      exit: 3,
      kind: "unreachable"
    },
    {
      args: ["add", "shared-table", "directory/people"],
      route: "/api/patches/directory",
      status: 404,
      exit: 2,
      kind: "rejected"
    },
    {
      args: ["add", "shared-table", "directory/people"],
      route: "/api/patches/directory",
      status: 503,
      exit: 3,
      kind: "unreachable"
    },
    {
      args: ["remove", "salesDb"],
      route: "/api/sdk/generate",
      status: 0,
      exit: 3,
      kind: "unreachable"
    }
  ])("reports $kind on $args's actual $route path", async ({ args, route, status, exit, kind }) => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url.split("?")[0] === route) {
        if (status === 0) return disconnect();
        return respond(status, { ok: false, error: "Instance refused the request." });
      }
      projectHandler(request, respond, disconnect);
    });
    const dir = projectTree(
      instance.url,
      projectConfig.replace(
        "uses: {}",
        'uses: { salesDb: { kind: "postgres", handle: "sales-db" } }'
      )
    );
    const result = await runCli([...args, "--api-url", instance.url, "--json"], { cwd: dir, env });
    expect(result).toMatchObject({ status: exit, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind });
    expect(instance.requests.some((request) => request.url.split("?")[0] === route)).toBe(true);
  });

  it.each([1, 2] as const)(
    "initializes a tier %s typechecking tree offline, refuses reinitialization and preserves sources across tier changes",
    async (tier) => {
      const registry = await localPackageRegistry();
      const instance = await stubInstance(
        projectHandler,
        () => CURRENT_RELEASE,
        readFileSync(
          path.join(packageDir, `artifacts/patchy-${CURRENT_RELEASE}-${releaseArtifact.digest}.tgz`)
        )
      );
      const parent = tempDir();
      const stateDir = tempDir();
      // Init targets the remembered instance, not the parent project's binding.
      writeFileSync(path.join(parent, "patchy.json"), '{"instance":"http://127.0.0.1:1"}\n');
      writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiUrl: instance.url }));
      const dir = path.join(parent, "notes-project");
      const options = { cwd: parent, stateDir, env: { ...env, ...registry } };
      const args = [
        "init",
        "notes-project",
        "--tier",
        String(tier),
        "--purpose",
        "Synthetic notes for CLI tests",
        "--json"
      ];
      const result = await runCli(args, options);
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        dir,
        release: CURRENT_RELEASE,
        tier,
        generated: expect.arrayContaining([
          "patchy/_generated/client.ts",
          "patchy/_generated/index.json",
          "patchy/_generated/manifest.json"
        ]),
        skills: tier === 2 ? [...coreProjectSkills, "patchy-server"].sort() : coreProjectSkills,
        installed: true
      });
      const authoredPaths = [
        "patchy.config.ts",
        "package.json",
        "tsconfig.json",
        "vite.config.ts",
        "src/main.tsx",
        "src/App.tsx",
        "index.html",
        ...(tier === 2 ? ["server/notes.ts"] : []),
        "AGENTS.md",
        "CLAUDE.md"
      ];
      const before = Object.fromEntries(
        authoredPaths.map((name) => [name, readFileSync(path.join(dir, name))])
      );
      const generatedBefore = treeBytes(path.join(dir, "patchy/_generated"));
      await exec("pnpm", ["typecheck"], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: stateDir, ...registry }
      });
      expect(readJson(path.join(dir, "patchy.json"))).toEqual({
        instance: instance.url,
        description: "Synthetic notes for CLI tests"
      });
      const repeated = await runCli(args, options);
      expect(repeated).toMatchObject({ status: 1, stdout: "" });
      expect(JSON.parse(repeated.stderr)).toMatchObject({ ok: false, kind: "local" });
      expect(treeBytes(path.join(dir, "patchy/_generated"))).toEqual(generatedBefore);
      for (const name of authoredPaths)
        expect(readFileSync(path.join(dir, name))).toEqual(before[name]);

      if (tier === 1) {
        const refreshOptions = { ...options, cwd: dir };
        const compilerOptions = {
          cwd: dir,
          env: { PATH: process.env.PATH, HOME: stateDir, ...registry }
        };
        const config = before["patchy.config.ts"]!.toString("utf8");
        const upgradedConfig = config.replace("tier: 1", "tier: 2");
        writeFileSync(path.join(dir, "patchy.config.ts"), upgradedConfig);
        const upgraded = await runCli(["refresh", "--json"], refreshOptions);
        expect(upgraded).toMatchObject({ status: 0, stderr: "" });
        expect(JSON.parse(upgraded.stdout)).toMatchObject({
          ok: true,
          changed: { pin: true }
        });
        expect(readJson(path.join(dir, "package.json"))).toMatchObject({
          devDependencies: { workerd: workerdVersion }
        });
        expect(readJson(path.join(dir, "node_modules/workerd/package.json"))).toMatchObject({
          version: workerdVersion
        });
        expect(existsSync(path.join(dir, "patchy/_generated/server.ts"))).toBe(true);
        expect(existsSync(path.join(dir, ".agents/skills/patchy-server/SKILL.md"))).toBe(true);
        expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toBe(upgradedConfig);
        for (const name of authoredPaths.filter(
          (name) => name !== "patchy.config.ts" && name !== "package.json"
        ))
          expect(readFileSync(path.join(dir, name))).toEqual(before[name]);
        await expect(exec("pnpm", ["typecheck"], compilerOptions)).rejects.toMatchObject({
          code: 2,
          stdout: expect.stringMatching(/src\/App\.tsx\(\d+,\d+\): error TS2339: Property 'tables'/)
        });

        writeFileSync(path.join(dir, "patchy.config.ts"), config);
        const downgraded = await runCli(["refresh", "--json"], refreshOptions);
        expect(downgraded).toMatchObject({ status: 0, stderr: "" });
        expect(JSON.parse(downgraded.stdout)).toMatchObject({
          ok: true,
          changed: { pin: true }
        });
        expect(readJson(path.join(dir, "package.json"))).not.toHaveProperty(
          "devDependencies.workerd"
        );
        expect(existsSync(path.join(dir, "patchy/_generated/server.ts"))).toBe(false);
        expect(existsSync(path.join(dir, ".agents/skills/patchy-server"))).toBe(false);
        for (const name of authoredPaths)
          expect(readFileSync(path.join(dir, name))).toEqual(before[name]);
        await exec("pnpm", ["typecheck"], compilerOptions);

        const unchanged = await runCli(["refresh", "--json"], refreshOptions);
        expect(unchanged).toMatchObject({ status: 0, stderr: "" });
        expect(JSON.parse(unchanged.stdout)).toMatchObject({
          ok: true,
          changed: { pin: false }
        });
        expect(readFileSync(path.join(dir, "package.json"))).toEqual(before["package.json"]);
      }
    },
    120_000
  ); // Real archives, isolated pnpm installs and tier-transition typechecks can exceed 30 seconds.
});
