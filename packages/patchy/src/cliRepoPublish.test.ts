// Repo publish checks: bound targets, the tier 0 refusal and bundled resources.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../../test/crypto.js";
import { CURRENT_RELEASE, MANIFEST_VERSION, repoLimits } from "@patchy/api";
import {
  decodePublishRequest,
  embeddedFontLook,
  generateProjectResponse,
  identity,
  localPackageRegistry,
  packageDir,
  projectHandler,
  projectSource,
  projectTree,
  publish,
  publishTree,
  releaseArtifact,
  runCli,
  stubInstance,
  tempDir,
  treeBytes,
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

  it("names pnpm patchy refresh when the instance moved past a repo's current pin", async () => {
    const instance = await stubInstance(projectHandler, () => "9.9.9");
    const dir = projectTree(instance.url);
    const result = await runCli(["publish", "--json"], {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_TOKEN: "pp_owner" }
    });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    const failure = JSON.parse(result.stderr);
    expect(failure).toMatchObject({ ok: false, kind: "local", code: "release_mismatch" });
    expect(failure.error).toContain("9.9.9");
    expect(failure.error).toContain("Run: pnpm patchy refresh");
    expect(failure.error).not.toContain("install.mjs");
  });

  // A repo bound before patchy.json kept a version can't be checked for newer work, so it goes over
  // what is live only when told to, once; that publish records the version the next one sends. A
  // dry run refuses it the same way, so a dry run that passes means publish won't refuse it locally.
  it("refuses a bound repo with no version, dry run too, until --allow-behind, which records one", async () => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish")
        return respond(200, { ...publish(200, "abcdefghijkl", 3), tier: 1 });
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = { cwd: dir, stateDir: tempDir(), env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const repoFile = path.join(dir, "patchy.json");
    const legacy = JSON.stringify({
      instance: instance.url,
      patch: "abcdefghijkl",
      description: "Synthetic notes"
    });
    writeFileSync(repoFile, legacy);

    const refused = await runCli(["publish", "--json"], options);
    expect(refused).toMatchObject({ status: 1, stdout: "" });
    const failure = JSON.parse(refused.stderr);
    expect(failure).toMatchObject({ ok: false, kind: "local", code: "unknown_base_version" });
    expect(failure.error).toContain("patchy pull abcdefghijkl");
    expect(failure.error).toContain("--allow-behind");
    const dry = await runCli(["publish", "--dry-run", "--json"], options);
    expect(dry).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(dry.stderr)).toEqual(failure);
    const dryAllowed = await runCli(["publish", "--dry-run", "--allow-behind", "--json"], options);
    expect(dryAllowed, dryAllowed.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(dryAllowed.stdout)).toMatchObject({ ok: true, dryRun: true });
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
    expect(readFileSync(repoFile, "utf8")).toBe(legacy);
    expect(existsSync(path.join(dir, ".patchy/publish"))).toBe(false);

    const allowed = await runCli(["publish", "--allow-behind", "--json"], options);
    expect(allowed, allowed.stderr).toMatchObject({ status: 0, stderr: "" });
    const sent = decodePublishRequest(
      instance.requests.find((request) => request.url === "/api/publish")?.body
    );
    expect(sent).toMatchObject({ patchId: "abcdefghijkl" });
    expect(sent.baseVersion).toBeUndefined();
    expect(JSON.parse(readFileSync(repoFile, "utf8"))).toMatchObject({ version: 3 });
  });

  // repoSnapshot.test.ts owns what is kept and the warnings; this proves a dry run checks and
  // reports it without sending, and leaves a pending publish for the next real one.
  it("lists what a repo's version would keep without sending it, even with a publish pending", async () => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") return disconnect();
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = { cwd: dir, stateDir: tempDir(), env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const notes = "Kept, tracked or not.";
    writeFileSync(path.join(dir, "notes.md"), notes);
    const sent = () => instance.requests.filter((request) => request.url === "/api/publish");

    const dry = await runCli(["publish", "--dry-run", "--json"], options);
    expect(dry, dry.stderr).toMatchObject({ status: 0, stderr: "" });
    const report = JSON.parse(dry.stdout);
    expect(report).toMatchObject({
      ok: true,
      dryRun: true,
      note: "Checks the repo snapshot and version without building or sending; publish still runs the build.",
      repo: { limits: { files: 2000, bytes: 10 * 1024 * 1024 } },
      warnings: []
    });
    expect(report.repo.entries).toContainEqual({
      path: "notes.md",
      files: 1,
      bytes: Buffer.byteLength(notes)
    });
    expect(
      report.repo.entries.reduce(
        (total: number, entry: { files: number }) => total + entry.files,
        0
      )
    ).toBe(report.repo.files);
    expect(sent()).toEqual([]);
    expect(existsSync(path.join(dir, ".patchy/publish"))).toBe(false);

    expect((await runCli(["publish", "--json"], options)).status).toBe(3);
    const pending = await runCli(["publish", "--dry-run", "--json"], options);
    expect(pending, pending.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(pending.stdout).warnings).toEqual([
      expect.stringContaining("the next `patchy publish` recovers it")
    ]);
    expect(sent()).toHaveLength(1);

    const file = await runCli(["publish", "index.html", "--dry-run", "--json"], options);
    expect(file).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(file.stderr).error).toContain("patchy validate <file>");
  });

  // A dry run measures patchy.json as the portal's newer description would leave it, and writes
  // nothing: neither that description nor anything else lands in the repo.
  it("leaves patchy.json and every other file in the repo as they were after a dry run", async () => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/patches/abcdefghijkl?state=all")
        return respond(200, {
          ...projectSource,
          description: "New portal text",
          descriptionUpdatedAt: "2026-09-17T00:00:00.000Z"
        });
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = { cwd: dir, stateDir: tempDir(), env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const repoFile = path.join(dir, "patchy.json");
    const local = JSON.stringify({
      instance: instance.url,
      patch: "abcdefghijkl",
      version: 1,
      description: "Local edit",
      descriptionSyncedAt: "2026-09-15T00:00:00.000Z"
    });
    writeFileSync(repoFile, local);
    const before = treeBytes(dir);
    const dry = await runCli(["publish", "--dry-run", "--json"], options);
    expect(dry, dry.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(repoFile, "utf8")).toBe(local);
    expect(treeBytes(dir)).toEqual(before);
  });

  /**
   * A bound repo at the snapshot limit, give or take `over` bytes, with `description` in its
   * patchy.json, as the description sync writes it; `portal` then changes the portal's
   * description to one newer than it.
   */
  const repoAtLimit = async (description: string, over: number) => {
    let cloud = { description, descriptionUpdatedAt: null as string | null };
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/patches/abcdefghijkl?state=all")
        return respond(200, { ...projectSource, ...cloud });
      if (request.url === "/api/publish") {
        const kept = decodePublishRequest(request.body).repo ?? [];
        const bytes = kept.reduce(
          (total, file) => total + Buffer.from(file.contents, "base64").length,
          0
        );
        return respond(200, {
          ...publish(200, "abcdefghijkl", 2),
          tier: 1,
          artifacts: {
            ...publish(200, "abcdefghijkl", 2).artifacts,
            repo: { files: kept.length, bytes }
          }
        });
      }
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = { cwd: dir, stateDir: tempDir(), env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const repo = {
      instance: instance.url,
      patch: "abcdefghijkl",
      version: 1,
      description,
      descriptionSyncedAt: "2026-09-15T00:00:00.000Z"
    };
    writeFileSync(path.join(dir, "patchy.json"), `${JSON.stringify(repo, null, 2)}\n`);
    const dryRun = () => runCli(["publish", "--dry-run", "--json"], options);
    const measured = await dryRun();
    expect(measured, measured.stderr).toMatchObject({ status: 0 });
    const filler = repoLimits.bytes - JSON.parse(measured.stdout).repo.bytes + over;
    writeFileSync(path.join(dir, "filler.bin"), Buffer.alloc(filler));
    const portal = (text: string) => {
      cloud = { description: text, descriptionUpdatedAt: "2026-09-17T00:00:00.000Z" };
    };
    return { instance, options, dryRun, portal };
  };

  // The size check counts patchy.json as publish would keep it, after the description sync.
  it("refuses a dry run as publish does when a longer portal description takes the repo past the limit", async () => {
    const { instance, options, dryRun, portal } = await repoAtLimit("Synthetic notes", 0);
    const full = await dryRun();
    expect(full, full.stderr).toMatchObject({ status: 0 });
    expect(JSON.parse(full.stdout).repo.bytes).toBe(repoLimits.bytes);
    portal("Synthetic notes, with a longer description written in the portal since");
    const dry = await dryRun();
    expect(dry).toMatchObject({ status: 1, stdout: "" });
    const real = await runCli(["publish", "--json"], options);
    expect(real).toMatchObject({ status: 1, stdout: "" });
    // The whole document matches, the portal's notice included.
    expect(JSON.parse(dry.stderr)).toEqual(JSON.parse(real.stderr));
    expect(JSON.parse(dry.stderr)).toMatchObject({
      kind: "local",
      code: "too_large",
      warnings: [expect.stringContaining("changed in the portal")]
    });
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
  });

  it("passes a dry run as publish does when a shorter portal description brings the repo under the limit", async () => {
    const { options, dryRun, portal } = await repoAtLimit(
      "Synthetic notes, with a longer description written in this repo first",
      1
    );
    const over = await dryRun();
    expect(over).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(over.stderr)).toMatchObject({ code: "too_large" });
    portal("Synthetic notes");
    const dry = await dryRun();
    expect(dry, dry.stderr).toMatchObject({ status: 0 });
    const real = await runCli(["publish", "--json"], options);
    expect(real, real.stderr).toMatchObject({ status: 0 });
    expect(JSON.parse(real.stdout).artifacts.repo).toEqual({
      files: JSON.parse(dry.stdout).repo.files,
      bytes: JSON.parse(dry.stdout).repo.bytes
    });
  });

  /** An attempt an older CLI saved for a tier 0 publish, which only a real publish clears. */
  const tierZeroAttempt = (dir: string, instanceUrl: string) => {
    const attemptPath = path.join(dir, ".patchy/publish", sha256(instanceUrl), "attempt");
    mkdirSync(attemptPath, { recursive: true });
    const file = path.join(attemptPath, `${sha256("tier-zero-attempt")}.json`);
    const attempt = JSON.stringify({
      ownerUserId: identity.user.id,
      target: { mode: "repo" },
      request: {
        publishKey: "tier-zero-attempt",
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
    });
    writeFileSync(file, attempt);
    return { file, attempt };
  };

  // The pending notice is remembered as soon as the attempt is found, so a refusal carries it.
  it("keeps the pending notice when a dry run is refused for size or a failed portal read", async () => {
    let gone = false;
    const instance = await stubInstance((request, respond, disconnect) => {
      if (gone && request.url === "/api/patches/abcdefghijkl?state=all")
        return respond(404, { ok: false, error: "Patch not found." });
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    writeFileSync(
      path.join(dir, "patchy.json"),
      JSON.stringify({
        instance: instance.url,
        patch: "abcdefghijkl",
        version: 1,
        description: "Synthetic notes"
      })
    );
    tierZeroAttempt(dir, instance.url);
    const options = { cwd: dir, stateDir: tempDir(), env: { PATCHY_API_TOKEN: "pp_owner" } };
    const pending = expect.stringContaining("A publish is pending");

    const filler = path.join(dir, "filler.bin");
    writeFileSync(filler, Buffer.alloc(repoLimits.bytes + 1));
    const large = await runCli(["publish", "--dry-run", "--json"], options);
    expect(large).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(large.stderr)).toMatchObject({ code: "too_large", warnings: [pending] });

    rmSync(filler);
    gone = true;
    const unread = await runCli(["publish", "--dry-run", "--json"], options);
    expect(unread).toMatchObject({ status: 2, stdout: "" });
    expect(JSON.parse(unread.stderr)).toMatchObject({
      kind: "rejected",
      error: expect.stringContaining("Patch is unavailable for update"),
      warnings: [pending]
    });
  });

  // State.test.ts owns how publish clears an older CLI's tier 0 attempt; a dry run only reports it.
  it("leaves an older CLI's tier 0 attempt in place after a dry run", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const options = { cwd: dir, stateDir: tempDir(), env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const { file, attempt } = tierZeroAttempt(dir, instance.url);

    const dry = await runCli(["publish", "--dry-run", "--json"], options);
    expect(dry, dry.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(dry.stdout).warnings).toEqual([
      expect.stringContaining("A publish is pending")
    ]);
    expect(readFileSync(file, "utf8")).toBe(attempt);
  });

  // Notices found before a failure are kept, the snapshot's own warnings too.
  it("keeps the near-limit warning when the typecheck fails", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const options = { cwd: dir, stateDir: tempDir(), env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets/video.bin"), Buffer.alloc(8.5 * 1024 * 1024));
    writeFileSync(path.join(dir, "src/main.ts"), "const title: string = 42;");
    const failed = await runCli(["publish", "--json"], options);
    expect(failed).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(failed.stderr)).toMatchObject({
      kind: "local",
      error: expect.stringContaining("Typecheck"),
      warnings: [expect.stringContaining("near the most a version keeps")]
    });
  });

  // Tier 0 is now tier 1: a repo still configured at tier 0 is refused before it builds, generates
  // or sends anything, and init no longer makes one.
  it("refuses a tier 0 repo by publish and dev before building, and init at tier 0", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const env = { PATCHY_API_TOKEN: "pp_owner" };
    const refreshed = await runCli(["refresh", "--json"], { cwd: dir, env });
    expect(refreshed.status, refreshed.stderr).toBe(0);
    const config = path.join(dir, "patchy.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("tier: 1", "tier: 0"));
    const refreshes = instance.requests.length;
    for (const command of ["publish", "dev"]) {
      const result = await runCli([command, "--json"], { cwd: dir, env, stateDir: tempDir() });
      expect(result).toMatchObject({ status: 1, stdout: "" });
      expect(JSON.parse(result.stderr)).toEqual({
        ok: false,
        kind: "local",
        code: "tier_mismatch",
        error: "Tier 0 is now tier 1. Set `tier: 1` and run `patchy refresh`."
      });
    }
    expect(existsSync(path.join(dir, "dist"))).toBe(false);
    expect(existsSync(path.join(dir, ".patchy/publish"))).toBe(false);
    expect(
      instance.requests
        .slice(refreshes)
        .filter((request) => ["/api/publish", "/api/sdk/generate"].includes(request.url))
    ).toEqual([]);

    const before = instance.requests.length;
    const init = await runCli(
      ["init", "static-page", "--tier", "0", "--purpose", "A static page", "--json"],
      { cwd: tempDir(), env: { ...env, PATCHY_API_URL: instance.url } }
    );
    expect(init.status).toBe(1);
    expect(init.stdout).toBe("");
    expect(JSON.parse(init.stderr)).toEqual({
      ok: false,
      kind: "local",
      error: 'Invalid value for flag --tier: "0". Expected: "1" | "2"'
    });
    expect(instance.requests.length).toBe(before);
  });

  // repoBuild.test.ts owns what the inspector refuses and the cap; this proves Vite's output
  // reaches the check, and that `patchy init` produces a repo whose page publishes, in the company
  // look with its embedded font, keeping its repo for a colleague to pull back set up.
  it("refuses unbundled resources before sending, then publishes the starter with its repo and version and pulls it back set up", async () => {
    const registry = await localPackageRegistry();
    let kept: ReadonlyArray<{ path: string; contents: string }> = [];
    const instance = await stubInstance(
      (request, respond, disconnect) => {
        if (request.url === "/api/publish") {
          kept = decodePublishRequest(request.body).repo ?? [];
          return respond(201, {
            ...publish(201, "abcdefghijkl", 1, "company", "notes-page"),
            tier: 1,
            artifacts: {
              ...publish(201, "abcdefghijkl", 1).artifacts,
              repo: { files: kept.length, bytes: 1234 }
            }
          });
        }
        if (request.url.split("?")[0] === "/api/patches/notes-page/repo")
          return respond(200, {
            ok: true,
            patchId: "abcdefghijkl",
            name: "notes-page",
            state: "live",
            versionNumber: 1,
            tier: 1,
            owner: { id: "usr_colleague", name: "Colleague" },
            description: "A page of notes, described in the portal",
            descriptionUpdatedAt: "2026-10-29T00:00:00.000Z",
            kind: "repo",
            files: kept
          });
        if (request.url === "/api/sdk/generate")
          return respond(200, generateProjectResponse(request.body, embeddedFontLook));
        projectHandler(request, respond, disconnect);
      },
      () => CURRENT_RELEASE,
      readFileSync(
        path.join(packageDir, `artifacts/patchy-${CURRENT_RELEASE}-${releaseArtifact.digest}.tgz`)
      )
    );
    const parent = tempDir();
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    const initialized = await runCli(
      ["init", "notes-page", "--purpose", "A page of notes", "--json"],
      { cwd: parent, env: { ...env, ...registry } }
    );
    expect(initialized, initialized.stderr).toMatchObject({ status: 0, stderr: "" });
    const dir = path.join(parent, "notes-page");
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      ok: true,
      dir,
      tier: 1,
      installed: true
    });
    const options = { cwd: dir, stateDir: tempDir(), env };
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
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
    expect(existsSync(path.join(dir, ".patchy/publish"))).toBe(false);

    writeFileSync(entry, starter);
    const published = await runCli(["publish", "--json"], options);
    expect(published, published.stderr).toMatchObject({ status: 0, stderr: "" });
    const sent = decodePublishRequest(
      instance.requests.find((request) => request.url === "/api/publish")?.body
    );
    expect(sent.manifest.tier).toBe(1);
    expect(sent.html).toContain(embeddedFontLook.font);
    expect(sent.html).toMatch(/main\{[^}]*max-width:960px/);

    // The repo goes with the version, without installs, local state or what refresh regenerates.
    const paths = (sent.repo ?? []).map((file) => file.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(
      expect.arrayContaining(["AGENTS.md", "index.html", "package.json", "patchy.config.ts"])
    );
    expect(
      paths.filter((file) =>
        /^(node_modules|\.patchy|patchy\/_generated|\.agents\/skills\/patchy-)/.test(file)
      )
    ).toEqual([]);
    expect(JSON.parse(published.stdout)).toMatchObject({
      artifacts: { repo: { files: paths.length } }
    });
    expect(JSON.parse(readFileSync(path.join(dir, "patchy.json"), "utf8"))).toMatchObject({
      patch: "abcdefghijkl",
      version: 1
    });
    // The next publish says which version this copy is from, unless told to go over newer ones.
    const lastSent = () =>
      decodePublishRequest(instance.requests.filter((r) => r.url === "/api/publish").at(-1)?.body);
    expect((await runCli(["publish", "--json"], options)).status).toBe(0);
    expect(lastSent().baseVersion).toBe(1);
    expect((await runCli(["publish", "--allow-behind", "--json"], options)).status).toBe(0);
    expect(lastSent().baseVersion).toBeUndefined();

    // A colleague pulls it into a folder where the patch builds again on today's release.
    const into = (args: ReadonlyArray<string>) =>
      runCli(["pull", "notes-page", ...args, "--json"], {
        cwd: parent,
        stateDir: tempDir(),
        env: { ...env, ...registry, pnpm_config_optional: "true" }
      });
    const occupied = await into([]);
    expect(occupied).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(occupied.stderr).error).toBe(
      `Refusing to pull into an existing tree: ${dir}`
    );
    const pulled = await into(["copy"]);
    expect(pulled, pulled.stderr).toMatchObject({ status: 0, stderr: "" });
    const copy = path.join(parent, "copy");
    expect(JSON.parse(pulled.stdout)).toMatchObject({
      ok: true,
      dir: copy,
      versionNumber: 1,
      kind: "repo",
      files: paths,
      owner: { id: "usr_colleague", name: "Colleague" },
      mine: false,
      setUp: true,
      release: CURRENT_RELEASE,
      warnings: []
    });
    expect(JSON.parse(readFileSync(path.join(copy, "patchy.json"), "utf8"))).toMatchObject({
      instance: instance.url,
      patch: "abcdefghijkl",
      version: 1,
      description: "A page of notes, described in the portal",
      descriptionSyncedAt: "2026-10-29T00:00:00.000Z"
    });
    for (const file of [
      "node_modules/patchy/package.json",
      "patchy/_generated/index.json",
      ".agents/skills/patchy-loop/SKILL.md"
    ])
      expect(existsSync(path.join(copy, file)), file).toBe(true);
    expect(readFileSync(path.join(copy, "index.html"), "utf8")).toBe(starter);
  }, 240_000); // Two offline installs of the real release archive.
});
