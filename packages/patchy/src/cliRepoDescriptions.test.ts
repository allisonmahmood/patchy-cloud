// Repo descriptions and change notices through the bundled CLI.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { sha256 } from "@patchy/core";
import { PublishRequest } from "@patchy/api";
import {
  decodeForceRequest,
  pendingFile,
  projectHandler,
  projectSource,
  publish,
  publishTree,
  readJson,
  runCli,
  stubInstance
} from "./test/cli.js";

describe("repo description sync and change notices", () => {
  // Project.test.ts owns which stamps pull; this proves publish sends and records the pulled text.
  it("publishes a newer cloud description over local text and records the returned stamp", async () => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/patches/abcdefghijkl?state=all")
        return respond(200, {
          ...projectSource,
          description: "New portal text",
          descriptionUpdatedAt: "2026-09-16T00:00:00.000Z"
        });
      if (request.url === "/api/publish") {
        const sent = Schema.decodeUnknownSync(PublishRequest)(request.body);
        return respond(200, {
          ...publish(200, "abcdefghijkl", 2),
          tier: 1,
          description: sent.manifest.description,
          descriptionUpdatedAt: "2026-09-17T00:00:00.000Z"
        });
      }
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = { cwd: dir, env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const repoFile = path.join(dir, "patchy.json");
    writeFileSync(
      repoFile,
      JSON.stringify({
        instance: instance.url,
        patch: "abcdefghijkl",
        description: "Local edit",
        descriptionSyncedAt: "2026-09-15T00:00:00.000Z",
        authorField: 7
      })
    );
    const published = await runCli(["publish", "--force", "--json"], options);
    expect(published, published.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(published.stdout)).toMatchObject({
      description: "New portal text",
      warnings: [expect.stringContaining("New portal text")]
    });
    expect(instance.requests.find((request) => request.url === "/api/publish")!.body).toMatchObject(
      { force: true, manifest: { description: "New portal text" } }
    );
    expect(readJson(repoFile)).toEqual({
      instance: instance.url,
      patch: "abcdefghijkl",
      description: "New portal text",
      descriptionSyncedAt: "2026-09-17T00:00:00.000Z",
      authorField: 7
    });
  });

  // primitiveReminders.test.ts owns the comparison; publish carries reminders in the tests below.
  it("carries definition-only reminders through refresh without blocking it", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const config = path.join(dir, "patchy.config.ts");
    const original = readFileSync(config, "utf8");
    const options = { cwd: dir, env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    writeFileSync(
      config,
      original.replace("title: t.text()", "title: t.text(), extra: t.text().optional()")
    );
    const refreshed = await runCli(["refresh", "--json"], options);
    expect(refreshed, refreshed.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(refreshed.stdout).warnings).toContainEqual(
      expect.stringContaining("Table `notes` changed since its last generation")
    );
    const unchanged = await runCli(["refresh", "--json"], options);
    expect(JSON.parse(unchanged.stdout).warnings).toEqual([]);
  });

  it("recovers a lost repo publish response with the original primitive reminder", async () => {
    let lost = true;
    const response = { ...publish(201, "abcdefghijkl", 1), tier: 1 };
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") {
        if (lost) return disconnect();
        return respond(201, response);
      }
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const config = path.join(dir, "patchy.config.ts");
    const options = { cwd: dir, env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "title: t.text()",
        "title: t.text(), extra: t.text().optional()"
      )
    );
    const failed = await runCli(["publish", "--json"], options);
    expect(failed).toMatchObject({ status: 3, stdout: "" });
    const failure = JSON.parse(failed.stderr);
    expect(failure).toMatchObject({
      ok: false,
      kind: "unreachable",
      warnings: [expect.stringContaining("Table `notes` changed since its last generation")]
    });
    const attemptPath = path.join(dir, ".patchy/publish", sha256(instance.url), "attempt");
    expect(readJson(pendingFile(attemptPath))).toMatchObject({ warnings: failure.warnings });
    writeFileSync(config, "broken config");
    lost = false;
    const recovered = await runCli(["publish", "--json"], options);
    expect(recovered).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(recovered.stdout)).toEqual({
      ...response,
      warnings: [...response.warnings, ...failure.warnings]
    });
    const sent = instance.requests.filter((request) => request.url === "/api/publish");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
    expect(existsSync(attemptPath)).toBe(false);
  });

  // Notices survive any later local failure; a typecheck failure stands for every stage.
  it("reports discovered notices when the typecheck fails before sending", async () => {
    let cloud = { description: "Synthetic notes", descriptionUpdatedAt: null as string | null };
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/patches/abcdefghijkl?state=all")
        return respond(200, { ...projectSource, ...cloud });
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const repoFile = path.join(dir, "patchy.json");
    writeFileSync(
      repoFile,
      JSON.stringify({
        instance: instance.url,
        patch: "abcdefghijkl",
        description: "Synthetic notes"
      })
    );
    const options = { cwd: dir, env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    cloud = {
      description: "Changed portal description",
      descriptionUpdatedAt: "2026-09-15T00:00:00.000Z"
    };
    const config = path.join(dir, "patchy.config.ts");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "title: t.text()",
        "title: t.text(), extra: t.text().optional()"
      )
    );
    writeFileSync(path.join(dir, "src/main.ts"), "const title: string = 42;");
    const failed = await runCli(["publish", "--json"], options);
    expect(failed).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(failed.stderr)).toMatchObject({
      ok: false,
      kind: "local",
      error: expect.stringContaining("Typecheck"),
      warnings: [
        expect.stringContaining("Changed portal description"),
        expect.stringContaining("Table `notes` changed since its last generation")
      ]
    });
    expect(readJson(repoFile)).toMatchObject({
      description: cloud.description,
      descriptionSyncedAt: cloud.descriptionUpdatedAt
    });
    expect(instance.requests.filter((request) => request.url === "/api/publish")).toEqual([]);
    expect(existsSync(path.join(dir, ".patchy/publish", sha256(instance.url), "attempt"))).toBe(
      false
    );
  });

  it("reports the unshare reminder at refusal before a fresh forced publish", async () => {
    const dependants = [
      { patchId: "mnopqrstuvwx", name: "reader", owner: { id: "other", name: "Sam" } }
    ];
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") {
        if (!decodeForceRequest(request.body).force)
          return respond(409, {
            ok: false,
            code: "has_dependants",
            error: "Readers would break.",
            dependants
          });
        return respond(200, { ...publish(200, "abcdefghijkl", 2), tier: 1 });
      }
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const config = path.join(dir, "patchy.config.ts");
    const privateConfig = readFileSync(config, "utf8");
    writeFileSync(
      config,
      privateConfig.replace("{ title: t.text() })", "{ title: t.text() }, { shared: true })")
    );
    writeFileSync(
      path.join(dir, "patchy.json"),
      JSON.stringify({
        instance: instance.url,
        patch: "abcdefghijkl",
        description: "Synthetic notes"
      })
    );
    const options = { cwd: dir, env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    writeFileSync(config, privateConfig);
    const refused = await runCli(["publish", "--json"], options);
    expect(refused).toMatchObject({ status: 2, stdout: "" });
    expect(JSON.parse(refused.stderr)).toMatchObject({
      ok: false,
      kind: "rejected",
      code: "has_dependants",
      dependants,
      warnings: [expect.stringContaining("Table `notes` changed since its last generation")]
    });
    const attemptPath = path.join(dir, ".patchy/publish", sha256(instance.url), "attempt");
    expect(existsSync(attemptPath)).toBe(false);
    const forced = await runCli(["publish", "--force", "--json"], options);
    expect(forced, forced.stderr).toMatchObject({ status: 0, stderr: "" });
    const sent = instance.requests.filter((request) => request.url === "/api/publish");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toMatchObject({ force: true });
    expect(existsSync(attemptPath)).toBe(false);
  });

  it("refuses a missing repo description on publish and a 501-code-point init purpose", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      env: { PATCHY_API_TOKEN: "pp_owner", PATCHY_API_URL: instance.url }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    writeFileSync(path.join(dir, "patchy.json"), JSON.stringify({ instance: instance.url }));
    const missing = await runCli(["publish", "--json"], options);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({
      kind: "local",
      code: "invalid_manifest",
      error: expect.stringContaining("description")
    });
    const init = await runCli(
      ["init", "too-long", "--purpose", "𐐀".repeat(501), "--json"],
      options
    );
    expect(init.status).toBe(1);
    expect(JSON.parse(init.stderr).error).toContain("501");
    expect(JSON.parse(init.stderr).error).toContain("500");
    expect(existsSync(path.join(dir, "too-long"))).toBe(false);
    expect(instance.requests.filter((request) => request.url === "/api/publish")).toEqual([]);
  });
});
