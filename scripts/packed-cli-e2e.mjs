import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { tsImport } from "tsx/esm/api";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPackageDir = path.join(repoRoot, "packages/cli");
const serverEntry = path.join(repoRoot, "apps/server/dist/start.js");
// npm is a pinned root devDependency so this test can install the CLI tarball
// hermetically; the CLI itself is private and is never published to a registry.
const npmCliEntry = path.join(repoRoot, "node_modules/npm/bin/npm-cli.js");
let DEV_SEED;
let authTesting;
const packedCliTempRootBasePrefix = "patchy-packed-cli-e2e-";
const probeOwnerEnvName = "PATCHY_PACKED_CLI_E2E_PROBE_OWNER_ID";
const activeChildren = new Set();
const childProcessGroupOwnership = new WeakMap();
const trackedProcessGroups = new Set();
const signalProbe = {
  target: process.env.PATCHY_PACKED_CLI_E2E_SIGNAL_PROBE,
  childMarkerPath: process.env.PATCHY_PACKED_CLI_E2E_SIGNAL_PROBE_CHILDREN,
  stubRunAfterSignal: process.env.PATCHY_PACKED_CLI_E2E_SIGNAL_PROBE_STUB_RUN_AFTER_SIGNAL === "1",
  observedSignal: undefined
};
const outerSignalProbe = {
  target: process.env.PATCHY_PACKED_CLI_E2E_OUTER_SIGNAL_PROBE
};
const lifecycleProbe = {
  mode: process.env.PATCHY_PACKED_CLI_E2E_LIFECYCLE_PROBE,
  markerPath: process.env.PATCHY_PACKED_CLI_E2E_LIFECYCLE_MARKER,
  cleanupCount: 0
};
const probeOwnerId = readProbeOwnerIdFromEnv();
const tempRootPrefix = probeOwnerId
  ? ownedTempRootPrefix(probeOwnerId)
  : packedCliTempRootBasePrefix;
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
let serverBindCollisionProbe;
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

class ProbeComplete extends Error {
  constructor() {
    super("probe completed");
    this.name = "ProbeComplete";
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

assertRuntimeModeSupportedOnPlatform({
  platform: process.platform,
  argvMode: process.argv[2]
});

if (
  process.argv[2] === "--signal-probes" ||
  process.argv[2] === "--platform-probes" ||
  process.argv[2] === "--lifecycle-probes"
) {
  await runProbeMode(process.argv[2]);
}

let mainFailure;
try {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  assert.ok(nodeMajor >= 22, `packed CLI E2E requires Node 22 or newer; found ${process.version}`);

  await signalProbeCheckpoint("before-temp-creation");
  throwIfSignalLatched();
  tempRoot = await mkdtemp(path.join(os.tmpdir(), tempRootPrefix));
  await recordProbeTempRoot();
  throwIfSignalLatched();
  await signalProbeCheckpoint("after-temp-created", probeTempRootDetails());
  throwIfSignalLatched();
  if (lifecycleProbe.mode === "timeout-owned-temp-root") {
    await runTimeoutOwnedTempRootWorkload();
    throw new Error("timeout-owned-temp-root probe unexpectedly completed");
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

  if (lifecycleProbe.mode === "server-spawn-error") {
    portReservation = await reserveLoopbackPort();
    const publicBaseUrl = `http://127.0.0.1:${portReservation.port}`;
    const startedServer = await startServer({ publicBaseUrl, objectDir });
    await waitForReady(`${startedServer.publicBaseUrl}/healthz`);
    throw new Error("server spawn error probe unexpectedly reached readiness");
  }

  if (lifecycleProbe.mode === "server-bind-race-retry") {
    await runServerBindRaceRetryProbe({ objectDir });
    throw new ProbeComplete();
  }

  if (lifecycleProbe.mode === "missing-server-entry-negative-control") {
    await runMissingServerEntryNegativeControl({ objectDir });
    throw new Error("missing server entry negative control unexpectedly completed");
  }

  if (lifecycleProbe.mode === "term-orphaned-process-group") {
    await runTermOrphanedProcessGroupWorkload();
    throw new ProbeComplete();
  }

  if (signalProbe.target === "after-real-server-ready") {
    console.log("[packed-cli-e2e] building the real server for signal probe");
    await run("pnpm", ["--filter", "@patchy/server...", "build"], { cwd: repoRoot });
    portReservation = await reserveLoopbackPort();
    let publicBaseUrl = `http://127.0.0.1:${portReservation.port}`;
    const startedServer = await startServer({ publicBaseUrl, objectDir });
    publicBaseUrl = startedServer.publicBaseUrl;
    await waitForReady(`${publicBaseUrl}/healthz`);
    await signalProbeCheckpoint("after-real-server-ready", {
      publicBaseUrl,
      ...probeTempRootDetails()
    });
    throw new Error("after-real-server signal probe unexpectedly resumed");
  }

  await signalProbeCheckpoint("before-first-child-spawn");
  throwIfSignalLatched();
  console.log("[packed-cli-e2e] building the real server");
  await run("pnpm", ["--filter", "@patchy/server...", "build"], { cwd: repoRoot });

  console.log("[packed-cli-e2e] building CLI once");
  await run("pnpm", ["--filter", "@patchy/cli", "build"], { cwd: repoRoot });

  console.log("[packed-cli-e2e] packing one exact tarball without rerunning prepack");
  const packed = await run(
    "pnpm",
    ["--config.ignore-scripts=true", "pack", "--json", "--pack-destination", packDir],
    { cwd: cliPackageDir }
  );
  const packResult = parsePackResult(packed.stdout);
  assert.equal(packResult.length, 1, "pnpm pack must produce exactly one artifact");

  const tarballs = (await checkedCall(() => readdir(packDir))).filter((entry) =>
    entry.endsWith(".tgz")
  );
  assert.deepEqual(
    tarballs,
    [path.basename(packResult[0].filename)],
    "pnpm pack must create one exact tarball"
  );
  const packedFiles = new Set(packResult[0].files.map((file) => file.path));
  for (const requiredFile of ["dist/index.js", "skills/patchy/SKILL.md", "LICENSE", "README.md"]) {
    assert.ok(packedFiles.has(requiredFile), `packed CLI is missing ${requiredFile}`);
  }

  const tarballPath = path.join(packDir, tarballs[0]);
  console.log("[packed-cli-e2e] installing tarball in a clean consumer directory");
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", tarballPath],
    { cwd: consumerDir, timeoutMs: 120_000 }
  );

  const cliPath = installedCliBinPath(consumerDir);
  await checkedCall(() => access(cliPath));
  const installedManifest = JSON.parse(
    await checkedCall(() =>
      readFile(path.join(consumerDir, "node_modules/@patchy/cli/package.json"), "utf8")
    )
  );
  const version = await run(cliPath, ["--version"], { cwd: consumerDir });
  assert.equal(version.stdout.trim(), installedManifest.version);
  assert.notEqual(version.stdout.trim(), "0.0.0-dev");

  portReservation = await reserveLoopbackPort();
  let publicBaseUrl = `http://127.0.0.1:${portReservation.port}`;
  const startedServer = await startServer({
    publicBaseUrl,
    objectDir
  });
  publicBaseUrl = startedServer.publicBaseUrl;
  await waitForReady(`${publicBaseUrl}/healthz`);
  await signalProbeCheckpoint("after-real-server-ready", {
    publicBaseUrl,
    ...probeTempRootDetails()
  });

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
      readFile(path.join(consumerDir, "node_modules/@patchy/cli/README.md"), "utf8")
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
  const first = parseUpload(
    await runCli(cliPath, ["upload", fixtureArgument, "--share", "public"], {
      cwd: consumerDir,
      env: cliEnv
    })
  );
  assert.equal(first.label, "Uploaded patch");
  assert.equal(first.versionNumber, 1);
  assert.equal(first.publicUrl, `${publicBaseUrl}/d/${first.patchId}`);
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

  await checkedCall(() => writeFile(fixturePath, secondHtml, "utf8"));
  const second = parseUpload(
    await runCli(cliPath, ["upload", fixtureArgument], { cwd: consumerDir, env: cliEnv })
  );
  assert.equal(second.label, "Updated patch");
  assert.equal(second.patchId, first.patchId);
  assert.equal(second.versionNumber, 2);
  assert.equal(second.scope, "public", "an update without --share must preserve sharing");

  const publicVersions = [
    { url: first.publicUrl, html: secondHtml, versionNumber: 2 },
    { url: `${first.publicUrl}/v/1`, html: firstHtml, versionNumber: 1 },
    { url: `${first.publicUrl}/v/2`, html: secondHtml, versionNumber: 2 }
  ];
  console.log("[packed-cli-e2e] validating public pages on current and explicit versions");
  for (const version of publicVersions) {
    assertPublicViewer(await fetchViewer(version.url), { ...version, patchId: first.patchId });
  }

  console.log("[packed-cli-e2e] refusing sharing changes by another user in the same company");
  const foreignToken = await checkedCall(() => seedOtherUserToken());
  const foreignResponse = await fetch(`${publicBaseUrl}/api/patches/${first.patchId}/share`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${foreignToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ scope: "company" }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000)
  });
  assert.equal(foreignResponse.status, 404, "company membership must not grant ownership");
  await foreignResponse.arrayBuffer();
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
  for (const version of publicVersions) {
    assertPublicViewer(await fetchViewer(version.url), { ...version, patchId: first.patchId });
  }

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

  console.log("[packed-cli-e2e] sharing by explicit id in both directions under --json");
  for (const scope of ["public", "company"]) {
    const shared = await runCli(cliPath, ["share", "--patch", first.patchId, scope, "--json"], {
      cwd: consumerDir,
      env: cliEnv
    });
    assert.equal(shared.stderr, "", "--json success must leave stderr empty");
    assert.deepEqual(JSON.parse(shared.stdout), {
      ok: true,
      patchId: first.patchId,
      scope,
      publicUrl: first.publicUrl
    });
    for (const version of publicVersions) {
      const viewer = await fetchViewer(version.url);
      if (scope === "public") {
        assertPublicViewer(viewer, { ...version, patchId: first.patchId });
      } else {
        assertViewerDoor(viewer);
      }
    }
  }

  await checkedCall(() => writeFile(fixturePath, newHtml, "utf8"));
  const freshUpload = await runCli(cliPath, ["upload", fixtureArgument, "--new", "--json"], {
    cwd: consumerDir,
    env: cliEnv
  });
  assert.equal(freshUpload.stderr, "", "--json success must leave stderr empty");
  const fresh = JSON.parse(freshUpload.stdout);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.scope, "company", "a new upload without --share defaults to company");
  assert.equal(fresh.versionNumber, 1);
  assert.notEqual(fresh.patchId, first.patchId);

  console.log("[packed-cli-e2e] validating the default-company upload's login door");
  for (const url of [fresh.publicUrl, `${fresh.publicUrl}/v/1`]) {
    assertViewerDoor(await fetchViewer(url));
  }

  const metadata = await readMetadata();
  assert.equal(metadata.drafts.length, 2);
  assert.equal(metadata.draftVersions.length, 3);
  await assertStoredDraft(metadata, objectDir, {
    patchId: first.patchId,
    expectedHtmlByVersion: [firstHtml, secondHtml],
    companyId: DEV_SEED.companyId,
    ownerUserId: DEV_SEED.userId,
    machineTokenId: DEV_SEED.tokenId
  });
  await assertStoredDraft(metadata, objectDir, {
    patchId: fresh.patchId,
    expectedHtmlByVersion: [newHtml],
    companyId: DEV_SEED.companyId,
    ownerUserId: DEV_SEED.userId,
    machineTokenId: DEV_SEED.tokenId
  });

  console.log("[packed-cli-e2e] proving unsafe HTML and bad credentials cannot mutate state");
  const unsafeHtml =
    '<!doctype html><html><head><title>Unsafe</title></head><body><script>alert("no")</script></body></html>';
  const unsafeValidationStateDir = path.join(tempRoot, "cli state unsafe validation");
  await checkedCall(() => mkdir(unsafeValidationStateDir));
  assert.deepEqual(await snapshotTree(unsafeValidationStateDir), []);
  await checkedCall(() => writeFile(fixturePath, unsafeHtml, "utf8"));
  await assertCliFailureNoMutation({
    cliPath,
    args: ["upload", fixtureArgument],
    cwd: consumerDir,
    env: environment({
      PATCHY_STATE_DIR: unsafeValidationStateDir,
      PATCHY_API_URL: publicBaseUrl,
      PATCHY_API_TOKEN: DEV_SEED.token
    }),
    cliStateDir: unsafeValidationStateDir,
    objectDir,
    expectAuthoritativeNonEmpty: true,
    expectEmptyCliState: true,
    stderr: /Blocked <script> tag found\./,
    exitCode: 1
  });

  await checkedCall(() =>
    writeFile(fixturePath, validHtml("Invalid env", "invalid-env-must-not-persist"), "utf8")
  );
  await assertCliFailureNoMutation({
    cliPath,
    args: ["upload", fixtureArgument],
    cwd: consumerDir,
    env: { ...cliEnv, PATCHY_API_TOKEN: "invalid-env-credential" },
    cliStateDir,
    objectDir,
    sensitiveValues: ["invalid-env-credential"],
    stderr: /Missing or invalid API token\./,
    exitCode: 2
  });

  console.log("[packed-cli-e2e] proving the --json contract and the unreachable rung");
  const rejectedJson = await runCli(cliPath, ["whoami", "--json"], {
    cwd: consumerDir,
    env: { ...cliEnv, PATCHY_API_TOKEN: "invalid-env-credential" },
    allowFailure: true,
    sensitiveValues: ["invalid-env-credential"]
  });
  assert.equal(rejectedJson.code, 2);
  assert.equal(rejectedJson.stdout, "", "--json failure must leave stdout empty");
  assert.deepEqual(JSON.parse(rejectedJson.stderr), {
    ok: false,
    error: "Missing or invalid API token.",
    kind: "rejected"
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
  const unreachable = await runCli(cliPath, ["whoami", "--api-url", "http://127.0.0.1:1"], {
    cwd: consumerDir,
    env: { ...cliEnv, PATCHY_API_TOKEN: DEV_SEED.token },
    allowFailure: true
  });
  assert.equal(unreachable.code, 3, `expected exit 3\nstderr:\n${unreachable.stderr}`);
  assert.match(unreachable.stderr, /^http:\/\/127\.0\.0\.1:1 could not be reached\./);

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
  await assertCliFailureNoMutation({
    cliPath,
    args: ["upload", fixtureArgument],
    cwd: consumerDir,
    env: invalidStoredEnv,
    cliStateDir: invalidStoredStateDir,
    objectDir,
    sensitiveValues: [invalidStoredToken],
    stderr: /Missing or invalid API token\./,
    exitCode: 2
  });

  console.log("[packed-cli-e2e] proving publishing without a key fails locally without mutation");
  const noKeyStateDir = path.join(tempRoot, "cli state no key");
  await checkedCall(() => mkdir(noKeyStateDir));
  const noKeyEnv = environment({ PATCHY_STATE_DIR: noKeyStateDir, PATCHY_API_URL: publicBaseUrl }, [
    "PATCHY_API_TOKEN"
  ]);
  for (const args of [
    ["upload", fixtureArgument, "--json"],
    ["delete", "--patch", fresh.patchId, "--json"],
    ["share", "--patch", fresh.patchId, "public", "--json"],
    ["whoami", "--json"]
  ]) {
    const failure = await assertCliFailureNoMutation({
      cliPath,
      args,
      cwd: consumerDir,
      env: noKeyEnv,
      cliStateDir: noKeyStateDir,
      objectDir,
      expectAuthoritativeNonEmpty: true,
      expectEmptyCliState: true,
      stderr: /Run: patchy login/,
      exitCode: 1
    });
    assert.equal(failure.stdout, "", "--json failure must leave stdout empty");
    const document = JSON.parse(failure.stderr);
    assert.equal(document.ok, false);
    assert.equal(document.kind, "local");
  }

  console.log("[packed-cli-e2e] proving environment credentials override stored credentials");
  const envPrecedenceHtml = validHtml(
    "Environment precedence",
    "valid-env-overrode-invalid-stored"
  );
  await checkedCall(() => writeFile(fixturePath, envPrecedenceHtml, "utf8"));
  const envPrecedence = parseUpload(
    await runCli(cliPath, ["upload", fixtureArgument], {
      cwd: consumerDir,
      env: { ...invalidStoredEnv, PATCHY_API_TOKEN: DEV_SEED.token }
    })
  );
  assertViewerDoor(await fetchViewer(envPrecedence.publicUrl));
  assertViewerDoor(await fetchViewer(`${envPrecedence.publicUrl}/v/1`));

  const finalMetadata = await readMetadata();
  assert.equal(finalMetadata.drafts.length, 3);
  assert.equal(finalMetadata.draftVersions.length, 4);
  for (const draft of finalMetadata.drafts) {
    assert.equal(draft.companyId, DEV_SEED.companyId);
    assert.equal(draft.ownerUserId, DEV_SEED.userId);
    assert.equal(draft.scope, "company");
  }
  assert.ok(
    !JSON.stringify(finalMetadata).includes(DEV_SEED.token),
    "the instance must keep only the machine token's hash"
  );
  await assertStoredDraft(finalMetadata, objectDir, {
    patchId: envPrecedence.patchId,
    expectedHtmlByVersion: [envPrecedenceHtml],
    companyId: DEV_SEED.companyId,
    ownerUserId: DEV_SEED.userId,
    machineTokenId: DEV_SEED.tokenId
  });
  assert.equal((await snapshotTree(objectDir)).length, 4);

  console.log("[packed-cli-e2e] proving delete takes a patch down as its owner user");
  // Its own upload on the authenticated state dir, so deleting by file resolves
  // to the patch this step created, whatever the script cached before it.
  const doomedHtml = validHtml("Packed contract doomed", "packed-contract-doomed");
  await checkedCall(() => writeFile(fixturePath, doomedHtml, "utf8"));
  const doomed = parseUpload(
    await runCli(cliPath, ["upload", fixtureArgument, "--new"], { cwd: consumerDir, env: cliEnv })
  );
  const doomedViewer = await fetchViewer(doomed.publicUrl);
  assertViewerDoor(doomedViewer);
  assertViewerDoor(await fetchViewer(`${doomed.publicUrl}/v/1`));
  const removed = await runCli(cliPath, ["delete", fixtureArgument], {
    cwd: consumerDir,
    env: cliEnv
  });
  assert.equal(
    removed.stdout,
    `Deleting from ${publicBaseUrl} (target came from the saved config).\nDeleted patch\nPatch ID: ${doomed.patchId}\n`
  );
  assert.equal(removed.stderr, "");
  const removedViewer = await fetchViewer(doomed.publicUrl);
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
  const removedAgain = await runCli(cliPath, ["delete", "--patch", doomed.patchId], {
    cwd: consumerDir,
    env: cliEnv,
    allowFailure: true
  });
  assert.equal(removedAgain.code, 2, "deleting a patch that is gone is the instance's refusal");

  // Login uses its own state and dev env so it cannot replace the seeded key
  // that the publishing scenarios above need. Revoke that seed only at the end.
  console.log("[packed-cli-e2e] exercising the agent login handoff and resume");
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

  const pendingDocument = {
    ok: true,
    status: "pending",
    userCode: handoff.userCode,
    expiresAt: handoff.expiresAt,
    next: handoff.next,
    agentNextSteps: handoff.agentNextSteps
  };
  const resumedResult = await runCli(cliPath, ["login", "--json"], loginOptions);
  assert.equal(resumedResult.stderr, "");
  assert.deepEqual(
    JSON.parse(resumedResult.stdout),
    pendingDocument,
    "rerunning login must poll the code the person is about to confirm, not start another"
  );
  const pendingResult = await runCli(
    cliPath,
    ["login", "--complete", "--wait", "0", "--json"],
    loginOptions
  );
  assert.equal(pendingResult.stderr, "", "--json pending is a success, not a failure");
  assert.deepEqual(JSON.parse(pendingResult.stdout), pendingDocument);

  console.log("[packed-cli-e2e] proving CLAUDECODE does not wait even with terminal stdin");
  const ptyStateDir = path.join(tempRoot, "cli state pty login");
  await checkedCall(() => mkdir(ptyStateDir));
  await assertAgentLoginOnPty(cliPath, publicBaseUrl, {
    ...loginOptions,
    env: { ...loginEnv, PATCHY_STATE_DIR: ptyStateDir }
  });

  console.log("[packed-cli-e2e] confirming through the real offline-signed browser session");
  const machineName = "Packed login machine";
  const confirm = await fetch(handoff.verificationUrlBare, {
    method: "POST",
    headers: {
      cookie: authTesting.signedInCookies(authTesting.signSession({ azp: publicBaseUrl })),
      origin: publicBaseUrl
    },
    body: new URLSearchParams({ action: "confirm", code: handoff.userCode, machineName }),
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
    "credentialsPath"
  ]);
  assert.equal(loggedIn.ok, true);
  assert.equal(loggedIn.status, "logged_in");
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
  const loginStatus = JSON.parse(
    (await runCli(cliPath, ["status", "--json"], loggedInOptions)).stdout
  );
  assert.equal(loginStatus.hasToken, true);
  assert.equal(loginStatus.tokenSource, "login", "a stored login must outrank the dev seed");
  const consumed = await runCli(cliPath, ["login", "--complete", "--wait", "0", "--json"], {
    ...loggedInOptions,
    allowFailure: true
  });
  assert.equal(consumed.code, 1, "completion must forget the pending login locally");
  assert.equal(consumed.stdout, "");
  assert.equal(JSON.parse(consumed.stderr).kind, "local");

  const envWhoami = await runCli(cliPath, ["whoami", "--json"], {
    ...loggedInOptions,
    env: { ...loginEnv, PATCHY_API_TOKEN: foreignToken }
  });
  assert.equal(JSON.parse(envWhoami.stdout).machine.id, "tok_packed_other");
  console.log("[packed-cli-e2e] logging out the login key restores the worktree seed");
  const loginLogout = await runCli(cliPath, ["logout"], loggedInOptions);
  assert.match(
    `${loginLogout.stdout}${loginLogout.stderr}`,
    /This worktree's dev instance still publishes with its seeded key/
  );
  const fallbackWhoami = await runCli(cliPath, ["whoami", "--json"], loggedInOptions);
  assert.equal(fallbackWhoami.stderr, "");
  assert.deepEqual(JSON.parse(fallbackWhoami.stdout), JSON.parse(whoamiJson.stdout));
  const fallbackStatus = JSON.parse(
    (await runCli(cliPath, ["status", "--json"], loggedInOptions)).stdout
  );
  assert.equal(fallbackStatus.hasToken, true);
  assert.equal(fallbackStatus.tokenSource, null);
  const revokedLogin = await runCli(cliPath, ["whoami", "--json"], {
    ...loggedInOptions,
    env: { ...loginEnv, PATCHY_API_TOKEN: loginToken },
    allowFailure: true
  });
  assert.equal(revokedLogin.code, 2, "logout must revoke the saved login key at the server");
  assert.equal(revokedLogin.stdout, "");
  assert.equal(JSON.parse(revokedLogin.stderr).kind, "rejected");
  const outsideWhoami = await runCli(cliPath, ["whoami", "--api-url", publicBaseUrl, "--json"], {
    ...loggedInOptions,
    cwd: consumerDir,
    allowFailure: true
  });
  assert.equal(outsideWhoami.code, 1, "outside a worktree logout leaves no publishing key");
  assert.equal(outsideWhoami.stdout, "");
  assert.equal(JSON.parse(outsideWhoami.stderr).kind, "local");
  assert.match(JSON.parse(outsideWhoami.stderr).error, /Run: patchy login/);

  console.log("[packed-cli-e2e] revoking only the auth-set seed, never the environment key");
  const logoutPending = await runCli(cliPath, ["login", "--json"], {
    cwd: consumerDir,
    env: cliEnv
  });
  assertLoginHandoff(JSON.parse(logoutPending.stdout), publicBaseUrl);
  const seedLogoutOptions = {
    cwd: consumerDir,
    env: { ...cliEnv, PATCHY_API_TOKEN: foreignToken },
    sensitiveValues: [foreignToken, loginToken]
  };
  const seedLogout = await runCli(cliPath, ["logout", "--json"], seedLogoutOptions);
  assert.equal(seedLogout.stderr, "", "courtesy warnings belong in the JSON success document");
  const loggedOut = JSON.parse(seedLogout.stdout);
  assertDocumentKeys(loggedOut, ["ok", "instanceUrl", "revoked", "warnings"]);
  assert.equal(loggedOut.ok, true);
  assert.equal(loggedOut.instanceUrl, publicBaseUrl);
  assert.equal(loggedOut.revoked, true);
  assert.ok(Array.isArray(loggedOut.warnings));
  assert.ok(loggedOut.warnings.some((warning) => warning.includes("PATCHY_API_TOKEN")));
  const environmentStillWorks = await runCli(cliPath, ["whoami", "--json"], seedLogoutOptions);
  assert.equal(JSON.parse(environmentStillWorks.stdout).machine.id, "tok_packed_other");
  const revokedSeed = await runCli(cliPath, ["whoami", "--json"], {
    ...seedLogoutOptions,
    env: { ...cliEnv, PATCHY_API_TOKEN: DEV_SEED.token },
    allowFailure: true
  });
  assert.equal(revokedSeed.code, 2, "the stored seed must be revoked, not the environment key");
  assert.equal(revokedSeed.stdout, "");
  assert.equal(JSON.parse(revokedSeed.stderr).kind, "rejected");
  const noPendingAfterLogout = await runCli(
    cliPath,
    ["login", "--complete", "--wait", "0", "--json"],
    { cwd: consumerDir, env: cliEnv, allowFailure: true }
  );
  assert.equal(noPendingAfterLogout.code, 1, "logout must also forget a pending login");
  assert.equal(noPendingAfterLogout.stdout, "");
  assert.equal(JSON.parse(noPendingAfterLogout.stderr).kind, "local");
  const noStoredAfterLogout = await runCli(cliPath, ["whoami", "--json"], {
    cwd: consumerDir,
    env: cliEnv,
    allowFailure: true
  });
  assert.equal(noStoredAfterLogout.code, 1, "logout must delete the saved auth-set key");
  assert.equal(noStoredAfterLogout.stdout, "");
  assert.equal(JSON.parse(noStoredAfterLogout.stderr).kind, "local");

  // Saving the now-revoked seed again exercises the courtesy call's 401 path.
  await runCli(cliPath, ["auth", "set", "--token-stdin"], {
    cwd: consumerDir,
    env: cliEnv,
    input: `${DEV_SEED.token}\n`
  });
  const alreadyRevoked = await runCli(cliPath, ["logout", "--json"], {
    cwd: consumerDir,
    env: cliEnv
  });
  assert.equal(alreadyRevoked.stderr, "");
  assert.deepEqual(JSON.parse(alreadyRevoked.stdout), {
    ok: true,
    instanceUrl: publicBaseUrl,
    revoked: true,
    warnings: []
  });

  console.log(
    "[packed-cli-e2e] PASS: spaced consumer/artifact/state paths and quoted POSIX sh commands"
  );
  console.log("[packed-cli-e2e] PASS: complete packed CLI real-server contract");
} catch (error) {
  if (!(error instanceof ProbeComplete)) mainFailure = error;
} finally {
  try {
    await cleanup();
  } catch (error) {
    mainFailure ??= error;
  }
}
if (latchedSignal) process.exit(latchedSignalExitCode);
if (mainFailure) throw mainFailure;

async function runProbeMode(mode) {
  let modeFailure;
  try {
    if (mode === "--signal-probes") {
      await runSignalProbes();
    } else if (mode === "--platform-probes") {
      await runPlatformProbes();
    } else if (mode === "--lifecycle-probes") {
      await runLifecycleProbes();
    } else {
      throw new Error(`unknown probe mode ${mode}`);
    }
  } catch (error) {
    if (!(error instanceof SignalAbort)) modeFailure = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      modeFailure ??= error;
    }
  }

  if (latchedSignal) process.exit(latchedSignalExitCode);
  if (modeFailure) throw modeFailure;
  process.exit(0);
}

async function runSignalProbes() {
  if (outerSignalProbe.target) {
    await runOuterSignalProbeRunnerTarget(outerSignalProbe.target);
    return;
  }

  const probes = [
    { checkpoint: "before-temp-creation", signal: "SIGINT", expectedCode: 130 },
    { checkpoint: "after-temp-created", signal: "SIGTERM", expectedCode: 143 },
    {
      checkpoint: "before-first-child-spawn",
      signal: "SIGTERM",
      expectedCode: 143,
      stubRunAfterSignal: true
    },
    { checkpoint: "after-real-server-ready", signal: "SIGINT", expectedCode: 130 }
  ];

  for (const probe of probes) {
    await runSignalProbe(probe);
    console.log(`[signal-probe] PASS ${probe.checkpoint} ${probe.signal}`);
  }
  await runSignalOverlapProbe();
  console.log("[signal-probe] PASS overlap-owned-temp-roots");
  await runOuterSignalRunnerProbe({
    checkpoint: "before-temp-creation",
    signal: "SIGINT",
    expectedCode: 130
  });
  console.log("[signal-probe] PASS outer-runner before-temp-creation SIGINT");
  await runOuterSignalRunnerProbe({
    checkpoint: "after-real-server-ready",
    signal: "SIGTERM",
    expectedCode: 143
  });
  console.log("[signal-probe] PASS outer-runner after-real-server-ready SIGTERM");
}

async function runPlatformProbes() {
  assertWin32LifecycleRejectionContract();

  const fakePnpmEntry = path.win32.join("C:\\tools", "pnpm", "pnpm.cjs");
  const winEnv = sanitizedProcessEnv({
    PATH: "C:\\Windows\\System32",
    PATCHY_API_TOKEN: "ambient-token",
    PATCHY_UNKNOWN_POISON: "ambient-poison",
    npm_execpath: fakePnpmEntry
  });

  const npmInvocation = resolveSpawnInvocation("npm", ["pack"], {
    platform: "win32",
    env: winEnv
  });
  assert.equal(npmInvocation.command, process.execPath);
  assert.deepEqual(npmInvocation.args, [npmCliEntry, "pack"]);

  const pnpmInvocation = resolveSpawnInvocation("pnpm", ["--filter", "@patchy/cli", "build"], {
    platform: "win32",
    env: winEnv
  });
  assert.equal(pnpmInvocation.command, process.execPath);
  assert.deepEqual(pnpmInvocation.args, [fakePnpmEntry, "--filter", "@patchy/cli", "build"]);

  const winCliBin = path.win32.join(
    "C:\\workspace",
    "consumer",
    "node_modules",
    ".bin",
    "patchy.cmd"
  );
  const winCliInvocation = resolveSpawnInvocation(winCliBin, ["--version"], {
    platform: "win32",
    env: winEnv
  });
  assert.equal(winCliInvocation.command, process.execPath);
  assert.deepEqual(winCliInvocation.args, [
    path.win32.join(
      "C:\\workspace",
      "consumer",
      "node_modules",
      "@patchy",
      "cli",
      "dist",
      "index.js"
    ),
    "--version"
  ]);

  const posixCliBin = "/tmp/consumer/node_modules/.bin/patchy";
  const posixCliInvocation = resolveSpawnInvocation(posixCliBin, ["--version"], {
    platform: "linux",
    env: sanitizedProcessEnv()
  });
  assert.equal(posixCliInvocation.command, posixCliBin);
  assert.deepEqual(posixCliInvocation.args, ["--version"]);

  assert.equal(winEnv.PATCHY_API_TOKEN, undefined);
  assert.equal(winEnv.PATCHY_UNKNOWN_POISON, undefined);
  assert.equal(winEnv.PATH, "C:\\Windows\\System32");

  assert.throws(
    () => resolveSpawnInvocation("pnpm", ["--version"], { platform: "win32", env: {} }),
    /npm_execpath/
  );

  console.log(
    "[platform-probe] PASS win32 lifecycle rejection, command resolution, and PATCHY env stripping"
  );
}

function assertWin32LifecycleRejectionContract() {
  const unsupportedCases = [
    { label: "full E2E", argvMode: undefined },
    { label: "signal probe runner", argvMode: "--signal-probes" },
    { label: "lifecycle probe runner", argvMode: "--lifecycle-probes" },
    { label: "signal probe child", argvMode: undefined },
    { label: "lifecycle probe child", argvMode: undefined }
  ];

  for (const runtime of unsupportedCases) {
    assert.throws(
      () => assertRuntimeModeSupportedOnPlatform({ platform: "win32", argvMode: runtime.argvMode }),
      /not supported on win32.*macOS\+Ubuntu\/POSIX.*--platform-probes/,
      `${runtime.label} should reject on win32 before temp or process mutation`
    );
  }
  assert.doesNotThrow(() =>
    assertRuntimeModeSupportedOnPlatform({ platform: "win32", argvMode: "--platform-probes" })
  );
  assert.doesNotThrow(() =>
    assertRuntimeModeSupportedOnPlatform({ platform: "linux", argvMode: undefined })
  );
  assert.doesNotThrow(() =>
    assertRuntimeModeSupportedOnPlatform({ platform: "darwin", argvMode: "--signal-probes" })
  );
}

function assertRuntimeModeSupportedOnPlatform({ platform, argvMode }) {
  if (platform !== "win32" || argvMode === "--platform-probes") return;
  throw new Error(
    "packed CLI E2E lifecycle, signal, and full E2E modes are not supported on win32; " +
      "the lifecycle contract is macOS+Ubuntu/POSIX CI only. " +
      "Use --platform-probes for static Windows command-resolution coverage."
  );
}

async function runLifecycleProbes() {
  await runLifecycleTimeoutCleanupProbe();
  console.log("[lifecycle-probe] PASS timeout-owned-temp-root-cleanup");

  const probes = [
    {
      mode: "server-spawn-error",
      expectFailure: true,
      expectedStderr:
        /server spawn failed before ready stdout \(ENOENT .*patchy-packed-cli-e2e-missing-server-spawn/
    },
    {
      mode: "server-bind-race-retry",
      expectFailure: false,
      timeoutMs: 120_000
    },
    {
      mode: "missing-server-entry-negative-control",
      expectFailure: true,
      expectedStderr:
        /server entry missing before spawn .*patchy-packed-cli-e2e-missing-server-entry-negative-control/,
      unexpectedStderr: /patchy-packed-cli-e2e-missing-server-spawn/
    },
    {
      mode: "term-orphaned-process-group",
      expectFailure: false
    }
  ];

  for (const probe of probes) {
    await runLifecycleProbe(probe);
    console.log(`[lifecycle-probe] PASS ${probe.mode}`);
  }
}

async function runLifecycleTimeoutCleanupProbe() {
  const targetOwnerId = createProbeOwnerId();
  const foreignOwnerId = createProbeOwnerId();
  const targetMarkerPath = path.join(
    os.tmpdir(),
    `patchy-packed-cli-e2e-lifecycle-probe-${process.pid}-${targetOwnerId}-timeout-owned-temp-root.jsonl`
  );
  const foreignMarkerPath = path.join(
    os.tmpdir(),
    `patchy-packed-cli-e2e-signal-probe-${process.pid}-${foreignOwnerId}-timeout-foreign.jsonl`
  );
  await Promise.all([
    rm(targetMarkerPath, { force: true }),
    rm(foreignMarkerPath, { force: true })
  ]);

  const target = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      [probeOwnerEnvName]: targetOwnerId,
      PATCHY_PACKED_CLI_E2E_LIFECYCLE_PROBE: "timeout-owned-temp-root",
      PATCHY_PACKED_CLI_E2E_LIFECYCLE_MARKER: targetMarkerPath
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  registerSpawnedChild(target);

  let targetStdout = "";
  let targetStderr = "";
  let targetLineBuffer = "";
  const targetEvents = [];
  let targetRecords = [];
  let targetTempRoot;
  let targetDescendantPort;
  let targetCleanupComplete = false;
  let foreign;
  let foreignTempRoot;
  let foreignRecords = [];
  let foreignLeakFailures;
  let foreignCleanupComplete = false;

  target.stdout.setEncoding("utf8");
  target.stderr.setEncoding("utf8");
  target.stdout.on("data", (chunk) => {
    targetStdout += chunk;
    targetLineBuffer += chunk;
    const lines = targetLineBuffer.split("\n");
    targetLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseLifecycleProbeEvent(line);
      if (event) targetEvents.push(event);
    }
  });
  target.stderr.on("data", (chunk) => {
    targetStderr += chunk;
  });

  try {
    const targetReady = await waitForJsonlRecord(
      targetMarkerPath,
      (record) => record.type === "timeout-owned-temp-root-ready",
      30_000
    );
    targetRecords = await readJsonlRecords(targetMarkerPath);
    targetTempRoot = validateOwnedTempRootPath(targetOwnerId, targetReady.tempRoot);
    targetDescendantPort = targetReady.port;
    assert.ok(
      await pathExists(targetTempRoot),
      `timeout target should own an active temp root before parent cleanup: ${targetTempRoot}\nstdout:\n${targetStdout}\nstderr:\n${targetStderr}`
    );
    assert.ok(
      Number.isInteger(targetDescendantPort) && (await isTcpPortOpen(targetDescendantPort)),
      `timeout target descendant port should be open before timeout cleanup: ${targetDescendantPort}\nstdout:\n${targetStdout}\nstderr:\n${targetStderr}`
    );

    foreign = spawnSignalProbeChild("after-temp-created", foreignMarkerPath, foreignOwnerId);
    const foreignCheckpoint = await foreign.waitForCheckpoint("after-temp-created", 30_000);
    foreignTempRoot = validateOwnedTempRootPath(
      foreignOwnerId,
      foreignCheckpoint.details?.tempRoot
    );
    assert.ok(
      await pathExists(foreignTempRoot),
      `foreign probe root should exist before target timeout cleanup: ${foreignTempRoot}`
    );

    try {
      await assert.rejects(
        () => waitForProbeChild(target, 250),
        /probe child timed out after 250ms/,
        "timeout-owned-temp-root should fail through the parent timeout"
      );
    } finally {
      targetRecords = await readJsonlRecords(targetMarkerPath);
      let assertionFailure;
      try {
        assert.ok(
          targetTempRoot && (await pathExists(targetTempRoot)),
          `timeout target root should still exist before owner-scoped parent cleanup: ${targetTempRoot}\nstdout:\n${targetStdout}\nstderr:\n${targetStderr}`
        );
        assert.equal(
          targetDescendantPort ? await isTcpPortOpen(targetDescendantPort) : false,
          false,
          `timeout kill should terminate the POSIX process group before cleanup; port ${targetDescendantPort} is still open`
        );
        assert.ok(
          await pathExists(foreignTempRoot),
          `foreign root must remain before target owner cleanup: ${foreignTempRoot}`
        );
        assert.ok(
          Number.isInteger(foreign.child.pid) && isPidAlive(foreign.child.pid),
          `foreign probe should remain alive before target owner cleanup\nstdout:\n${foreign.stdout()}\nstderr:\n${foreign.stderr()}`
        );
      } catch (error) {
        assertionFailure = error;
      }

      await emergencyCleanupLifecycleProbe({
        ownerId: targetOwnerId,
        markerPath: targetMarkerPath,
        records: targetRecords,
        events: targetEvents,
        leakedTempRoots: await listOwnedPackedCliTempRoots(targetOwnerId)
      });
      targetCleanupComplete = true;
      assert.equal(
        targetTempRoot ? await pathExists(targetTempRoot) : false,
        false,
        `parent finally should remove exact owned timeout root ${targetTempRoot}`
      );
      if (assertionFailure) throw assertionFailure;
    }

    assert.ok(
      await pathExists(foreignTempRoot),
      `target cleanup must not remove foreign root ${foreignTempRoot}`
    );
    assert.ok(
      Number.isInteger(foreign.child.pid) && isPidAlive(foreign.child.pid),
      `foreign probe should remain alive after target cleanup\nstdout:\n${foreign.stdout()}\nstderr:\n${foreign.stderr()}`
    );

    try {
      foreign.child.kill("SIGTERM");
      const foreignResult = await waitForProbeChild(foreign.child, 30_000);
      foreignRecords = await readSignalProbeChildRecords(foreignMarkerPath);
      foreignLeakFailures = await collectSignalProbeLeaks({
        ownerId: foreignOwnerId,
        childRecords: foreignRecords,
        checkpointDetails: { tempRoot: foreignTempRoot }
      });

      assert.equal(
        foreignResult.code,
        143,
        `foreign probe should exit 143 after separate signal\nstdout:\n${foreign.stdout()}\nstderr:\n${foreign.stderr()}`
      );
      assert.deepEqual(
        foreignLeakFailures.messages,
        [],
        `foreign probe leaked after separate cleanup:\n${foreignLeakFailures.messages.join("\n")}\nstdout:\n${foreign.stdout()}\nstderr:\n${foreign.stderr()}`
      );
    } finally {
      await cleanupSignalProbeArtifacts(
        foreignMarkerPath,
        foreignRecords.length > 0 ? foreignRecords : await readJsonlRecords(foreignMarkerPath),
        foreignLeakFailures?.leakedTempRoots ?? [],
        foreignOwnerId
      );
      foreignCleanupComplete = true;
    }
  } finally {
    if (!targetCleanupComplete) {
      terminateProcessGroup(target, "SIGKILL");
      await Promise.race([waitForProbeChild(target, 1_000).catch(() => undefined), delay(1_000)]);
      targetRecords =
        targetRecords.length > 0 ? targetRecords : await readJsonlRecords(targetMarkerPath);
      await emergencyCleanupLifecycleProbe({
        ownerId: targetOwnerId,
        markerPath: targetMarkerPath,
        records: targetRecords,
        events: targetEvents,
        leakedTempRoots: await listOwnedPackedCliTempRoots(targetOwnerId)
      });
    }
    if (!foreignCleanupComplete) {
      await forceCleanupSignalProbeChild(
        foreign,
        foreignMarkerPath,
        foreignRecords,
        foreignLeakFailures?.leakedTempRoots ?? [],
        foreignOwnerId
      );
    }
  }
}

async function runLifecycleProbe(probe) {
  const ownerId = createProbeOwnerId();
  const markerPath = path.join(
    os.tmpdir(),
    `patchy-packed-cli-e2e-lifecycle-probe-${process.pid}-${ownerId}-${probe.mode}.jsonl`
  );
  await rm(markerPath, { force: true });

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      [probeOwnerEnvName]: ownerId,
      PATCHY_PACKED_CLI_E2E_LIFECYCLE_PROBE: probe.mode,
      PATCHY_PACKED_CLI_E2E_LIFECYCLE_MARKER: markerPath
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  registerSpawnedChild(child);

  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  let result;
  let records = [];
  let events = [];
  let leakFailures;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseLifecycleProbeEvent(line);
      if (event) events.push(event);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    result = await waitForProbeChild(child, probe.timeoutMs ?? 60_000);
    records = await readJsonlRecords(markerPath);
    leakFailures = await collectLifecycleProbeLeaks({
      ownerId,
      records,
      events
    });

    const cleanupStarts = records.filter((record) => record.type === "cleanup-start");
    const cleanupEnds = records.filter((record) => record.type === "cleanup-end");
    assert.equal(
      cleanupStarts.length,
      1,
      `${probe.mode} should start cleanup exactly once\nrecords:\n${JSON.stringify(records, null, 2)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.equal(
      cleanupEnds.length,
      1,
      `${probe.mode} should finish cleanup exactly once\nrecords:\n${JSON.stringify(records, null, 2)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.deepEqual(
      cleanupStarts.map((record) => record.count),
      [1]
    );
    assert.deepEqual(
      cleanupEnds.map((record) => record.count),
      [1]
    );

    if (probe.expectFailure) {
      assert.notEqual(
        result.code,
        0,
        `${probe.mode} should reject main\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
      assert.match(stderr, probe.expectedStderr);
      if (probe.unexpectedStderr) assert.doesNotMatch(stderr, probe.unexpectedStderr);
    } else {
      assert.equal(
        result.code,
        0,
        `${probe.mode} should exit cleanly after cleanup\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }

    assert.deepEqual(
      leakFailures.messages,
      [],
      `${probe.mode} leaked state:\n${leakFailures.messages.join("\n")}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  } finally {
    const cleanupRecords = records.length > 0 ? records : await readJsonlRecords(markerPath);
    const cleanupEvents = events;
    await emergencyCleanupLifecycleProbe({
      ownerId,
      markerPath,
      records: cleanupRecords,
      events: cleanupEvents,
      leakedTempRoots: leakFailures?.leakedTempRoots ?? []
    });
  }
}

async function runSignalProbe(probe) {
  const ownerId = createProbeOwnerId();
  const markerPath = path.join(
    os.tmpdir(),
    `patchy-packed-cli-e2e-signal-probe-${process.pid}-${ownerId}-${probe.checkpoint}.jsonl`
  );
  await rm(markerPath, { force: true });

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      [probeOwnerEnvName]: ownerId,
      PATCHY_PACKED_CLI_E2E_SIGNAL_PROBE: probe.checkpoint,
      PATCHY_PACKED_CLI_E2E_SIGNAL_PROBE_CHILDREN: markerPath,
      ...(probe.stubRunAfterSignal
        ? { PATCHY_PACKED_CLI_E2E_SIGNAL_PROBE_STUB_RUN_AFTER_SIGNAL: "1" }
        : {})
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  registerSpawnedChild(child);

  let stdout = "";
  let stderr = "";
  let signaled = false;
  let checkpointDetails = {};
  let lineBuffer = "";
  let result;
  let childRecords = [];
  let leakFailures;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseSignalProbeEvent(line);
      if (event?.checkpoint === probe.checkpoint && !signaled) {
        signaled = true;
        checkpointDetails = event.details ?? {};
        child.kill(probe.signal);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    result = await waitForProbeChild(child, probe.timeoutMs ?? 180_000);
    childRecords = await readSignalProbeChildRecords(markerPath);
    leakFailures = await collectSignalProbeLeaks({
      ownerId,
      childRecords,
      checkpointDetails
    });

    assert.ok(
      signaled,
      `${probe.checkpoint} did not reach its signal checkpoint\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.equal(
      result.code,
      probe.expectedCode,
      `${probe.checkpoint} ${probe.signal} should exit ${probe.expectedCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.deepEqual(
      leakFailures.messages,
      [],
      `${probe.checkpoint} ${probe.signal} leaked state:\n${leakFailures.messages.join("\n")}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  } finally {
    const cleanupRecords =
      childRecords.length > 0 ? childRecords : await readJsonlRecords(markerPath);
    await cleanupSignalProbeArtifacts(
      markerPath,
      cleanupRecords,
      leakFailures?.leakedTempRoots ?? [],
      ownerId
    );
  }
}

async function runOuterSignalRunnerProbe(probe) {
  const outer = spawn(process.execPath, [fileURLToPath(import.meta.url), "--signal-probes"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATCHY_PACKED_CLI_E2E_OUTER_SIGNAL_PROBE: probe.checkpoint
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  registerSpawnedChild(outer);

  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  const events = [];
  const waiters = [];
  let result;
  let childRecords = [];
  let leakFailures;
  outer.stdout.setEncoding("utf8");
  outer.stderr.setEncoding("utf8");
  outer.stdout.on("data", (chunk) => {
    stdout += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseOuterSignalProbeEvent(line);
      if (!event) continue;
      events.push(event);
      for (const waiter of [...waiters]) waiter();
    }
  });
  outer.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let checkpointEvent;
  try {
    checkpointEvent = await waitForSignalProbeChildEvent(
      outer,
      events,
      waiters,
      (event) => event.checkpoint === probe.checkpoint,
      probe.timeoutMs ?? 180_000,
      () => ({ stdout, stderr })
    );
    outer.kill(probe.signal);
    result = await waitForProbeChild(outer, 30_000);
    childRecords = await readSignalProbeChildRecords(checkpointEvent.markerPath);
    leakFailures = await collectSignalProbeLeaks({
      ownerId: checkpointEvent.ownerId,
      childRecords,
      checkpointDetails: {
        ...(checkpointEvent.details ?? {}),
        pid: checkpointEvent.childPid
      }
    });

    assert.equal(
      result.code,
      probe.expectedCode,
      `outer runner ${probe.checkpoint} ${probe.signal} should exit ${probe.expectedCode}\nresult:\n${JSON.stringify(result)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.deepEqual(
      leakFailures.messages,
      [],
      `outer runner ${probe.checkpoint} ${probe.signal} leaked state:\n${leakFailures.messages.join("\n")}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  } finally {
    if (outer.exitCode === null && outer.signalCode === null) {
      terminateProcessGroup(outer, "SIGKILL");
      await Promise.race([waitForProbeChild(outer, 1_000).catch(() => undefined), delay(1_000)]);
    }
    if (checkpointEvent) {
      const cleanupRecords =
        childRecords.length > 0 ? childRecords : await readJsonlRecords(checkpointEvent.markerPath);
      await cleanupSignalProbeArtifacts(
        checkpointEvent.markerPath,
        cleanupRecords,
        leakFailures?.leakedTempRoots ?? [],
        checkpointEvent.ownerId
      );
    }
  }
}

async function runOuterSignalProbeRunnerTarget(checkpoint) {
  const ownerId = createProbeOwnerId();
  const markerPath = path.join(
    os.tmpdir(),
    `patchy-packed-cli-e2e-outer-signal-probe-${process.pid}-${ownerId}-${checkpoint}.jsonl`
  );
  await rm(markerPath, { force: true });

  const probeChild = spawnSignalProbeChild(checkpoint, markerPath, ownerId);
  let childRecords = [];
  let leakFailures;
  try {
    const checkpointEvent = await probeChild.waitForCheckpoint(
      checkpoint,
      checkpoint === "after-real-server-ready" ? 180_000 : 30_000
    );
    console.log(
      `__PATCHY_OUTER_SIGNAL_PROBE__${JSON.stringify({
        checkpoint,
        ownerId,
        markerPath,
        childPid: probeChild.child.pid,
        details: checkpointEvent.details ?? {}
      })}`
    );
    while (!latchedSignal) await delay(100);
    throwIfSignalLatched();
  } finally {
    await waitForProbeChild(probeChild.child, 30_000).catch(() => undefined);
    childRecords = await readSignalProbeChildRecords(markerPath);
    leakFailures = await collectSignalProbeLeaks({
      ownerId,
      childRecords,
      checkpointDetails: {}
    });
    await cleanupSignalProbeArtifacts(
      markerPath,
      childRecords,
      leakFailures?.leakedTempRoots ?? [],
      ownerId
    );
    assert.deepEqual(
      leakFailures.messages,
      [],
      `outer signal target leaked nested state:\n${leakFailures.messages.join("\n")}\nstdout:\n${probeChild.stdout()}\nstderr:\n${probeChild.stderr()}`
    );
  }
}

async function runSignalOverlapProbe() {
  const aOwnerId = createProbeOwnerId();
  const bOwnerId = createProbeOwnerId();
  const aMarkerPath = path.join(
    os.tmpdir(),
    `patchy-packed-cli-e2e-signal-probe-${process.pid}-${aOwnerId}-overlap-a.jsonl`
  );
  const bMarkerPath = path.join(
    os.tmpdir(),
    `patchy-packed-cli-e2e-signal-probe-${process.pid}-${bOwnerId}-overlap-b.jsonl`
  );
  await Promise.all([rm(aMarkerPath, { force: true }), rm(bMarkerPath, { force: true })]);

  let a;
  let b;
  let aRecords = [];
  let aLeakFailures;
  let bRecords = [];
  let bLeakFailures;
  let aCleanupComplete = false;
  let bCleanupComplete = false;
  try {
    a = spawnSignalProbeChild("before-temp-creation", aMarkerPath, aOwnerId);
    const aCheckpoint = await a.waitForCheckpoint("before-temp-creation", 30_000);
    b = spawnSignalProbeChild("after-temp-created", bMarkerPath, bOwnerId);
    const bCheckpoint = await b.waitForCheckpoint("after-temp-created", 30_000);
    const bTempRoot = validateOwnedTempRootPath(bOwnerId, bCheckpoint.details?.tempRoot);
    const bTempRootName = path.basename(bTempRoot);
    assert.deepEqual(
      await listOwnedPackedCliTempRoots(bOwnerId),
      [bTempRootName],
      "overlap B should have exactly one owned active temp root"
    );

    try {
      a.child.kill("SIGINT");
      const aResult = await waitForProbeChild(a.child, 30_000);
      aRecords = await readSignalProbeChildRecords(aMarkerPath);
      aLeakFailures = await collectSignalProbeLeaks({
        ownerId: aOwnerId,
        childRecords: aRecords,
        checkpointDetails: aCheckpoint.details ?? {}
      });

      assert.equal(
        aResult.code,
        130,
        `overlap A should exit 130\nstdout:\n${a.stdout()}\nstderr:\n${a.stderr()}`
      );
      assert.deepEqual(
        aLeakFailures.messages,
        [],
        `overlap A must not flag B's active temp root ${bTempRootName}\nmessages:\n${aLeakFailures.messages.join("\n")}\nA stdout:\n${a.stdout()}\nA stderr:\n${a.stderr()}\nB stdout:\n${b.stdout()}\nB stderr:\n${b.stderr()}\nB checkpoint:\n${JSON.stringify(bCheckpoint)}`
      );
    } finally {
      await cleanupSignalProbeArtifacts(
        aMarkerPath,
        aRecords,
        aLeakFailures?.leakedTempRoots ?? [],
        aOwnerId
      );
      aCleanupComplete = true;
    }

    assert.ok(
      await pathExists(bTempRoot),
      `overlap A must not remove B's active temp root ${bTempRoot}`
    );
    assert.ok(
      Number.isInteger(b.child.pid) && isPidAlive(b.child.pid),
      `overlap B should remain alive after A cleanup\nB stdout:\n${b.stdout()}\nB stderr:\n${b.stderr()}`
    );

    try {
      b.child.kill("SIGTERM");
      const bResult = await waitForProbeChild(b.child, 30_000);
      bRecords = await readSignalProbeChildRecords(bMarkerPath);
      bLeakFailures = await collectSignalProbeLeaks({
        ownerId: bOwnerId,
        childRecords: bRecords,
        checkpointDetails: bCheckpoint.details ?? {}
      });

      assert.equal(
        bResult.code,
        143,
        `overlap B should exit 143\nstdout:\n${b.stdout()}\nstderr:\n${b.stderr()}`
      );
      assert.deepEqual(
        bLeakFailures.messages,
        [],
        `overlap B leaked state:\n${bLeakFailures.messages.join("\n")}\nstdout:\n${b.stdout()}\nstderr:\n${b.stderr()}`
      );
      assert.equal(await pathExists(bTempRoot), false, `overlap B should remove ${bTempRoot}`);
    } finally {
      await cleanupSignalProbeArtifacts(
        bMarkerPath,
        bRecords,
        bLeakFailures?.leakedTempRoots ?? [],
        bOwnerId
      );
      bCleanupComplete = true;
    }
  } finally {
    if (!aCleanupComplete) {
      await forceCleanupSignalProbeChild(
        a,
        aMarkerPath,
        aRecords,
        aLeakFailures?.leakedTempRoots ?? [],
        aOwnerId
      );
    }
    if (!bCleanupComplete) {
      await forceCleanupSignalProbeChild(
        b,
        bMarkerPath,
        bRecords,
        bLeakFailures?.leakedTempRoots ?? [],
        bOwnerId
      );
    }
  }
}

async function forceCleanupSignalProbeChild(
  probeChild,
  markerPath,
  records,
  leakedTempRoots,
  ownerId
) {
  if (probeChild?.child.exitCode === null && probeChild.child.signalCode === null) {
    terminateProcessGroup(probeChild.child, "SIGKILL");
    await Promise.race([
      waitForProbeChild(probeChild.child, 1_000).catch(() => undefined),
      delay(1_000)
    ]);
  }
  const cleanupRecords = records.length > 0 ? records : await readJsonlRecords(markerPath);
  await cleanupSignalProbeArtifacts(markerPath, cleanupRecords, leakedTempRoots, ownerId);
}

function spawnSignalProbeChild(checkpoint, markerPath, ownerId) {
  assertValidProbeOwnerId(ownerId);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      [probeOwnerEnvName]: ownerId,
      PATCHY_PACKED_CLI_E2E_SIGNAL_PROBE: checkpoint,
      PATCHY_PACKED_CLI_E2E_SIGNAL_PROBE_CHILDREN: markerPath
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  registerSpawnedChild(child);

  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  const events = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseSignalProbeEvent(line);
      if (!event) continue;
      events.push(event);
      for (const waiter of [...waiters]) waiter();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    waitForCheckpoint: (checkpointName, timeoutMs) =>
      waitForSignalProbeChildEvent(
        child,
        events,
        waiters,
        (event) => event.checkpoint === checkpointName,
        timeoutMs,
        () => ({ stdout, stderr })
      )
  };
}

async function waitForSignalProbeChildEvent(child, events, waiters, predicate, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolve) => {
      let timeout;
      const waiter = () => {
        clearTimeout(timeout);
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex !== -1) waiters.splice(waiterIndex, 1);
        resolve();
      };
      timeout = setTimeout(waiter, Math.min(100, Math.max(0, deadline - Date.now())));
      waiters.push(waiter);
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      const { stdout, stderr } = output();
      throw new Error(
        `signal probe child exited before expected checkpoint\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }
  }
  const { stdout, stderr } = output();
  terminateProcessGroup(child, "SIGKILL");
  throw new Error(
    `timed out waiting for signal probe checkpoint\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );
}

function parseSignalProbeEvent(line) {
  const prefix = "__PATCHY_SIGNAL_PROBE__";
  if (!line.startsWith(prefix)) return undefined;
  return JSON.parse(line.slice(prefix.length));
}

function parseLifecycleProbeEvent(line) {
  const prefix = "__PATCHY_LIFECYCLE_PROBE__";
  if (!line.startsWith(prefix)) return undefined;
  return JSON.parse(line.slice(prefix.length));
}

function parseOuterSignalProbeEvent(line) {
  const prefix = "__PATCHY_OUTER_SIGNAL_PROBE__";
  if (!line.startsWith(prefix)) return undefined;
  return JSON.parse(line.slice(prefix.length));
}

async function waitForProbeChild(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child, "SIGKILL");
  }, timeoutMs);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.ok(!timedOut, `probe child timed out after ${timeoutMs}ms`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function collectLifecycleProbeLeaks({ ownerId, records, events }) {
  assertValidProbeOwnerId(ownerId);
  await delay(300);
  const leakedTempRoots = await listOwnedPackedCliTempRoots(ownerId);
  const messages = [];
  if (leakedTempRoots.length > 0) {
    messages.push(`owned temp roots remained: ${leakedTempRoots.join(", ")}`);
  }

  const descendantEvents = events.filter((event) => event.type === "descendant-ready");
  for (const event of descendantEvents) {
    if (Number.isInteger(event.launcherPid) && isProcessGroupAlive(event.launcherPid)) {
      messages.push(`process group ${event.launcherPid} remained alive`);
    }
    if (Number.isInteger(event.descendantPid) && isPidAlive(event.descendantPid)) {
      messages.push(`descendant process ${event.descendantPid} remained alive`);
    }
    if (Number.isInteger(event.port) && (await isTcpPortOpen(event.port))) {
      messages.push(`descendant port ${event.port} remained open`);
    }
  }

  for (const record of records) {
    if (record.type === "cleanup-end" && record.tempRoot) {
      const tempRootName = path.basename(validateOwnedTempRootPath(ownerId, record.tempRoot));
      if (leakedTempRoots.includes(tempRootName)) {
        messages.push(`cleanup temp root remained: ${tempRootName}`);
      }
    }
  }

  return { messages, leakedTempRoots };
}

async function emergencyCleanupLifecycleProbe({
  ownerId,
  markerPath,
  records,
  events,
  leakedTempRoots
}) {
  assertValidProbeOwnerId(ownerId);
  for (const record of records) {
    if (Number.isInteger(record.pid)) {
      if (process.platform === "win32") {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      } else {
        terminatePosixProcessGroup(record.pid, "SIGKILL");
      }
    }
    if (Number.isInteger(record.descendantPid)) {
      try {
        process.kill(record.descendantPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  for (const event of events) {
    if (Number.isInteger(event.launcherPid) && process.platform !== "win32") {
      terminatePosixProcessGroup(event.launcherPid, "SIGKILL");
    }
    if (Number.isInteger(event.descendantPid)) {
      try {
        process.kill(event.descendantPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  const tempRootsToRemove = new Set();
  for (const record of records) {
    if (record.tempRoot) tempRootsToRemove.add(validateOwnedTempRootPath(ownerId, record.tempRoot));
  }
  for (const tempRootName of leakedTempRoots) {
    tempRootsToRemove.add(ownedTempRootPathFromName(ownerId, tempRootName));
  }
  for (const ownedTempRoot of tempRootsToRemove) {
    await rm(ownedTempRoot, { recursive: true, force: true });
  }
  await rm(markerPath, { force: true });
}

async function collectSignalProbeLeaks({ ownerId, childRecords, checkpointDetails }) {
  assertValidProbeOwnerId(ownerId);
  await delay(300);
  const leakedTempRoots = await listOwnedPackedCliTempRoots(ownerId);
  const messages = [];
  if (leakedTempRoots.length > 0) {
    messages.push(`owned temp roots remained: ${leakedTempRoots.join(", ")}`);
  }

  const knownTempRoots = ownedTempRootPathsFromRecords(ownerId, [
    ...childRecords,
    checkpointDetails
  ]);
  for (const knownTempRoot of knownTempRoots) {
    const tempRootName = path.basename(knownTempRoot);
    if (leakedTempRoots.includes(tempRootName) || (await pathExists(knownTempRoot))) {
      messages.push(`known temp root remained: ${tempRootName}`);
    }
  }

  const ports = new Set();
  if (checkpointDetails.publicBaseUrl) {
    ports.add(Number(new URL(checkpointDetails.publicBaseUrl).port));
  }
  for (const record of childRecords) {
    if (Number.isInteger(record.port)) ports.add(record.port);
    if (Number.isInteger(record.pid) && isProcessGroupAlive(record.pid)) {
      messages.push(`${record.type ?? "child"} process group ${record.pid} remained alive`);
    }
  }
  for (const port of ports) {
    if (await isTcpPortOpen(port)) messages.push(`server/sentinel port ${port} remained open`);
  }

  return { messages, leakedTempRoots };
}

async function cleanupSignalProbeArtifacts(markerPath, childRecords, leakedTempRoots, ownerId) {
  assertValidProbeOwnerId(ownerId);
  for (const record of childRecords) {
    if (Number.isInteger(record.pid)) {
      try {
        process.kill(process.platform === "win32" ? record.pid : -record.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  const tempRootsToRemove = new Set(ownedTempRootPathsFromRecords(ownerId, childRecords));
  for (const tempRootName of leakedTempRoots) {
    tempRootsToRemove.add(ownedTempRootPathFromName(ownerId, tempRootName));
  }
  for (const ownedTempRoot of tempRootsToRemove) {
    await rm(ownedTempRoot, { recursive: true, force: true });
  }
  await rm(markerPath, { force: true });
}

async function readSignalProbeChildRecords(markerPath) {
  return readJsonlRecords(markerPath);
}

async function readJsonlRecords(markerPath) {
  let raw;
  try {
    raw = await readFile(markerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runServerBindRaceRetryProbe({ objectDir }) {
  console.log("[lifecycle-probe] building real server for bind race probe");
  await run("pnpm", ["--filter", "@patchy/server...", "build"], { cwd: repoRoot });

  serverBindCollisionProbe = {
    armed: true,
    started: false,
    firstPort: undefined,
    hits: 0,
    server: undefined
  };

  try {
    portReservation = await reserveLoopbackPort();
    const firstPort = portReservation.port;
    const publicBaseUrl = `http://127.0.0.1:${firstPort}`;
    const startedServer = await startServer({ publicBaseUrl, objectDir });
    const readyBaseUrl = startedServer?.publicBaseUrl ?? publicBaseUrl;
    await waitForReady(`${readyBaseUrl}/healthz`);

    assert.equal(
      serverBindCollisionProbe.hits,
      0,
      "bind race probe accepted the collision service as server health"
    );
    assert.notEqual(
      Number(new URL(readyBaseUrl).port),
      serverBindCollisionProbe.firstPort,
      "bind race probe should retry on a newly reserved port"
    );
  } finally {
    await closeServerBindCollisionProbe();
  }
}

async function runMissingServerEntryNegativeControl({ objectDir }) {
  const missingServerEntry = path.join(
    tempRoot,
    "patchy-packed-cli-e2e-missing-server-entry-negative-control",
    "start.js"
  );
  portReservation = await reserveLoopbackPort();
  const publicBaseUrl = `http://127.0.0.1:${portReservation.port}`;
  const startedServer = await startServer({
    publicBaseUrl,
    objectDir,
    serverEntryPath: missingServerEntry
  });
  await waitForReady(`${startedServer.publicBaseUrl}/healthz`);
  throw new Error("missing server entry negative control unexpectedly reached readiness");
}

async function maybeStartServerBindCollisionProbe(publicBaseUrl) {
  if (!serverBindCollisionProbe?.armed || serverBindCollisionProbe.started) return;

  const port = Number(new URL(publicBaseUrl).port);
  serverBindCollisionProbe.started = true;
  serverBindCollisionProbe.firstPort = port;
  const collisionServer = createHttpServer((request, response) => {
    serverBindCollisionProbe.hits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, collision: true, url: request.url }));
  });
  serverBindCollisionProbe.server = collisionServer;

  await new Promise((resolve, reject) => {
    collisionServer.once("error", reject);
    collisionServer.listen({ host: "0.0.0.0", port, exclusive: true }, resolve);
  });
  console.log(
    `__PATCHY_LIFECYCLE_PROBE__${JSON.stringify({
      type: "bind-collision-service",
      port
    })}`
  );
}

async function closeServerBindCollisionProbe() {
  const collisionServer = serverBindCollisionProbe?.server;
  serverBindCollisionProbe = undefined;
  if (!collisionServer?.listening) return;
  await new Promise((resolve) => collisionServer.close(() => resolve()));
}

async function runTermOrphanedProcessGroupWorkload() {
  assert.ok(lifecycleProbe.markerPath, "term orphan lifecycle probe requires a marker path");
  const launcher = spawn(
    process.execPath,
    ["-e", termOrphanLauncherScript(), lifecycleProbe.markerPath],
    {
      cwd: repoRoot,
      env: sanitizedProcessEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
      shell: false
    }
  );
  const launcherLifecycle = registerSpawnedChild(launcher);
  launcherLifecycle.errorPromise.catch(() => {});

  let launcherStderr = "";
  launcher.stderr.setEncoding("utf8");
  launcher.stderr.on("data", (chunk) => {
    launcherStderr += chunk;
  });

  const descendant = await waitForJsonlRecord(
    lifecycleProbe.markerPath,
    (record) => record.type === "descendant-ready",
    5_000
  );
  console.log(
    `__PATCHY_LIFECYCLE_PROBE__${JSON.stringify({
      type: "descendant-ready",
      launcherPid: launcher.pid,
      descendantPid: descendant.pid,
      port: descendant.port,
      tempRootName: path.basename(tempRoot)
    })}`
  );
  assert.equal(launcherStderr, "");
  await cleanup();
}

function termOrphanLauncherScript() {
  const descendantScript = [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const marker = process.argv[1];",
    "process.on('SIGTERM', () => {});",
    "const server = net.createServer();",
    "server.listen(0, '127.0.0.1', () => {",
    "  fs.appendFileSync(marker, JSON.stringify({ type: 'descendant-ready', pid: process.pid, port: server.address().port }) + '\\n');",
    "});",
    "setInterval(() => {}, 1000);"
  ].join("\n");

  return [
    "const { spawn } = require('node:child_process');",
    "const marker = process.argv[1];",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}, marker], { stdio: 'ignore', detached: false });`,
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1000);"
  ].join("\n");
}

async function waitForJsonlRecord(markerPath, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = await readJsonlRecords(markerPath);
    const record = records.find(predicate);
    if (record) return record;
    await delay(50);
  }
  throw new Error(`timed out waiting for lifecycle probe record in ${markerPath}`);
}

async function runTimeoutOwnedTempRootWorkload() {
  assert.ok(lifecycleProbe.markerPath, "timeout owned root probe requires a marker path");
  const descendant = spawn(
    process.execPath,
    ["-e", timeoutOwnedTempRootDescendantScript(), lifecycleProbe.markerPath],
    {
      cwd: repoRoot,
      env: sanitizedProcessEnv(),
      detached: false,
      stdio: "ignore",
      shell: false
    }
  );
  registerSpawnedChild(descendant, { ownsProcessGroup: false });
  const descendantRecord = await waitForJsonlRecord(
    lifecycleProbe.markerPath,
    (record) => record.type === "timeout-descendant-ready",
    5_000
  );
  const readyRecord = {
    type: "timeout-owned-temp-root-ready",
    pid: process.pid,
    tempRoot,
    descendantPid: descendantRecord.pid,
    port: descendantRecord.port
  };
  await recordLifecycleProbe(readyRecord);
  console.log(`__PATCHY_LIFECYCLE_PROBE__${JSON.stringify(readyRecord)}`);
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await new Promise(() => {});
  } finally {
    clearInterval(keepAlive);
  }
}

function timeoutOwnedTempRootDescendantScript() {
  return [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const marker = process.argv[1];",
    "process.on('SIGTERM', () => {});",
    "const server = net.createServer();",
    "server.listen(0, '127.0.0.1', () => {",
    "  fs.appendFileSync(marker, JSON.stringify({ type: 'timeout-descendant-ready', pid: process.pid, port: server.address().port }) + '\\n');",
    "});",
    "setInterval(() => {}, 1000);"
  ].join("\n");
}

function createProbeOwnerId() {
  return assertValidProbeOwnerId(randomBytes(16).toString("hex"));
}

function readProbeOwnerIdFromEnv() {
  const ownerId = process.env[probeOwnerEnvName];
  if (!isProbeChildProcess()) return undefined;
  assert.ok(ownerId, `probe child requires ${probeOwnerEnvName}`);
  return assertValidProbeOwnerId(ownerId);
}

function isProbeChildProcess() {
  return (
    process.argv[2] !== "--signal-probes" &&
    process.argv[2] !== "--platform-probes" &&
    process.argv[2] !== "--lifecycle-probes" &&
    Boolean(signalProbe.target || lifecycleProbe.mode)
  );
}

function assertValidProbeOwnerId(ownerId) {
  assert.match(
    ownerId,
    /^[a-f0-9]{32}$/,
    `probe owner id must be 32 lowercase hex characters, got ${JSON.stringify(ownerId)}`
  );
  return ownerId;
}

function ownedTempRootPrefix(ownerId) {
  return `${packedCliTempRootBasePrefix}${assertValidProbeOwnerId(ownerId)}-`;
}

function validateOwnedTempRootName(ownerId, tempRootName) {
  assert.equal(
    path.basename(tempRootName),
    tempRootName,
    "owned temp root name must be a basename"
  );
  const prefix = ownedTempRootPrefix(ownerId);
  assert.ok(
    tempRootName.startsWith(prefix),
    `owned temp root ${tempRootName} must start with ${prefix}`
  );
  assert.match(
    tempRootName.slice(prefix.length),
    /^[A-Za-z0-9]+$/,
    `owned temp root ${tempRootName} has an invalid mkdtemp suffix`
  );
  return tempRootName;
}

function validateOwnedTempRootPath(ownerId, ownedTempRoot) {
  assert.equal(typeof ownedTempRoot, "string", "owned temp root path must be a string");
  assert.equal(
    path.dirname(ownedTempRoot),
    os.tmpdir(),
    `owned temp root must live directly under ${os.tmpdir()}`
  );
  validateOwnedTempRootName(ownerId, path.basename(ownedTempRoot));
  return ownedTempRoot;
}

function ownedTempRootPathFromName(ownerId, tempRootName) {
  return path.join(os.tmpdir(), validateOwnedTempRootName(ownerId, tempRootName));
}

function ownedTempRootPathsFromRecords(ownerId, records) {
  const ownedTempRoots = new Set();
  for (const record of records) {
    if (record?.tempRoot) {
      ownedTempRoots.add(validateOwnedTempRootPath(ownerId, record.tempRoot));
    }
  }
  return ownedTempRoots;
}

function probeTempRootDetails() {
  if (!probeOwnerId || !tempRoot) return {};
  return {
    ownerId: probeOwnerId,
    tempRoot,
    tempRootName: path.basename(validateOwnedTempRootPath(probeOwnerId, tempRoot))
  };
}

async function recordProbeTempRoot() {
  if (!probeOwnerId || !tempRoot) return;
  const record = { type: "temp-root", ...probeTempRootDetails() };
  await recordSignalProbeChild(record);
  await recordLifecycleProbe(record);
}

async function listOwnedPackedCliTempRoots(ownerId) {
  assertValidProbeOwnerId(ownerId);
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });
  const prefix = ownedTempRootPrefix(ownerId);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort();
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
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

async function signalProbeCheckpoint(checkpoint, details = {}) {
  if (signalProbe.target !== checkpoint) return;
  console.log(
    `__PATCHY_SIGNAL_PROBE__${JSON.stringify({ checkpoint, details, pid: process.pid })}`
  );
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (signal) => {
        if (resolved) return;
        resolved = true;
        signalProbe.observedSignal = signal;
        resolve();
      };
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => resolveOnce(signal));
      }
    });
  } finally {
    clearInterval(keepAlive);
  }
  throwIfSignalLatched();
}

async function recordSignalProbeChild(record) {
  if (!signalProbe.childMarkerPath) return;
  await appendFile(signalProbe.childMarkerPath, `${JSON.stringify(record)}\n`);
}

async function recordLifecycleProbe(record) {
  if (!lifecycleProbe.markerPath) return;
  await appendFile(lifecycleProbe.markerPath, `${JSON.stringify(record)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validHtml(title, marker) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${marker}</h1></body></html>`;
}

function parsePackResult(stdout) {
  const parsed = JSON.parse(stdout);
  assert.ok(parsed && typeof parsed === "object", `unexpected pnpm pack JSON: ${stdout}`);
  return Array.isArray(parsed) ? parsed : [parsed];
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

async function startServer({ publicBaseUrl, objectDir, serverEntryPath = serverEntry }) {
  let nextPublicBaseUrl = publicBaseUrl;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await startServerAttempt({
        publicBaseUrl: nextPublicBaseUrl,
        objectDir,
        serverEntryPath
      });
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

async function startServerAttempt({ publicBaseUrl, objectDir, serverEntryPath }) {
  throwIfSignalLatched();
  const serverArgs = [serverEntryPath];
  const injectsServerSpawnError = shouldInjectServerSpawnError(process.execPath, serverArgs);
  if (!injectsServerSpawnError) await assertServerEntryExists(serverEntryPath);
  throwIfSignalLatched();
  assert.ok(portReservation, "loopback port must be reserved before server launch");
  await new Promise((resolve, reject) => {
    portReservation.server.close((error) => (error ? reject(error) : resolve()));
  });
  portReservation = undefined;
  await maybeStartServerBindCollisionProbe(publicBaseUrl);
  throwIfSignalLatched();

  authTesting ??= await tsImport("../packages/auth/src/testing.ts", import.meta.url);

  const serverEnv = environment(
    {
      ...authTesting.clerkEnv(),
      PORT: new URL(publicBaseUrl).port,
      PATCHY_PUBLIC_BASE_URL: publicBaseUrl,
      PATCHY_MAX_HTML_BYTES: String(512 * 1024),
      DATABASE_URL: await startPostgres(),
      PATCHY_STORAGE_DIR: objectDir,
      PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE: "10000",
      PATCHY_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE: "10000"
    },
    [
      "CLERK_AUTHORIZED_PARTIES",
      "PATCHY_TRUST_PROXY",
      "AZURE_STORAGE_ACCOUNT",
      "AZURE_STORAGE_CONTAINER",
      "AZURE_STORAGE_CONNECTION_STRING"
    ]
  );

  throwIfSignalLatched();
  console.log(`[packed-cli-e2e] launching real server at ${publicBaseUrl}`);
  serverProcessFailure = undefined;
  serverReadyStdoutObserved = false;
  const serverInvocation = resolveSpawnInvocation(process.execPath, serverArgs, {
    cwd: repoRoot,
    env: serverEnv
  });
  let childStdout = "";
  let childStderr = "";
  let readyResolve;
  const readyLine = expectedServerReadyLine(publicBaseUrl);
  const readyPromise = new Promise((resolve) => {
    readyResolve = resolve;
  });
  serverProcess = spawn(serverInvocation.command, serverInvocation.args, {
    cwd: repoRoot,
    env: serverEnv,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  const serverLifecycle = registerSpawnedChild(serverProcess);
  serverLifecycle.errorPromise.catch((error) => {
    serverProcessFailure = error;
  });
  const serverRecord = {
    type: "server",
    pid: serverProcess.pid,
    port: Number(new URL(publicBaseUrl).port)
  };
  await recordSignalProbeChild(serverRecord);
  await recordLifecycleProbe(serverRecord);
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

async function assertCliFailureNoMutation({
  cliPath,
  args,
  cwd,
  env,
  cliStateDir,
  objectDir,
  expectAuthoritativeNonEmpty = false,
  expectEmptyCliState = false,
  sensitiveValues = [],
  stderr,
  exitCode
}) {
  const authoritativeBefore = await authoritativeSnapshot(objectDir);
  const cliStateBefore = await snapshotTree(cliStateDir);
  if (expectAuthoritativeNonEmpty) {
    assertAuthoritativeSnapshotNonEmpty(authoritativeBefore);
  }
  if (expectEmptyCliState) {
    assert.deepEqual(cliStateBefore, [], "expected dedicated CLI state to start empty");
  }
  const result = await runCli(cliPath, args, {
    cwd,
    env,
    allowFailure: true,
    sensitiveValues
  });
  // The ladder: 1 local, 2 rejected, 3 unreachable — the code says who has to act.
  assert.equal(result.code, exitCode, `expected exit ${exitCode}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, stderr);
  assert.deepEqual(
    await authoritativeSnapshot(objectDir),
    authoritativeBefore,
    "failed CLI invocation mutated server metadata or object storage"
  );
  assert.deepEqual(
    await snapshotTree(cliStateDir),
    expectEmptyCliState ? [] : cliStateBefore,
    expectEmptyCliState
      ? "failed CLI invocation created CLI state"
      : "failed CLI invocation mutated CLI state"
  );
  return result;
}

async function authoritativeSnapshot(objectDir) {
  return {
    metadata: JSON.stringify(await readMetadata()),
    objects: await snapshotTree(objectDir)
  };
}

function assertAuthoritativeSnapshotNonEmpty(snapshot) {
  const metadata = JSON.parse(snapshot.metadata);
  assert.ok(metadata.drafts.length > 0, "expected existing authoritative drafts before failure");
  assert.ok(snapshot.objects.length > 0, "expected existing authoritative objects before failure");
}

async function snapshotTree(rootDir) {
  const files = [];
  await visit(rootDir, "");
  return files;

  async function visit(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push([relativePath, await readFile(absolutePath, "utf8")]);
      } else {
        throw new Error(`unexpected non-file storage entry: ${absolutePath}`);
      }
    }
  }
}

function parseUpload(result) {
  const label = result.stdout.match(/^(Uploaded patch|Updated patch)$/m)?.[1];
  const publicUrl = result.stdout.match(/^URL: (.+)$/m)?.[1];
  const patchId = result.stdout.match(/^Patch ID: ([a-z0-9]{12})$/m)?.[1];
  const scope = result.stdout.match(/^Scope: (company|public)\b/m)?.[1];
  const versionNumber = Number(result.stdout.match(/^Version: (\d+)$/m)?.[1]);
  assert.ok(label, `missing upload label in CLI output:\n${result.stdout}`);
  assert.ok(publicUrl, `missing public URL in CLI output:\n${result.stdout}`);
  assert.ok(patchId, `missing patch ID in CLI output:\n${result.stdout}`);
  assert.ok(Number.isInteger(versionNumber), `missing version in CLI output:\n${result.stdout}`);
  assert.ok(scope, `missing sharing scope in CLI output:\n${result.stdout}`);
  return { label, publicUrl, patchId, versionNumber, scope };
}

async function fetchViewer(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  return { response, body: await response.text() };
}

function assertPublicViewer(viewer, { patchId, versionNumber, html }) {
  assert.equal(viewer.response.status, 200);
  assert.equal(viewer.response.headers.get("cache-control"), "public, max-age=60");
  assert.equal(viewer.response.headers.get("set-cookie"), null);
  assert.equal(
    viewer.response.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; " +
      "frame-src 'self' about:; base-uri 'none'; form-action 'none'"
  );
  assert.equal(viewer.response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(viewer.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(viewer.response.headers.get("x-robots-tag"), "noindex");
  assert.equal(viewer.response.headers.get("content-type"), "text/html");
  assert.equal(viewer.response.headers.get("www-authenticate"), null);
  assert.equal(viewer.response.headers.get("x-patchy-sign-in-url"), null);
  assert.ok(viewer.body.includes('sandbox=""'), "the patch must remain sandboxed");
  assert.ok(viewer.body.includes('referrerpolicy="no-referrer"'));
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
  assert.equal(viewer.response.headers.get("cache-control"), "private, no-store");
  assert.equal(viewer.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(viewer.response.headers.get("x-robots-tag"), "noindex");
  assert.equal(viewer.response.headers.get("content-type"), "text/html");
  assert.equal(viewer.response.headers.get("location"), null);
  assert.equal(viewer.response.headers.get("www-authenticate"), null);
  const signInUrl = viewer.response.headers.get("x-patchy-sign-in-url");
  assert.ok(signInUrl, "the door must advertise the browser sign-in URL");
  assert.equal(new URL(signInUrl).protocol, "https:");
  assert.equal(viewer.body.match(/<a\b/g)?.length, 1, "the door must offer one sign-in link");
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
  // this harness's own signal latch and cleanup in every process, probes
  // included. Only a process that starts Postgres pays that, and it takes the
  // handlers back out — `cleanup` stops Postgres itself.
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
          "SELECT id, patch_id, version_number, object_key, created_by_machine_token_id FROM patch_versions ORDER BY created_at"
        )
      ).map((row) => ({
        id: row.id,
        patchId: row.patch_id,
        versionNumber: row.version_number,
        objectKey: row.object_key,
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
  { patchId, expectedHtmlByVersion, companyId, ownerUserId, machineTokenId }
) {
  const draft = metadata.drafts.find((candidate) => candidate.id === patchId);
  assert.ok(draft, `metadata is missing draft ${patchId}`);
  assert.equal(draft.companyId, companyId);
  assert.equal(draft.ownerUserId, ownerUserId);
  assert.equal(draft.scope, "company");

  const versions = metadata.draftVersions
    .filter((version) => version.patchId === patchId)
    .sort((left, right) => left.versionNumber - right.versionNumber);
  assert.equal(versions.length, expectedHtmlByVersion.length);
  assert.equal(draft.currentVersionId, versions.at(-1).id);

  for (let index = 0; index < versions.length; index += 1) {
    const version = versions[index];
    assert.equal(version.versionNumber, index + 1);
    assert.equal(version.createdByMachineTokenId, machineTokenId);
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
  throwIfSignalLatched();
  const probeCommand = signalProbe.stubRunAfterSignal && signalProbe.observedSignal;
  const effectiveCommand = probeCommand ? process.execPath : command;
  const effectiveArgs = probeCommand
    ? [
        "-e",
        [
          "const fs = require('node:fs');",
          "const net = require('node:net');",
          "const marker = process.env.PATCHY_PACKED_CLI_E2E_SENTINEL_MARKER;",
          "const server = net.createServer();",
          "server.listen(0, '127.0.0.1', () => {",
          "  const port = server.address().port;",
          "  fs.appendFileSync(marker, JSON.stringify({ type: 'sentinel', pid: process.pid, port }) + '\\n');",
          "});",
          "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50));",
          "setInterval(() => {}, 1000);"
        ].join("\n")
      ]
    : args;
  const effectiveEnv = probeCommand
    ? {
        ...(options.env ?? sanitizedProcessEnv()),
        PATCHY_PACKED_CLI_E2E_SENTINEL_MARKER: signalProbe.childMarkerPath
      }
    : (options.env ?? sanitizedProcessEnv());
  const invocation = resolveSpawnInvocation(effectiveCommand, effectiveArgs, {
    cwd: options.cwd ?? repoRoot,
    env: effectiveEnv,
    platform: options.platform ?? process.platform
  });
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd ?? repoRoot,
    env: effectiveEnv,
    detached: process.platform !== "win32",
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
    if (process.platform !== "win32" && Number.isInteger(child.pid)) {
      terminatePosixProcessGroup(child.pid, "SIGKILL");
    }
  }, options.timeoutMs ?? 60_000);

  const result = await Promise.race([
    childLifecycle.errorPromise,
    childLifecycle.closePromise
  ]).finally(() => {
    clearTimeout(timeout);
    activeChildren.delete(child);
    releaseTrackedProcessGroupIfEmpty(child);
  });
  throwIfSignalLatched();

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

function resolveSpawnInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (shouldInjectServerSpawnError(command, args)) {
    return {
      command: path.join(os.tmpdir(), "patchy-packed-cli-e2e-missing-server-spawn"),
      args: []
    };
  }

  if (command === "npm") {
    return { command: process.execPath, args: [npmCliEntry, ...args] };
  }

  if (command === "pnpm" && platform === "win32") {
    const pnpmEntry = resolvePnpmJsEntry(env);
    return { command: process.execPath, args: [pnpmEntry, ...args] };
  }

  if (platform === "win32" && isPatchyBinPath(command)) {
    return {
      command: process.execPath,
      args: [installedPatchyJsForBin(command, platform), ...args]
    };
  }

  return { command, args };
}

function shouldInjectServerSpawnError(command, args) {
  return (
    lifecycleProbe.mode === "server-spawn-error" &&
    command === process.execPath &&
    args[0] === serverEntry
  );
}

function resolvePnpmJsEntry(env) {
  const entry = env.npm_execpath;
  assert.ok(
    entry && /(?:^|[\\/])pnpm(?:\.cjs|\.js)?$/i.test(entry),
    "Windows pnpm execution requires npm_execpath to point at pnpm's JavaScript entry"
  );
  assert.ok(
    !/\.cmd$/i.test(entry),
    "Windows pnpm execution must use pnpm's JavaScript entry, not a .cmd shim"
  );
  return entry;
}

function isPatchyBinPath(command) {
  return /[\\/]node_modules[\\/]\.bin[\\/]patchy(?:\.cmd)?$/i.test(command);
}

function installedPatchyJsForBin(command, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const binDir = pathApi.dirname(command);
  const nodeModulesDir = pathApi.dirname(binDir);
  return pathApi.join(nodeModulesDir, "@patchy", "cli", "dist", "index.js");
}

function installedCliBinPath(consumerDir) {
  return path.join(
    consumerDir,
    "node_modules/.bin",
    process.platform === "win32" ? "patchy.cmd" : "patchy"
  );
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

function registerSpawnedChild(child, options = {}) {
  const ownsProcessGroup = options.ownsProcessGroup ?? true;
  childProcessGroupOwnership.set(child, ownsProcessGroup);
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

function trackProcessGroup(child) {
  if (process.platform !== "win32" && Number.isInteger(child.pid) && childOwnsProcessGroup(child)) {
    trackedProcessGroups.add(child.pid);
  }
}

function releaseTrackedProcessGroupIfEmpty(child) {
  if (
    process.platform !== "win32" &&
    Number.isInteger(child.pid) &&
    childOwnsProcessGroup(child) &&
    !isProcessGroupAlive(child.pid)
  ) {
    trackedProcessGroups.delete(child.pid);
  }
}

function childOwnsProcessGroup(child) {
  return childProcessGroupOwnership.get(child) !== false;
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
    const targetPid =
      process.platform === "win32" || !childOwnsProcessGroup(child) ? child.pid : -child.pid;
    process.kill(targetPid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function terminateTrackedProcessGroups(signal) {
  if (process.platform === "win32") return;
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
    lifecycleProbe.cleanupCount += 1;
    await recordLifecycleProbe({
      type: "cleanup-start",
      count: lifecycleProbe.cleanupCount,
      tempRoot
    });
    if (portReservation) {
      await new Promise((resolve) => portReservation.server.close(() => resolve()));
      portReservation = undefined;
    }
    for (const child of activeChildren) terminateProcessGroup(child, "SIGTERM");
    terminateTrackedProcessGroups("SIGTERM");
    if (activeChildren.size > 0) {
      await Promise.race([
        Promise.allSettled([...activeChildren].map((child) => waitForClose(child))),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
    if (process.platform === "win32") {
      for (const child of activeChildren) terminateProcessGroup(child, "SIGKILL");
    } else {
      terminateTrackedProcessGroups("SIGKILL");
    }
    if (activeChildren.size > 0) {
      await Promise.race([
        Promise.allSettled([...activeChildren].map((child) => waitForClose(child))),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
    if (postgres) {
      await Promise.race([
        postgres.embedded.stop().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 15_000))
      ]);
      postgres = undefined;
    }
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    activeChildren.clear();
    trackedProcessGroups.clear();
    await recordLifecycleProbe({
      type: "cleanup-end",
      count: lifecycleProbe.cleanupCount,
      tempRoot
    });
  })();
  return cleanupPromise;
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
