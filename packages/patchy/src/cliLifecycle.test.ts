// Lifecycle verbs, their recovery and discovery through the bundled CLI.
import * as Struct from "effect/Struct";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { sha256 } from "@patchy/core";
import { CURRENT_RELEASE, MANIFEST_VERSION, PublishRequest } from "@patchy/api";
import {
  decodeDescriptionRequest,
  decodeForceRequest,
  htmlFile,
  identity,
  projectConnections,
  projectHandler,
  projectSource,
  projectTree,
  publish,
  readJson,
  runCli,
  stubInstance,
  stubPublishingInstance,
  tempDir,
  validHtml
} from "./test/cli.js";

describe("patch lifecycle commands", () => {
  const patchId = "abcdefghijkl";
  const owner = { id: "usr_other", name: "Sam" };
  const dependants = [{ patchId: "mnopqrstuvwx", name: "office-map", owner }];
  const sources = [
    { patchId: "mnopqrstuvwx", name: "orders", table: "orders", state: "retired" },
    { patchId: "zyxwvutsrqpo", table: "people", state: "gone" }
  ];
  const purgeAt = "2026-10-15T00:00:00.000Z";
  const cases = [
    {
      verb: "retire",
      args: [],
      method: "POST",
      suffix: "/retire",
      response: { ok: true, patchId, state: "retired", retiredAt: "2026-09-15T00:00:00.000Z" },
      text: "Retired patch"
    },
    {
      verb: "delete",
      args: ["--yes"],
      method: "DELETE",
      suffix: "",
      response: {
        ok: true,
        patchId,
        state: "deleted",
        deletedAt: "2026-09-15T00:00:00.000Z",
        purgeAt
      },
      text: purgeAt
    },
    {
      verb: "restore",
      args: [],
      method: "POST",
      suffix: "/restore",
      response: { ok: true, patchId, state: "live" },
      text: "Restored patch"
    },
    {
      verb: "rollback",
      args: ["1"],
      method: "POST",
      suffix: "/rollback",
      response: {
        ok: true,
        patchId,
        currentVersion: 1,
        address: "http://instance.test/company/page"
      },
      text: "Version: 1"
    },
    {
      verb: "describe",
      args: ["A useful tool"],
      method: "PUT",
      suffix: "/description",
      response: {
        ok: true,
        patchId,
        description: "A useful tool",
        descriptionUpdatedAt: "2026-09-15T00:00:00.000Z"
      },
      text: "A useful tool"
    }
  ];

  it.each(cases)(
    "sends $verb to its route for an explicit target and prints the JSON document",
    async ({ verb, args, method, suffix, response }) => {
      const instance = await stubInstance((request, respond) => {
        if (request.method !== method || request.url !== `/api/patches/${patchId}${suffix}`)
          return respond(404, { ok: false, error: "Patch not found." });
        respond(200, response);
      });
      const result = await runCli([verb, ...args, "--patch", patchId, "--json"], {
        env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
      });
      expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual(response);
    }
  );

  // Every verb resolves its target through one helper; describe also rewrites the repo.
  it("resolves repo and cached-file targets, and describe records the repo's new description", async () => {
    const instance = await stubInstance((request, respond) => {
      const entry = cases.find(
        ({ method, suffix }) =>
          request.method === method && request.url === `/api/patches/${patchId}${suffix}`
      );
      if (entry === undefined) return respond(404, { ok: false, error: "Patch not found." });
      respond(200, entry.response);
    });
    const dir = projectTree(instance.url);
    const config = {
      instance: instance.url,
      patch: patchId,
      description: "Old description",
      authorField: 7
    };
    writeFileSync(path.join(dir, "patchy.json"), JSON.stringify(config));
    const file = path.join(dir, "page.html");
    const cache = {
      hosts: {
        [instance.url]: {
          files: {
            [file]: {
              patchId,
              publicUrl: "http://instance.test/company/page",
              latestVersionNumber: 3,
              updatedAt: "unchanged"
            }
          }
        }
      }
    };
    writeFileSync(path.join(dir, "patches.json"), JSON.stringify(cache));
    const options = {
      cwd: dir,
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    const repo = await runCli(["retire"], options);
    expect(repo, repo.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(repo.stdout).toContain("Retired patch");
    expect(readJson(path.join(dir, "patchy.json"))).toEqual(config);
    const cached = await runCli(["retire", file, "--json"], options);
    expect(cached, cached.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(cached.stdout)).toEqual(cases[0]!.response);
    expect(readJson(path.join(dir, "patches.json"))).toEqual(cache);
    const described = await runCli(["describe", "A useful tool"], options);
    expect(described, described.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(described.stdout).toContain("A useful tool");
    expect(readJson(path.join(dir, "patchy.json"))).toEqual({
      ...config,
      description: "A useful tool",
      descriptionSyncedAt: "2026-09-15T00:00:00.000Z"
    });
  });

  it.each([
    {
      verb: "retire",
      args: [],
      status: 409,
      code: "has_dependants",
      fields: { dependants },
      text: "office-map"
    },
    {
      verb: "delete",
      args: ["--yes"],
      status: 409,
      code: "has_dependants",
      fields: { dependants },
      text: "Sam"
    },
    {
      verb: "restore",
      args: [],
      status: 409,
      code: "sources_off",
      fields: { sources },
      text: "gone"
    },
    {
      verb: "restore",
      args: [],
      status: 409,
      code: "sources_off",
      fields: { sources: [{ patchId: "zyxwvutsrqpo", store: "documents", state: "gone" }] },
      text: "/ documents: gone"
    },
    {
      verb: "restore",
      args: [],
      status: 409,
      code: "patch_deleted",
      fields: { purgeAt },
      text: purgeAt
    },
    {
      verb: "rollback",
      args: ["1"],
      status: 409,
      code: "wrong_state",
      fields: { state: "retired" },
      text: "retired"
    },
    {
      verb: "describe",
      args: ["New description"],
      status: 409,
      code: "wrong_state",
      fields: { state: "deleted" },
      text: "deleted"
    },
    // Every verb renders not_owner through the same refusal path.
    { verb: "retire", args: [], status: 403, code: "not_owner", fields: { owner }, text: "Sam" }
  ])(
    "preserves $verb $code refusal details and actionable text",
    async ({ verb, args, status, code, fields, text }) => {
      const instance = await stubInstance((_, respond) =>
        respond(status, {
          ok: false,
          code,
          error: `Action refused: ${"state" in fields ? fields.state : code}.`,
          ...fields
        })
      );
      const dir = tempDir();
      const file = path.join(dir, "page.html");
      const cache = JSON.stringify({
        hosts: {
          [instance.url]: {
            files: {
              [file]: {
                patchId,
                publicUrl: "http://instance.test/page",
                latestVersionNumber: 1,
                updatedAt: "unchanged"
              }
            }
          }
        }
      });
      writeFileSync(path.join(dir, "patches.json"), cache);
      const options = {
        stateDir: dir,
        env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
      };
      for (const json of [false, true]) {
        const result = await runCli(
          [verb, ...args, "--patch", patchId, ...(json ? ["--json"] : [])],
          options
        );
        expect(result.status).toBe(2);
        if (json) {
          expect(result.stdout).toBe("");
          expect(JSON.parse(result.stderr)).toMatchObject({
            ok: false,
            kind: "rejected",
            code,
            ...fields
          });
        }
        const message = json ? JSON.parse(result.stderr).error : result.stderr.trim();
        expect(message).toContain(text);
        if (code === "has_dependants" || code === "sources_off")
          expect(message).toMatch(/Ask the person you are working for before forcing\.$/);
        if (code === "not_owner") {
          expect(message).toContain("reassign");
          expect(message).not.toMatch(/new patch|--new|Remove patch/i);
        }
        expect(readFileSync(path.join(dir, "patches.json"), "utf8")).toBe(cache);
      }
    }
  );

  it.each(["retire", "delete", "restore"])(
    "requires --force to proceed past %s dependency checks",
    async (verb) => {
      const instance = await stubInstance((request, respond) => {
        const forced =
          verb === "delete"
            ? request.url.endsWith("?force=true")
            : decodeForceRequest(request.body).force;
        if (!forced)
          return respond(409, {
            ok: false,
            code: verb === "restore" ? "sources_off" : "has_dependants",
            error: "Readers would break.",
            ...(verb === "restore" ? { sources } : { dependants })
          });
        respond(200, cases.find((entry) => entry.verb === verb)!.response);
      });
      const options = { env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" } };
      const args = [verb, "--patch", patchId, ...(verb === "delete" ? ["--yes"] : []), "--json"];
      expect((await runCli(args, options)).status).toBe(2);
      expect((await runCli([...args, "--force"], options)).status).toBe(0);
    }
  );

  it("refuses noninteractive deletion without --yes, including redirected yes and --force", async () => {
    const instance = await stubInstance((_, respond) => respond(500, {}));
    for (const extra of [[], ["--force"], ["--json"]]) {
      const result = await runCli(["delete", "--patch", patchId, ...extra], {
        input: "yes\n",
        env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--yes");
    }
    const agent = await runCli(["delete", "--patch", patchId], {
      terminalInput: "",
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner", AI_AGENT: "" }
    });
    expect(agent.status).toBe(1);
    expect(agent.stdout).toContain("--yes");
    expect(instance.requests).toEqual([]);
  });

  it.each(["y\n", "n\n"])("confirms interactive delete before any request: %j", async (answer) => {
    const instance = await stubInstance((_, respond) => respond(200, cases[1]!.response));
    const result = await runCli(["delete", "--patch", patchId], {
      terminalInput: answer,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    });
    expect(result.status).toBe(answer === "y\n" ? 0 : 1);
    expect(instance.requests).toHaveLength(answer === "y\n" ? 1 : 0);
    if (answer === "n\n") expect(result.stdout).toContain("Nothing was done");
  });

  // Every verb resolves its target through one helper; retire stands for them.
  it("refuses conflicting and unpublished targets locally", async () => {
    const instance = await stubInstance((_, respond) => respond(500, {}));
    const dir = projectTree(instance.url);
    const options = {
      cwd: dir,
      env: { PATCHY_API_TOKEN: "pp_owner", PATCHY_API_URL: instance.url }
    };
    for (const selected of [[], ["page.html", "--patch", patchId]]) {
      const result = await runCli(["retire", ...selected, "--json"], options);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({ kind: "local" });
    }
    expect(instance.requests).toEqual([]);
  });

  // Project.test.ts owns each DescriptionText refusal; describe adds its own argument checks.
  it("refuses missing or conflicting description arguments and invalid text locally", async () => {
    const instance = await stubInstance((request, respond) =>
      respond(200, {
        ok: true,
        patchId,
        description: decodeDescriptionRequest(request.body).description,
        descriptionUpdatedAt: null
      })
    );
    const options = { env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" } };
    for (const args of [[], ["text\u0007"], ["page.html", "text", "--clear"]]) {
      const result = await runCli(["describe", ...args, "--patch", patchId, "--json"], options);
      expect(result.status).toBe(1);
    }
    expect(instance.requests).toEqual([]);
  });

  it("clears descriptions explicitly and normalizes nonempty text", async () => {
    const instance = await stubInstance((request, respond) =>
      respond(200, {
        ok: true,
        patchId,
        description: decodeDescriptionRequest(request.body).description,
        descriptionUpdatedAt: null
      })
    );
    const options = { env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" } };
    const cleared = await runCli(["describe", "--clear", "--patch", patchId], options);
    expect(cleared).toMatchObject({ status: 0, stderr: "" });
    expect(cleared.stdout).toContain("(no description)");
    const normalized = await runCli(
      ["describe", "  A \n useful   tool  ", "--patch", patchId, "--json"],
      options
    );
    expect(JSON.parse(normalized.stdout)).toMatchObject({ description: "A useful tool" });
  });

  it("preserves a repo target changed while describe was in flight", async () => {
    let repoFile = "";
    let changed = "";
    const instance = await stubInstance((_, respond) => {
      changed = JSON.stringify({
        instance: instance.url,
        patch: "mnopqrstuvwx",
        description: "Other patch",
        authorField: 8
      });
      writeFileSync(repoFile, changed);
      respond(200, {
        ok: true,
        patchId,
        description: "Cloud text",
        descriptionUpdatedAt: "2026-09-15T00:00:00.000Z"
      });
    });
    const dir = projectTree(instance.url);
    repoFile = path.join(dir, "patchy.json");
    writeFileSync(
      repoFile,
      JSON.stringify({ instance: instance.url, patch: patchId, description: "Original" })
    );
    const result = await runCli(["describe", "Cloud text", "--json"], {
      cwd: dir,
      env: { PATCHY_API_TOKEN: "pp_owner" }
    });
    expect(result.status).toBe(1);
    expect(readFileSync(repoFile, "utf8")).toBe(changed);
  });

  it.each(["0", "-1", "1.5"])(
    "refuses invalid rollback version %s before HTTP",
    async (version) => {
      const instance = await stubInstance((_, respond) => respond(500, {}));
      const result = await runCli(["rollback", version, "--patch", patchId, "--json"], {
        env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
      });
      expect(result.status).toBe(1);
      expect(instance.requests).toEqual([]);
    }
  );
});

describe("publish description and lifecycle recovery", () => {
  it("sends file metadata and force, but replays the saved request before today's flags", async () => {
    let lost = true;
    const instance = await stubPublishingInstance((request, respond, disconnect) => {
      if (lost) return disconnect();
      const sent = Schema.decodeUnknownSync(PublishRequest)(request.body);
      respond(201, {
        ...publish(201, "abcdefghijkl", 1),
        description: sent.metadata.description,
        descriptionUpdatedAt: "2026-09-15T00:00:00.000Z"
      });
    });
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const options = {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect(
      (
        await runCli(
          ["publish", file, "--description", "  Original \n text ", "--force", "--json"],
          options
        )
      ).status
    ).toBe(3);
    lost = false;
    const recovered = await runCli(
      ["publish", "missing.html", "--description", "x".repeat(501), "--json"],
      options
    );
    expect(recovered).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      description: "Original text",
      descriptionUpdatedAt: "2026-09-15T00:00:00.000Z"
    });
    const sent = instance.requests.filter((request) => request.url === "/api/publish");
    expect(sent[0]!.body).toEqual(sent[1]!.body);
    expect(sent[0]!.body).toMatchObject({
      force: true,
      metadata: { description: "Original text" }
    });
    expect(instance.requests.map((request) => request.url)).toEqual([
      "/api/me",
      "/api/release",
      "/api/publish",
      "/api/me",
      "/api/publish"
    ]);
  });

  it("refuses --description in repo mode and invalid file descriptions without publishing", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = projectTree(instance.url);
    const file = htmlFile(dir, "page.html", validHtml);
    const options = {
      cwd: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    const repo = await runCli(["publish", "--description", "Wrong home", "--json"], options);
    expect(repo.status).toBe(1);
    expect(JSON.parse(repo.stderr).error).toContain("patchy.json");
    const invalid = await runCli(
      ["publish", file, "--description", "x".repeat(501), "--json"],
      options
    );
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      code: "invalid_description",
      kind: "local"
    });
    expect(instance.requests.every((request) => request.url === "/api/me")).toBe(true);
  });

  // Api.test.ts owns the full definitive list; these prove repo mode clears without rebinding.
  it.each([
    {
      status: 403,
      code: "not_owner",
      fields: { owner: { id: "other", name: "Sam" } },
      text: "Sam"
    },
    {
      status: 409,
      code: "patch_deleted",
      fields: { purgeAt: "2026-10-15T00:00:00.000Z" },
      text: "2026-10-15"
    }
  ])(
    "clears definitive $code retries without changing the repo identity",
    async ({ status, code, fields, text }) => {
      const instance = await stubPublishingInstance((_, respond) =>
        respond(status, { ok: false, code, error: "Refused.", ...fields })
      );
      const dir = projectTree(instance.url);
      const repoFile = path.join(dir, "patchy.json");
      const repo = JSON.stringify({
        instance: instance.url,
        patch: "abcdefghijkl",
        description: "Local description",
        authorField: 7
      });
      writeFileSync(repoFile, repo);
      const attemptPath = path.join(dir, ".patchy/publish", sha256(instance.url), "attempt");
      mkdirSync(attemptPath, { recursive: true });
      writeFileSync(
        path.join(attemptPath, `${sha256("lifecycle-retry")}.json`),
        JSON.stringify({
          ownerUserId: identity.user.id,
          target: { mode: "repo" },
          request: {
            publishKey: "lifecycle-retry",
            patchId: "abcdefghijkl",
            html: validHtml,
            metadata: {},
            manifest: {
              manifestVersion: MANIFEST_VERSION,
              release: CURRENT_RELEASE,
              tier: 0,
              tables: {},
              files: {},
              uses: {}
            }
          }
        })
      );
      const result = await runCli(
        ["publish", "--description", "ignored during recovery", "--force", "--json"],
        { cwd: dir, env: { PATCHY_API_TOKEN: "pp_owner" } }
      );
      expect(result.status).toBe(2);
      const failure = JSON.parse(result.stderr);
      expect(failure).toMatchObject({ kind: "rejected", code, ...fields });
      expect(failure.error).toContain(text);
      expect(failure.error).not.toMatch(/new patch|--new|Remove patch/i);
      expect(existsSync(attemptPath)).toBe(false);
      expect(readFileSync(repoFile, "utf8")).toBe(repo);
      expect(instance.requests.map((request) => request.url)).toEqual(["/api/me", "/api/publish"]);
    }
  );
});

describe("patchy list", () => {
  it("merges discovery under a saved login without reading patchy.json", async () => {
    const patches = [
      Struct.omit(projectSource, ["title", "inventory", "reads", "descriptionUpdatedAt"])
    ];
    const instance = await stubInstance((request, respond) => {
      const url = new URL(request.url, "http://instance.test");
      if (url.pathname === "/api/patches") {
        expect(url.searchParams.get("state")).toBe("live");
        return respond(200, { patches });
      }
      if (url.pathname === "/api/connections") return respond(200, projectConnections);
      respond(404, { ok: false, error: "Not found." });
    });
    const stateDir = tempDir();
    const saved = await runCli(["auth", "set", "--token-stdin", "--api-url", instance.url], {
      stateDir,
      input: "pp_discovery\n"
    });
    expect(saved.status).toBe(0);
    writeFileSync(path.join(stateDir, "patchy.json"), "not JSON");
    const result = await runCli(["list", "--json"], { stateDir });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      patches,
      connections: projectConnections.connections
    });
    expect(
      instance.requests.every((request) => request.authorization === "Bearer pp_discovery")
    ).toBe(true);
  });

  const env = { PATCHY_API_TOKEN: "pp_discovery" };
  const summary = Struct.omit(projectSource, [
    "title",
    "inventory",
    "reads",
    "descriptionUpdatedAt"
  ]);
  const primitive = {
    kind: "table",
    name: "people",
    description: "One person per id.",
    shared: true,
    declarable: true,
    schemaRevision: 7,
    columns: [
      { name: "id", kind: "text", optional: false },
      { name: "nickname", kind: "text", optional: true, default: null },
      { name: "active", kind: "boolean", optional: false, default: false },
      { name: "count", kind: "integer", optional: false, default: 0 },
      { name: "manager", kind: "ref", optional: true, ref: "people" }
    ],
    indexes: [{ name: "by_nickname", columns: ["nickname"], unique: true }]
  };

  it("groups ids before names and prints lifecycle, owner and description metadata", async () => {
    const patches = [
      { ...summary, description: "First line\nSecond line", currentVersion: 7 },
      {
        ...summary,
        id: "zyxwvutsrqpo",
        name: "archive",
        mine: false,
        description: "",
        owner: { id: "other", name: "Sam", deactivated: true },
        state: "deleted",
        deletedAt: new Date().toISOString(),
        purgeAt: new Date(Date.now() + 18 * 86_400_000).toISOString()
      }
    ];
    const instance = await stubInstance((request, respond) => {
      const url = new URL(request.url, "http://instance.test");
      if (url.pathname === "/api/patches") {
        expect(url.searchParams.get("state")).toBe("all");
        return respond(200, { patches });
      }
      respond(200, projectConnections);
    });
    for (const args of [["list"], ["list", "patches"]]) {
      const result = await runCli([...args, "--state", "all", "--api-url", instance.url], { env });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain(`Yours:\n${summary.id}  directory  live`);
      expect(result.stdout).toContain("v7  First line");
      expect(result.stdout).not.toContain("Second line");
      expect(result.stdout).toContain(
        "Company:\nzyxwvutsrqpo  archive  deleted · gone in 18 days  Sam · deactivated"
      );
      expect(result.stdout).toContain("(no description)");
      expect(result.stdout).toContain("Connections:\nsales-db");
      expect(result.stdout).toContain("patchy add postgres/sales-db");
      expect(result.stdout).not.toContain("patchy add postgres/archive-db");
    }
  });

  it("passes top-level state and ownership filters without filtering connections", async () => {
    const instance = await stubInstance((request, respond) => {
      const url = new URL(request.url, "http://instance.test");
      if (url.pathname === "/api/patches") {
        expect(url.searchParams.get("state")).toBe("retired");
        expect(url.searchParams.get("mine")).toBe("true");
        return respond(200, { patches: [] });
      }
      expect(url.search).toBe("");
      respond(200, projectConnections);
    });
    const result = await runCli(
      ["list", "patches", "--mine", "--state", "retired", "--json", "--api-url", instance.url],
      { env }
    );
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      patches: [],
      connections: projectConnections.connections
    });
  });

  it("drills into a pasted address and preserves the inventory and retained reads", async () => {
    const detail = {
      ...projectSource,
      inventory: {
        tables: [
          {
            ...projectSource.inventory.tables[0],
            hint: `patchy add shared-table ${summary.id}/people`
          },
          {
            name: "private",
            description: "Private notes",
            shared: false,
            declarable: false,
            reason: "not_shared",
            hint: "Not shared; ask Sam."
          }
        ],
        stores: [
          {
            name: "photos",
            description: "Profile photos",
            shared: true,
            declarable: true,
            hint: `patchy add shared-store ${summary.id}/photos`
          }
        ]
      },
      reads: [
        { alias: "old", patchId: "zyxwvutsrqpo", table: "orders", state: "gone" },
        { alias: "assets", patchId: "zyxwvutsrqpo", store: "documents", state: "gone" }
      ]
    };
    const instance = await stubInstance((request, respond) => {
      expect(new URL(request.url, "http://instance.test").pathname).toBe("/api/patches/directory");
      respond(200, detail);
    });
    for (const json of [false, true]) {
      const result = await runCli(
        [
          "list",
          "https://patchy.test/company/directory/?view=1#read",
          ...(json ? ["--json"] : []),
          "--api-url",
          instance.url
        ],
        { env }
      );
      expect(result).toMatchObject({ status: 0, stderr: "" });
      if (json) expect(JSON.parse(result.stdout)).toEqual(detail);
      else {
        expect(result.stdout).toContain(`${summary.id}  directory`);
        expect(result.stdout).toContain("Company directory");
        expect(result.stdout).toContain("Tables:");
        expect(result.stdout).toContain(`patchy add shared-table ${summary.id}/people`);
        expect(result.stdout).toContain("Not shared; ask Sam.");
        expect(result.stdout).toContain("Stores:\n  photos: Profile photos");
        expect(result.stdout).toContain("Reads:\n  old: zyxwvutsrqpo orders  gone");
        expect(result.stdout).toContain("assets: zyxwvutsrqpo documents  gone");
      }
    }
  });

  it("distinguishes an unavailable inventory from an empty patch", async () => {
    const instance = await stubInstance((_, respond) =>
      respond(200, { ...projectSource, inventory: null })
    );
    const result = await runCli(["list", "directory", "--api-url", instance.url], { env });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Tables: unavailable");
    expect(result.stdout).toContain("Stores: unavailable");
    expect(result.stdout).not.toContain("none");
    const json = await runCli(["list", "directory", "--json", "--api-url", instance.url], { env });
    expect(JSON.parse(json.stdout).inventory).toBeNull();
  });

  it.each(["table", "store"])(
    "prints a %s's schema without losing explicit defaults",
    async (kind) => {
      const body =
        kind === "table"
          ? primitive
          : {
              ...primitive,
              kind,
              name: "photos",
              shared: true,
              declarable: true,
              hint: `patchy add shared-store ${summary.id}/photos`,
              columns: [],
              indexes: []
            };
      const instance = await stubInstance((request, respond) => {
        expect(new URL(request.url, "http://instance.test").pathname).toBe(
          `/api/patches/${summary.id}/primitives/${body.name}`
        );
        respond(200, body);
      });
      const args = ["list", summary.id, body.name, "--api-url", instance.url];
      const result = await runCli(args, { env });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain(`Shared: ${body.shared}`);
      expect(result.stdout).toContain("Schema revision: 7");
      if (kind === "store") {
        expect(result.stdout).toContain("Declarable: true");
        expect(result.stdout).toContain(`patchy add shared-store ${summary.id}/photos`);
      }
      if (kind === "table") {
        expect(result.stdout).toContain("id: text required\n");
        expect(result.stdout).toContain("nickname: text optional default null");
        expect(result.stdout).toContain("active: boolean required default false");
        expect(result.stdout).toContain("count: integer required default 0");
        expect(result.stdout).toContain("manager: ref optional ref people");
        expect(result.stdout).toContain("by_nickname (nickname) unique");
      }
      const json = await runCli([...args, "--json"], { env });
      expect(json).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(json.stdout)).toEqual(body);
    }
  );

  it.each([
    ["directory", "--mine"],
    ["patches", "--all"],
    ["connections", "--state", "live"],
    ["directory/people"]
  ])("refuses wrong-level flags or paths locally: %s", async (...args) => {
    const instance = await stubInstance((_, respond) => respond(500, {}));
    const result = await runCli(["list", ...args, "--json", "--api-url", instance.url], { env });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests).toEqual([]);
  });

  // The primitive level shares the patch level's state plumbing.
  it.each([
    { state: "retired", ref: "directory", filter: "retired", refusedFlags: [] },
    { state: "deleted", ref: summary.id, filter: "all", refusedFlags: [] },
    { state: "live", ref: "directory", filter: "live", refusedFlags: ["--state", "retired"] }
  ])(
    "preserves $state refusals and applies --state to $ref",
    async ({ state, ref, filter, refusedFlags }) => {
      const detail = { ...projectSource, state, retiredAt: "2026-09-01T00:00:00.000Z" };
      const instance = await stubInstance((request, respond) => {
        const url = new URL(request.url, "http://instance.test");
        if (url.searchParams.get("state") !== filter)
          return respond(409, {
            ok: false,
            error: `Patch is ${state}.`,
            code: "wrong_state",
            state
          });
        respond(200, detail);
      });
      const args = ["list", ref, "--api-url", instance.url];
      const refused = await runCli([...args, ...refusedFlags], { env });
      expect(refused).toMatchObject({ status: 2, stdout: "" });
      expect(refused.stderr).toContain(`${state}; pass --state ${filter}`);
      const refusedJson = await runCli([...args, ...refusedFlags, "--json"], { env });
      expect(refusedJson).toMatchObject({ status: 2, stdout: "" });
      expect(JSON.parse(refusedJson.stderr)).toEqual({
        ok: false,
        error: expect.stringContaining(`${state}; pass --state ${filter}`),
        kind: "rejected",
        code: "wrong_state",
        state
      });
      const accepted = await runCli([...args, "--state", filter, "--json"], { env });
      expect(accepted).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(accepted.stdout)).toEqual(detail);
    }
  );

  it.each([false, true])(
    "lists connections with offered integrations only under --all=%s",
    async (all) => {
      const instance = await stubInstance(projectHandler);
      const args = ["list", "connections", ...(all ? ["--all"] : []), "--api-url", instance.url];
      const result = await runCli([...args, "--json"], { env });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        ...projectConnections,
        ...(all ? { offered: [{ integration: "postgres", connected: true }] } : {})
      });
      const text = await runCli(args, { env });
      expect(text).toMatchObject({ status: 0, stderr: "" });
      for (const connection of projectConnections.connections)
        expect(text.stdout).toContain(connection.hint);
      if (all) expect(text.stdout).toContain("postgres: connected");
      else expect(text.stdout).not.toContain("postgres: connected");
      expect(text.stdout).not.toContain("patchy add postgres/archive-db");
    }
  );

  it("prints connection snapshots with keys and taken-at, or explicitly unavailable", async () => {
    const snapshot = {
      version: 1,
      revision: 3,
      takenAt: "2026-09-01T00:00:00.000Z",
      relations: [
        {
          schema: "public",
          name: "people",
          kind: "table",
          columns: [
            {
              name: "id",
              nullable: false,
              type: {
                schema: "pg_catalog",
                name: "int4",
                sql: "integer",
                baseSchema: "pg_catalog",
                baseName: "int4",
                kind: "base"
              }
            }
          ],
          primaryKey: { name: "people_pkey", columns: ["id"] },
          foreignKeys: []
        }
      ],
      enums: [],
      exclusions: [{ schema: "private", relation: "salaries", reason: "access_denied" }]
    };
    for (const available of [true, false]) {
      const detail = {
        handle: "sales-db",
        description: "Sales database",
        status: "connected",
        snapshot: available ? snapshot : null
      };
      const instance = await stubInstance((request, respond) => {
        expect(request.url).toBe("/api/connections/sales-db");
        respond(200, detail);
      });
      const args = ["list", "connections", "sales-db", "--api-url", instance.url];
      const result = await runCli(args, { env });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      if (available) {
        expect(result.stdout).toContain("Taken at: 2026-09-01T00:00:00.000Z");
        expect(result.stdout).toContain("Schema revision: 3");
        expect(result.stdout).toContain("public.people (table)");
        expect(result.stdout).toContain("id: integer required");
        expect(result.stdout).toContain("Primary key: people_pkey (id)");
        expect(result.stdout).toContain("Excluded private.salaries: access_denied");
      } else expect(result.stdout).toContain("Snapshot: unavailable");
      const json = await runCli([...args, "--json"], { env });
      expect(json).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(json.stdout)).toEqual(detail);
    }
  });
});
