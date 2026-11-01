// Patch-repo declarations, refresh and init through the bundled CLI.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE } from "@patchy/api";
import { patchChangesBetween } from "@patchy/core/whatsNew";
import { workerdVersion } from "@patchy/api/guest";
import {
  coreProjectSkills,
  exec,
  generateProjectResponse,
  identity,
  localPackageRegistry,
  packageDir,
  patchyLookFiles,
  projectConfig,
  projectConnections,
  projectHandler,
  projectSource,
  projectTree,
  tier2ProjectTree,
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
import { ManagedProject, ProjectLocked } from "./ManagedProject.js";
import toolchain from "./toolchain.json" with { type: "json" };
import { lookRevision, readLookFixture } from "../../../test/look-fixtures.js";

describe("patch-repo commands", () => {
  const env = { PATCHY_API_TOKEN: "pp_project" };

  it.each([["init", "--purpose", "Synthetic notes"], ["refresh"], ["list"]])(
    "refuses %s without a key before making a request",
    async (...args) => {
      const instance = await stubInstance(projectHandler);
      const dir = projectTree(instance.url);
      const result = await runCli([...args, "--api-url", instance.url, "--json"], { cwd: dir });
      expect(result).toMatchObject({ status: 1, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
      expect(JSON.parse(result.stderr).error).toContain("Run: patchy login");
      expect(instance.requests).toEqual([]);
    }
  );

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

  // Every declarable refusal shares one branch; an unavailable inventory is its own.
  it.each([
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
    { availability: "unavailable", inventory: null, code: "source_unavailable" }
  ])(
    "refuses a $availability shared source without enumerating connections",
    async ({ inventory, code }) => {
      const instance = await stubInstance((request, respond, disconnect) => {
        if (request.url.split("?")[0] === "/api/patches/directory")
          return respond(200, {
            ...projectSource,
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
    // As after a rollback past the release that added it: this instance doesn't ship the skill.
    mkdirSync(path.join(dir, ".agents/skills/patchy-later"), { recursive: true });
    writeFileSync(
      path.join(dir, ".agents/skills/patchy-later/SKILL.md"),
      "A later release's skill"
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
        skills: [...coreProjectSkills, "patchy-later"].sort(),
        fixtures: []
      },
      warnings: ["Removed the patchy-later skill."]
    });
    expect(existsSync(path.join(dir, ".agents/skills/patchy-later"))).toBe(false);
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

  it("swaps in the company's current look at each refresh and leaves an existing styled page alone", async () => {
    let look: Parameters<typeof generateProjectResponse>[1] = patchyLookFiles;
    let unavailable = false;
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/sdk/generate" && unavailable)
        return respond(503, { ok: false, code: "source_unavailable", error: "Unavailable." });
      if (request.url === "/api/sdk/generate")
        return respond(200, generateProjectResponse(request.body, look));
      projectHandler(request, respond, disconnect);
    });
    // A repo from before the look: its page has its own style and never imported look.css.
    const dir = publishTree(instance.url);
    const main = path.join(dir, "src/main.tsx");
    writeFileSync(main, readFileSync(main, "utf8").replace(/^import "[^"]+look\.css";\n/, ""));
    writeFileSync(path.join(dir, "src/styles.css"), "body { background: #fff0f5; }\n");
    const page = () => ({
      src: treeBytes(path.join(dir, "src")),
      html: readFileSync(path.join(dir, "index.html"))
    });
    const before = page();
    const generated = (name: string) => path.join(dir, "patchy/_generated", name);
    const options = { cwd: dir, env, stateDir: tempDir() };

    expect(await runCli(["refresh", "--json"], options)).toMatchObject({ status: 0 });
    expect(readFileSync(generated("look.css"), "utf8")).toBe(patchyLookFiles["look.css"]);
    expect(existsSync(generated("logo.svg"))).toBe(false);
    expect(existsSync(path.join(dir, ".agents/skills/patchy-look/SKILL.md"))).toBe(true);

    const logo =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';
    const company = { "look.css": readLookFixture("linear")["look.css"], "logo.svg": logo };
    look = company;
    const swapped = await runCli(["refresh", "--json"], options);
    expect(swapped, swapped.stderr).toMatchObject({ status: 0 });
    expect(JSON.parse(swapped.stdout).changed.generated).toEqual(
      expect.arrayContaining(["patchy/_generated/look.css", "patchy/_generated/logo.svg"])
    );
    expect(readFileSync(generated("look.css"), "utf8")).toBe(company["look.css"]);
    expect(readFileSync(generated("logo.svg"), "utf8")).toBe(logo);

    // An interrupted generation keeps the look the repo already had.
    look = patchyLookFiles;
    unavailable = true;
    expect((await runCli(["refresh", "--json"], options)).status).not.toBe(0);
    expect(readFileSync(generated("look.css"), "utf8")).toBe(company["look.css"]);
    expect(readFileSync(generated("logo.svg"), "utf8")).toBe(logo);

    // Back to no company look: the Patchy look returns and the company's logo goes.
    unavailable = false;
    expect(await runCli(["refresh", "--json"], options)).toMatchObject({ status: 0 });
    expect(readFileSync(generated("look.css"), "utf8")).toBe(patchyLookFiles["look.css"]);
    expect(existsSync(generated("logo.svg"))).toBe(false);
    expect(page()).toEqual(before);
  });

  it("tells a page that imports the look about the revision refresh brings in", async () => {
    const follow =
      "Colours and fonts follow; to restyle this tool's components, ask your agent to update it to the current look.";
    let look: Parameters<typeof generateProjectResponse>[1] = {
      ...patchyLookFiles,
      revision: lookRevision(7, "first green")
    };
    let identityRefused = false;
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/sdk/generate")
        return respond(200, generateProjectResponse(request.body, look));
      if (request.url === "/api/me" && identityRefused)
        return respond(429, { ok: false, code: "rate_limited", error: "Too many requests." });
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = { cwd: dir, env, stateDir: tempDir() };
    const refresh = async (args: string[] = []) => {
      const result = await runCli(["refresh", ...args], options);
      expect(result, result.stderr).toMatchObject({ status: 0 });
      return result.stdout;
    };
    const warnings = async () => JSON.parse(await refresh(["--json"])).warnings;
    await refresh();

    look = { ...patchyLookFiles, revision: lookRevision(8, "darker green") };
    expect(await warnings()).toEqual([
      `Patchy Dev's look changed, rev 7 → 8 by Sam: darker green. ${follow}`
    ]);
    // A restore credits whoever restored, not the revision's author.
    const restored = {
      by: { id: "usr_ada", name: "Ada" },
      at: "2026-10-08T10:00:00.000Z",
      note: "rev 8 failed dark mode"
    };
    look = { ...patchyLookFiles, revision: lookRevision(7, "first green"), restored };
    expect(await warnings()).toEqual([
      `Patchy Dev's look changed, rev 8 → 7, restored by Ada: rev 8 failed dark mode. ${follow}`
    ]);
    // The notice is advisory: without the company's name it still lands, and so does the look.
    identityRefused = true;
    look = { ...patchyLookFiles, revision: lookRevision(8, "darker green") };
    expect((await refresh()).split("\n")[0]).toBe(
      `The company's look changed, rev 7 → 8 by Sam: darker green. ${follow}`
    );

    // A page that swapped the import for its own stylesheet hears nothing.
    const main = path.join(dir, "src/main.tsx");
    writeFileSync(main, readFileSync(main, "utf8").replace(/^import "[^"]+look\.css";\n/, ""));
    writeFileSync(path.join(dir, "src/styles.css"), "body { background: #fff0f5; }\n");
    look = { ...patchyLookFiles, revision: lookRevision(9, "rebrand") };
    expect(await warnings()).toEqual([]);
  }, 60_000);

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

  it("lists what the releases a refresh crosses change for an existing patch, then nothing", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    mkdirSync(path.join(dir, "patchy/_generated"), { recursive: true });
    // The repo's last generation, as release 29 wrote it.
    writeFileSync(
      path.join(dir, "patchy/_generated/index.json"),
      JSON.stringify({ release: "0.29.0" })
    );
    const crossed = patchChangesBetween(29, Number(CURRENT_RELEASE.split(".")[1])).map(
      ({ release, change }) => `Changed in 0.${release}.0: ${change}`
    );
    expect(crossed.length).toBeGreaterThan(1);
    const upgrade = await runCli(["refresh", "--json"], { cwd: dir, env });
    expect(upgrade, upgrade.stderr).toMatchObject({ status: 0 });
    const { warnings } = JSON.parse(upgrade.stdout);
    expect(warnings.filter((line: string) => line.startsWith("Changed in "))).toEqual(crossed);
    const repeated = await runCli(["refresh"], { cwd: dir, env });
    expect(repeated, repeated.stderr).toMatchObject({ status: 0 });
    expect(repeated.stdout).not.toContain("Changed in ");
  });

  it("adds the sole connected Postgres declaration without overwriting fixtures", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = tier2ProjectTree(instance.url);
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
      skills: [...coreProjectSkills, "patchy-postgres", "patchy-server"].sort()
    });
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toMatchObject({
      uses: {
        salesDb: { kind: "postgres", handle: "sales-db", id: "conn-sales", revision: 1 }
      }
    });
    expect(readFileSync(path.join(dir, "fixtures/postgres-sales-db.sql"), "utf8")).toBe(fixture);
  });

  it("adds a PostHog declaration with its client and skill, and no fixture", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = tier2ProjectTree(instance.url);
    const result = await runCli(["add", "posthog/product", "--as", "analytics", "--json"], {
      cwd: dir,
      env
    });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      alias: "analytics",
      declaration: { kind: "posthog", handle: "product" },
      generated: expect.arrayContaining([
        "patchy/_generated/uses/analytics.ts",
        "patchy/_generated/context/analytics.md"
      ]),
      skills: [...coreProjectSkills, "patchy-posthog", "patchy-server"].sort()
    });
    expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toContain(
      '"analytics": { kind: "posthog", handle: "product" }'
    );
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toMatchObject({
      uses: { analytics: { kind: "posthog", handle: "product", id: "conn-product", revision: 1 } }
    });
    expect(existsSync(path.join(dir, "fixtures"))).toBe(false);
    // Only a connected PostHog connection of that name is added; Postgres ones never are.
    const missing = await runCli(["add", "posthog/sales-db", "--json"], { cwd: dir, env });
    expect(missing).toMatchObject({ status: 2, stdout: "" });
    expect(JSON.parse(missing.stderr)).toMatchObject({ code: "connection_not_connected" });
  });

  it("adds a Pidgeon declaration with its client and skill, and removes them again", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = tier2ProjectTree(instance.url);
    const result = await runCli(["add", "pidgeon/support", "--json"], { cwd: dir, env });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      alias: "support",
      declaration: { kind: "pidgeon", handle: "support" },
      generated: expect.arrayContaining([
        "patchy/_generated/uses/support.ts",
        "patchy/_generated/context/support.md"
      ]),
      skills: [...coreProjectSkills, "patchy-pidgeon", "patchy-server"].sort()
    });
    expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toContain(
      '"support": { kind: "pidgeon", handle: "support" }'
    );
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toMatchObject({
      uses: { support: { kind: "pidgeon", handle: "support", id: "conn-support", revision: 1 } }
    });
    expect(readFileSync(path.join(dir, "patchy/_generated/context/support.md"), "utf8")).toContain(
      "Address: <code>support@acme.example</code>"
    );
    expect(readFileSync(path.join(dir, "patchy/_generated/uses/support.ts"), "utf8")).toContain(
      'export const address = "support@acme.example";'
    );
    expect(existsSync(path.join(dir, ".agents/skills/patchy-pidgeon/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(dir, "fixtures"))).toBe(false);
    // Only a connected Pidgeon connection of that name is added.
    const missing = await runCli(["add", "pidgeon/product", "--json"], { cwd: dir, env });
    expect(missing).toMatchObject({ status: 2, stdout: "" });
    expect(JSON.parse(missing.stderr)).toMatchObject({ code: "connection_not_connected" });
    const removed = await runCli(["remove", "support", "--json"], { cwd: dir, env });
    expect(removed).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).not.toContain("pidgeon");
    expect(existsSync(path.join(dir, "patchy/_generated/context/support.md"))).toBe(false);
    expect(existsSync(path.join(dir, "patchy/_generated/uses/support.ts"))).toBe(false);
    expect(existsSync(path.join(dir, ".agents/skills/patchy-pidgeon"))).toBe(false);
  });

  it("adds an Attio declaration with its context and skill, and removes them again", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = tier2ProjectTree(instance.url);
    const result = await runCli(["add", "attio/crm", "--json"], { cwd: dir, env });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      alias: "crm",
      declaration: { kind: "attio", handle: "crm" },
      generated: expect.arrayContaining([
        "patchy/_generated/uses/crm.ts",
        "patchy/_generated/context/crm.md"
      ]),
      skills: [...coreProjectSkills, "patchy-attio", "patchy-server"].sort()
    });
    expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toContain(
      '"crm": { kind: "attio", handle: "crm" }'
    );
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toMatchObject({
      uses: { crm: { kind: "attio", handle: "crm", id: "conn-crm", revision: 1 } }
    });
    const context = readFileSync(path.join(dir, "patchy/_generated/context/crm.md"), "utf8");
    expect(context).toContain("### <code>deals</code>: <code>Deals</code>");
    expect(context).toContain(
      "- <code>stage</code> (status): <code>Deal stage</code>. Options: <code>Lead</code>, <code>Won 🎉</code>"
    );
    expect(existsSync(path.join(dir, ".agents/skills/patchy-attio/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(dir, "fixtures"))).toBe(false);
    const removed = await runCli(["remove", "crm", "--json"], { cwd: dir, env });
    expect(removed).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).not.toContain("attio");
    expect(existsSync(path.join(dir, "patchy/_generated/context/crm.md"))).toBe(false);
    expect(existsSync(path.join(dir, ".agents/skills/patchy-attio"))).toBe(false);
  });

  it("adds the unstamped member directory and refuses removal until member columns are gone", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = tier2ProjectTree(instance.url);
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
export default defineConfig({ name: "member-assignments", tier: 2, uses: { members: members() },
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

  it("refuses a declaration on a tier 1 repo before generation, naming tier 2 handlers", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    for (const target of ["members", "posthog/product"]) {
      const result = await runCli(["add", target, "--json"], { cwd: dir, env });
      expect(result).toMatchObject({ status: 1, stdout: "" });
      const refusal = JSON.parse(result.stderr);
      expect(refusal).toMatchObject({ kind: "local", code: "tier_mismatch" });
      expect(refusal.error).toContain("uses requires tier 2");
      expect(refusal.error).toContain("server handlers");
      expect(refusal.error).toContain("patchy.config.ts is unchanged");
      expect(refusal.error).not.toContain("delete them all");
    }
    expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toBe(projectConfig);
    expect(instance.requests.some((request) => request.url === "/api/sdk/generate")).toBe(false);
  });

  it("leads a tier 1 repo that already declares several uses out by editing its config", async () => {
    const instance = await stubInstance(projectHandler);
    const declared = projectConfig.replace(
      "uses: {}",
      'uses: { members: { kind: "members" }, analytics: { kind: "posthog", handle: "product" } }'
    );
    const dir = projectTree(instance.url, declared);
    // Removing one leaves the other, which tier 1 still can't declare.
    const removed = await runCli(["remove", "analytics", "--json"], { cwd: dir, env });
    expect(removed).toMatchObject({ status: 1, stdout: "" });
    const refusal = JSON.parse(removed.stderr);
    expect(refusal).toMatchObject({ kind: "local", code: "tier_mismatch" });
    expect(refusal.error).toContain('cannot declare "members"');
    expect(refusal.error).toContain("delete them all from uses in patchy.config.ts");
    expect(readFileSync(path.join(dir, "patchy.config.ts"), "utf8")).toBe(declared);
    // As the refusal says: delete them all from uses, then refresh.
    writeFileSync(path.join(dir, "patchy.config.ts"), projectConfig);
    const refreshed = await runCli(["refresh", "--json"], { cwd: dir, env });
    expect(refreshed, refreshed.stderr).toMatchObject({ status: 0 });
    expect(readJson(path.join(dir, "patchy/_generated/manifest.json"))).toHaveProperty("uses", {});
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
    const dir = tier2ProjectTree(instance.url);
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

  it("refuses a shared but undeclarable store before generation", async () => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url.split("?")[0] === "/api/patches/directory")
        return respond(200, {
          ...projectSource,
          inventory: {
            tables: [],
            stores: [
              {
                ...projectSource.inventory.stores[0],
                shared: true,
                declarable: false,
                reason: "source_off"
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
  });

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

  it("relays why pnpm could not install the release when refresh fails", async () => {
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
        /^Dependency installation failed; the previous project set is preserved\.\npnpm: .*404/
      )
    });
    expect(readFileSync(path.join(dir, "package.json"), "utf8")).toBe(originalPackage);
  });

  it("tells a refresh that another live command holds the repo, in text and JSON", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    const holder = await ManagedProject.begin(dir);
    try {
      const json = await runCli(["refresh", "--json"], { cwd: dir, env });
      expect(json).toMatchObject({ status: 1, stdout: "" });
      expect(JSON.parse(json.stderr)).toEqual({
        ok: false,
        kind: "local",
        error: new ProjectLocked({ holder: "live" }).message
      });
      const text = await runCli(["refresh"], { cwd: dir, env });
      expect(text.status).toBe(1);
      expect(text.stderr).toContain(new ProjectLocked({ holder: "live" }).message);
    } finally {
      await holder.finish(false);
    }
  });

  it("reinstalls matching pins after a killed refresh, then clears its lock and transaction", async () => {
    const instance = await stubInstance(
      projectHandler,
      () => CURRENT_RELEASE,
      readFileSync(
        path.join(packageDir, `artifacts/patchy-${CURRENT_RELEASE}-${releaseArtifact.digest}.tgz`)
      )
    );
    const dir = projectTree(instance.url);
    // This PID is alive, so only the birth mismatch proves the recorded owner gone.
    mkdirSync(path.join(dir, ".patchy/refresh-lock"), { recursive: true });
    writeFileSync(
      path.join(dir, ".patchy/refresh-lock/dead.json"),
      JSON.stringify({ pid: process.pid, birth: "stale", nonce: "dead" })
    );
    mkdirSync(path.join(dir, ".patchy/refresh-orphan/node_modules"), { recursive: true });
    // Roots the killed run had not swapped yet still hold the previous generation.
    const stale = ["patchy/_generated/client.ts", ".agents/skills/patchy-loop/SKILL.md"];
    for (const file of stale) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), "previous generation\n");
    }
    const store = tempDir();
    const result = await runCli(["refresh", "--json"], {
      cwd: dir,
      env: {
        ...env,
        pnpm_config_registry: instance.url,
        pnpm_config_store_dir: path.join(store, "store"),
        pnpm_config_cache_dir: path.join(store, "cache"),
        pnpm_config_update_notifier: "false"
      }
    });
    expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, changed: { pin: false } });
    expect(existsSync(path.join(dir, "pnpm-lock.yaml"))).toBe(true);
    expect(readdirSync(path.join(dir, ".patchy"))).toEqual([]);
    for (const file of stale)
      expect(readFileSync(path.join(dir, file), "utf8")).not.toBe("previous generation\n");
  }, 30_000); // One isolated pnpm install of the real release archive.

  // The refreshing CLI checks nothing itself: an older release's pinned CLI that relays the
  // installed release's toolchain reply, as every release's refresh does, hears the same warnings.
  it("warns with the newly installed release's checks, TypeScript and crossed releases included, whichever CLI refreshes from an older release", async () => {
    const required = {
      ...toolchain,
      vite: { testedAgainst: "99.0.0", accepted: "^99.0.0" },
      typescript: { testedAgainst: "99.0.0", accepted: "^99.0.0" }
    };
    const instance = await stubInstance(
      projectHandler,
      () => CURRENT_RELEASE,
      readFileSync(
        path.join(packageDir, `artifacts/patchy-${CURRENT_RELEASE}-${releaseArtifact.digest}.tgz`)
      ),
      required
    );
    const previousPin = `${instance.url}/sdk/patchy-0.21.0-${"1".repeat(64)}.tgz`;
    const linked = (name: string) =>
      `link:${path.dirname(require.resolve(`${name}/package.json`, { paths: [packageDir] }))}`;
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
          devDependencies: {
            patchy: previousPin,
            vite: linked("vite"),
            typescript: linked("typescript")
          }
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
      mkdirSync(path.join(dir, "patchy/_generated"), { recursive: true });
      writeFileSync(
        path.join(dir, "patchy/_generated/index.json"),
        JSON.stringify({ release: "0.21.0" })
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
      release: { from: "0.21.0", to: CURRENT_RELEASE },
      changed: { pin: true },
      warnings: expect.arrayContaining([
        expect.stringContaining(`Loaded vite ${toolchain.vite.testedAgainst} is unsupported`),
        expect.stringContaining(
          `This repo has TypeScript ${toolchain.typescript.testedAgainst}; this release publishes only TypeScript ^99.0.0`
        ),
        expect.stringMatching(/^Changed in 0\.22\.0: /)
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

  it("refuses init from a CLI behind its instance before asking for a purpose or writing", async () => {
    const instance = await stubInstance(projectHandler, () => "9.9.9");
    const parent = tempDir();
    const result = await runCli(["init", "notes", "--api-url", instance.url, "--json"], {
      cwd: parent,
      env
    });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    const failure = JSON.parse(result.stderr);
    expect(failure).toMatchObject({ kind: "local", code: "release_mismatch" });
    expect(failure.error).toContain(`curl -fsS '${instance.url}/install.mjs'`);
    expect(instance.requests.map(({ url }) => url)).toEqual(["/api/me", "/api/release"]);
    expect(existsSync(path.join(parent, "notes"))).toBe(false);
  });

  // The packed tier 2 e2e initializes tier 2; this owns the offline pin and both tier transitions.
  it("initializes a tier 1 typechecking tree offline, refuses reinitialization and preserves sources across tier changes", async () => {
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
      "1",
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
      tier: 1,
      generated: expect.arrayContaining([
        "patchy/_generated/client.ts",
        "patchy/_generated/index.json",
        "patchy/_generated/manifest.json"
      ]),
      skills: coreProjectSkills,
      installed: true
    });
    const authoredPaths = [
      "patchy.config.ts",
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "src/main.tsx",
      "src/App.tsx",
      "src/styles.css",
      "index.html",
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
    // TypeScript 7 exits 1 when it reports errors.
    await expect(exec("pnpm", ["typecheck"], compilerOptions)).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringMatching(/src\/App\.tsx\(\d+,\d+\): error TS2339: Property 'tables'/)
    });

    writeFileSync(path.join(dir, "patchy.config.ts"), config);
    const downgraded = await runCli(["refresh", "--json"], refreshOptions);
    expect(downgraded).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(downgraded.stdout)).toMatchObject({
      ok: true,
      changed: { pin: true }
    });
    expect(readJson(path.join(dir, "package.json"))).not.toHaveProperty("devDependencies.workerd");
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
  }, 120_000); // Real archives, isolated pnpm installs and tier-transition typechecks can exceed 30 seconds.
});

describe("patchy pull", () => {
  const env = { PATCHY_API_TOKEN: "pp_project" };
  const base64 = (text: string) => Buffer.from(text).toString("base64");
  const pulled = (overrides: Record<string, unknown>) => ({
    ok: true,
    patchId: "abcdefghijkl",
    name: "team-notes",
    state: "live",
    versionNumber: 3,
    tier: 1,
    owner: { id: identity.user.id, name: identity.user.name },
    description: "Team notes",
    descriptionUpdatedAt: null,
    kind: "repo",
    files: [],
    ...overrides
  });
  const serving = (route: string, status: number, body: unknown) =>
    stubInstance((request, respond) => {
      if (request.url === "/api/me") return respond(200, identity);
      if (request.url.split("?")[0] === route) return respond(status, body);
      respond(404, { ok: false, error: "Unexpected fixture route." });
    });

  it("writes a file-born page as its one file, with the publish line for it", async () => {
    const instance = await serving(
      "/api/patches/launch-plan/repo",
      200,
      pulled({
        name: "launch-plan",
        tier: 1,
        kind: "file",
        files: [{ path: "Launch Plan.html", contents: base64("<p>Plan</p>") }]
      })
    );
    const parent = tempDir();
    const result = await runCli(
      ["pull", `${instance.url}/acme/launch-plan`, "--api-url", instance.url],
      {
        cwd: parent,
        env
      }
    );
    expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
    const file = path.join(parent, "launch-plan", "Launch Plan.html");
    expect(readFileSync(file, "utf8")).toBe("<p>Plan</p>");
    expect(result.stdout.split("\n")).toEqual([
      `Pulled launch-plan v3 into ${path.join(parent, "launch-plan")} (1 file).`,
      `It is one HTML file. Publish a change with: patchy publish '${file}' --patch abcdefghijkl --api-url ${instance.url}`,
      ""
    ]);
  });

  it("keeps a retired patch's files, names its owner, and leaves setup until it's restored", async () => {
    const instance = await serving(
      "/api/patches/team-notes/repo",
      200,
      pulled({
        state: "retired",
        owner: { id: "usr_colleague", name: "Colleague" },
        files: [
          { path: "patchy.json", contents: base64('{"instance":"https://old.example","extra":1}') },
          { path: "src/App.tsx", contents: base64("export const App = 1;") },
          { path: "scripts/check.sh", contents: base64("#!/bin/sh\n"), executable: true }
        ]
      })
    );
    const parent = tempDir();
    const result = await runCli(
      ["pull", "team-notes", "--state", "retired", "--api-url", instance.url, "--json"],
      { cwd: parent, env }
    );
    expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
    const dir = path.join(parent, "team-notes");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      dir,
      state: "retired",
      mine: false,
      setUp: false,
      warnings: [
        `team-notes is retired, so its dependencies and generated files weren't set up. Once it's restored, run patchy refresh in ${dir}.`
      ]
    });
    expect(readJson(path.join(dir, "patchy.json"))).toEqual({
      instance: instance.url,
      extra: 1,
      patch: "abcdefghijkl",
      version: 3,
      description: "Team notes",
      descriptionSyncedAt: null
    });
    expect(readFileSync(path.join(dir, "src/App.tsx"), "utf8")).toBe("export const App = 1;");
    expect(statSync(path.join(dir, "scripts/check.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(path.join(dir, "src/App.tsx")).mode & 0o111).toBe(0);
    expect(instance.requests.find((request) => request.url.includes("/repo"))?.url).toBe(
      "/api/patches/team-notes/repo?state=retired"
    );
    expect(instance.requests.some((request) => request.url === "/api/sdk/generate")).toBe(false);
  });

  it("keeps the files and says how to finish when setup fails, leaving no staging behind", async () => {
    // The stub answers no patch detail, so refresh's description sync fails.
    const instance = await serving(
      "/api/patches/team-notes/repo",
      200,
      pulled({ files: [{ path: "src/App.tsx", contents: base64("export const App = 1;") }] })
    );
    const parent = tempDir();
    const result = await runCli(["pull", "team-notes", "--api-url", instance.url, "--json"], {
      cwd: parent,
      env
    });
    expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
    const dir = path.join(parent, "team-notes");
    const document = JSON.parse(result.stdout);
    expect(document).toMatchObject({ ok: true, setUp: false });
    expect(document.warnings).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Its dependencies and generated files weren't set up: .+\\nFix that, then run patchy refresh in ${dir.replaceAll("/", "\\/")}\\.$`,
          "s"
        )
      )
    ]);
    expect(readFileSync(path.join(dir, "src/App.tsx"), "utf8")).toBe("export const App = 1;");
    expect(readdirSync(parent)).toEqual(["team-notes"]);
  });

  it("relays a version with nothing to pull, and refuses a version number below 1 first", async () => {
    const instance = await serving("/api/patches/team-notes/repo", 404, {
      ok: false,
      code: "no_repo",
      error: "Version 3 of team-notes was published without its repo, so there is nothing to pull.",
      versionNumber: 3,
      owner: { id: "usr_colleague", name: "Colleague" }
    });
    const parent = tempDir();
    const none = await runCli(["pull", "team-notes", "--api-url", instance.url, "--json"], {
      cwd: parent,
      env
    });
    expect(none).toMatchObject({ status: 2, stdout: "" });
    expect(JSON.parse(none.stderr)).toMatchObject({
      ok: false,
      kind: "rejected",
      code: "no_repo",
      versionNumber: 3,
      owner: { id: "usr_colleague", name: "Colleague" }
    });
    expect(readdirSync(parent)).toEqual([]);

    const sent = () =>
      instance.requests.filter((request) => request.url.startsWith("/api/")).length;
    const before = sent();
    const zero = await runCli(["pull", "team-notes", "--version", "0", "--json"], {
      cwd: parent,
      env
    });
    expect(zero).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(zero.stderr).error).toBe("--version must be a version number, from 1.");
    expect(sent()).toBe(before);
  });
});
