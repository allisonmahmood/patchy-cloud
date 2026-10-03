// The packed `patchy` release against a disposable real server and Postgres.
//   node scripts/packed-cli-e2e.mjs                  the full journey (`pnpm test:packed-cli-e2e`)
//   node scripts/packed-cli-e2e.mjs --tier2          the tier 2 journey in packed-tier2-e2e.mjs
//   node scripts/packed-cli-e2e.mjs --cleanup-check  cleanup() reaps what a child leaves behind
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter, on } from "node:events";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import pg from "pg";
import { tsImport } from "tsx/esm/api";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPackageDir = path.join(repoRoot, "packages/patchy");
const serverEntry = path.join(repoRoot, "apps/server/dist/start.js");
// npm is a pinned root devDependency so this test can pack bundled dependencies
// and install the CLI tarball hermetically, without publishing it to a registry.
const npmCliEntry = path.join(repoRoot, "node_modules/npm/bin/npm-cli.js");
// Cold workspace compilation includes the SDK tarball; it is not a runtime command.
const buildTimeoutMs = 120_000;
let DEV_SEED;
let authTesting;
const activeChildren = new Set();
const trackedProcessGroups = new Set();
let latchedSignal;
let latchedSignalExitCode;
let tempRoot;
let cleanupPromise;
let portReservation;
let serverProcess;
let serverProcessFailure;
let serverReadyStdoutObserved = false;
let serverStdout = "";
let serverStderr = "";
let tier1BrowserServer;
let patchDevCleanup;
/** The embedded Postgres behind the real server, started once per process. */
let postgres;
const TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM", "SIGBREAK"];

class SignalAbort extends Error {
  constructor(signal) {
    super(`received ${signal}`);
    this.name = "SignalAbort";
    this.signal = signal;
  }
}

/** Ends a mode that runs only part of the flow (`--cleanup-check`, `--tier2`) without failing. */
class ModeComplete extends Error {
  constructor() {
    super("mode completed");
    this.name = "ModeComplete";
  }
}

class ServerStartupError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ServerStartupError";
    this.code = options.code;
    this.cause = options.cause;
  }
}

function latchSignal(signal) {
  if (latchedSignal) return;
  latchedSignal = signal;
  latchedSignalExitCode = 128 + os.constants.signals[signal];
  process.exitCode = latchedSignalExitCode;
  for (const child of activeChildren) terminateProcessGroup(child, "SIGTERM");
  terminateTrackedProcessGroups("SIGTERM");
}

function throwIfSignalLatched() {
  if (latchedSignal) throw new SignalAbort(latchedSignal);
}

async function checkedCall(operation) {
  throwIfSignalLatched();
  const result = await operation();
  throwIfSignalLatched();
  return result;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => latchSignal(signal));
}

let mainFailure;
try {
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  assert.ok(
    nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 22),
    `packed CLI E2E requires Node 22.22.0 or newer; found ${process.version}`
  );
  // Process groups, `sh` and `script(1)` are POSIX; CI runs this on Ubuntu.
  assert.notEqual(process.platform, "win32", "packed CLI E2E runs on macOS and Linux only");

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "patchy-packed-cli-e2e-"));
  throwIfSignalLatched();
  if (process.argv[2] === "--cleanup-check") {
    await runCleanupCheck();
    throw new ModeComplete();
  }

  const packDir = path.join(tempRoot, "packed artifacts");
  const consumerDir = path.join(tempRoot, "clean consumer");
  const serverStateDir = path.join(tempRoot, "server state");
  const objectDir = path.join(serverStateDir, "objects");
  const cliStateDir = path.join(tempRoot, "cli state authenticated");
  assertSpacedPath("packed artifact directory", packDir);
  assertSpacedPath("clean consumer directory", consumerDir);
  assertSpacedPath("server state directory", serverStateDir);
  assertSpacedPath("CLI state directory", cliStateDir);
  console.log(
    `[packed-cli-e2e] spaced paths: consumer=${JSON.stringify(consumerDir)} artifact=${JSON.stringify(packDir)} state=${JSON.stringify(cliStateDir)}`
  );
  await checkedCall(() =>
    Promise.all([mkdir(packDir), mkdir(consumerDir), mkdir(serverStateDir), mkdir(cliStateDir)])
  );

  console.log("[packed-cli-e2e] building the real server");
  await run("pnpm", ["--filter", "@patchy/server...", "build"], {
    cwd: repoRoot,
    timeoutMs: buildTimeoutMs
  });

  console.log("[packed-cli-e2e] building CLI once");
  await run("pnpm", ["--filter", "patchy", "build"], {
    cwd: repoRoot,
    timeoutMs: buildTimeoutMs
  });

  console.log("[packed-cli-e2e] reading the exact digest-addressed release tarball");
  const releaseArtifact = JSON.parse(
    await checkedCall(() => readFile(path.join(cliPackageDir, "artifacts/release.json"), "utf8"))
  );
  const releaseTarball = path.join(
    cliPackageDir,
    `artifacts/patchy-${releaseArtifact.release}-${releaseArtifact.digest}.tgz`
  );
  const packed = await run("npm", [
    "pack",
    releaseTarball,
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packDir
  ]);
  const packResult = parsePackResult(packed.stdout);
  assert.equal(packResult.length, 1, "npm pack must produce exactly one artifact");

  const tarballs = (await checkedCall(() => readdir(packDir))).filter((entry) =>
    entry.endsWith(".tgz")
  );
  assert.deepEqual(
    tarballs,
    [path.basename(packResult[0].filename)],
    "npm pack must create one exact tarball"
  );
  const packedFiles = new Set(packResult[0].files.map((file) => file.path));
  for (const requiredFile of [
    "dist/index.js",
    "dist/dev.js",
    "dist/devChild.js",
    "node_modules/@electric-sql/pglite/package.json",
    "skills/patchy/SKILL.md",
    "LICENSE",
    "README.md"
  ]) {
    assert.ok(packedFiles.has(requiredFile), `packed CLI is missing ${requiredFile}`);
  }

  const tarballPath = path.join(packDir, tarballs[0]);
  console.log("[packed-cli-e2e] installing tarball offline with an empty npm cache");
  await run(
    "npm",
    [
      "install",
      "--offline",
      "--cache",
      path.join(tempRoot, "npm-cache"),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      tarballPath
    ],
    { cwd: consumerDir, timeoutMs: 120_000 }
  );

  const cliPath = installedCliBinPath(consumerDir);
  await checkedCall(() => access(cliPath));
  const installedManifest = JSON.parse(
    await checkedCall(() =>
      readFile(path.join(consumerDir, "node_modules/patchy/package.json"), "utf8")
    )
  );
  const version = await run(cliPath, ["--version"], { cwd: consumerDir });
  assert.equal(version.stdout.trim(), installedManifest.version);
  assert.notEqual(version.stdout.trim(), "0.0.0-dev");

  console.log("[packed-cli-e2e] exercising bundled PGlite from the installed dev runtime");
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'import assert from "node:assert/strict";',
        'import { createRequire } from "node:module";',
        'await import("patchy/dev");',
        'const require = createRequire(import.meta.resolve("patchy/dev"));',
        'const { PGlite } = require("@electric-sql/pglite");',
        "const database = await PGlite.create();",
        "try {",
        '  const result = await database.query("SELECT 42 AS answer");',
        "  assert.deepEqual(result.rows, [{ answer: 42 }]);",
        "} finally {",
        "  await database.close();",
        "}"
      ].join("\n")
    ],
    { cwd: consumerDir }
  );

  portReservation = await reserveLoopbackPort();
  let publicBaseUrl = `http://127.0.0.1:${portReservation.port}`;
  const startedServer = await startServer({
    publicBaseUrl,
    objectDir
  });
  publicBaseUrl = startedServer.publicBaseUrl;
  await waitForReady(`${publicBaseUrl}/healthz`);

  const cliEnv = environment(
    {
      PATCHY_STATE_DIR: cliStateDir
    },
    ["PATCHY_API_TOKEN", "PATCHY_API_URL"]
  );

  console.log("[packed-cli-e2e] configuring packed CLI auth through stdin");
  const auth = await runCli(cliPath, ["auth", "set", "--token-stdin", "--api-url", publicBaseUrl], {
    cwd: consumerDir,
    env: cliEnv,
    input: `${DEV_SEED.token}\n`
  });
  assert.equal(auth.stdout, `Patchy Cloud credentials saved for ${publicBaseUrl}.\n`);
  assert.equal(auth.stderr, "");
  assert.ok(!`${auth.stdout}${auth.stderr}`.includes(DEV_SEED.token), "token leaked in CLI output");

  if (process.argv[2] === "--tier2") {
    const { runTier2Flow } = await import("./packed-tier2-e2e.mjs");
    await seedOtherUserToken();
    tier1BrowserServer = await chromium.launchServer({
      headless: true,
      host: "127.0.0.1",
      env: sanitizedProcessEnv(),
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false
    });
    registerSpawnedChild(tier1BrowserServer.process());
    const browser = await checkedCall(() => chromium.connect(tier1BrowserServer.wsEndpoint()));
    let journeyTimeout;
    const timeout = new Promise((_, reject) => {
      journeyTimeout = setTimeout(() => {
        console.error("[packed-tier2-e2e] journey exceeded 5 minutes");
        latchSignal("SIGTERM");
        reject(new SignalAbort("SIGTERM"));
      }, 300_000);
    });
    try {
      await Promise.race([
        timeout,
        runTier2Flow({
          cliPath,
          cliEnv,
          publicBaseUrl,
          tempRoot,
          browser,
          authTesting,
          run,
          runCli,
          installedCliBinPath,
          startDev: async (cliPath, options) => {
            patchDevCleanup = { cliPath, options };
            const dev = JSON.parse((await runCli(cliPath, ["dev", "--json"], options)).stdout);
            patchDevCleanup.pid = dev.pid;
            trackedProcessGroups.add(dev.pid);
            return dev;
          },
          stopDev: async () => {
            await runCli(patchDevCleanup.cliPath, ["dev", "stop", "--json"], {
              ...patchDevCleanup.options,
              cleanup: true
            });
            trackedProcessGroups.delete(patchDevCleanup.pid);
            patchDevCleanup = undefined;
          }
        })
      ]);
    } finally {
      clearTimeout(journeyTimeout);
      await browser.close();
    }
    throw new ModeComplete();
  }

  const whoami = await runCli(cliPath, ["whoami"], {
    cwd: consumerDir,
    env: cliEnv
  });
  assert.equal(
    whoami.stdout,
    `User: ${DEV_SEED.userName} (${DEV_SEED.email})\nCompany: ${DEV_SEED.companyName} (${DEV_SEED.companyHandle})\nRole: ${DEV_SEED.role}\nMachine: ${DEV_SEED.tokenName} (${DEV_SEED.tokenId})\n`
  );
  assert.equal(whoami.stderr, "");

  const fixturePath = path.join(consumerDir, "review artifact.html");
  const fixtureArgument = "./review artifact.html";
  assertSpacedPath("HTML artifact path", fixturePath);
  console.log(`[packed-cli-e2e] spaced HTML artifact path: ${JSON.stringify(fixturePath)}`);
  const firstHtml = validHtml("Packed contract v1", "packed-contract-version-one");
  const secondHtml = validHtml("Packed contract v2", "packed-contract-version-two");
  const newHtml = validHtml("Packed contract new draft", "packed-contract-new-draft");

  console.log("[packed-cli-e2e] exercising authenticated create, cached update, and --new");
  await checkedCall(() => writeFile(fixturePath, firstHtml, "utf8"));
  const publicShellSequence = decodePackedCliWorkflow(
    await checkedCall(() =>
      readFile(path.join(consumerDir, "node_modules/patchy/README.md"), "utf8")
    )
  );
  const hostileInheritedApiToken = "hostile-inherited-api-token";
  const hostileInheritedToken = "hostile-inherited-token";
  console.log("[packed-cli-e2e] exercising shipped commands under inherited POSIX sh xtrace");
  const shellStateDir = path.join(tempRoot, "cli state shell credentials");
  await checkedCall(() => mkdir(shellStateDir));
  const shellEnv = { ...cliEnv, PATCHY_STATE_DIR: shellStateDir };
  const shellAuth = await runPublicPosixSh(publicShellSequence, {
    cwd: consumerDir,
    env: {
      ...shellEnv,
      PATH: [path.dirname(cliPath), cliEnv.PATH].filter(Boolean).join(path.delimiter),
      PATCHY_API_URL: "https://hostile.invalid",
      PATCHY_API_TOKEN: hostileInheritedApiToken,
      TOKEN: hostileInheritedToken,
      PATCHY_SETUP_URL: publicBaseUrl,
      PATCHY_SETUP_TOKEN: DEV_SEED.token
    },
    sensitiveValues: [DEV_SEED.token, hostileInheritedApiToken, hostileInheritedToken]
  });
  assert.equal(shellAuth.stdout, `Patchy Cloud credentials saved for ${publicBaseUrl}.\n`);
  const shellWhoami = await runCli(cliPath, ["whoami"], {
    cwd: consumerDir,
    env: shellEnv
  });
  assert.equal(shellWhoami.stdout, whoami.stdout);
  assert.equal(shellWhoami.stderr, "");
  const first = parsePublish(
    await runCli(cliPath, ["publish", fixtureArgument, "--share", "public"], {
      cwd: consumerDir,
      env: cliEnv
    })
  );
  assert.equal(first.label, "Published patch");
  assert.equal(first.versionNumber, 1);
  assert.equal(first.address, `${publicBaseUrl}/${DEV_SEED.companyHandle}/review-artifact`);
  assert.equal(first.scope, "public");
  const fixtureCachePath = await checkedCall(() => realpath(fixturePath));
  const patchCache = JSON.parse(
    await checkedCall(() => readFile(path.join(cliStateDir, "patches.json"), "utf8"))
  );
  assert.deepEqual(
    Object.keys(patchCache.hosts ?? {}),
    [publicBaseUrl],
    "the patch cache must be keyed by the instance the upload targeted"
  );
  assert.deepEqual(
    Object.keys(patchCache.hosts[publicBaseUrl].files ?? {}),
    [fixtureCachePath],
    "upload must cache the resolved spaced artifact path"
  );
  assert.equal(patchCache.hosts[publicBaseUrl].files[fixtureCachePath].publicUrl, first.address);

  await checkedCall(() => writeFile(fixturePath, secondHtml, "utf8"));
  const second = parsePublish(
    await runCli(cliPath, ["publish", fixtureArgument], { cwd: consumerDir, env: cliEnv })
  );
  assert.equal(second.label, "Updated patch");
  assert.equal(second.patchId, first.patchId);
  assert.equal(second.versionNumber, 2);
  assert.equal(second.scope, "public", "an update without --share must preserve sharing");
  assert.equal(second.address, first.address, "a cached update without --name must keep its name");

  const publicVersions = [
    { url: first.address, html: secondHtml, versionNumber: 2 },
    { url: `${first.address}/~v/2`, html: secondHtml, versionNumber: 2 }
  ];
  console.log("[packed-cli-e2e] validating the public current version at both URL shapes");
  for (const version of publicVersions) {
    assertPublicViewer(await fetchViewer(version.url), { ...version, patchId: first.patchId });
  }
  assertViewerDoor(await fetchViewer(`${first.address}/~v/1`));

  console.log("[packed-cli-e2e] refusing sharing changes by another user in the same company");
  const foreignToken = await checkedCall(() => seedOtherUserToken());
  const foreignShare = await runCli(
    cliPath,
    ["share", "--patch", first.patchId, "company", "--json"],
    {
      cwd: consumerDir,
      env: { ...cliEnv, PATCHY_API_TOKEN: foreignToken },
      allowFailure: true,
      sensitiveValues: [foreignToken]
    }
  );
  assert.equal(foreignShare.code, 2);
  assert.equal(foreignShare.stdout, "", "--json failure must leave stdout empty");
  const foreignFailure = JSON.parse(foreignShare.stderr);
  assert.equal(foreignFailure.ok, false);
  assert.equal(foreignFailure.kind, "rejected");
  assert.equal(foreignFailure.code, "not_owner");
  assertPublicViewer(await fetchViewer(first.address), {
    ...publicVersions[0],
    patchId: first.patchId
  });

  console.log("[packed-cli-e2e] taking the cached-file patch back inside the company");
  const companyShare = await runCli(cliPath, ["share", fixtureArgument, "company"], {
    cwd: consumerDir,
    env: cliEnv
  });
  assert.equal(companyShare.stderr, "");
  assert.match(companyShare.stdout, /^Scope: company\b/m);
  for (const { url } of publicVersions) {
    assertViewerDoor(await fetchViewer(url));
  }
  assertViewerDoor(await fetchViewer(`${first.address}/~v/1`));

  console.log("[packed-cli-e2e] sharing publicly again by explicit id under --json");
  const shared = await runCli(cliPath, ["share", "--patch", first.patchId, "public", "--json"], {
    cwd: consumerDir,
    env: cliEnv
  });
  assert.equal(shared.stderr, "", "--json success must leave stderr empty");
  assert.deepEqual(JSON.parse(shared.stdout), {
    ok: true,
    patchId: first.patchId,
    scope: "public",
    publicUrl: first.address
  });
  for (const version of publicVersions) {
    assertPublicViewer(await fetchViewer(version.url), { ...version, patchId: first.patchId });
  }
  assertViewerDoor(await fetchViewer(`${first.address}/~v/1`));

  await checkedCall(() => writeFile(fixturePath, newHtml, "utf8"));
  const freshUpload = await runCli(cliPath, ["publish", fixtureArgument, "--new", "--json"], {
    cwd: consumerDir,
    env: cliEnv
  });
  assert.equal(freshUpload.stderr, "", "--json success must leave stderr empty");
  const fresh = JSON.parse(freshUpload.stdout);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.scope, "company", "a new upload without --share defaults to company");
  assert.equal(fresh.versionNumber, 1);
  assert.notEqual(fresh.patchId, first.patchId);
  assert.equal(fresh.name, "review-artifact-2", "a new same-file patch must get an available name");
  assert.equal(fresh.address, `${publicBaseUrl}/${DEV_SEED.companyHandle}/${fresh.name}`);
  assert.equal(fresh.publicUrl, fresh.address);

  console.log("[packed-cli-e2e] validating the default-company publish's login door");
  for (const url of [fresh.address, `${fresh.address}/~v/1`]) {
    assertViewerDoor(await fetchViewer(url));
  }

  const metadata = await readMetadata();
  assert.equal(metadata.drafts.length, 2);
  assert.equal(metadata.draftVersions.length, 3);
  await assertStoredDraft(metadata, objectDir, {
    patchId: first.patchId,
    expectedHtmlByVersion: [firstHtml, secondHtml],
    scope: "public",
    companyId: DEV_SEED.companyId,
    ownerUserId: DEV_SEED.userId,
    machineTokenId: DEV_SEED.tokenId
  });
  await assertStoredDraft(metadata, objectDir, {
    patchId: fresh.patchId,
    expectedHtmlByVersion: [newHtml],
    scope: "company",
    companyId: DEV_SEED.companyId,
    ownerUserId: DEV_SEED.userId,
    machineTokenId: DEV_SEED.tokenId
  });

  const whoamiJson = await runCli(cliPath, ["whoami", "--json"], { cwd: consumerDir, env: cliEnv });
  assert.equal(whoamiJson.stderr, "", "--json success must leave stderr empty");
  assert.deepEqual(JSON.parse(whoamiJson.stdout), {
    user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
    company: {
      id: DEV_SEED.companyId,
      handle: DEV_SEED.companyHandle,
      name: DEV_SEED.companyName
    },
    role: DEV_SEED.role,
    machine: { id: DEV_SEED.tokenId, name: DEV_SEED.tokenName }
  });

  console.log("[packed-cli-e2e] proving environment credentials override stored credentials");
  const invalidStoredStateDir = path.join(tempRoot, "cli state invalid stored");
  await checkedCall(() => mkdir(invalidStoredStateDir));
  const invalidStoredToken = "invalid-stored-credential";
  await runCli(cliPath, ["auth", "set", "--token-stdin", "--api-url", publicBaseUrl], {
    cwd: consumerDir,
    env: environment({ PATCHY_STATE_DIR: invalidStoredStateDir }, ["PATCHY_API_TOKEN"]),
    input: `${invalidStoredToken}\n`,
    sensitiveValues: [invalidStoredToken]
  });
  const invalidStoredEnv = environment({ PATCHY_STATE_DIR: invalidStoredStateDir }, [
    "PATCHY_API_TOKEN",
    "PATCHY_API_URL"
  ]);
  const envPrecedenceHtml = validHtml(
    "Environment precedence",
    "valid-env-overrode-invalid-stored"
  );
  await checkedCall(() => writeFile(fixturePath, envPrecedenceHtml, "utf8"));
  const nameRefusal = await runCli(
    cliPath,
    ["publish", fixtureArgument, "--name", "review-artifact", "--json"],
    {
      cwd: consumerDir,
      env: { ...invalidStoredEnv, PATCHY_API_TOKEN: DEV_SEED.token },
      allowFailure: true
    }
  );
  assert.equal(nameRefusal.code, 2);
  assert.equal(nameRefusal.stdout, "");
  assert.equal(JSON.parse(nameRefusal.stderr).kind, "rejected");
  assert.equal(JSON.parse(nameRefusal.stderr).code, "name_taken");
  const envPrecedence = parsePublish(
    await runCli(cliPath, ["publish", fixtureArgument, "--name", "environment-precedence"], {
      cwd: consumerDir,
      env: { ...invalidStoredEnv, PATCHY_API_TOKEN: DEV_SEED.token }
    })
  );
  assert.equal(
    envPrecedence.address,
    `${publicBaseUrl}/${DEV_SEED.companyHandle}/environment-precedence`,
    "a corrected --name must start a fresh attempt after name_taken"
  );
  assertViewerDoor(await fetchViewer(envPrecedence.address));
  assertViewerDoor(await fetchViewer(`${envPrecedence.address}/~v/1`));

  const finalMetadata = await readMetadata();
  assert.equal(finalMetadata.drafts.length, 3);
  assert.equal(finalMetadata.draftVersions.length, 4);
  for (const draft of finalMetadata.drafts) {
    assert.equal(draft.companyId, DEV_SEED.companyId);
    assert.equal(draft.ownerUserId, DEV_SEED.userId);
  }
  assert.ok(
    !JSON.stringify(finalMetadata).includes(DEV_SEED.token),
    "the instance must keep only the machine token's hash"
  );
  await assertStoredDraft(finalMetadata, objectDir, {
    patchId: envPrecedence.patchId,
    expectedHtmlByVersion: [envPrecedenceHtml],
    scope: "company",
    companyId: DEV_SEED.companyId,
    ownerUserId: DEV_SEED.userId,
    machineTokenId: DEV_SEED.tokenId
  });

  console.log("[packed-cli-e2e] proving delete takes a patch down as its owner user");
  // Its own upload on the authenticated state dir, so deleting by file resolves
  // to the patch this step created, whatever the script cached before it.
  const doomedHtml = validHtml("Packed contract doomed", "packed-contract-doomed");
  await checkedCall(() => writeFile(fixturePath, doomedHtml, "utf8"));
  const doomed = parsePublish(
    await runCli(cliPath, ["publish", fixtureArgument, "--new", "--name", "packed-doomed"], {
      cwd: consumerDir,
      env: cliEnv
    })
  );
  const doomedViewer = await fetchViewer(doomed.address);
  assertViewerDoor(doomedViewer);
  assertViewerDoor(await fetchViewer(`${doomed.address}/~v/1`));
  const removed = await runCli(cliPath, ["delete", fixtureArgument, "--yes", "--json"], {
    cwd: consumerDir,
    env: cliEnv
  });
  const deletion = JSON.parse(removed.stdout);
  assert.equal(deletion.patchId, doomed.patchId);
  assert.equal(deletion.state, "deleted");
  assert.equal(
    Date.parse(deletion.purgeAt) - Date.parse(deletion.deletedAt),
    30 * 24 * 60 * 60 * 1000
  );
  assert.equal(removed.stderr, "");
  const removedViewer = await fetchViewer(doomed.address);
  assertViewerDoor(removedViewer);
  assert.equal(removedViewer.body, doomedViewer.body, "the door must not disclose deletion");
  const deletedMetadata = await readMetadata();
  assert.ok(
    deletedMetadata.drafts.find((draft) => draft.id === doomed.patchId)?.deletedAt,
    "a successful delete must mark the stored patch deleted"
  );
  const cacheAfterDelete = JSON.parse(
    await checkedCall(() => readFile(path.join(cliStateDir, "patches.json"), "utf8"))
  );
  assert.equal(
    cacheAfterDelete.hosts[publicBaseUrl].files[fixtureCachePath],
    undefined,
    "a successful delete must drop the patch from the per-instance cache"
  );
  const removedAgain = await runCli(cliPath, ["delete", "--patch", doomed.patchId, "--yes"], {
    cwd: consumerDir,
    env: cliEnv,
    allowFailure: true
  });
  assert.equal(removedAgain.code, 2, "deleting an already-deleted patch is the instance's refusal");

  await runTier1Flow({ cliPath, cliEnv, publicBaseUrl, release: installedManifest.version });

  // Login uses its own state and a worktree dev env that names this instance, so it
  // cannot replace the seeded key that the publishing scenarios above need.
  console.log("[packed-cli-e2e] exercising the agent login handoff");
  const loginStateDir = path.join(tempRoot, "cli state login");
  const loginWorktree = path.join(consumerDir, "login worktree");
  const loginDevDir = path.join(loginWorktree, ".local", "dev");
  await checkedCall(() =>
    Promise.all([mkdir(loginStateDir), mkdir(loginDevDir, { recursive: true })])
  );
  await checkedCall(() =>
    writeFile(
      path.join(loginDevDir, "env"),
      `PATCHY_API_URL=${publicBaseUrl}\nPATCHY_API_TOKEN=${DEV_SEED.token}\n`,
      { mode: 0o600 }
    )
  );
  const loginEnv = environment({ PATCHY_STATE_DIR: loginStateDir }, [
    "PATCHY_API_TOKEN",
    "PATCHY_API_URL"
  ]);
  const loginOptions = { cwd: loginWorktree, env: loginEnv, timeoutMs: 10_000 };
  const handoffResult = await runCli(cliPath, ["login", "--json"], loginOptions);
  assert.equal(handoffResult.stderr, "", "--json handoff must leave stderr empty");
  const handoff = JSON.parse(handoffResult.stdout);
  assertLoginHandoff(handoff, publicBaseUrl);
  const completeArgs = handoff.next.split(" ");
  assert.equal(completeArgs.shift(), "patchy");

  console.log("[packed-cli-e2e] proving CLAUDECODE does not wait even with terminal stdin");
  const ptyStateDir = path.join(tempRoot, "cli state pty login");
  await checkedCall(() => mkdir(ptyStateDir));
  await assertAgentLoginOnPty(cliPath, publicBaseUrl, {
    ...loginOptions,
    env: { ...loginEnv, PATCHY_STATE_DIR: ptyStateDir }
  });

  console.log("[packed-cli-e2e] confirming through the real offline-signed browser session");
  const machineName = "Packed login machine";
  const cookie = authTesting.signedInCookies(authTesting.signSession({ azp: publicBaseUrl }));
  // Submit what the rendered page carries, as a browser would: the code and the account it shows.
  const page = await fetch(handoff.verificationUrl, {
    headers: { cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000)
  });
  assert.equal(page.status, 200, "the real confirmation page must render for the signed-in user");
  const rendered = Object.fromEntries(
    Array.from(
      (await page.text()).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g),
      ([, name, value]) => [name, value]
    )
  );
  const confirm = await fetch(handoff.verificationUrlBare, {
    method: "POST",
    headers: { cookie, origin: publicBaseUrl },
    body: new URLSearchParams({ ...rendered, action: "confirm", machineName }),
    redirect: "manual",
    signal: AbortSignal.timeout(5_000)
  });
  assert.equal(confirm.status, 200, "the real confirm route must accept the signed-in user");
  await confirm.arrayBuffer();
  const completed = await runCli(cliPath, [...completeArgs, "--wait", "30", "--json"], {
    ...loginOptions,
    timeoutMs: 40_000
  });
  assert.equal(completed.stderr, "", "--json complete must leave stderr empty");
  const loggedIn = JSON.parse(completed.stdout);
  assertDocumentKeys(loggedIn, [
    "ok",
    "status",
    "instanceUrl",
    "company",
    "user",
    "machine",
    "credentialsPath",
    "warnings"
  ]);
  assert.equal(loggedIn.ok, true);
  assert.equal(loggedIn.status, "logged_in");
  assert.deepEqual(loggedIn.warnings, []);
  assert.equal(loggedIn.instanceUrl, publicBaseUrl);
  assert.deepEqual(loggedIn.company, {
    handle: DEV_SEED.companyHandle,
    name: DEV_SEED.companyName
  });
  assert.deepEqual(loggedIn.user, { email: DEV_SEED.email });
  assertDocumentKeys(loggedIn.machine, ["id", "name"]);
  assert.equal(loggedIn.machine.name, machineName);
  assert.match(loggedIn.machine.id, /^tok_/);
  assert.notEqual(loggedIn.machine.id, DEV_SEED.tokenId);
  assert.equal(loggedIn.credentialsPath, path.join(loginStateDir, "credentials.json"));
  const loginCredential = JSON.parse(
    await checkedCall(() => readFile(loggedIn.credentialsPath, "utf8"))
  ).hosts[publicBaseUrl];
  const loginToken = loginCredential.token;
  assert.ok(typeof loginToken === "string" && loginToken !== DEV_SEED.token);
  assert.ok(
    !`${completed.stdout}${completed.stderr}`.includes(loginToken),
    "the newly minted publishing key must never appear in the login receipt"
  );
  const loggedInOptions = { ...loginOptions, sensitiveValues: [loginToken, foreignToken] };
  const loginWhoami = await runCli(cliPath, ["whoami", "--json"], loggedInOptions);
  assert.equal(loginWhoami.stderr, "");
  assert.deepEqual(JSON.parse(loginWhoami.stdout), {
    ...JSON.parse(whoamiJson.stdout),
    machine: loggedIn.machine
  });

  console.log("[packed-cli-e2e] logging out revokes the login key at the server");
  await runCli(cliPath, ["logout"], loggedInOptions);
  const revokedLogin = await runCli(cliPath, ["whoami", "--json"], {
    ...loggedInOptions,
    env: { ...loginEnv, PATCHY_API_TOKEN: loginToken },
    allowFailure: true
  });
  assert.equal(revokedLogin.code, 2, "logout must revoke the saved login key at the server");
  assert.equal(revokedLogin.stdout, "");
  assert.equal(JSON.parse(revokedLogin.stderr).kind, "rejected");

  console.log(
    "[packed-cli-e2e] PASS: spaced consumer/artifact/state paths and quoted POSIX sh commands"
  );
  console.log("[packed-cli-e2e] PASS: complete packed CLI real-server contract");
} catch (error) {
  if (!(error instanceof ModeComplete)) mainFailure = error;
} finally {
  try {
    await cleanup();
  } catch (error) {
    mainFailure ??= error;
  }
}
if (latchedSignal) process.exit(latchedSignalExitCode);
if (mainFailure) throw mainFailure;

/**
 * `--cleanup-check`: `cleanup()` must reap a process that outlives the child it
 * spawned and ignores SIGTERM, so an interrupted run cannot leave a server bound
 * on a shared machine. It needs no build or server and takes about a second.
 */
async function runCleanupCheck() {
  const marker = path.join(tempRoot, "orphan.json");
  // The launcher leads its own process group and exits on SIGTERM. The orphan it
  // leaves in that group ignores SIGTERM and holds a port, as a stuck server would.
  const orphan = `process.on("SIGTERM", () => {});
const server = require("node:net").createServer().listen(0, "127.0.0.1", () =>
  require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, port: server.address().port })));`;
  const launcher = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(orphan)}, process.argv[1]], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);`;
  registerSpawnedChild(
    spawn(process.execPath, ["-e", launcher, marker], {
      env: sanitizedProcessEnv(),
      detached: true,
      stdio: "ignore"
    })
  );
  let spawned;
  try {
    spawned = await waitFor("the orphan to listen", async () =>
      JSON.parse(await readFile(marker, "utf8"))
    );
    await cleanup();
    await waitFor(
      "cleanup to kill the orphan",
      async () => !isPidAlive(spawned.pid) && !(await isTcpPortOpen(spawned.port))
    );
    await assert.rejects(access(tempRoot), { code: "ENOENT" }, "cleanup must remove the temp root");
    console.log("[packed-cli-e2e] PASS: cleanup reaps an orphan that ignores SIGTERM");
  } finally {
    if (spawned && isPidAlive(spawned.pid)) process.kill(spawned.pid, "SIGKILL");
  }
}

/** Polls `check` until it returns a truthy value; a throw counts as not yet. */
async function waitFor(description, check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(50);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function isTcpPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(300);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function validHtml(title, marker) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${marker}</h1></body></html>`;
}

function parsePackResult(stdout) {
  const parsed = JSON.parse(stdout);
  assert.ok(
    parsed && typeof parsed === "object" && !Array.isArray(parsed),
    `unexpected npm pack JSON: ${stdout}`
  );
  // The pinned npm 12 packer keys its result by package name.
  return Object.values(parsed);
}

async function reserveLoopbackPort() {
  throwIfSignalLatched();
  const server = createServer();
  server.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    if (latchedSignal) {
      await new Promise((resolve) => server.close(() => resolve()));
      throwIfSignalLatched();
    }
  } catch (error) {
    await new Promise((resolve) => server.close(() => resolve()));
    throw error;
  }
  throwIfSignalLatched();
  const address = server.address();
  assert.ok(address && typeof address === "object", "failed to reserve an ephemeral port");
  return { server, port: address.port };
}

async function startServer({ publicBaseUrl, objectDir }) {
  let nextPublicBaseUrl = publicBaseUrl;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await startServerAttempt({ publicBaseUrl: nextPublicBaseUrl, objectDir });
    } catch (error) {
      if (!isEaddrInUseServerStartupError(error) || attempt === maxAttempts) throw error;
      const failedServerProcess = serverProcess;
      await waitForClose(failedServerProcess).catch(() => undefined);
      assert.equal(
        activeChildren.has(failedServerProcess),
        false,
        "failed server attempt remained in the active child registry"
      );
      if (Number.isInteger(failedServerProcess.pid)) {
        assert.equal(
          trackedProcessGroups.has(failedServerProcess.pid),
          false,
          "failed server attempt left a reusable process group tracked"
        );
      }
      portReservation = await reserveLoopbackPort();
      nextPublicBaseUrl = `http://127.0.0.1:${portReservation.port}`;
      console.log(`[packed-cli-e2e] retrying real server at ${nextPublicBaseUrl} after EADDRINUSE`);
    }
  }
  throw new Error("unreachable server startup retry state");
}

async function startServerAttempt({ publicBaseUrl, objectDir }) {
  throwIfSignalLatched();
  await assertServerEntryExists(serverEntry);
  throwIfSignalLatched();
  assert.ok(portReservation, "loopback port must be reserved before server launch");
  await new Promise((resolve, reject) => {
    portReservation.server.close((error) => (error ? reject(error) : resolve()));
  });
  portReservation = undefined;
  throwIfSignalLatched();

  authTesting ??= await tsImport("../packages/auth/src/testing.ts", import.meta.url);
  const databaseUrl = await startPostgres();

  const serverEnv = environment(
    {
      ...authTesting.clerkEnv(),
      PORT: new URL(publicBaseUrl).port,
      PATCHY_PUBLIC_BASE_URL: publicBaseUrl,
      PATCHY_MAX_HTML_BYTES: String(512 * 1024),
      DATABASE_URL: databaseUrl,
      PATCHY_COMPANY_DB_ADMIN_URL: databaseUrl,
      PATCHY_COMPANY_DB_URL: databaseUrl,
      PATCHY_CREDENTIAL_KEYS: `test:${Buffer.alloc(32, 1).toString("base64")}`,
      PATCHY_STORAGE_DIR: objectDir,
      PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE: "10000",
      PATCHY_AUTHENTICATED_PUBLISH_RATE_LIMIT_PER_MINUTE: "10000"
    },
    ["CLERK_AUTHORIZED_PARTIES", "PATCHY_TRUST_PROXY"]
  );

  throwIfSignalLatched();
  console.log(`[packed-cli-e2e] launching real server at ${publicBaseUrl}`);
  serverProcessFailure = undefined;
  serverReadyStdoutObserved = false;
  let childStdout = "";
  let childStderr = "";
  let readyResolve;
  const readyLine = expectedServerReadyLine(publicBaseUrl);
  const readyPromise = new Promise((resolve) => {
    readyResolve = resolve;
  });
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: serverEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  const serverLifecycle = registerSpawnedChild(serverProcess);
  serverLifecycle.errorPromise.catch((error) => {
    serverProcessFailure = error;
  });
  throwIfSignalLatched();
  serverProcess.stdout.setEncoding("utf8");
  serverProcess.stderr.setEncoding("utf8");
  serverProcess.stdout.on("data", (chunk) => {
    childStdout += chunk;
    serverStdout += chunk;
    if (hasExactLine(childStdout, readyLine)) readyResolve();
  });
  serverProcess.stderr.on("data", (chunk) => {
    childStderr += chunk;
    serverStderr += chunk;
  });
  try {
    await waitForServerReadyStdout({
      publicBaseUrl,
      readyPromise,
      serverLifecycle,
      output: () => ({ stdout: childStdout, stderr: childStderr })
    });
  } catch (error) {
    serverProcessFailure = error;
    throw error;
  }
  serverReadyStdoutObserved = true;
  const seed = await import("../packages/auth/dist/seed.js");
  DEV_SEED = seed.DEV_SEED;
  await checkedCall(() => seed.applyDevSeed(postgres.databaseUrl));
  const { Patches } = await import("../packages/patches/dist/index.js");
  const { layerFromUrl } = await import("../packages/sql/dist/index.js");
  await checkedCall(() =>
    Effect.runPromise(
      Patches.backfillNames().pipe(
        Effect.provide(layerFromUrl(Redacted.make(postgres.databaseUrl)))
      )
    )
  );
  return { publicBaseUrl };
}

async function waitForReady(healthUrl) {
  assert.ok(
    serverReadyStdoutObserved,
    "server health must not be probed before exact child ready stdout"
  );
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    throwIfSignalLatched();
    if (serverProcessFailure) throw serverProcessFailure;
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      throwIfSignalLatched();
      throw new Error(
        `server exited before readiness (${serverProcess.exitCode ?? serverProcess.signalCode})${serverDiagnostics()}`
      );
    }
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(750) });
      const body = await response.json();
      if (response.status === 200 && body?.ok === true) return;
      lastError = new Error(`health returned ${response.status}: ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
    }
    throwIfSignalLatched();
    await new Promise((resolve) => setTimeout(resolve, 100));
    throwIfSignalLatched();
  }
  throwIfSignalLatched();
  throw new Error(
    `server readiness timed out: ${lastError?.message ?? "no response"}${serverDiagnostics()}`
  );
}

async function assertServerEntryExists(serverEntryPath) {
  try {
    await access(serverEntryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ServerStartupError(`server entry missing before spawn ${serverEntryPath}`, {
        code: "SERVER_ENTRY_MISSING",
        cause: error
      });
    }
    throw error;
  }
}

function serverDiagnostics() {
  return formatServerDiagnostics(serverStdout, serverStderr);
}

async function waitForServerReadyStdout({ publicBaseUrl, readyPromise, serverLifecycle, output }) {
  let timeout;
  try {
    await Promise.race([
      readyPromise,
      serverLifecycle.errorPromise.catch((error) => {
        throw new ServerStartupError(
          `server spawn failed before ready stdout (${describeSpawnError(error)})${formatServerDiagnostics(
            output().stdout,
            output().stderr
          )}`,
          { code: error.code, cause: error }
        );
      }),
      serverLifecycle.closePromise.then((result) => {
        throw serverStartupErrorFromClose(publicBaseUrl, result, output());
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new ServerStartupError(
              `server did not emit exact ready stdout ${JSON.stringify(
                expectedServerReadyLine(publicBaseUrl)
              )}${formatServerDiagnostics(output().stdout, output().stderr)}`
            )
          );
        }, 20_000);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function serverStartupErrorFromClose(publicBaseUrl, result, output) {
  const combinedOutput = `${output.stdout}\n${output.stderr}`;
  return new ServerStartupError(
    `server exited before exact ready stdout (${result.code ?? result.signal}) for ${publicBaseUrl}${formatServerDiagnostics(
      output.stdout,
      output.stderr
    )}`,
    { code: combinedOutput.includes("EADDRINUSE") ? "EADDRINUSE" : undefined }
  );
}

function describeSpawnError(error) {
  return [error.code, error.path ?? error.message].filter(Boolean).join(" ");
}

function isEaddrInUseServerStartupError(error) {
  return error instanceof ServerStartupError && error.code === "EADDRINUSE";
}

function expectedServerReadyLine(publicBaseUrl) {
  return `Patchy Cloud server listening on http://0.0.0.0:${new URL(publicBaseUrl).port}`;
}

function hasExactLine(output, expectedLine) {
  return output.split(/\r?\n/).includes(expectedLine);
}

function formatServerDiagnostics(stdout, stderr) {
  const sensitiveValues = [DEV_SEED?.token].filter(Boolean);
  return `\nserver stdout:\n${redactSensitive(stdout, sensitiveValues) || "<empty>"}\nserver stderr:\n${redactSensitive(stderr, sensitiveValues) || "<empty>"}`;
}

function assertSpacedPath(label, candidatePath) {
  assert.ok(candidatePath.includes(" "), `${label} must intentionally contain a space`);
}

function decodePackedCliWorkflow(readme) {
  const startMarker = "<!-- patchy-packed-cli-e2e:start -->";
  const endMarker = "<!-- patchy-packed-cli-e2e:end -->";
  assert.equal(
    readme.split(startMarker).length - 1,
    1,
    "packed CLI README must contain one workflow start marker"
  );
  assert.equal(
    readme.split(endMarker).length - 1,
    1,
    "packed CLI README must contain one workflow end marker"
  );

  const start = readme.indexOf(startMarker) + startMarker.length;
  const end = readme.indexOf(endMarker, start);
  assert.ok(end > start, "packed CLI README workflow markers must be ordered");
  const marked = readme.slice(start, end);
  const fence = marked.match(/^\s*```sh[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  assert.ok(fence, "packed CLI README workflow marker must wrap exactly one sh fence");
  const workflow = fence[1].replaceAll("\r\n", "\n");
  // The package is private and never published, so the workflow must drive the
  // installed `patchy` bin on PATH. A registry fetcher would test nothing here.
  assert.ok(
    [...workflow.matchAll(/\bpatchy\b/g)].length > 0,
    "packed CLI README workflow must invoke patchy"
  );
  assert.doesNotMatch(workflow, /\bnpx\b/, "packed CLI workflow must never fetch from a registry");
  return workflow;
}

async function runPublicPosixSh(commandText, options) {
  const sensitiveValues = options.sensitiveValues ?? [];
  const shellArgs = ["-eux", "-c", commandText];
  const environmentValues = new Set(Object.values(options.env ?? {}));
  assert.ok(sensitiveValues.length > 0, "public shell credential coverage requires a secret");
  for (const sensitiveValue of sensitiveValues) {
    assert.ok(
      environmentValues.has(sensitiveValue),
      "public shell credentials must be passed through the child environment"
    );
    assert.ok(
      shellArgs.every((argument) => !argument.includes(sensitiveValue)),
      "public shell credentials must never appear in sh argv"
    );
  }

  const result = await run("sh", shellArgs, { ...options, sensitiveValues });
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(
    sensitiveValues.every((sensitiveValue) => !output.includes(sensitiveValue)),
    "sensitive value leaked in public shell output"
  );
  return result;
}

function assertDocumentKeys(document, keys) {
  assert.deepEqual(Object.keys(document).sort(), [...keys].sort());
}

function assertLoginHandoff(document, publicBaseUrl) {
  assertDocumentKeys(document, [
    "ok",
    "status",
    "verificationUrl",
    "verificationUrlBare",
    "userCode",
    "expiresAt",
    "interval",
    "next",
    "agentNextSteps",
    "notWaitingBecause"
  ]);
  assert.equal(document.ok, true);
  assert.equal(document.status, "awaiting_confirmation");
  assert.match(document.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.equal(document.verificationUrl, `${publicBaseUrl}/login/device?code=${document.userCode}`);
  assert.equal(document.verificationUrlBare, `${publicBaseUrl}/login/device`);
  assert.ok(Date.parse(document.expiresAt) > Date.now(), "handoff must have a live expiry");
  assert.equal(document.interval, 5);
  assert.equal(document.next, `patchy login --complete ${document.userCode}`);
  assert.equal(typeof document.agentNextSteps, "string");
  assert.match(document.agentNextSteps, /do not open a browser/i);
  assert.match(document.agentNextSteps, /next command/i);
  assert.equal(document.notWaitingBecause, "--json");
}

async function assertAgentLoginOnPty(cliPath, publicBaseUrl, options) {
  const env = { ...options.env, PATCHY_PACKED_CLI_PATH: cliPath, NO_COLOR: "1" };
  for (const name of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CURSOR_AGENT",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "GEMINI_CLI",
    "OPENCODE",
    "CLINE_ACTIVE",
    "AI_AGENT",
    "CI"
  ])
    delete env[name];
  env.CLAUDECODE = "1";
  // Prove stdin is a terminal inside the same shell that execs the packed bin.
  // Keep the spaced executable path in the environment, never shell-quote it.
  const command =
    'test -t 0 || exit 99; printf "PACKED_LOGIN_STDIN_IS_TTY\\n"; exec "$PATCHY_PACKED_CLI_PATH" login';
  const args =
    process.platform === "darwin"
      ? ["-q", "/dev/null", "sh", "-c", command]
      : ["-q", "-e", "-c", command, "/dev/null"];
  const result = await runCli("script", args, { ...options, env });
  const output = `${result.stdout}${result.stderr}`.replaceAll("\r\n", "\n");
  assert.ok(output.includes("PACKED_LOGIN_STDIN_IS_TTY\n"));
  const next = output.match(
    /Then run: patchy login --complete ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})/
  );
  assert.ok(next, "a terminal agent must receive a resumable handoff without waiting");
  assert.ok(output.includes(`${publicBaseUrl}/login/device?code=${next[1]}`));
  assert.match(output, /CLAUDECODE is set/);
}

async function runCli(cliPath, args, options) {
  const sensitiveValues = [DEV_SEED?.token, ...(options.sensitiveValues ?? [])].filter(Boolean);
  assert.ok(
    args.every((argument) =>
      sensitiveValues.every((sensitiveValue) => !argument.includes(sensitiveValue))
    ),
    "API tokens must never appear in CLI argv"
  );
  const result = await run(cliPath, args, { ...options, sensitiveValues });
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(
    sensitiveValues.every((sensitiveValue) => !output.includes(sensitiveValue)),
    "sensitive value leaked in CLI output"
  );
  assert.ok(
    !/\bpp_[A-Za-z0-9_-]{43}\b/.test(output),
    "a newly minted publishing key leaked before it could be read from local state"
  );
  return result;
}

function parseJsonSuccess(result, keys) {
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "", "--json success must leave stderr empty");
  const document = JSON.parse(result.stdout);
  assertDocumentKeys(document, keys);
  assert.equal(document.ok, true);
  return document;
}

async function runTier1Flow({ cliPath, cliEnv, publicBaseUrl, release }) {
  console.log("[packed-cli-e2e] tier 1: init with a fresh pnpm store and metadata cache");
  const dir = path.join(tempRoot, "tier1-notes");
  const options = {
    cwd: dir,
    env: {
      ...cliEnv,
      pnpm_config_store_dir: path.join(tempRoot, "tier1 pnpm store"),
      pnpm_config_cache_dir: path.join(tempRoot, "tier1 pnpm metadata")
    },
    timeoutMs: 120_000
  };
  await runCli(
    cliPath,
    ["init", dir, "--tier", "1", "--purpose", "Exercise disposable notes end to end", "--json"],
    { ...options, cwd: tempRoot }
  );
  const repoCliPath = installedCliBinPath(dir);
  await checkedCall(() => access(repoCliPath));
  await run("pnpm", ["typecheck"], options);
  await run("pnpm", ["lint"], options);
  const lintProbePath = path.join(dir, "helpers/lint-probe.ts");
  await checkedCall(() =>
    writeFile(
      lintProbePath,
      'import { useQuery } from "patchy/preact";\n' +
        "export function useData(handler: Parameters<typeof useQuery>[0]) { return useQuery(handler, {}); }\n"
    )
  );
  await run("pnpm", ["exec", "eslint", "helpers/lint-probe.ts"], options);
  const forbiddenImports = [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
    "preact",
    "preact/hooks",
    "preact/compat",
    "preact/compat/client"
  ];
  await checkedCall(() =>
    writeFile(
      lintProbePath,
      forbiddenImports.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n") +
        '\nimport { useEffect, useQuery } from "patchy/preact";\n' +
        "export function useLintProbe(condition: boolean, value: string, handler: Parameters<typeof useQuery>[0]) {\n" +
        "  if (condition) useQuery(handler, {});\n" +
        "  useEffect(() => { console.log(value); }, []);\n" +
        "}\n"
    )
  );
  try {
    const refused = await run(
      "pnpm",
      ["exec", "eslint", "helpers/lint-probe.ts", "--format", "json"],
      {
        ...options,
        allowFailure: true
      }
    );
    assert.equal(refused.code, 1);
    const messages = JSON.parse(refused.stdout).flatMap((file) => file.messages);
    assert.equal(
      messages.filter((message) => message.ruleId === "no-restricted-imports").length,
      forbiddenImports.length
    );
    assert.ok(messages.some((message) => message.ruleId === "react-hooks/rules-of-hooks"));
    assert.ok(messages.some((message) => message.ruleId === "react-hooks/exhaustive-deps"));
  } finally {
    await checkedCall(() => rm(lintProbePath));
  }
  const initialConfigPath = path.join(dir, "patchy.config.ts");
  const initialConfig = await checkedCall(() => readFile(initialConfigPath, "utf8"));
  await checkedCall(() =>
    writeFile(
      initialConfigPath,
      initialConfig
        .replace("One note per id, with a title.", "One shared note per id, with a title.")
        .replace("{ title: t.text() })", "{ title: t.text() }, { shared: true })")
        .replace(
          "tables: {",
          'tables: { orders: table("One order per id, with an item.", { item: t.text() }, { shared: true }),'
        )
    )
  );
  const appPath = path.join(dir, "src/App.tsx");
  const appSource = await checkedCall(() => readFile(appPath, "utf8"));
  const insertNote = "await patchy.tables.notes.insert({ title });";
  await checkedCall(() =>
    writeFile(
      appPath,
      appSource.replace(
        insertNote,
        `${insertNote}\n    await patchy.tables.orders.insert({ item: title });`
      )
    )
  );

  // Register the repo before starting: a failed/interrupted start can already have
  // spawned its detached daemon. The CLI's stop checks its recorded process identity.
  patchDevCleanup = { cliPath: repoCliPath, options };
  const dev = parseJsonSuccess(await runCli(repoCliPath, ["dev", "--json"], options), [
    "ok",
    "healthy",
    "url",
    "colleagueUrl",
    "logPath",
    "stop",
    "pid",
    "release",
    "identity",
    "warnings"
  ]);
  assert.equal(dev.healthy, true);
  assert.equal(dev.release, release);
  assert.deepEqual(dev.identity, {
    user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
    company: {
      id: DEV_SEED.companyId,
      handle: DEV_SEED.companyHandle,
      name: DEV_SEED.companyName
    },
    role: DEV_SEED.role,
    machine: { id: DEV_SEED.tokenId, name: DEV_SEED.tokenName }
  });
  assert.ok(Number.isSafeInteger(dev.pid) && dev.pid > 0);
  patchDevCleanup.pid = dev.pid;
  trackedProcessGroups.add(dev.pid);
  assert.equal(new URL(dev.url).origin.startsWith("http://127.0.0.1:"), true);
  assert.equal(new URL(dev.colleagueUrl).hostname, "127.0.0.1");
  assert.notEqual(new URL(dev.colleagueUrl).origin, new URL(dev.url).origin);
  assert.ok(dev.logPath.startsWith(path.join(dir, ".patchy", "dev") + path.sep));
  assert.equal(dev.stop, `pnpm patchy dev stop --api-url '${publicBaseUrl}'`);

  // A BrowserServer exposes the owned process, so the existing signal/process-group
  // cleanup also covers Chromium. Failure to launch is a failure, never a skipped tier.
  throwIfSignalLatched();
  tier1BrowserServer = await chromium.launchServer({
    headless: true,
    host: "127.0.0.1",
    env: sanitizedProcessEnv(),
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false
  });
  registerSpawnedChild(tier1BrowserServer.process());
  throwIfSignalLatched();
  const browser = await checkedCall(() => chromium.connect(tier1BrowserServer.wsEndpoint()));
  const context = await checkedCall(() => browser.newContext());
  const initialReadHeld = Promise.withResolvers();
  const releaseInitialRead = Promise.withResolvers();
  let holdInitialRead = true;
  // Match browser-tier1's offline boundary, without replacing any runtime response.
  await context.route("**/*", async (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      await route.abort("blockedbyclient");
      return;
    }
    if (
      holdInitialRead &&
      new URL(route.request().url()).pathname === "/api/runtime/call" &&
      route.request().method() === "POST" &&
      route.request().postDataJSON().op === "tables.list"
    ) {
      holdInitialRead = false;
      const response = await route.fetch();
      initialReadHeld.resolve();
      await releaseInitialRead.promise;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(15_000);
  const runtimeResponses = new EventEmitter();
  await page.exposeBinding("__packedRuntimeResponse", ({ frame }, response) => {
    runtimeResponses.emit("response", { frame, ...response });
  });
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== "/api/runtime/call" || request.method !== "POST")
        return fetch(request);
      const body = await request.clone().json();
      const response = await fetch(request);
      // Copy bytes in the browser, before the broker can react and navigate.
      // No CDP response-body lookup survives here for a reload to invalidate.
      const result = await response.clone().json();
      await window.__packedRuntimeResponse({
        status: response.status,
        url: response.url,
        body,
        result
      });
      return response;
    };
  });
  const notes = page.frameLocator("#patch");
  const readRuntime = async (op, published) => {
    for await (const [response] of on(runtimeResponses, "response", {
      signal: AbortSignal.timeout(15_000)
    })) {
      const { frame, status, url, body, result } = response;
      if (body.op !== op) continue;
      assert.equal(status, 200);
      assert.equal(frame, page.mainFrame(), "only the real shell may call the runtime");
      assertDocumentKeys(body, ["patchId", "versionId", "principal", "wire", "op", "args"]);
      assert.deepEqual(body.principal, { userId: DEV_SEED.userId });
      assert.ok(Number.isSafeInteger(body.wire) && body.wire > 0);
      if (published) {
        assert.equal(body.patchId, published.patchId);
        assert.equal(body.versionId, published.versionId);
        assert.equal(new URL(url).origin, publicBaseUrl);
      }
      assertDocumentKeys(result, ["ok", "value"]);
      assert.equal(result.ok, true);
      return result.value;
    }
  };
  let inspectInitialLoading = true;
  const openNotes = async (url, published) => {
    const checkLoading = inspectInitialLoading
      ? (async () => {
          await initialReadHeld.promise;
          try {
            await expect(notes.getByRole("status")).toHaveText("Loading notes...");
            await expect(notes.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
            await expect(
              notes.getByRole("button", { name: "Add note", exact: true })
            ).toBeDisabled();
          } finally {
            releaseInitialRead.resolve();
          }
        })()
      : Promise.resolve();
    inspectInitialLoading = false;
    const [content, listed, shell] = await checkedCall(() =>
      Promise.all([
        page.waitForResponse((response) =>
          new URL(response.url()).pathname.startsWith("/~content/")
        ),
        readRuntime("tables.list", published),
        page.goto(url),
        checkLoading
      ])
    );
    assert.equal(shell.status(), 200);
    assert.equal(content.status(), 200);
    await expect(notes.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
    await expect(notes.locator("#error")).toBeEmpty();
    await expect(notes.getByRole("status")).toBeEmpty();
    await expect(notes.getByRole("button", { name: "Add note", exact: true })).toBeEnabled();
    return listed;
  };
  const addNote = async (title, published, keyboard = false) => {
    await notes.getByRole("textbox", { name: "Title", exact: true }).fill(title);
    const [row, listed] = await checkedCall(() =>
      Promise.all([
        readRuntime("tables.insert", published),
        readRuntime("tables.list", published),
        keyboard
          ? notes.getByRole("textbox", { name: "Title", exact: true }).press("Enter")
          : notes.getByRole("button", { name: "Add note", exact: true }).click()
      ])
    );
    assertDocumentKeys(row, ["id", "createdAt", "updatedAt", "title"]);
    assert.equal(row.title, title);
    assert.equal(typeof row.id, "string");
    assert.ok(row.id.length > 0);
    assert.deepEqual(listed, {
      rows: [row],
      cursor: null
    });
    await expect(notes.locator("#list li")).toHaveText([title]);
    await expect(notes.locator("#error")).toBeEmpty();
    await expect(notes.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("");
    return row;
  };

  console.log("[packed-cli-e2e] tier 1: inserting through the generated app and dev shell");
  assert.deepEqual(await openNotes(dev.url), { rows: [], cursor: null });
  await notes.getByRole("button", { name: "Add note", exact: true }).click();
  assert.equal(
    await notes
      .getByRole("textbox", { name: "Title", exact: true })
      .evaluate((input) => input.validity.valueMissing),
    true
  );
  await expect(notes.locator("#list li")).toHaveCount(0);
  const localRow = await addNote("Local-only note");
  const stopped = parseJsonSuccess(await runCli(repoCliPath, ["dev", "stop", "--json"], options), [
    "ok",
    "healthy",
    "reset"
  ]);
  assert.deepEqual(stopped, {
    ok: true,
    healthy: false,
    reset: false
  });
  trackedProcessGroups.delete(dev.pid);
  patchDevCleanup = undefined;
  assert.equal(await isTcpPortOpen(Number(new URL(dev.url).port)), false);

  const publishKeys = [
    "ok",
    "patchId",
    "versionId",
    "versionNumber",
    "title",
    "description",
    "descriptionUpdatedAt",
    "scope",
    "name",
    "address",
    "publicUrl",
    "tier",
    "schemaRevision",
    "provisioned",
    "unused",
    "artifacts",
    "warnings"
  ];
  console.log("[packed-cli-e2e] tier 1: publishing the repo and opening the session-gated bundle");
  const published = parseJsonSuccess(
    await runCli(repoCliPath, ["publish", "--json"], options),
    publishKeys
  );
  assert.match(published.patchId, /^[a-z0-9]{12}$/);
  assert.equal(typeof published.versionId, "string");
  assert.ok(published.versionId.length > 0);
  assert.equal(typeof published.title, "string");
  assert.deepEqual(
    {
      ...published,
      provisioned: {
        ...published.provisioned,
        tables: published.provisioned.tables.toSorted(),
        columns: published.provisioned.columns.toSorted()
      }
    },
    {
      ok: true,
      patchId: published.patchId,
      versionId: published.versionId,
      versionNumber: 1,
      title: published.title,
      description: "Exercise disposable notes end to end",
      descriptionUpdatedAt: published.descriptionUpdatedAt,
      scope: "company",
      name: "tier1-notes",
      address: `${publicBaseUrl}/${DEV_SEED.companyHandle}/tier1-notes`,
      publicUrl: `${publicBaseUrl}/${DEV_SEED.companyHandle}/tier1-notes`,
      tier: 1,
      schemaRevision: 1,
      provisioned: {
        tables: ["notes", "orders"],
        columns: ["notes.title", "orders.item"],
        indexes: [],
        stores: []
      },
      unused: { tables: [], columns: [], indexes: [], stores: [] },
      warnings: [],
      artifacts: published.artifacts
    }
  );
  assert.ok(Number.isFinite(Date.parse(published.descriptionUpdatedAt)));
  assertViewerDoor(await fetchViewer(published.address));
  await context.addCookies(
    authTesting
      .signedInCookies(authTesting.signSession({ azp: publicBaseUrl }))
      .split("; ")
      .map((cookie) => {
        const at = cookie.indexOf("=");
        return {
          name: cookie.slice(0, at),
          value: cookie.slice(at + 1),
          url: publicBaseUrl,
          sameSite: "Lax"
        };
      })
  );
  const hosted = await openNotes(published.address, published);
  const assertHtmlArtifact = async (receipt) => {
    const source = await page.locator("#patch").getAttribute("src");
    assert.ok(source);
    const response = await context.request.get(new URL(source, publicBaseUrl).href);
    assert.equal(response.status(), 200);
    const bytes = await response.body();
    assert.deepEqual(receipt.artifacts, {
      html: { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }
    });
  };
  await assertHtmlArtifact(published);
  // Publish carries the application and schema, never local rows. Exercise the same
  // generated form in the cloud rather than silently seeding/copying production data.
  assert.deepEqual(hosted, { rows: [], cursor: null }, "local rows must not sync on publish");
  await expect(notes.locator("#list li")).toHaveCount(0);
  console.log("[packed-cli-e2e] tier 1: local data is isolated; inserting a separate hosted note");
  const hostedRow = await addNote("Hosted note", published, true);
  assert.notEqual(hostedRow.id, localRow.id);
  assert.deepEqual(
    await openNotes(published.address, published),
    {
      rows: [hostedRow],
      cursor: null
    },
    "the shell's real runtime POST must return the persisted hosted row after reload"
  );

  console.log("[packed-cli-e2e] tier 1: publishing an additive optional column");
  const configPath = path.join(dir, "patchy.config.ts");
  const config = await checkedCall(() => readFile(configPath, "utf8"));
  assert.ok(config.includes("title: t.text()"));
  await checkedCall(() =>
    writeFile(
      configPath,
      config.replace("title: t.text()", "title: t.text(), detail: t.text().optional()")
    )
  );
  const updated = parseJsonSuccess(
    await runCli(repoCliPath, ["publish", "--json"], options),
    publishKeys
  );
  assert.notEqual(updated.versionId, published.versionId);
  assert.deepEqual(updated, {
    ...published,
    versionId: updated.versionId,
    versionNumber: 2,
    artifacts: updated.artifacts,
    schemaRevision: 2,
    provisioned: { tables: [], columns: ["notes.detail"], indexes: [], stores: [] },
    warnings: [
      "Table `notes` changed since its last generation; check that its description still holds: 'One shared note per id, with a title.'"
    ]
  });
  assert.deepEqual(
    await openNotes(updated.address, updated),
    {
      rows: [{ ...hostedRow, detail: null }],
      cursor: null
    },
    "adding a column must retain hosted rows without importing local data"
  );
  await assertHtmlArtifact(updated);
  await expect(notes.locator("#list li")).toHaveText(["Hosted note"]);
  console.log(
    "[packed-cli-e2e] lifecycle: dependant refusal, forced retirement, restore and rollback"
  );
  const readerDir = path.join(tempRoot, "packed-orders-reader");
  await runCli(
    cliPath,
    ["init", readerDir, "--tier", "1", "--purpose", "Reads the team's shared orders", "--json"],
    { ...options, cwd: tempRoot }
  );
  const readerCli = installedCliBinPath(readerDir);
  const readerOptions = { ...options, cwd: readerDir };
  await runCli(
    readerCli,
    ["add", "shared-table", `${published.patchId}/orders`, "--json"],
    readerOptions
  );
  // Existing vanilla pages keep using the framework-free generated client.
  await checkedCall(() =>
    Promise.all([
      rm(path.join(readerDir, "src/main.tsx")),
      rm(path.join(readerDir, "src/App.tsx")),
      writeFile(
        path.join(readerDir, "index.html"),
        '<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Shared orders</title></head>' +
          '<body><ul id="list"></ul><script type="module" src="/src/main.ts"></script></body></html>\n'
      )
    ])
  );
  await checkedCall(() =>
    writeFile(
      path.join(readerDir, "src/main.ts"),
      'import { patchy } from "../patchy/_generated/client.js";\n' +
        "const orders = await patchy.shared.orders.list({ limit: 20 });\n" +
        'document.querySelector("#list")!.textContent = JSON.stringify(orders);\n'
    )
  );
  const dependant = parseJsonSuccess(
    await runCli(readerCli, ["publish", "--json"], readerOptions),
    publishKeys
  );
  const openReader = async () => {
    const [rows, response] = await checkedCall(() =>
      Promise.all([readRuntime("shared.list", dependant), page.goto(dependant.address)])
    );
    assert.equal(response.status(), 200);
    await expect(page.frameLocator("#patch").locator("#list")).toHaveText(JSON.stringify(rows));
    assert.deepEqual(
      rows.rows.map((row) => row.item),
      ["Hosted note"]
    );
  };
  await openReader();

  const listing = JSON.parse((await runCli(cliPath, ["list", "--json"], options)).stdout);
  for (const patch of [published, dependant]) {
    const summary = listing.patches.find((entry) => entry.id === patch.patchId);
    assert.ok(summary, `list must include ${patch.name}`);
    assert.equal(summary.state, "live");
  }
  const detail = JSON.parse(
    (await runCli(cliPath, ["list", published.name, "--json"], options)).stdout
  );
  assert.equal(detail.id, published.patchId);
  assert.ok(detail.inventory, "the source inventory must be available");
  const ordersTable = detail.inventory.tables.find((table) => table.name === "orders");
  assert.ok(ordersTable, "the source inventory must include orders");
  assert.equal(ordersTable.declarable, true);
  const orderSchema = JSON.parse(
    (await runCli(cliPath, ["list", published.name, "orders", "--json"], options)).stdout
  );
  assert.deepEqual(orderSchema.columns, [{ name: "item", kind: "text", optional: false }]);
  assert.equal(orderSchema.shared, true);
  const readerDetail = JSON.parse(
    (await runCli(cliPath, ["list", dependant.patchId, "--json"], options)).stdout
  );
  assert.deepEqual(readerDetail.reads, [
    {
      alias: "orders",
      patchId: published.patchId,
      name: published.name,
      table: "orders",
      state: "live"
    }
  ]);

  const refusedRetire = await runCli(repoCliPath, ["retire", "--json"], {
    ...options,
    allowFailure: true
  });
  assert.equal(refusedRetire.code, 2);
  assert.equal(refusedRetire.stdout, "");
  const refusal = JSON.parse(refusedRetire.stderr);
  assert.equal(refusal.kind, "rejected");
  assert.equal(refusal.code, "has_dependants");
  assert.deepEqual(
    refusal.dependants.map(({ patchId }) => patchId),
    [dependant.patchId]
  );
  assert.match(refusal.error, /Ask the person you are working for before forcing\.$/);
  await openReader();
  const retired = JSON.parse(
    (await runCli(repoCliPath, ["retire", "--force", "--json"], options)).stdout
  );
  assert.equal(retired.state, "retired");
  assert.equal((await checkedCall(() => page.goto(published.address))).status(), 200);
  await expect(page.locator("#patch")).toHaveCount(0);
  await expect(
    page.locator("dd").filter({ hasText: `Retired by ${DEV_SEED.userName}` })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await expect(page.locator(`a[href="/patches/${published.name}"]`)).toBeVisible();
  const [denied] = await checkedCall(() =>
    Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/runtime/call" &&
          response.request().postDataJSON()?.op === "shared.list"
      ),
      page.goto(dependant.address)
    ])
  );
  assert.equal((await denied.json()).code, "access_denied");
  const restored = JSON.parse((await runCli(repoCliPath, ["restore", "--json"], options)).stdout);
  assert.equal(restored.state, "live");
  await openReader();
  const rolledBack = JSON.parse(
    (await runCli(repoCliPath, ["rollback", "1", "--json"], options)).stdout
  );
  assert.equal(rolledBack.currentVersion, 1);
  assert.equal(rolledBack.address, published.address);
  assert.deepEqual(
    await openNotes(published.address, published),
    {
      rows: [hostedRow],
      cursor: null
    },
    "rollback serves v1 with its original columns and retained hosted rows"
  );
  assert.deepEqual(
    await openNotes(`${published.address}/~v/2`, updated),
    {
      rows: [{ ...hostedRow, detail: null }],
      cursor: null
    },
    "v2 still reads the cumulative schema after rollback"
  );

  console.log("[packed-cli-e2e] description: a portal-side edit reaches the repo on refresh");
  const cloudDescription = "Keeps shared notes and optional details for the team.";
  await runCli(cliPath, ["describe", cloudDescription, "--patch", published.patchId, "--json"], {
    ...options,
    cwd: tempRoot
  });
  const pulled = await runCli(repoCliPath, ["refresh"], options);
  assert.ok(
    pulled.stdout.includes(
      `The description was changed in the portal to '${cloudDescription}'; check it`
    )
  );
  assert.ok(pulled.stdout.includes(published.description));
  const syncedRepo = JSON.parse(
    await checkedCall(() => readFile(path.join(dir, "patchy.json"), "utf8"))
  );
  assert.equal(syncedRepo.description, cloudDescription);
  await checkedCall(() => browser.close());
  await checkedCall(() => tier1BrowserServer.close());
  tier1BrowserServer = undefined;
  console.log(
    "[packed-cli-e2e] PASS: packed init, local and hosted tier 1, discovery, lifecycle and description sync"
  );
}

function parsePublish(result) {
  const label = result.stdout.match(/^(Published patch|Updated patch)$/m)?.[1];
  const address = result.stdout.match(/^URL: (.+)$/m)?.[1];
  const patchId = result.stdout.match(/^Patch ID: ([a-z0-9]{12})$/m)?.[1];
  const scope = result.stdout.match(/^Scope: (company|public)\b/m)?.[1];
  const versionNumber = Number(result.stdout.match(/^Version: (\d+)$/m)?.[1]);
  assert.ok(label, `missing upload label in CLI output:\n${result.stdout}`);
  assert.ok(address, `missing address in CLI output:\n${result.stdout}`);
  assert.ok(patchId, `missing patch ID in CLI output:\n${result.stdout}`);
  assert.ok(Number.isInteger(versionNumber), `missing version in CLI output:\n${result.stdout}`);
  assert.ok(scope, `missing sharing scope in CLI output:\n${result.stdout}`);
  return { label, address, patchId, versionNumber, scope };
}

async function fetchViewer(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  return { response, body: await response.text() };
}

// Exact headers and CSPs are pinned by packages/serving's Pages tests; these prove
// the real server serves the right version, sandboxed, and keeps doors shut.
function assertPublicViewer(viewer, { patchId, versionNumber, html }) {
  assert.equal(viewer.response.status, 200);
  assert.ok(viewer.body.includes('sandbox=""'), "the patch must remain sandboxed");
  const escapedHtml = html
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  assert.ok(
    viewer.body.includes(`srcdoc="${escapedHtml}"`),
    "the frame must contain the complete uploaded version, attribute-escaped"
  );
  assert.ok(!viewer.body.includes(html), "uploaded HTML must never enter the outer shell");
  assert.doesNotMatch(viewer.body, /<(?:script|footer|a|form)\b/i);
  assert.ok(viewer.body.includes(`<!-- patch:${patchId} version:${versionNumber} -->`));
}

function assertViewerDoor(viewer) {
  assert.equal(viewer.response.status, 401);
  assert.ok(!viewer.body.includes("<iframe"), "the door must not disclose patch content");
  assert.ok(!viewer.body.includes("<!-- patch:"), "the door must not disclose patch identity");
}

/**
 * The instance's Postgres, as the assertions read it: every patch, every
 * version, every token's hash. Started under the temp root on a loopback port
 * the first time the real server needs it; stopped by `cleanup`.
 */
async function startPostgres() {
  if (postgres) return postgres.databaseUrl;
  // Imported here, not at the top: embedded-postgres installs process-exiting
  // signal handlers (async-exit-hook) the moment it loads, which would pre-empt
  // this harness's own signal latch and cleanup. Only a process that starts
  // Postgres pays that, and it takes the handlers back out — `cleanup` stops
  // Postgres itself.
  const listenersBefore = new Map(
    TERMINATION_SIGNALS.map((signal) => [signal, new Set(process.listeners(signal))])
  );
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  for (const signal of TERMINATION_SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!listenersBefore.get(signal).has(listener)) process.removeListener(signal, listener);
    }
  }
  const reservation = await reserveLoopbackPort();
  await new Promise((resolve) => reservation.server.close(() => resolve()));
  const databaseDir = path.join(tempRoot, "server state", "postgres");
  await mkdir(databaseDir, { recursive: true });
  const embedded = new EmbeddedPostgres({
    databaseDir,
    port: reservation.port,
    user: "postgres",
    password: "postgres",
    persistent: false,
    // Durability off: the cluster is disposable, and this is most of its speed.
    postgresFlags: [
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off"
    ],
    onLog() {},
    onError() {}
  });
  await embedded.initialise();
  await embedded.start();
  await embedded.createDatabase("patchy");
  postgres = {
    embedded,
    databaseUrl: `postgresql://postgres:postgres@127.0.0.1:${reservation.port}/patchy`
  };
  return postgres.databaseUrl;
}

async function seedOtherUserToken() {
  const token = randomBytes(32).toString("hex");
  const client = new pg.Client({ connectionString: postgres.databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO users (id, clerk_user_id, company_id, email, name, role, created_at)
       VALUES ('usr_packed_other', 'user_packed_other', $1,
         'packed-other@patchy.local', 'Other Publisher', 'member', now())`,
      [DEV_SEED.companyId]
    );
    await client.query(
      `INSERT INTO machine_tokens
         (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
       VALUES ('tok_packed_other', 'usr_packed_other', 'Other Machine', $1,
         now(), now() + interval '90 days', now())`,
      [createHash("sha256").update(token).digest("hex")]
    );
    return token;
  } finally {
    await client.end();
  }
}

async function readMetadata() {
  assert.ok(postgres, "the real server's Postgres must be running to read its metadata");
  const client = new pg.Client({ connectionString: postgres.databaseUrl });
  await client.connect();
  try {
    const query = async (text) => (await client.query(text)).rows;
    return {
      drafts: (
        await query(
          "SELECT id, company_id, owner_user_id, scope, current_version_id, deleted_at FROM patches ORDER BY created_at"
        )
      ).map((row) => ({
        id: row.id,
        companyId: row.company_id,
        ownerUserId: row.owner_user_id,
        scope: row.scope,
        currentVersionId: row.current_version_id,
        deletedAt: row.deleted_at
      })),
      draftVersions: (
        await query(
          "SELECT id, patch_id, version_number, object_key, created_by_machine_token_id, tier, release, wire_version FROM patch_versions ORDER BY created_at"
        )
      ).map((row) => ({
        id: row.id,
        patchId: row.patch_id,
        versionNumber: row.version_number,
        objectKey: row.object_key,
        tier: row.tier,
        release: row.release,
        wireVersion: row.wire_version,
        createdByMachineTokenId: row.created_by_machine_token_id
      })),
      machineTokens: (
        await query("SELECT id, user_id, token_hash FROM machine_tokens ORDER BY id")
      ).map((row) => ({ id: row.id, userId: row.user_id, tokenHash: row.token_hash }))
    };
  } finally {
    await client.end();
  }
}

async function assertStoredDraft(
  metadata,
  objectDir,
  { patchId, expectedHtmlByVersion, scope, companyId, ownerUserId, machineTokenId }
) {
  const draft = metadata.drafts.find((candidate) => candidate.id === patchId);
  assert.ok(draft, `metadata is missing draft ${patchId}`);
  assert.equal(draft.companyId, companyId);
  assert.equal(draft.ownerUserId, ownerUserId);
  assert.equal(draft.scope, scope);

  const versions = metadata.draftVersions
    .filter((version) => version.patchId === patchId)
    .sort((left, right) => left.versionNumber - right.versionNumber);
  assert.equal(versions.length, expectedHtmlByVersion.length);
  assert.equal(draft.currentVersionId, versions.at(-1).id);

  for (let index = 0; index < versions.length; index += 1) {
    const version = versions[index];
    assert.equal(version.versionNumber, index + 1);
    assert.equal(version.createdByMachineTokenId, machineTokenId);
    assert.equal(version.tier, 0);
    assert.equal(version.release, "0.0.1");
    assert.equal(version.wireVersion, 1);
    assert.equal(
      await readFile(path.join(objectDir, version.objectKey), "utf8"),
      expectedHtmlByVersion[index]
    );
  }
}

function environment(overrides, unset = []) {
  const env = sanitizedProcessEnv();
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  for (const name of unset) delete env[name];
  return env;
}

function sanitizedProcessEnv(source = process.env) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (name.startsWith("PATCHY_")) delete env[name];
  }
  return env;
}

async function run(command, args, options = {}) {
  if (!options.cleanup) throwIfSignalLatched();
  const env = options.env ?? sanitizedProcessEnv();
  // npm is the pinned devDependency, run through this Node rather than a PATH lookup.
  const [executable, argv] =
    command === "npm" ? [process.execPath, [npmCliEntry, ...args]] : [command, args];
  const child = spawn(executable, argv, {
    cwd: options.cwd ?? repoRoot,
    env,
    detached: true,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    shell: false
  });
  const childLifecycle = observeSpawnedChild(child);
  activeChildren.add(child);
  trackProcessGroup(child);

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  if (options.input !== undefined) child.stdin.end(options.input);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child, "SIGKILL");
    if (Number.isInteger(child.pid)) terminatePosixProcessGroup(child.pid, "SIGKILL");
  }, options.timeoutMs ?? 60_000);

  const result = await Promise.race([
    childLifecycle.errorPromise,
    childLifecycle.closePromise
  ]).finally(() => {
    clearTimeout(timeout);
    activeChildren.delete(child);
    releaseTrackedProcessGroupIfEmpty(child);
  });
  if (!options.cleanup) throwIfSignalLatched();

  if (timedOut || (result.code !== 0 && !options.allowFailure)) {
    const sensitiveValues = options.sensitiveValues ?? [];
    throw new Error(
      [
        `${command} ${args.map((arg) => redactSensitive(arg, sensitiveValues)).join(" ")} ${timedOut ? "timed out" : `exited ${result.code ?? result.signal}`}`,
        stdout && `stdout:\n${redactSensitive(stdout, sensitiveValues)}`,
        stderr && `stderr:\n${redactSensitive(stderr, sensitiveValues)}`
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return { ...result, stdout, stderr };
}

function installedCliBinPath(consumerDir) {
  return path.join(consumerDir, "node_modules/.bin/patchy");
}

function observeSpawnedChild(child) {
  let rejectSpawnError;
  const errorPromise = new Promise((_, reject) => {
    rejectSpawnError = reject;
  });
  errorPromise.catch(() => {});
  child.once("error", (error) => {
    activeChildren.delete(child);
    rejectSpawnError(error);
  });
  const closePromise = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { errorPromise, closePromise };
}

function registerSpawnedChild(child) {
  const lifecycle = observeSpawnedChild(child);
  activeChildren.add(child);
  trackProcessGroup(child);
  lifecycle.closePromise.finally(() => {
    activeChildren.delete(child);
    releaseTrackedProcessGroupIfEmpty(child);
  });
  lifecycle.errorPromise.catch(() => {
    activeChildren.delete(child);
    releaseTrackedProcessGroupIfEmpty(child);
  });
  if (latchedSignal) terminateProcessGroup(child, "SIGTERM");
  return lifecycle;
}

// Every child is spawned detached, so it leads its own process group. A group stays
// tracked until no member is left, so cleanup can reap what outlives the child itself.
function trackProcessGroup(child) {
  if (Number.isInteger(child.pid)) trackedProcessGroups.add(child.pid);
}

function releaseTrackedProcessGroupIfEmpty(child) {
  if (Number.isInteger(child.pid) && !isProcessGroupAlive(child.pid)) {
    trackedProcessGroups.delete(child.pid);
  }
}

function redactSensitive(value, sensitiveValues) {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) redacted = redacted.split(sensitiveValue).join("[REDACTED]");
  }
  return redacted.replace(/\bpp_[A-Za-z0-9_-]{43}\b/g, "[REDACTED]");
}

function terminateProcessGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!Number.isInteger(child.pid)) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function terminateTrackedProcessGroups(signal) {
  for (const pid of trackedProcessGroups) terminatePosixProcessGroup(pid, signal);
}

function terminatePosixProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function cleanup() {
  cleanupPromise ??= (async () => {
    const resourceFailures = [];
    if (patchDevCleanup) {
      try {
        await runCli(patchDevCleanup.cliPath, ["dev", "stop", "--json"], {
          ...patchDevCleanup.options,
          timeoutMs: 30_000,
          cleanup: true
        });
        trackedProcessGroups.delete(patchDevCleanup.pid);
        patchDevCleanup = undefined;
      } catch (error) {
        resourceFailures.push(error);
      }
    }
    if (tier1BrowserServer) {
      try {
        await tier1BrowserServer.close();
      } catch (error) {
        resourceFailures.push(error);
      }
      tier1BrowserServer = undefined;
    }
    if (portReservation) {
      await new Promise((resolve) => portReservation.server.close(() => resolve()));
      portReservation = undefined;
    }
    for (const child of activeChildren) terminateProcessGroup(child, "SIGTERM");
    terminateTrackedProcessGroups("SIGTERM");
    if (activeChildren.size > 0) {
      await settleWithin(Promise.allSettled([...activeChildren].map(waitForClose)), 2_000);
    }
    terminateTrackedProcessGroups("SIGKILL");
    if (activeChildren.size > 0) {
      await settleWithin(Promise.allSettled([...activeChildren].map(waitForClose)), 2_000);
    }
    if (postgres) {
      await settleWithin(
        postgres.embedded.stop().catch(() => {}),
        15_000
      );
      postgres = undefined;
    }
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    activeChildren.clear();
    trackedProcessGroups.clear();
    if (resourceFailures.length > 0) {
      throw new AggregateError(resourceFailures, "Tier 1 resource cleanup failed");
    }
  })();
  return cleanupPromise;
}

/** Waits for `promise` at most `ms`, without leaving a timer that holds the process open. */
async function settleWithin(promise, ms) {
  let timer;
  await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
