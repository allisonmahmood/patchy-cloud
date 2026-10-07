// Repo publish recovery: managed files, diagnostics and interrupted publishes.
import * as Struct from "effect/Struct";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "@patchy/core";
import { CURRENT_RELEASE, MANIFEST_VERSION } from "@patchy/api";
import {
  generateProjectResponse,
  identity,
  pendingFile,
  projectHandler,
  projectTree,
  publish,
  publishTree,
  readJson,
  runCli,
  stubInstance,
  stubPublishingInstance,
  tempDir,
  treeBytes,
  validHtml
} from "./test/cli.js";

describe("repo publish recovery", () => {
  it.each(["file", "parent"])(
    "refuses a generated manifest %s symlink without truncating its target",
    async (kind) => {
      const instance = await stubInstance(projectHandler);
      const dir = publishTree(instance.url);
      const options = {
        cwd: dir,
        stateDir: tempDir(),
        env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
      };
      expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
      const generated = path.join(dir, "patchy/_generated");
      const external = tempDir();
      const target = path.join(external, "manifest.json");
      const sentinel = "external manifest must not be truncated\n";
      if (kind === "parent") {
        for (const [file, contents] of Object.entries(treeBytes(generated))) {
          mkdirSync(path.dirname(path.join(external, file)), { recursive: true });
          writeFileSync(path.join(external, file), contents);
        }
        rmSync(generated, { recursive: true });
        symlinkSync(external, generated, process.platform === "win32" ? "junction" : "dir");
      } else {
        rmSync(path.join(generated, "manifest.json"));
        symlinkSync(target, path.join(generated, "manifest.json"));
      }
      writeFileSync(target, sentinel);
      const result = await runCli(["publish", "--json"], options);
      expect(result).toMatchObject({ status: 1, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
      expect(readFileSync(target, "utf8")).toBe(sentinel);
      expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
    }
  );

  it.each([
    ["patchy.config.ts", 'throw new Error("private-diagnostic-marker");'],
    ["src/main.ts", 'import { value } from "private-diagnostic-marker"; console.log(value);'],
    ["vite.config.ts", 'throw new Error("private-diagnostic-marker"); export default {};']
  ])("keeps %s failure diagnostics out of the public envelope", async (file, source) => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    writeFileSync(path.join(dir, file), source);
    for (const command of file === "patchy.config.ts" ? ["publish", "refresh"] : ["publish"]) {
      const result = await runCli([command, "--json"], options);
      expect(result).toMatchObject({ status: 1, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
      expect(result.stderr).not.toContain("private-diagnostic-marker");
    }
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
    expect(existsSync(path.join(dir, ".patchy/publish", sha256(instance.url), "attempt"))).toBe(
      false
    );
  });

  it("reapplies a moved update's legacy receipt and retains a conflicting author selection", async () => {
    let lost = true;
    const legacy = Struct.omit(publish(200, "abcdefghijkl", 2), [
      "artifacts",
      "description",
      "descriptionUpdatedAt"
    ]);
    const response = { ...legacy, tier: 1 };
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") {
        if (lost) return disconnect();
        return respond(200, response);
      }
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    writeFileSync(
      path.join(dir, "patchy.json"),
      JSON.stringify({
        instance: instance.url,
        patch: response.patchId,
        description: "Synthetic notes",
        authorField: 8
      })
    );
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    expect((await runCli(["publish", "--json"], options)).status).toBe(3);
    const moved = path.join(tempDir(), "moved-update");
    renameSync(dir, moved);
    options.cwd = moved;
    const attemptPath = path.join(moved, ".patchy/publish", sha256(instance.url), "attempt");
    const legacyAttempt = JSON.parse(readFileSync(pendingFile(attemptPath), "utf8"));
    delete legacyAttempt.warnings;
    const original = JSON.stringify(legacyAttempt);
    writeFileSync(pendingFile(attemptPath), original);
    writeFileSync(path.join(moved, "patchy.config.ts"), "broken config");
    writeFileSync(
      path.join(moved, "patchy.json"),
      JSON.stringify({
        instance: instance.url,
        patch: "mnopqrstuvwx",
        authorField: 8
      })
    );
    lost = false;
    expect((await runCli(["publish", "--json"], options)).status).toBe(1);
    expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
    expect(readJson(path.join(moved, "patchy.json"))).toHaveProperty("patch", "mnopqrstuvwx");
    writeFileSync(
      path.join(moved, "patchy.json"),
      JSON.stringify({
        instance: instance.url,
        authorField: 8
      })
    );
    const recovered = await runCli(["publish", "--json"], options);
    expect(recovered).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(recovered.stdout)).toEqual(response);
    expect(readJson(path.join(moved, "patchy.json"))).toEqual({
      instance: instance.url,
      patch: response.patchId,
      authorField: 8
    });
    expect(existsSync(attemptPath)).toBe(false);
    expect(
      instance.requests
        .filter((request) => request.url === "/api/publish")
        .map((request) => request.body)
    ).toEqual(Array(3).fill(JSON.parse(original).request));
  });

  it.each([true, false])(
    "clears only a proven payload-too-large response (decoded: %s)",
    async (decoded) => {
      let refused = true;
      const instance = await stubInstance((request, respond, disconnect) => {
        if (request.url === "/api/publish") {
          if (refused)
            return respond(
              413,
              decoded
                ? { ok: false, error: "Publish request too large." }
                : { unknown: "not a publish refusal" }
            );
          return respond(201, { ...publish(201, "abcdefghijkl", 1), tier: 1 });
        }
        projectHandler(request, respond, disconnect);
      });
      const dir = publishTree(instance.url);
      const options = {
        cwd: dir,
        stateDir: tempDir(),
        env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
      };
      expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
      const initial = await runCli(["publish", "--json"], options);
      expect(initial.status).toBe(2);
      const attemptPath = path.join(dir, ".patchy/publish", sha256(instance.url), "attempt");
      expect(existsSync(attemptPath)).toBe(!decoded);
      refused = false;
      expect((await runCli(["publish", "--json"], options)).status).toBe(0);
      const requests = instance.requests.filter((request) => request.url === "/api/publish");
      if (decoded) expect(requests[1]!.body).not.toEqual(requests[0]!.body);
      else expect(requests[1]!.body).toEqual(requests[0]!.body);
      expect(existsSync(attemptPath)).toBe(false);
    }
  );

  it("recovers a moved create across owner refusal, failed identity write and release change", async () => {
    let phase: "lost" | "other-owner" | "blocked-write" | "changed-binding" | "recover" = "lost";
    let currentRelease = CURRENT_RELEASE;
    const response = {
      ...publish(201, "abcdefghijkl", 1),
      tier: 1,
      provisioned: { tables: ["notes"], columns: [], indexes: [], stores: [] }
    };
    let dir = "";
    const instance = await stubInstance(
      (request, respond, disconnect) => {
        if (request.url === "/api/me")
          return respond(
            200,
            phase === "other-owner"
              ? { ...identity, user: { ...identity.user, id: "different-owner" } }
              : identity
          );
        if (request.url === "/api/sdk/generate")
          return respond(200, generateProjectResponse(request.body));
        if (request.url === "/api/look") return respond(200, { current: null, revisions: [] });
        if (request.url === "/api/publish") {
          if (phase === "lost") return disconnect();
          if (phase === "blocked-write") {
            rmSync(path.join(dir, "patchy.json"));
            mkdirSync(path.join(dir, "patchy.json"));
          }
          if (phase === "changed-binding")
            writeFileSync(
              path.join(dir, "patchy.json"),
              JSON.stringify({ instance: "http://127.0.0.1:1", authorField: 7 })
            );
          return respond(201, response);
        }
        respond(404, { ok: false, error: "Unexpected route" });
      },
      () => currentRelease
    );
    dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const initial = await runCli(["publish", "--json"], options);
    expect(initial.status, initial.stderr).toBe(3);
    let attemptPath = path.join(dir, ".patchy/publish", sha256(instance.url), "attempt");
    const original = readFileSync(pendingFile(attemptPath), "utf8");
    const request = instance.requests.find((r) => r.url === "/api/publish")!.body;
    expect(request).toMatchObject({ manifest: { tier: 1, tables: { notes: {} } } });
    expect(JSON.stringify(request)).toContain("<script");
    currentRelease = "9.9.9";
    writeFileSync(path.join(dir, "patchy.config.ts"), "broken config");
    rmSync(path.join(dir, "node_modules"), { recursive: true });
    phase = "other-owner";
    expect((await runCli(["publish", "--json"], options)).status).toBe(1);
    expect(instance.requests.filter((r) => r.url === "/api/publish")).toHaveLength(1);
    expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
    phase = "blocked-write";
    expect((await runCli(["publish", "--json"], options)).status).toBe(1);
    expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
    rmSync(path.join(dir, "patchy.json"), { recursive: true });
    writeFileSync(
      path.join(dir, "patchy.json"),
      JSON.stringify({ instance: "http://127.0.0.1:1", authorField: 7 })
    );
    const oldRoot = dir;
    const moved = path.join(tempDir(), "moved-repo");
    renameSync(dir, moved);
    dir = moved;
    options.cwd = moved;
    attemptPath = path.join(moved, ".patchy/publish", sha256(instance.url), "attempt");
    expect(existsSync(oldRoot)).toBe(false);
    phase = "recover";
    const beforeMismatch = instance.requests.length;
    const mismatched = await runCli(["publish", "--json"], options);
    expect(mismatched).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(mismatched.stderr)).toMatchObject({ code: "instance_mismatch" });
    expect(instance.requests).toHaveLength(beforeMismatch);
    expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
    expect(readJson(path.join(dir, "patchy.json"))).toEqual({
      instance: "http://127.0.0.1:1",
      authorField: 7
    });
    writeFileSync(
      path.join(dir, "patchy.json"),
      JSON.stringify({ instance: `${instance.url}/`, authorField: 7 })
    );
    phase = "changed-binding";
    const changedDuringRequest = await runCli(["publish", "--json"], options);
    expect(changedDuringRequest).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(changedDuringRequest.stderr)).toMatchObject({ code: "instance_mismatch" });
    expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
    expect(readJson(path.join(dir, "patchy.json"))).toEqual({
      instance: "http://127.0.0.1:1",
      authorField: 7
    });
    writeFileSync(
      path.join(dir, "patchy.json"),
      JSON.stringify({ instance: `${instance.url}/`, authorField: 7 })
    );
    phase = "recover";
    const recovered = await runCli(["publish", "--json"], options);
    expect(recovered).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(recovered.stdout)).toEqual(response);
    expect(readJson(path.join(dir, "patchy.json"))).toEqual({
      instance: `${instance.url}/`,
      authorField: 7,
      patch: response.patchId,
      descriptionSyncedAt: null
    });
    expect(existsSync(attemptPath)).toBe(false);
    expect(instance.requests.filter((r) => r.url === "/api/publish").map((r) => r.body)).toEqual([
      request,
      request,
      request,
      request
    ]);
    expect(instance.requests.filter((r) => r.url === "/api/release")).toHaveLength(2);
  });

  it("uses the repo identity for share and delete, and a missing update cannot become a create", async () => {
    const instance = await stubPublishingInstance((request, respond) => {
      if (request.url.endsWith("/share"))
        return respond(200, {
          ok: true,
          patchId: "abcdefghijkl",
          publicUrl: "http://instance.test/patchy-dev/page",
          scope: "public"
        });
      if (request.method === "DELETE")
        return respond(200, {
          ok: true,
          patchId: "abcdefghijkl",
          state: "deleted",
          deletedAt: "2026-01-01T00:00:00.000Z",
          purgeAt: "2026-01-31T00:00:00.000Z"
        });
      respond(404, { ok: false, error: "Patch not found." });
    });
    const dir = projectTree(instance.url);
    writeFileSync(
      path.join(dir, "patchy.json"),
      JSON.stringify({ instance: instance.url, patch: "abcdefghijkl" })
    );
    const options = { cwd: dir, env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["share", "public", "--json"], options)).status).toBe(0);
    expect((await runCli(["delete", "--yes", "--json"], options)).status).toBe(0);
    const attemptPath = path.join(dir, ".patchy/publish", sha256(instance.url), "attempt");
    mkdirSync(attemptPath, { recursive: true });
    writeFileSync(
      path.join(attemptPath, `${sha256("repo-deleted-attempt")}.json`),
      JSON.stringify({
        ownerUserId: identity.user.id,
        target: { mode: "repo" },
        request: {
          publishKey: "repo-deleted-attempt",
          patchId: "abcdefghijkl",
          html: validHtml,
          metadata: {},
          manifest: {
            release: CURRENT_RELEASE,
            manifestVersion: MANIFEST_VERSION,
            tier: 0,
            name: "cli-project",
            tables: {},
            files: {},
            uses: {}
          }
        }
      })
    );
    const result = await runCli(["publish", "--json"], options);
    expect(result.status).toBe(2);
    expect(readJson(path.join(dir, "patchy.json"))).toMatchObject({ patch: "abcdefghijkl" });
    expect(existsSync(attemptPath)).toBe(false);
    expect(instance.requests.map((r) => [r.method, r.url])).toEqual([
      ["POST", "/api/patches/abcdefghijkl/share"],
      ["DELETE", "/api/patches/abcdefghijkl"],
      ["GET", "/api/me"],
      ["POST", "/api/publish"]
    ]);
  });
});
