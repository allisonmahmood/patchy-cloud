// File publishing, sharing and deletion through the bundled CLI.
import { type ChildProcess } from "node:child_process";
import * as Struct from "effect/Struct";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { DEV_SEED } from "@patchy/auth/seed";
import { sha256 } from "@patchy/core";
import { CURRENT_RELEASE, PublishRequest } from "@patchy/api";
import {
  type CliResult,
  htmlFile,
  identity,
  pendingFile,
  publish,
  readJson,
  requestBarrier,
  runCli,
  stubInstance,
  stubPublishingInstance,
  tempDir,
  validHtml
} from "./test/cli.js";

describe("patchy publish", async () => {
  // Api.test.ts owns which refusals keep an attempt; these prove a kept one recovers intact.
  it.each([
    { status: 401, route: "/api/me", body: { ok: false, error: "Missing or invalid API token." } },
    {
      status: 429,
      route: "/api/publish",
      body: { ok: false, code: "rate_limited", error: "Slow down.", retryAfterSeconds: 60 }
    },
    { status: 400, route: "/api/publish", body: "undecodable admission refusal" }
  ])(
    "recovers a legacy receipt through $status on $route and same-owner token rotation",
    async ({ status, route, body }) => {
      const dir = tempDir();
      const file = htmlFile(dir, "page.html", validHtml);
      let phase: "lost" | "refused" | "recovered" = "lost";
      const response = Struct.omit(publish(201, "abcdefghijkl", 1), [
        "artifacts",
        "description",
        "descriptionUpdatedAt"
      ]);
      const instance = await stubInstance((request, respond, disconnect) => {
        if (phase === "refused" && request.url === route) return respond(status, body);
        if (request.url === "/api/me") return respond(200, identity);
        if (phase === "lost") return disconnect();
        respond(201, response);
      });
      const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_original" };
      expect((await runCli(["publish", file, "--json"], { stateDir: dir, env })).status).toBe(3);
      const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt");
      const original = readFileSync(pendingFile(attemptPath), "utf8");
      phase = "refused";
      const refused = await runCli(["publish", "missing.html", "--new", "--json"], {
        stateDir: dir,
        env
      });
      expect(refused.status).not.toBe(0);
      expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
      phase = "recovered";
      const recovered = await runCli(["publish", "missing.html", "--new", "--json"], {
        stateDir: dir,
        env: { ...env, PATCHY_API_TOKEN: "pp_rotated" }
      });
      expect(recovered).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(recovered.stdout)).toEqual(response);
      const sent = instance.requests.filter((request) => request.url === "/api/publish");
      expect(sent.at(-1)).toMatchObject({
        authorization: "Bearer pp_rotated",
        body: sent[0]?.body
      });
      for (const request of sent) expect(request.body).toEqual(sent[0]?.body);
      expect(instance.requests.filter((request) => request.url === "/api/release")).toHaveLength(1);
      expect(readJson(path.join(dir, "patches.json"))).toMatchObject({
        hosts: {
          [instance.url]: {
            files: {
              [file]: {
                patchId: response.patchId,
                publicUrl: response.publicUrl,
                latestVersionNumber: response.versionNumber
              }
            }
          }
        }
      });
      expect(existsSync(attemptPath)).toBe(false);
    }
  );

  it("requires current description fields on a fresh publish response", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const response = Struct.omit(publish(201, "abcdefghijkl", 1), [
      "description",
      "descriptionUpdatedAt"
    ]);
    const instance = await stubPublishingInstance((_, respond) => respond(201, response));
    const result = await runCli(["publish", file, "--json"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    });
    expect(result).toMatchObject({ status: 3, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ kind: "unreachable" });
    expect(existsSync(path.join(dir, "patches.json"))).toBe(false);
    expect(existsSync(path.join(dir, "publish", sha256(instance.url), "attempt"))).toBe(true);
  });

  it("keeps an unreadable retained receipt pending until its identity and metadata are valid", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const legacy = Struct.omit(publish(201, "abcdefghijkl", 1), [
      "artifacts",
      "description",
      "descriptionUpdatedAt"
    ]);
    const response = {
      ...legacy,
      receiptRelease: "before-descriptions",
      provisioned: { ...legacy.provisioned, oldReceiptDetail: 17 }
    };
    let reply: unknown;
    const instance = await stubPublishingInstance((_, respond, disconnect) => {
      if (reply === undefined) return disconnect();
      respond(201, reply);
    });
    const options = {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["publish", file, "--json"], options)).status).toBe(3);
    const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt");
    const original = readFileSync(pendingFile(attemptPath), "utf8");
    for (const malformed of [
      { ...response, patchId: "not-a-patch-id" },
      { ...response, artifacts: { html: { sha256: "invalid", bytes: -1 } } },
      { ...response, description: 42 }
    ]) {
      reply = malformed;
      const rejected = await runCli(["publish", "missing.html", "--json"], options);
      expect(rejected).toMatchObject({ status: 3, stdout: "" });
      expect(JSON.parse(rejected.stderr)).toMatchObject({ kind: "unreachable" });
      expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
      expect(existsSync(path.join(dir, "patches.json"))).toBe(false);
    }
    reply = response;
    const recovered = await runCli(["publish", "missing.html", "--json"], options);
    expect(recovered).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(recovered.stdout)).toEqual(response);
    expect(existsSync(attemptPath)).toBe(false);
    const sent = instance.requests.filter((request) => request.url === "/api/publish");
    for (const request of sent) expect(request.body).toEqual(sent[0]?.body);
  });

  it("never sends recovered HTML to another owner, but accepts a rotated key for the original owner", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    let first = true;
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/me") {
        return respond(
          200,
          request.authorization === "Bearer pp_other"
            ? { ...identity, user: { ...identity.user, id: "usr_other" } }
            : identity
        );
      }
      if (first) {
        first = false;
        return disconnect();
      }
      respond(201, publish(201, "abcdefghijkl", 1));
    });
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_original" };
    expect((await runCli(["publish", file, "--json"], { stateDir: dir, env })).status).toBe(3);
    const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt");
    const original = readFileSync(pendingFile(attemptPath), "utf8");
    expect(JSON.parse(original)).toMatchObject({ ownerUserId: identity.user.id });
    const wrongOwner = await runCli(
      ["publish", "missing.html", "--patch", "ignored", "--new", "--json"],
      {
        stateDir: dir,
        env: { ...env, PATCHY_API_TOKEN: "pp_other" }
      }
    );
    expect(wrongOwner.status).toBe(1);
    expect(JSON.parse(wrongOwner.stderr)).toMatchObject({ kind: "local" });
    expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
    expect(
      instance.requests.filter((request) => request.authorization === "Bearer pp_other")
    ).toEqual([
      { method: "GET", url: "/api/me", authorization: "Bearer pp_other", body: undefined }
    ]);
    const recovered = await runCli(["publish", "missing.html", "--json"], {
      stateDir: dir,
      env: { ...env, PATCHY_API_TOKEN: "pp_rotated" }
    });
    expect(recovered.status).toBe(0);
    const sent = instance.requests.filter((request) => request.url === "/api/publish");
    expect(sent.map((request) => request.body)).toEqual([sent[0]?.body, sent[0]?.body]);
    expect(existsSync(attemptPath)).toBe(false);
  });

  it("fails closed without guessing the owner of an old pending attempt", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const instance = await stubPublishingInstance((_, __, disconnect) => disconnect());
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    expect((await runCli(["publish", file, "--json"], { stateDir: dir, env })).status).toBe(3);
    const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt");
    const legacy = JSON.parse(readFileSync(pendingFile(attemptPath), "utf8"));
    delete legacy.ownerUserId;
    const original = JSON.stringify(legacy);
    writeFileSync(pendingFile(attemptPath), original);
    const before = instance.requests.length;
    const refused = await runCli(["publish", "missing.html", "--json"], { stateDir: dir, env });
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ kind: "local" });
    expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
    expect(instance.requests).toHaveLength(before);
  });

  it("replays the exclusive-creation winner through a state-dir symlink without letting its delayed response clear a newer attempt", async () => {
    const dir = tempDir();
    const alias = path.join(tempDir(), "state-alias");
    symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const file = htmlFile(dir, "winner.html", validHtml);
    const losingFile = htmlFile(dir, "loser.html", validHtml.replace("hi", "different candidate"));
    const nextFile = htmlFile(dir, "next.html", validHtml.replace("hi", "next attempt"));
    const winnerIdentity = requestBarrier();
    const loserIdentity = requestBarrier();
    const originalPublish = requestBarrier();
    const replayPublish = requestBarrier();
    const nextPublish = requestBarrier();
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/me") {
        if (request.authorization === "Bearer pp_winner") {
          return winnerIdentity.handler(request, respond, disconnect);
        }
        if (request.authorization === "Bearer pp_loser") {
          return loserIdentity.handler(request, respond, disconnect);
        }
        return respond(200, identity);
      }
      if (request.authorization === "Bearer pp_winner") {
        return originalPublish.handler(request, respond, disconnect);
      }
      if (request.authorization === "Bearer pp_loser") {
        return replayPublish.handler(request, respond, disconnect);
      }
      nextPublish.handler(request, respond, disconnect);
    });
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_winner" };
    const children: ChildProcess[] = [];
    const onSpawn = (child: ChildProcess) => {
      children.push(child);
    };
    const winner = runCli(["publish", file, "--json"], { stateDir: dir, env, onSpawn });
    const loser = runCli(["publish", losingFile, "--new", "--share", "public", "--json"], {
      stateDir: alias,
      env: { ...env, PATCHY_API_TOKEN: "pp_loser" },
      onSpawn
    });
    let next: Promise<CliResult> | undefined;
    try {
      const [firstIdentity, secondIdentity] = await Promise.all([
        winnerIdentity.wait(winner),
        loserIdentity.wait(loser)
      ]);
      const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt");
      expect(existsSync(attemptPath)).toBe(false);
      firstIdentity.respond(200, identity);
      const firstRequest = await originalPublish.wait(winner);
      const original = readFileSync(pendingFile(attemptPath), "utf8");
      expect(JSON.parse(original)).toMatchObject({
        target: { mode: "file", file },
        ownerUserId: identity.user.id,
        request: firstRequest.request.body
      });
      secondIdentity.respond(200, identity);
      const replay = await replayPublish.wait(loser);
      expect(replay.request.body).toEqual(firstRequest.request.body);
      expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
      const response = publish(201, "abcdefghijkl", 1);
      replay.respond(201, response);
      expect(await loser).toMatchObject({ status: 0, stderr: "" });
      expect(existsSync(attemptPath)).toBe(false);
      expect(readJson(path.join(dir, "patches.json"))).toMatchObject({
        hosts: {
          [instance.url]: {
            files: { [file]: { patchId: response.patchId, latestVersionNumber: 1 } }
          }
        }
      });
      expect(readJson(path.join(dir, "patches.json"))).not.toMatchObject({
        hosts: { [instance.url]: { files: { [losingFile]: expect.anything() } } }
      });

      next = runCli(["publish", nextFile, "--json"], {
        stateDir: dir,
        env: { ...env, PATCHY_API_TOKEN: "pp_next" },
        onSpawn
      });
      const newerRequest = await nextPublish.wait(next);
      const newer = readFileSync(pendingFile(attemptPath), "utf8");
      expect(JSON.parse(newer).request.publishKey).not.toBe(
        JSON.parse(original).request.publishKey
      );
      expect(JSON.parse(newer)).toMatchObject({
        target: { mode: "file", file: nextFile },
        request: newerRequest.request.body
      });
      firstRequest.respond(201, response);
      expect(await winner).toMatchObject({ status: 0, stderr: "" });
      expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(newer);
      newerRequest.respond(201, publish(201, "mnopqrstuvwx", 1));
      expect(await next).toMatchObject({ status: 0, stderr: "" });
      expect(existsSync(attemptPath)).toBe(false);
    } finally {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all([winner, loser, next]);
    }
  });

  it("does not send the winning attempt when a fresh candidate loses exclusive creation to another owner", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "winner.html", validHtml);
    const losingFile = htmlFile(dir, "loser.html", validHtml.replace("hi", "other owner's page"));
    const winnerIdentity = requestBarrier();
    const loserIdentity = requestBarrier();
    const originalPublish = requestBarrier();
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/me") {
        return (
          request.authorization === "Bearer pp_owner" ? winnerIdentity : loserIdentity
        ).handler(request, respond, disconnect);
      }
      if (request.authorization === "Bearer pp_owner") {
        return originalPublish.handler(request, respond, disconnect);
      }
      respond(201, publish(201, "mnopqrstuvwx", 1));
    });
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    const children: ChildProcess[] = [];
    const onSpawn = (child: ChildProcess) => {
      children.push(child);
    };
    const winner = runCli(["publish", file, "--json"], { stateDir: dir, env, onSpawn });
    const loser = runCli(["publish", losingFile, "--json"], {
      stateDir: dir,
      env: { ...env, PATCHY_API_TOKEN: "pp_other" },
      onSpawn
    });
    try {
      const [firstIdentity, secondIdentity] = await Promise.all([
        winnerIdentity.wait(winner),
        loserIdentity.wait(loser)
      ]);
      const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt");
      expect(existsSync(attemptPath)).toBe(false);
      firstIdentity.respond(200, identity);
      const originalRequest = await originalPublish.wait(winner);
      const original = readFileSync(pendingFile(attemptPath), "utf8");
      secondIdentity.respond(200, {
        ...identity,
        user: { ...identity.user, id: "usr_other" }
      });
      const refused = await loser;
      expect(refused.status).toBe(1);
      expect(JSON.parse(refused.stderr)).toMatchObject({ kind: "local" });
      expect(
        instance.requests.filter(
          (request) => request.url === "/api/publish" && request.authorization === "Bearer pp_other"
        )
      ).toEqual([]);
      expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
      originalRequest.respond(201, publish(201, "abcdefghijkl", 1));
      expect((await winner).status).toBe(0);
      expect(existsSync(attemptPath)).toBe(false);
    } finally {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all([winner, loser]);
    }
  });

  it("recovers the persisted request through a state-dir symlink after SIGKILL", async () => {
    const dir = tempDir();
    const alias = path.join(tempDir(), "state-alias");
    symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const file = htmlFile(dir, "page.html", validHtml);
    const originalPublish = requestBarrier();
    const response = publish(201, "abcdefghijkl", 1);
    let first = true;
    const instance = await stubPublishingInstance((request, respond, disconnect) => {
      if (first) {
        first = false;
        return originalPublish.handler(request, respond, disconnect);
      }
      respond(201, response);
    });
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    let child: ChildProcess | undefined;
    const killed = runCli(["publish", file, "--json"], {
      stateDir: dir,
      env,
      onSpawn: (process) => {
        child = process;
      }
    });
    try {
      const originalRequest = await originalPublish.wait(killed);
      const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt");
      const original = readFileSync(pendingFile(attemptPath), "utf8");
      child?.kill("SIGKILL");
      expect((await killed).status).toBeNull();
      expect(readFileSync(pendingFile(attemptPath), "utf8")).toBe(original);
      const recovered = await runCli(["publish", "missing.html", "--new", "--json"], {
        stateDir: alias,
        env
      });
      expect(recovered).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(recovered.stdout)).toEqual(response);
      const sent = instance.requests.filter((request) => request.url === "/api/publish");
      expect(sent.map((request) => request.body)).toEqual([
        originalRequest.request.body,
        originalRequest.request.body
      ]);
      expect(existsSync(attemptPath)).toBe(false);
      expect(readJson(path.join(dir, "patches.json"))).toMatchObject({
        hosts: {
          [instance.url]: {
            files: { [file]: { patchId: response.patchId, latestVersionNumber: 1 } }
          }
        }
      });
    } finally {
      child?.kill("SIGKILL");
      await killed;
    }
  });

  it("replays a lost reply before file, flags and release checks, applies the original cache target, and stops", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    let currentRelease = CURRENT_RELEASE;
    let first = true;
    let durableAttempt: unknown;
    const response = publish(201, "abcdefghijkl", 1, "public");
    const instance = await stubPublishingInstance(
      (_, respond, disconnect) => {
        const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt");
        durableAttempt = readJson(pendingFile(attemptPath));
        if (first) {
          first = false;
          disconnect();
        } else {
          respond(201, response);
        }
      },
      () => currentRelease
    );
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_private_credential" };
    const initial = await runCli(["publish", file, "--share", "public", "--json"], {
      stateDir: dir,
      env
    });
    expect(initial.status).toBe(3);
    expect(JSON.parse(initial.stderr)).toMatchObject({ ok: false, kind: "unreachable" });
    const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt");
    expect(durableAttempt).toMatchObject({
      request: instance.requests[2]?.body,
      target: { mode: "file", file }
    });
    expect(readFileSync(pendingFile(attemptPath), "utf8")).not.toContain(env.PATCHY_API_TOKEN);
    expect(statSync(pendingFile(attemptPath)).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(attemptPath)).mode & 0o777).toBe(0o700);

    currentRelease = "9.9.9";
    rmSync(file);
    const replay = await runCli(
      [
        "publish",
        "missing.html",
        "--patch",
        "ignored",
        "--new",
        "--share",
        "company",
        "--name",
        "Invalid",
        "--json"
      ],
      { stateDir: dir, env }
    );
    expect(replay).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(replay.stdout)).toEqual(response);
    expect(instance.requests.map((r) => r.url)).toEqual([
      "/api/me",
      "/api/release",
      "/api/publish",
      "/api/me",
      "/api/publish"
    ]);
    expect(instance.requests[4]?.body).toEqual(instance.requests[2]?.body);
    expect(readJson(path.join(dir, "patches.json"))).toMatchObject({
      hosts: {
        [instance.url]: { files: { [file]: { patchId: response.patchId, latestVersionNumber: 1 } } }
      }
    });
    expect(existsSync(attemptPath)).toBe(false);
  });

  it("recovers the same create after a failed cache write, without reading today's broken cache or HTML first", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const cachePath = path.join(dir, "patches.json");
    let blockCache = true;
    const response = publish(201, "abcdefghijkl", 1);
    const instance = await stubPublishingInstance((_, respond) => {
      if (blockCache) {
        mkdirSync(cachePath);
        blockCache = false;
      }
      respond(201, response);
    });
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    const initial = await runCli(["publish", file, "--json"], { stateDir: dir, env });
    expect(initial.status).toBe(1);
    expect(JSON.parse(initial.stderr)).toMatchObject({ kind: "local" });
    const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt");
    expect(existsSync(attemptPath)).toBe(true);

    // Replay is sent even while applying the cache is still impossible.
    const blocked = await runCli(["publish", "missing.html", "--json"], { stateDir: dir, env });
    expect(blocked.status).toBe(1);
    expect(instance.requests[4]?.body).toEqual(instance.requests[2]?.body);
    expect(existsSync(attemptPath)).toBe(true);
    rmSync(cachePath, { recursive: true });
    writeFileSync(file, "<script>unsafe today</script>");
    const recovered = await runCli(["publish", file, "--json"], { stateDir: dir, env });
    expect(recovered).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(recovered.stdout)).toEqual(response);
    expect(instance.requests.map((r) => r.url)).toEqual([
      "/api/me",
      "/api/release",
      "/api/publish",
      "/api/me",
      "/api/publish",
      "/api/me",
      "/api/publish"
    ]);
    expect(instance.requests[6]?.body).toEqual(instance.requests[2]?.body);
    expect(readJson(cachePath)).toMatchObject({
      hosts: {
        [instance.url]: { files: { [file]: { patchId: response.patchId, latestVersionNumber: 1 } } }
      }
    });
    expect(existsSync(attemptPath)).toBe(false);
  });

  // Api.test.ts owns the full definitive list; these prove file mode clears and starts fresh.
  it.each([
    { status: 422, code: "release_mismatch" },
    { status: 409, code: "name_taken" }
  ])(
    "retains an unknown outcome but clears a definitive $code refusal",
    async ({ status, code }) => {
      const dir = tempDir();
      const file = htmlFile(dir, "page.html", validHtml);
      let calls = 0;
      const instance = await stubPublishingInstance((_, respond) => {
        calls++;
        if (calls === 1) return respond(503, { error: "unknown commit outcome" });
        if (calls === 2)
          return respond(status, {
            ok: false,
            code,
            error: "The publish was refused."
          });
        respond(201, publish(201, "abcdefghijkl", 1, "company", "available-name"));
      });
      const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
      const initial = await runCli(["publish", file, "--name", "taken-name", "--json"], {
        stateDir: dir,
        env
      });
      expect(initial.status).toBe(3);
      const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt");
      expect(existsSync(attemptPath)).toBe(true);
      const refusal = await runCli(["publish", "missing.html", "--json"], { stateDir: dir, env });
      expect(refusal.status).toBe(2);
      expect(JSON.parse(refusal.stderr)).toMatchObject({
        ok: false,
        kind: "rejected",
        code
      });
      expect(instance.requests[4]?.body).toEqual(instance.requests[2]?.body);
      expect(existsSync(attemptPath)).toBe(false);
      const fresh = await runCli(["publish", file, "--name", "available-name", "--json"], {
        stateDir: dir,
        env
      });
      expect(fresh.status).toBe(0);
      expect(instance.requests.map((r) => r.url)).toEqual([
        "/api/me",
        "/api/release",
        "/api/publish",
        "/api/me",
        "/api/publish",
        "/api/me",
        "/api/release",
        "/api/publish"
      ]);
      const firstRequest = Schema.decodeUnknownSync(PublishRequest)(instance.requests[2]?.body);
      const freshRequest = Schema.decodeUnknownSync(PublishRequest)(instance.requests[7]?.body);
      expect(freshRequest.publishKey).not.toBe(firstRequest.publishKey);
      expect(firstRequest.manifest.name).toBe("taken-name");
      expect(freshRequest.manifest.name).toBe("available-name");
      expect(JSON.parse(fresh.stdout)).toMatchObject({
        name: "available-name",
        address: `http://instance.test/${DEV_SEED.companyHandle}/available-name`
      });
    }
  );

  it("reports an exact release mismatch locally before reading the file or persisting an attempt", async () => {
    const instance = await stubPublishingInstance(
      (_, respond) => respond(201, publish(201, "abcdefghijkl", 1)),
      () => "9.9.9"
    );
    const dir = tempDir();
    const result = await runCli(["publish", "missing.html", "--json"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      kind: "local",
      code: "release_mismatch"
    });
    expect(result.stderr).toContain(CURRENT_RELEASE);
    expect(result.stderr).toContain("9.9.9");
    expect(instance.requests.map((r) => r.url)).toEqual(["/api/me", "/api/release"]);
    expect(existsSync(path.join(dir, "publish", sha256(instance.url), "attempt"))).toBe(false);
  });

  it("never persists invalid request options, so corrected patch IDs and names can publish next", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const response = publish(200, "abcdefghijkl", 2);
    const instance = await stubPublishingInstance((_, respond) => respond(200, response));
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    const invalid = await runCli(["publish", file, "--patch", "invalid", "--json"], {
      stateDir: dir,
      env
    });
    const invalidName = await runCli(["publish", file, "--name", "UpperCase", "--json"], {
      stateDir: dir,
      env
    });
    expect(invalidName.status).toBe(1);
    expect(JSON.parse(invalidName.stderr)).toMatchObject({ kind: "local" });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ kind: "local" });
    expect(existsSync(path.join(dir, "publish", sha256(instance.url), "attempt"))).toBe(false);
    expect(instance.requests.filter((request) => request.url === "/api/publish")).toEqual([]);
    const corrected = await runCli(["publish", file, "--patch", "abcdefghijkl", "--json"], {
      stateDir: dir,
      env
    });
    expect(corrected).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(corrected.stdout)).toEqual(response);
    expect(instance.requests.filter((request) => request.url === "/api/publish")).toMatchObject([
      { body: { patchId: "abcdefghijkl", html: validHtml } }
    ]);
  });

  it("publishes with an explicit name, then keeps it when republishing with the cached patch id", async () => {
    const instance = await stubPublishingInstance((request, respond) => {
      const body = request.body as { patchId?: string; manifest: { name?: string } };
      return body.patchId
        ? respond(200, publish(200, body.patchId, 2, "company", "quarterly-plan"))
        : respond(201, publish(201, "abcdefghijkl", 1, "company", body.manifest.name ?? "page"));
    });
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    await runCli(["auth", "set", "--token-stdin", "--api-url", instance.url], {
      stateDir: dir,
      input: `${DEV_SEED.token}\n`
    });

    const first = await runCli(
      ["publish", file, "--name", "quarterly-plan", "--api-url", instance.url],
      { stateDir: dir }
    );
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(
      `URL: http://instance.test/${DEV_SEED.companyHandle}/quarterly-plan`
    );
    expect(first.stdout).toContain("Scope: company (signed-in colleagues in your company)");
    expect(first.stderr).toBe("Warning: No <title> found.\n");
    expect(`${first.stdout}${first.stderr}`).not.toContain(DEV_SEED.token);
    expect(instance.requests.map((r) => r.url)).toEqual([
      "/api/me",
      "/api/release",
      "/api/publish"
    ]);
    expect(instance.requests[2]).toMatchObject({ authorization: `Bearer ${DEV_SEED.token}` });
    expect(instance.requests[2]?.body).toMatchObject({
      html: validHtml,
      manifest: {
        manifestVersion: 1,
        release: CURRENT_RELEASE,
        name: "quarterly-plan",
        tier: 0,
        tables: {},
        files: {},
        uses: {}
      },
      metadata: { cliVersion: "0.0.1", filename: "page.html" }
    });
    expect(instance.requests[2]?.body).not.toHaveProperty("scope");

    // The cache turns the second publish of the same file into an update, and
    // under --json the document is the wire shape alone.
    const second = await runCli(["publish", file, "--json"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url }
    });
    expect(second.status).toBe(0);
    expect(second.stderr).toBe("");
    expect(JSON.parse(second.stdout)).toEqual(
      publish(200, "abcdefghijkl", 2, "company", "quarterly-plan")
    );
    expect(instance.requests[5]?.body).toMatchObject({ patchId: "abcdefghijkl" });
    expect(instance.requests[5]?.body).not.toHaveProperty("scope");
    expect(instance.requests[5]?.body).not.toHaveProperty("manifest.name");
    expect(readJson(path.join(dir, "patches.json"))).toMatchObject({
      hosts: {
        [instance.url]: {
          files: {
            [file]: {
              patchId: "abcdefghijkl",
              publicUrl: `http://instance.test/${DEV_SEED.companyHandle}/quarterly-plan`
            }
          }
        }
      }
    });
    expect(instance.requests[5]).toMatchObject({ authorization: `Bearer ${DEV_SEED.token}` });

    // --new ignores the cache; the environment token beats the stored one.
    const fresh = await runCli(["publish", file, "--new"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_env" }
    });
    expect(fresh.status).toBe(0);
    expect(instance.requests[8]?.body).not.toHaveProperty("patchId");
    expect(instance.requests[8]?.body).not.toHaveProperty("manifest.name");
    expect(instance.requests[8]).toMatchObject({ authorization: "Bearer pp_env" });
  });

  it("sets sharing explicitly on create and update, reporting the returned audience", async () => {
    let version = 0;
    const instance = await stubPublishingInstance((_, respond) => {
      version++;
      respond(
        version === 1 ? 201 : 200,
        publish(
          version === 1 ? 201 : 200,
          "abcdefghijkl",
          version,
          version === 1 ? "public" : "company"
        )
      );
    });
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };

    const published = await runCli(["publish", file, "--share", "public", "--json"], {
      stateDir: dir,
      env
    });
    expect(published.status).toBe(0);
    expect(published.stderr).toBe("");
    expect(JSON.parse(published.stdout)).toMatchObject({ scope: "public" });
    expect(instance.requests[2]?.body).toMatchObject({ scope: "public" });
    expect(instance.requests[2]?.body).not.toHaveProperty("patchId");

    const restricted = await runCli(["publish", file, "--share", "company"], {
      stateDir: dir,
      env
    });
    expect(restricted.status).toBe(0);
    expect(restricted.stdout).toContain("Scope: company (signed-in colleagues in your company)");
    expect(instance.requests[5]?.body).toMatchObject({ scope: "company", patchId: "abcdefghijkl" });

    const invalid = await runCli(["publish", file, "--share", "private", "--json"], {
      stateDir: dir,
      env
    });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests).toHaveLength(6);
  });

  it("publishes with the worktree seed and leaves stderr empty under --json", async () => {
    const instance = await stubPublishingInstance((_, respond) =>
      respond(201, publish(201, "abcdefghijkl", 1))
    );
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    mkdirSync(path.join(dir, ".local", "dev"), { recursive: true });
    writeFileSync(
      path.join(dir, ".local", "dev", "env"),
      `PATCHY_API_URL=${instance.url}\nPATCHY_API_TOKEN=${DEV_SEED.token}\n`
    );
    const result = await runCli(["publish", file, "--json"], {
      stateDir: dir
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(publish(201, "abcdefghijkl", 1));
    expect(result.stderr).toBe("");
    expect(instance.requests[2]).toMatchObject({ authorization: `Bearer ${DEV_SEED.token}` });

    // A stored key outranks the seed, and an explicit environment key outranks both.
    await runCli(["auth", "set", "--token-stdin"], {
      stateDir: dir,
      input: "pp_saved\n"
    });
    const saved = await runCli(["publish", file, "--new", "--json"], { stateDir: dir });
    expect(saved.status).toBe(0);
    expect(instance.requests[5]).toMatchObject({ authorization: "Bearer pp_saved" });
    const savedStatus = await runCli(["status"], { stateDir: dir });
    expect(JSON.parse(savedStatus.stdout)).toMatchObject({
      hasToken: true,
      tokenSource: "auth-set"
    });

    const env = { PATCHY_API_TOKEN: "pp_environment" };
    const explicit = await runCli(["publish", file, "--new", "--json"], { stateDir: dir, env });
    expect(explicit.status).toBe(0);
    expect(instance.requests[8]).toMatchObject({ authorization: "Bearer pp_environment" });
    const environmentStatus = await runCli(["status"], { stateDir: dir, env });
    expect(JSON.parse(environmentStatus.stdout)).toMatchObject({
      hasToken: true,
      tokenSource: null
    });
  });

  it("checks identity before release and HTML, and does not retry a refused key", async () => {
    const instance = await stubInstance((request, respond) =>
      request.authorization === "Bearer pp_good"
        ? respond(200, identity)
        : respond(401, { ok: false, error: "Missing or invalid API token." })
    );
    const dir = tempDir();
    const bad = htmlFile(dir, "bad.html", "<!doctype html><script>1</script>");
    const env = { PATCHY_API_TOKEN: "pp_bad", PATCHY_API_URL: instance.url };
    const local = await runCli(["publish", bad], {
      stateDir: dir,
      env: { ...env, PATCHY_API_TOKEN: "pp_good" }
    });
    expect(local.status).toBe(1);
    expect(local.stderr).toContain("HTML failed Patchy Cloud validation");
    expect(instance.requests.map((r) => r.url)).toEqual(["/api/me", "/api/release"]);

    const good = htmlFile(dir, "good.html", validHtml);
    const rejected = await runCli(["publish", good], { stateDir: dir, env });
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("Missing or invalid API token.");
    expect(instance.requests.map((r) => r.url)).toEqual(["/api/me", "/api/release", "/api/me"]);
  });

  it("reports an unavailable update target without retrying as a create", async () => {
    const instance = await stubPublishingInstance((_, respond) =>
      respond(404, { ok: false, error: "Patch not found." })
    );
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp" };

    const explicit = await runCli(["publish", file, "--patch", "abcdefghijkl"], {
      stateDir: dir,
      env
    });
    expect(explicit.status).toBe(2);
    expect(explicit.stderr).toBe(
      "Patch is unavailable for update. --patch never creates a new patch.\n"
    );

    writeFileSync(
      path.join(dir, "patches.json"),
      JSON.stringify({
        hosts: {
          [instance.url]: {
            files: {
              [file]: {
                draftId: "mnopqrstuvwx",
                publicUrl: "u",
                latestVersionNumber: 1,
                updatedAt: "t"
              }
            }
          }
        }
      })
    );
    const cached = await runCli(["publish", file], { stateDir: dir, env });
    expect(cached.status).toBe(2);
    expect(cached.stderr).toBe(
      "Cached patch is unavailable for update. Use --new to create a new patch.\n"
    );
    // The pre-rename `draftId` entry was read as the same page.
    expect(instance.requests[5]?.body).toMatchObject({ patchId: "mnopqrstuvwx" });
    expect(instance.requests).toHaveLength(6);
    expect(existsSync(path.join(dir, "publish", sha256(instance.url), "attempt"))).toBe(false);

    const conflict = await runCli(["publish", file, "--patch", "abcdefghijkl", "--new"], {
      stateDir: dir,
      env
    });
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toBe("--patch and --new cannot be used together.\n");
  });

  it("refuses to publish past a patch cache still named drafts.json", async () => {
    const instance = await stubPublishingInstance((_, respond) =>
      respond(201, publish(201, "abcdefghijkl", 1))
    );
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    // Refused even beside a patches.json: the CLI never guesses which one is current.
    for (const name of ["drafts.json", "patches.json"]) {
      writeFileSync(path.join(dir, name), JSON.stringify({ hosts: {} }));
    }

    const result = await runCli(["publish", file], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp" }
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `The patch cache is now ${path.join(dir, "patches.json")} but the old file is still here: ${path.join(dir, "drafts.json")}\n` +
        "Rename it to patches.json to keep updating the patches it remembers, or delete it to start a fresh cache.\n"
    );
    expect(instance.requests.map((request) => request.url)).toEqual(["/api/me", "/api/release"]);
  });

  it("fails closed on invalid stored credentials for this instance, and only this instance", async () => {
    const instance = await stubInstance((_, respond) => respond(200, identity));
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({ hosts: { [instance.url]: { token: "" }, "http://other.test": 42 } })
    );
    const file = htmlFile(dir, "page.html", validHtml);
    const broken = await runCli(["publish", file, "--api-url", instance.url], { stateDir: dir });
    expect(broken.status).toBe(1);
    expect(broken.stderr).toBe(
      `Stored credentials for ${instance.url} are invalid. Run: patchy auth set --api-url ${instance.url} to replace them.\n`
    );
    expect(instance.requests).toHaveLength(0);

    // Repairing this instance's entry keeps the neighbour's exactly as it was.
    await runCli(["auth", "set", "--token-stdin", "--api-url", instance.url], {
      stateDir: dir,
      input: "pp_ok\n"
    });
    expect(readJson(path.join(dir, "credentials.json"))).toMatchObject({
      hosts: { [instance.url]: { token: "pp_ok" }, "http://other.test": 42 }
    });
    expect((await runCli(["whoami", "--api-url", instance.url], { stateDir: dir })).status).toBe(0);
  });
});

describe("patchy share", () => {
  it("targets this instance's cached patch or an explicit ID, preserving the cache on success and refusal", async () => {
    const patchId = "abcdefghijkl";
    const publicUrl = `http://instance.test/${DEV_SEED.companyHandle}/page`;
    let responses = 0;
    const instance = await stubInstance((request, respond) => {
      if (
        request.method !== "POST" ||
        request.url !== `/api/patches/${patchId}/share` ||
        request.authorization !== "Bearer pp_owner"
      ) {
        return respond(404, { ok: false, error: "Patch not found." });
      }
      respond(200, {
        ok: true,
        patchId,
        scope: responses++ === 0 ? "public" : "company",
        publicUrl
      });
    });
    const other = await stubInstance((_, respond) =>
      respond(404, { ok: false, error: "Patch not found." })
    );
    const dir = tempDir();
    // Sharing only needs the cached path, not the original file's contents.
    const file = path.join(dir, "page.html");
    const cached = { patchId, publicUrl, latestVersionNumber: 7, updatedAt: "unchanged" };
    const cachePath = path.join(dir, "patches.json");
    const cache = JSON.stringify({
      hosts: {
        [instance.url]: { files: { [file]: cached } },
        "http://other.test": { files: { [file]: { ...cached, patchId: "mnopqrstuvwx" } } }
      }
    });
    writeFileSync(cachePath, cache);
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };

    const shared = await runCli(["share", "page.html", "public"], { stateDir: dir, env });
    expect(shared.status).toBe(0);
    expect(shared.stderr).toBe("");
    expect(shared.stdout).toContain(`URL: ${publicUrl}`);
    expect(shared.stdout).toContain("Scope: public (anyone with the link)");
    expect(readFileSync(cachePath, "utf8")).toBe(cache);

    const restricted = await runCli(["share", "--patch", patchId, "company", "--json"], {
      stateDir: dir,
      env
    });
    expect(restricted.status).toBe(0);
    expect(restricted.stderr).toBe("");
    expect(JSON.parse(restricted.stdout)).toEqual({
      ok: true,
      patchId,
      scope: "company",
      publicUrl
    });
    expect(readFileSync(cachePath, "utf8")).toBe(cache);

    const refused = await runCli(["share", "--patch", "mnopqrstuvwx", "public", "--json"], {
      stateDir: dir,
      env
    });
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe("");
    expect(JSON.parse(refused.stderr)).toMatchObject({
      ok: false,
      kind: "rejected",
      error: "Patch not found."
    });
    expect(readFileSync(cachePath, "utf8")).toBe(cache);
    expect(instance.requests).toHaveLength(3);

    const uncached = await runCli(
      ["share", "page.html", "public", "--api-url", other.url, "--json"],
      {
        stateDir: dir,
        env
      }
    );
    expect(uncached.status).toBe(1);
    expect(JSON.parse(uncached.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(other.requests).toHaveLength(0);
    expect(readFileSync(cachePath, "utf8")).toBe(cache);
  });

  it.each([
    { args: [] },
    { args: ["--patch", "abcdefghijkl", "private"] },
    { args: ["page.html", "public", "--patch", "abcdefghijkl"] }
  ])("rejects invalid targets or scope locally: $args", async ({ args }) => {
    const instance = await stubInstance((_, respond) => respond(500, {}));
    const result = await runCli(["share", ...args, "--json"], {
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests).toHaveLength(0);
  });
});

describe("patchy delete", async () => {
  it("forgets every cached file after deletion and reports a repeated delete as wrong_state", async () => {
    const live = new Set<string>();
    const deletedPatches = new Set<string>();
    const deletion = {
      ok: true,
      patchId: "abcdefghijkl",
      state: "deleted",
      deletedAt: "2026-01-01T00:00:00.000Z",
      purgeAt: "2026-01-31T00:00:00.000Z"
    };
    const instance = await stubPublishingInstance((request, respond) => {
      if (request.url === "/api/publish") {
        const body = request.body as { patchId?: string };
        if (body.patchId !== undefined) {
          return live.has(body.patchId)
            ? respond(200, publish(200, body.patchId, 2))
            : respond(404, { ok: false, error: "Patch not found." });
        }
        live.add("abcdefghijkl");
        return respond(201, publish(201, "abcdefghijkl", 1));
      }
      const patchId = request.url.replace("/api/patches/", "");
      if (request.method === "DELETE" && live.delete(patchId)) {
        deletedPatches.add(patchId);
        return respond(200, deletion);
      }
      if (request.method === "DELETE" && deletedPatches.has(patchId))
        return respond(409, {
          ok: false,
          code: "wrong_state",
          state: "deleted",
          error: "Patch is deleted."
        });
      return respond(404, { ok: false, error: "Patch not found." });
    });
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const copy = htmlFile(dir, "copy.html", validHtml);
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    expect((await runCli(["publish", file], { stateDir: dir, env })).status).toBe(0);
    // A second file pointed at the same patch by hand; the cache now names it twice.
    expect(
      (await runCli(["publish", copy, "--patch", "abcdefghijkl"], { stateDir: dir, env })).status
    ).toBe(0);

    const deleted = await runCli(["delete", file, "--yes", "--json"], { stateDir: dir, env });
    expect(deleted).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(deleted.stdout)).toEqual(deletion);
    expect(instance.requests[6]).toMatchObject({
      method: "DELETE",
      url: "/api/patches/abcdefghijkl",
      authorization: "Bearer pp_owner"
    });
    // Every file that pointed at the patch is forgotten, not only the one named,
    // so no later file publish tries to update the deleted patch.
    expect(readJson(path.join(dir, "patches.json"))).toEqual({
      hosts: { [instance.url]: { files: {} } }
    });

    const forgotten = await runCli(["delete", file], { stateDir: dir, env });
    expect(forgotten.status).toBe(1);
    expect(forgotten.stderr).toMatch(/^No patch on .* was published from /);
    expect(instance.requests).toHaveLength(7);

    const repeated = await runCli(["delete", "--patch", "abcdefghijkl", "--yes", "--json"], {
      stateDir: dir,
      env
    });
    expect(repeated.status).toBe(2);
    expect(JSON.parse(repeated.stderr)).toMatchObject({ kind: "rejected", code: "wrong_state" });
  });
});
