/**
 * The contract, seen from outside: the bundled CLI as a child process against
 * a stub instance. Exit codes per the ladder, one-line stderr, the `--json`
 * shapes, the token never in argv or output, and the state dir's fail-closed
 * files. What the commands do between those edges is the commands' own tests.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as Struct from "effect/Struct";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { DEV_SEED } from "@patchy/auth/seed";
import { sha256 } from "@patchy/core";
import {
  CURRENT_RELEASE,
  type DeclarationMetadata,
  type Generated,
  GenerateRequest,
  ForceRequest,
  DescriptionRequest,
  MANIFEST_VERSION,
  PublishRequest,
  WIRE_VERSION
} from "@patchy/api";
import { generateClient } from "../../sdk/src/generateClient.js";
import { generate as generatePostgres } from "../../integrations/src/postgres/Generate.js";
import { starterFiles } from "./initProject.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageDir, "dist/index.js");
const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

afterAll(() => {
  for (const server of servers) server.close();
});

const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "patchy-cli-test-"));
  tempDirs.push(dir);
  return dir;
};

const pendingFile = (directory: string) => path.join(directory, readdirSync(directory)[0]!);

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

type Handler = (
  request: Recorded,
  respond: (status: number, body: unknown) => void,
  disconnect: () => void
) => void;

/** A stub instance: every request recorded, answered by `handler`. */
const stubInstance = async (
  handler: Handler,
  release = () => CURRENT_RELEASE,
  tarball?: Buffer
) => {
  const requests: Recorded[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const recorded: Recorded = {
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined
      };
      requests.push(recorded);
      const respond = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (recorded.url === "/sdk/patchy.tgz" && tarball) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(tarball);
        return;
      }
      if (recorded.url === "/api/release") {
        respond(200, {
          release: release(),
          package: { tarball: "/sdk/patchy.tgz", integrity: `sha512-${"A".repeat(86)}==` },
          manifestVersion: MANIFEST_VERSION,
          wireVersion: WIRE_VERSION
        });
        return;
      }
      handler(recorded, respond, () => response.destroy());
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
};

const publish = (
  status: 200 | 201,
  patchId: string,
  versionNumber: number,
  scope: "company" | "public" = "company",
  name = "page"
) => ({
  ok: true,
  patchId,
  versionId: `${patchId}-v${versionNumber}`,
  versionNumber,
  title: "Page",
  description: "",
  descriptionUpdatedAt: null,
  name,
  address: `http://instance.test/${DEV_SEED.companyHandle}/${name}`,
  publicUrl: `http://instance.test/${DEV_SEED.companyHandle}/${name}`,
  scope,
  tier: 0,
  schemaRevision: 0,
  provisioned: { tables: [], columns: [], indexes: [], stores: [] },
  unused: { tables: [], columns: [], indexes: [], stores: [] },
  warnings: status === 201 ? ["No <title> found."] : []
});

const identity = {
  user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
  company: { id: DEV_SEED.companyId, handle: DEV_SEED.companyHandle, name: DEV_SEED.companyName },
  role: DEV_SEED.role,
  machine: { id: DEV_SEED.tokenId, name: DEV_SEED.tokenName }
};

/** Publish fixtures still dispatch identity refusals explicitly through stubInstance. */
const stubPublishingInstance = (handler: Handler, release = () => CURRENT_RELEASE) =>
  stubInstance((request, respond, disconnect) => {
    if (request.url === "/api/me") return respond(200, identity);
    handler(request, respond, disconnect);
  }, release);

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stateDir: string;
}

/** Asynchronous on purpose: the stub instance answers from this same event loop. */
const runCli = (
  args: ReadonlyArray<string>,
  options: {
    stateDir?: string;
    env?: Record<string, string>;
    input?: string;
    terminalInput?: string;
    cwd?: string;
    onSpawn?: (child: ChildProcess) => void;
  } = {}
) =>
  new Promise<CliResult>((resolve, reject) => {
    const stateDir = options.stateDir ?? tempDir();
    const command = [process.execPath, cliPath, ...args];
    const terminal = options.terminalInput !== undefined;
    const child = spawn(
      terminal ? "script" : process.execPath,
      terminal
        ? [
            "-q",
            "-e",
            "-c",
            command.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" "),
            "/dev/null"
          ]
        : [cliPath, ...args],
      {
        cwd: options.cwd ?? stateDir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: stateDir,
          PATCHY_STATE_DIR: stateDir,
          ...options.env
        }
      }
    );
    let stdout = "";
    let stderr = "";
    let answered = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (terminal && !answered && stdout.includes("It will be kept for 30 days")) {
        answered = true;
        child.stdin.write(options.terminalInput!);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, stateDir }));
    if (!terminal) child.stdin.end(options.input ?? "");
    options.onSpawn?.(child);
  });

interface HeldRequest {
  readonly request: Recorded;
  readonly respond: (status: number, body: unknown) => void;
}

/** Hold a real HTTP request until the test explicitly answers it. */
const requestBarrier = () => {
  let entered!: (request: HeldRequest) => void;
  const reached = new Promise<HeldRequest>((resolve) => {
    entered = resolve;
  });
  const handler: Handler = (request, respond) => entered({ request, respond });
  return {
    handler,
    wait: (running: Promise<CliResult>) =>
      Promise.race([
        reached,
        running.then((result) => {
          throw new Error(`CLI exited before request barrier: ${result.stderr}`);
        })
      ])
  };
};

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const decodeGenerateRequest = Schema.decodeUnknownSync(GenerateRequest);
const decodeForceRequest = Schema.decodeUnknownSync(ForceRequest);
const decodeDescriptionRequest = Schema.decodeUnknownSync(DescriptionRequest);
const decodePackageFixture = Schema.decodeUnknownSync(
  Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
  }),
  { onExcessProperty: "preserve" }
);
const coreProjectSkills = ["patchy-files", "patchy-loop", "patchy-tables"];
const projectConfig =
  'import { defineConfig, table, t } from "patchy/config";\n\n' +
  'export default defineConfig({ name: "cli-project", tier: 1,\n' +
  '  tables: { notes: table("One note per id, with a title.", { title: t.text() }) }, files: {},\n' +
  "  uses: {}\n});\n";
const projectConnections = {
  connections: [
    {
      id: "conn-sales",
      handle: "sales-db",
      integration: "postgres",
      description: "Synthetic sales database",
      status: "connected",
      hint: "patchy add postgres/sales-db"
    },
    {
      id: "conn-archive",
      handle: "archive-db",
      integration: "postgres",
      description: "Historical sales database",
      status: "disconnected",
      reason: "not_connected",
      hint: "Ask an admin to reconnect archive-db at /company/connections."
    }
  ]
};
const projectSource = {
  id: "abcdefghijkl",
  name: "directory",
  address: "/company/directory",
  owner: { id: identity.user.id, name: identity.user.name, deactivated: false },
  mine: true,
  tier: 1,
  scope: "company",
  description: "Company directory",
  descriptionUpdatedAt: null,
  state: "live",
  retiredAt: null,
  deletedAt: null,
  purgeAt: null,
  currentVersion: 1,
  publishedAt: "2026-09-01T00:00:00.000Z",
  title: "Directory",
  inventory: {
    tables: [{ name: "people", description: "One person per id.", shared: true, declarable: true }],
    stores: []
  },
  reads: []
};

/** Only the instance metadata is stubbed: these are the shipped client generators. */
const generateProjectResponse = (body: unknown): typeof Generated.Type => {
  const { manifest } = decodeGenerateRequest(body);
  const files: Array<{ path: string; contents: string }> = [];
  const uses: Array<{
    alias: string;
    id: string;
    revision: number;
    declaration: (typeof GenerateRequest.Type)["manifest"]["uses"][string];
  }> = [];
  const postgres: Record<string, (typeof DeclarationMetadata.Type)["postgres"][string]> = {};
  const connections: Record<string, string> = {};
  const skills = new Set(coreProjectSkills);
  for (const [alias, declaration] of Object.entries(manifest.uses)) {
    if (declaration.kind !== "postgres") throw new Error("Unexpected fixture declaration.");
    const stamp = { ...declaration, id: "conn-sales", revision: 1 };
    const snapshot = {
      version: 1 as const,
      relations: [],
      enums: [],
      exclusions: []
    };
    postgres[alias] = { declaration: stamp, snapshot };
    const generated = generatePostgres(stamp, snapshot);
    files.push(
      { path: `patchy/_generated/uses/${alias}.ts`, contents: generated.client },
      { path: `patchy/_generated/context/${alias}.md`, contents: generated.context },
      { path: `fixtures/postgres-${declaration.handle}.sql`, contents: generated.fixture }
    );
    connections[alias] = `./uses/${alias}.js`;
    uses.push({ alias, id: stamp.id, revision: stamp.revision, declaration: stamp });
    skills.add("patchy-postgres");
  }
  files.push(
    { path: "patchy/_generated/client.ts", contents: generateClient({ connections }) },
    {
      path: "patchy/_generated/index.json",
      contents: JSON.stringify({
        release: CURRENT_RELEASE,
        manifestVersion: MANIFEST_VERSION,
        uses,
        skills: [...skills].sort()
      })
    }
  );
  for (const skill of [...skills].sort())
    files.push({
      path: `.agents/skills/${skill}/SKILL.md`,
      contents: readFileSync(path.join(packageDir, "../sdk/skills", skill, "SKILL.md"), "utf8")
    });
  return { ok: true, files, metadata: { postgres, shared: {} }, uses };
};

const projectHandler: Handler = (request, respond) => {
  if (request.url === "/api/me") return respond(200, identity);
  if (request.url.startsWith("/api/connections"))
    return respond(200, {
      ...projectConnections,
      ...(request.url.includes("all=true")
        ? { offered: [{ integration: "postgres", connected: true }] }
        : {})
    });
  if (["/api/patches/directory", "/api/patches/abcdefghijkl"].includes(request.url.split("?")[0]!))
    return respond(200, projectSource);
  if (request.url === "/api/sdk/generate")
    return respond(200, generateProjectResponse(request.body));
  respond(404, { ok: false, error: "Unexpected fixture route." });
};

const projectTree = (instance: string, source = projectConfig) => {
  const dir = tempDir();
  writeFileSync(
    path.join(dir, "patchy.json"),
    JSON.stringify({ instance, description: "Synthetic notes" })
  );
  writeFileSync(path.join(dir, "patchy.config.ts"), source);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "cli-project",
      private: true,
      type: "module",
      devDependencies: { patchy: `${instance}/sdk/patchy.tgz` }
    }) + "\n"
  );
  mkdirSync(path.join(dir, "node_modules"));
  symlinkSync(packageDir, path.join(dir, "node_modules/patchy"), "dir");
  return dir;
};

/** Real repo tools, linked from the checkout instead of reinstalling them for each scenario. */
const publishTree = (instance: string) => {
  const dir = projectTree(instance);
  for (const [file, source] of Object.entries(
    starterFiles({
      instance,
      name: "cli-project",
      tier: 1,
      purpose: "Synthetic notes",
      tarball: `${instance}/sdk/patchy.tgz`
    })
  )) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), source);
  }
  for (const name of ["typescript", "vite", "vite-plugin-singlefile", "@types/node"]) {
    const manifest =
      name === "vite-plugin-singlefile"
        ? path.join(packageDir, "node_modules/vite-plugin-singlefile/package.json")
        : require.resolve(`${name}/package.json`, {
            paths: [packageDir, path.dirname(require.resolve("vitest/package.json"))]
          });
    const destination = path.join(dir, "node_modules", name);
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(path.dirname(manifest), destination, "dir");
  }
  return dir;
};

const treeBytes = (root: string): Record<string, Buffer> => {
  const files: Record<string, Buffer> = {};
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files[path.relative(root, file)] = readFileSync(file);
    }
  };
  visit(root);
  return files;
};

/**
 * A loopback-only npm registry, packed from this checkout's actual dependencies.
 * No dependency, compiler, generated client or install executable is substituted.
 */
const localPackageRegistry = async () => {
  const dir = tempDir();
  const packages = new Map<
    string,
    { manifest: Record<string, unknown>; version: string; tarball: string }
  >();
  const seen = new Set<string>();
  const resolvePackage = (name: string, from: string): string => {
    const resolver = createRequire(from);
    try {
      return resolver.resolve(`${name}/package.json`);
    } catch {
      let current = path.dirname(resolver.resolve(name));
      while (current !== path.dirname(current)) {
        const candidate = path.join(current, "package.json");
        if (existsSync(candidate)) {
          const pkg = readJson(candidate);
          if (pkg !== null && typeof pkg === "object" && "name" in pkg && pkg.name === name)
            return candidate;
        }
        current = path.dirname(current);
      }
      throw new Error(`The offline CLI fixture needs the real installed package ${name}.`);
    }
  };
  const pack = async (file: string): Promise<void> => {
    file = realpathSync(file);
    if (seen.has(file)) return;
    seen.add(file);
    const manifest = decodePackageFixture(readJson(file));
    const tarball = path.join(dir, `${seen.size}.tgz`);
    packages.set(`${manifest.name}@${manifest.version}`, {
      manifest,
      version: manifest.version,
      tarball
    });
    let source = path.dirname(file);
    if (manifest.name.startsWith("@typescript/typescript-")) {
      const executable = path.join("lib", process.platform === "win32" ? "tsc.exe" : "tsc");
      const original = path.join(source, `${executable}.original`);
      if (existsSync(original)) {
        // New projects install Microsoft's compiler, not the checkout's Effect replacement.
        const staged = path.join(dir, `${seen.size}-native`);
        cpSync(source, staged, { recursive: true });
        copyFileSync(original, path.join(staged, executable));
        rmSync(path.join(staged, `${executable}.original`));
        rmSync(path.join(staged, `${executable}.sig`), { force: true });
        source = staged;
      }
    }
    await exec("tar", [
      "-czf",
      tarball,
      "--exclude=node_modules",
      "--transform=s,^\\.,package,",
      "-C",
      source,
      "."
    ]);
    for (const name of Object.keys(manifest.dependencies ?? {}))
      await pack(resolvePackage(name, file));
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      let optional: string;
      try {
        optional = resolvePackage(name, file);
      } catch {
        continue; // Other platforms' optional binaries are not installed in this checkout.
      }
      await pack(optional);
    }
  };
  for (const name of ["typescript", "vite-plugin-singlefile", "@types/node"])
    await pack(resolvePackage(name, import.meta.url));
  await pack(resolvePackage("vite", require.resolve("vitest/package.json")));
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "/").slice(1));
    const archive = [...packages.values()].find(
      (entry) => name === `tarballs/${path.basename(entry.tarball)}`
    );
    if (archive) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(readFileSync(archive.tarball));
      return;
    }
    const versions = [...packages.values()].filter((entry) => entry.manifest.name === name);
    response.setHeader("content-type", "application/json");
    if (!versions.length) {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "Package is not in the offline fixture." }));
      return;
    }
    response.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: versions[0]!.version },
        versions: Object.fromEntries(
          versions.map((entry) => [
            entry.version,
            {
              ...entry.manifest,
              dist: { tarball: `${url}/tarballs/${path.basename(entry.tarball)}` }
            }
          ])
        )
      })
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    npm_config_registry: url,
    npm_config_store_dir: path.join(dir, "store"),
    npm_config_cache: path.join(dir, "cache"),
    npm_config_optional: "false",
    npm_config_auto_install_peers: "false",
    npm_config_update_notifier: "false"
  };
};

const htmlFile = (dir: string, name: string, html: string) => {
  const file = path.join(dir, name);
  writeFileSync(file, html);
  return file;
};

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

const validHtml =
  "<!doctype html><html><head><title>Ok</title></head><body><p>hi</p></body></html>";

describe("built-ins", async () => {
  it("prints the bare version and help without touching the network", async () => {
    const version = await runCli(["--version"]);
    expect(version).toMatchObject({ status: 0, stdout: "0.0.1\n", stderr: "" });
    expect((await runCli(["--help"])).status).toBe(0);
  });

  it("does not retain upload as an alias", async () => {
    const result = await runCli(["upload", "page.html", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
  });
});

describe("the exit-code ladder", async () => {
  it("exits 130 on SIGINT, as Effect's interruption", async () => {
    const instance = await stubInstance(() => undefined);
    const child = spawn(process.execPath, [cliPath, "whoami", "--api-url", instance.url], {
      env: { PATH: process.env.PATH ?? "", PATCHY_STATE_DIR: tempDir(), PATCHY_API_TOKEN: "t" }
    });
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const poll = () => (instance.requests.length > 0 ? resolve() : setTimeout(poll, 20));
      poll();
    });
    child.kill("SIGINT");
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(status).toBe(130);
  });

  it("exits 1 when the caller can fix it: a file that fails validation", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "bad.html", "<!doctype html><title>x</title><script>1</script>");

    const text = await runCli(["validate", file], { stateDir: dir });
    expect(text.status).toBe(1);
    expect(text.stdout).toBe("");
    expect(text.stderr).toMatch(
      /^HTML failed Patchy Cloud validation:\n- Blocked <script> tag found\./
    );

    const json = await runCli(["validate", file, "--json"], { stateDir: dir });
    expect(json.status).toBe(1);
    expect(json.stdout).toBe("");
    expect(JSON.parse(json.stderr)).toMatchObject({ ok: false, kind: "local" });
  });

  it("exits 2 when the instance answered and said no: a rejected token", async () => {
    const instance = await stubInstance((_, respond) =>
      respond(401, { ok: false, error: "Missing or invalid API token." })
    );
    const result = await runCli(["whoami", "--api-url", instance.url, "--json"], {
      env: { PATCHY_API_TOKEN: "bad-token" }
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: "Missing or invalid API token.",
      kind: "rejected"
    });
    expect(result.stderr).not.toContain("bad-token");
  });

  it("exits 3 when there was no usable answer: a 5xx, or nothing listening", async () => {
    const instance = await stubInstance((_, respond) => respond(503, "<html>down</html>"));
    const down = await runCli(["whoami", "--api-url", instance.url], {
      env: { PATCHY_API_TOKEN: "token" }
    });
    expect(down.status).toBe(3);
    expect(down.stderr).toBe(
      `${instance.url} answered 503. Try again later, or tell the operator.\n`
    );

    const nobody = await runCli(["whoami", "--api-url", "http://127.0.0.1:1", "--json"], {
      env: { PATCHY_API_TOKEN: "token" }
    });
    expect(nobody.status).toBe(3);
    expect(JSON.parse(nobody.stderr)).toMatchObject({ ok: false, kind: "unreachable" });
  });
});

const pendingLogin = {
  deviceCode: "private-device-secret",
  userCode: "BCDF-GHJK",
  verificationUrl: "http://instance.test/login/device?code=BCDF-GHJK",
  verificationUrlBare: "http://instance.test/login/device",
  interval: 5,
  expiresAt: "2099-01-01T00:00:00.000Z"
};

describe("patchy login", () => {
  it("hands off without exposing the device secret and resumes the same login", async () => {
    const instance = await stubInstance((request, respond) => {
      if (request.url === "/api/login/device") {
        return respond(201, {
          ok: true,
          deviceCode: "private-device-secret",
          userCode: "BCDF-GHJK",
          verificationUrl: "http://instance.test/login/device?code=BCDF-GHJK",
          verificationUrlBare: "http://instance.test/login/device",
          interval: 5,
          expiresAt: "2099-01-01T00:00:00.000Z"
        });
      }
      respond(200, { ok: true, status: "pending" });
    });
    const options = { stateDir: tempDir(), env: { PATCHY_API_URL: instance.url } };
    const first = await runCli(["login", "--json"], options);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: "awaiting_confirmation",
      userCode: "BCDF-GHJK",
      next: "patchy login --complete BCDF-GHJK",
      notWaitingBecause: "--json"
    });
    expect(first.stdout).not.toContain("private-device-secret");
    const resumed = await runCli(["login", "--json"], options);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ userCode: "BCDF-GHJK" });
    expect(instance.requests.filter((r) => r.url === "/api/login/device")).toHaveLength(1);
    const pending = await runCli(["login", "--complete", "--wait", "0", "--json"], options);
    expect(pending.status).toBe(0);
    expect(JSON.parse(pending.stdout)).toMatchObject({
      status: "pending",
      next: "patchy login --complete BCDF-GHJK"
    });
  });

  it("keeps an explicit instance in next even when a worktree selects another instance", async () => {
    const instance = await stubInstance((request, respond) =>
      request.url === "/api/login/device"
        ? respond(201, { ok: true, ...pendingLogin })
        : respond(200, { ok: true, status: "pending" })
    );
    const worktree = tempDir();
    mkdirSync(path.join(worktree, ".local", "dev"), { recursive: true });
    writeFileSync(
      path.join(worktree, ".local", "dev", "env"),
      "PATCHY_API_URL=http://127.0.0.1:1\nPATCHY_API_TOKEN=seed\n"
    );
    const options = { stateDir: tempDir(), cwd: worktree };
    const first = await runCli(["login", "--api-url", instance.url, "--json"], options);
    expect(first.status).toBe(0);
    const next = JSON.parse(first.stdout).next as string;
    const resumed = await runCli(
      next.slice("patchy ".length).replaceAll("'", "").split(" ").concat("--wait", "0", "--json"),
      options
    );
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      status: "pending",
      userCode: pendingLogin.userCode
    });
    expect(instance.requests.at(-1)?.url).toBe("/api/login/device/token");
    const logout = await runCli(["logout", "--api-url", instance.url, "--json"], options);
    expect(logout.status).toBe(0);
    expect(JSON.parse(logout.stdout)).toMatchObject({
      warnings: ["This worktree's dev instance still publishes with its seeded key"]
    });
  });

  it("refuses a foreign code without polling or losing the live handoff", async () => {
    const instance = await stubInstance((_, respond) => respond(500, {}));
    const dir = tempDir();
    const saved = { hosts: { [instance.url]: pendingLogin } };
    writeFileSync(path.join(dir, "device-login.json"), JSON.stringify(saved));
    const result = await runCli(["login", "--complete", "XXXX-XXXX", "--json"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url }
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      kind: "local",
      error: expect.stringContaining(`has code ${pendingLogin.userCode}, not XXXX-XXXX`)
    });
    expect(instance.requests).toHaveLength(0);
    expect(readJson(path.join(dir, "device-login.json"))).toEqual(saved);
  });

  it.each([
    ["denied", "The login was denied in the browser. Nothing was saved. Run: patchy login"],
    [
      "expired",
      "The login expired before it was confirmed (codes last ten minutes). Run: patchy login"
    ],
    ["unknown", null]
  ])(
    "reports the instance's %s answer even after local expiry, preserving the old key",
    async (code, copy) => {
      const instance = await stubInstance((_, respond) =>
        respond(410, { ok: false, error: "Gone", code })
      );
      const dir = tempDir();
      writeFileSync(
        path.join(dir, "device-login.json"),
        JSON.stringify({
          hosts: { [instance.url]: { ...pendingLogin, expiresAt: "2000-01-01T00:00:00.000Z" } }
        })
      );
      const credential = {
        hosts: { [instance.url]: { token: "previous-key", source: "auth-set" } }
      };
      writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(credential));
      const result = await runCli(["login", "--complete", "--json"], {
        stateDir: dir,
        env: { PATCHY_API_URL: instance.url }
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr)).toEqual({
        ok: false,
        kind: "rejected",
        error:
          copy ??
          `No login is pending for code ${pendingLogin.userCode} on ${instance.url}; it may already have been reported. Run: patchy login`
      });
      expect(instance.requests).toHaveLength(1);
      expect(readJson(path.join(dir, "device-login.json"))).toEqual({ hosts: {} });
      expect(readJson(path.join(dir, "credentials.json"))).toEqual(credential);
    }
  );

  it.each([
    { token: undefined, json: true },
    { token: "", json: true },
    { token: "environment-key", json: true },
    { token: "environment-key", json: false }
  ])(
    "reports a saved login and any environment override ($token, json=$json)",
    async ({ token, json }) => {
      const instance = await stubInstance((request, respond) =>
        request.url === "/api/login/device/token"
          ? respond(200, {
              ok: true,
              status: "complete",
              token: "one-time-key",
              machine: identity.machine,
              company: { handle: identity.company.handle, name: identity.company.name },
              user: { email: identity.user.email },
              expiresAt: "2099-01-01T00:00:00.000Z"
            })
          : respond(200, identity)
      );
      const dir = tempDir();
      writeFileSync(
        path.join(dir, "device-login.json"),
        JSON.stringify({ hosts: { [instance.url]: pendingLogin } })
      );
      const options = {
        stateDir: dir,
        env: token === undefined ? {} : { PATCHY_API_TOKEN: token }
      };
      const warnings = token
        ? ["Login saved. PATCHY_API_TOKEN is still set and takes precedence over this login."]
        : [];
      const result = await runCli(
        ["login", "--complete", "--api-url", instance.url, ...(json ? ["--json"] : [])],
        options
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      if (json)
        expect(JSON.parse(result.stdout)).toEqual({
          ok: true,
          status: "logged_in",
          instanceUrl: instance.url,
          company: { handle: identity.company.handle, name: identity.company.name },
          user: { email: identity.user.email },
          machine: identity.machine,
          credentialsPath: path.join(dir, "credentials.json"),
          warnings
        });
      else expect(result.stdout).toContain(warnings[0]);
      expect(instance.requests.map((r) => r.url)).toEqual(["/api/login/device/token"]);
      expect(readJson(path.join(dir, "credentials.json"))).toMatchObject({
        hosts: { [instance.url]: { token: "one-time-key", source: "login" } }
      });
      expect(result.stdout + result.stderr).not.toContain("environment-key");
      expect(result.stdout + result.stderr).not.toContain("one-time-key");
      expect(JSON.parse((await runCli(["status"], options)).stdout)).toMatchObject({
        instanceUrl: instance.url,
        hasToken: true,
        tokenSource: token ? null : "login"
      });
      expect((await runCli(["whoami", "--json"], options)).status).toBe(0);
      expect(instance.requests.at(-1)?.authorization).toBe(`Bearer ${token || "one-time-key"}`);
      expect(readJson(path.join(dir, "device-login.json"))).toEqual({ hosts: {} });
    }
  );
});

describe("patchy logout", () => {
  it("forgets local state before a courtesy refusal and leaves environment and other instances alone", async () => {
    const dir = tempDir();
    const other = { token: "other-key", source: "auth-set" };
    const instance = await stubInstance((request, respond) => {
      expect(request.authorization).toBe("Bearer stored-key");
      expect(readJson(path.join(dir, "credentials.json"))).toEqual({
        hosts: { "http://other.test": other }
      });
      expect(readJson(path.join(dir, "device-login.json"))).toEqual({ hosts: {} });
      respond(401, { ok: false, error: "Missing or invalid API token." });
    });
    writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({
        hosts: {
          [instance.url]: { token: "stored-key", source: "auth-set" },
          "http://other.test": other
        }
      })
    );
    writeFileSync(
      path.join(dir, "device-login.json"),
      JSON.stringify({ hosts: { [instance.url]: pendingLogin } })
    );
    const options = {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "env-key" }
    };
    const result = await runCli(["logout", "--json"], options);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      revoked: true,
      warnings: [expect.stringContaining("PATCHY_API_TOKEN")]
    });
    expect(result.stdout).not.toContain("stored-key");
    expect(JSON.parse((await runCli(["status"], options)).stdout)).toMatchObject({
      hasToken: true,
      tokenSource: null
    });
  });

  it("succeeds locally when revocation is unreachable, and whoami then requires login", async () => {
    const dir = tempDir();
    const url = "http://127.0.0.1:1";
    writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({ hosts: { [url]: { token: "stored-key" } } })
    );
    writeFileSync(
      path.join(dir, "device-login.json"),
      JSON.stringify({ hosts: { [url]: pendingLogin } })
    );
    const options = { stateDir: dir, env: { PATCHY_API_URL: url } };
    const result = await runCli(["logout", "--json"], options);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      instanceUrl: url,
      revoked: false,
      warnings: [
        "Logged out on this machine. The key could not be revoked; it expires on its own after 30 idle days, or revoke it now on Your machines."
      ]
    });
    const whoami = await runCli(["whoami", "--json"], options);
    expect(whoami.status).toBe(1);
    expect(JSON.parse(whoami.stderr)).toMatchObject({
      kind: "local",
      error: expect.stringContaining("Run: patchy login")
    });
    expect(readJson(path.join(dir, "device-login.json"))).toEqual({ hosts: {} });
  });
});

describe("patchy auth set", async () => {
  it("saves keys per resolved instance without echoing them", async () => {
    const instance = await stubInstance((_, respond) => respond(500, {}));
    const result = await runCli(["auth", "set", "--api-url", instance.url, "--token-stdin"], {
      input: "pp_secret_one\n"
    });
    expect(result).toMatchObject({
      status: 0,
      stdout: expect.not.stringContaining("pp_secret_one"),
      stderr: ""
    });
    expect(readJson(path.join(result.stateDir, "credentials.json"))).toMatchObject({
      hosts: { [instance.url]: { token: "pp_secret_one", source: "auth-set" } }
    });
    expect(readJson(path.join(result.stateDir, "config.json"))).toEqual({
      apiUrl: instance.url
    });
    expect(instance.requests).toHaveLength(0);

    // A second instance sits beside the first; neither disturbs the other.
    const second = await runCli(["auth", "set", "--token-stdin", "--json"], {
      stateDir: result.stateDir,
      env: { PATCHY_API_URL: "http://two.test" },
      input: "pp_secret_two"
    });
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({ ok: true, instanceUrl: "http://two.test" });
    const hosts = (
      readJson(path.join(result.stateDir, "credentials.json")) as {
        hosts: Record<string, { token: string }>;
      }
    ).hosts;
    expect(Object.keys(hosts).sort()).toEqual([instance.url, "http://two.test"].sort());
  });

  it("rejects empty and multi-line input, and a prompt with no terminal", async () => {
    for (const [input, message] of [
      ["\n", "API token cannot be empty."],
      ["a\nb\n", "API token must be provided as a single line."],
      [" a \n", "API token cannot begin or end with whitespace."]
    ]) {
      const result = await runCli(["auth", "set", "--token-stdin"], { input });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`${message}\n`);
    }
    const prompt = await runCli(["auth", "set"], { input: "" });
    expect(prompt.status).toBe(1);
    expect(prompt.stderr).toMatch(/^Interactive token entry requires a terminal\./);
  });

  it("fails closed on a credentials file in the retired single-instance format", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ apiToken: "old" }));
    const result = await runCli(["auth", "set", "--token-stdin"], {
      stateDir: dir,
      input: "new\n"
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/retired single-instance format/);
    expect(readJson(path.join(dir, "credentials.json"))).toEqual({ apiToken: "old" });
  });
});

describe("patchy whoami", async () => {
  it("prints the identity as text or as the wire document", async () => {
    const instance = await stubInstance((_, respond) => respond(200, identity));
    const dir = tempDir();
    await runCli(["auth", "set", "--token-stdin", "--api-url", instance.url], {
      stateDir: dir,
      input: "pp_stored\n"
    });

    const text = await runCli(["whoami"], { stateDir: dir });
    expect(text).toMatchObject({
      status: 0,
      stdout: `User: ${DEV_SEED.userName} (${DEV_SEED.email})\nCompany: ${DEV_SEED.companyName} (${DEV_SEED.companyHandle})\nRole: ${DEV_SEED.role}\nMachine: ${DEV_SEED.tokenName} (${DEV_SEED.tokenId})\n`,
      stderr: ""
    });
    expect(instance.requests[0]).toMatchObject({
      url: "/api/me",
      authorization: "Bearer pp_stored"
    });

    const json = await runCli(["whoami", "--json"], { stateDir: dir });
    expect(json.status).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual(identity);
  });
});

describe("commands without a publishing key", () => {
  it.each(["whoami", "publish", "delete", "share"])(
    "refuses %s locally without a request",
    async (command) => {
      const instance = await stubInstance((_, respond) => respond(200, identity));
      const dir = tempDir();
      const target =
        command === "publish"
          ? [htmlFile(dir, "page.html", validHtml)]
          : command === "delete"
            ? ["--patch", "abcdefghijkl"]
            : command === "share"
              ? ["--patch", "abcdefghijkl", "public"]
              : [];
      const result = await runCli([command, ...target, "--api-url", instance.url, "--json"], {
        stateDir: dir
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        kind: "local"
      });
      expect(instance.requests).toHaveLength(0);
    }
  );
});

describe("patchy validate", async () => {
  it("passes a safe document, with warnings on stderr in text mode and in the document under --json", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "untitled.html", "<!doctype html><p>hi</p>");
    const text = await runCli(["validate", file], { stateDir: dir });
    expect(text).toMatchObject({ status: 0, stdout: "HTML passed Patchy Cloud validation.\n" });
    expect(text.stderr).toMatch(/^Warning: /);

    const json = await runCli(["validate", file, "--json"], { stateDir: dir });
    expect(json.status).toBe(0);
    expect(json.stderr).toBe("");
    const document = JSON.parse(json.stdout) as { ok: boolean; warnings: string[] };
    expect(document.ok).toBe(true);
    expect(document.warnings.length).toBeGreaterThan(0);
  });
});

describe("patchy publish", async () => {
  it.each([
    { status: 401, route: "/api/me", body: { ok: false, error: "Missing or invalid API token." } },
    {
      status: 401,
      route: "/api/publish",
      body: { ok: false, error: "Missing or invalid API token." }
    },
    {
      status: 429,
      route: "/api/publish",
      body: { ok: false, code: "rate_limited", error: "Slow down.", retryAfterSeconds: 60 }
    },
    {
      status: 403,
      route: "/api/publish",
      body: { ok: false, code: "live_patch_quota_exceeded", error: "Quota reached.", quota: 1 }
    },
    {
      status: 422,
      route: "/api/publish",
      body: { ok: false, code: "unknown_admission_refusal", error: "Try later." }
    },
    { status: 400, route: "/api/publish", body: "undecodable admission refusal" }
  ])(
    "recovers a legacy receipt through $status on $route and same-owner token rotation",
    async ({ status, route, body }) => {
      const dir = tempDir();
      const file = htmlFile(dir, "page.html", validHtml);
      let phase: "lost" | "refused" | "recovered" = "lost";
      const response = Struct.omit(publish(201, "abcdefghijkl", 1), [
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

  it.each([
    { status: 422, code: "release_mismatch" },
    { status: 422, code: "patch_not_openable" },
    { status: 409, code: "publish_key_conflict" },
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
  }, 30_000); // Six real CLI processes exercise the complete credential-precedence sequence.

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
    { args: ["public"] },
    { args: ["page.html"] },
    { args: ["--patch", "abcdefghijkl"] },
    { args: ["page.html", "private"] },
    { args: ["--patch", "abcdefghijkl", "private"] },
    { args: ["page.html", "public", "--patch", "abcdefghijkl"] },
    { args: ["page.html", "public", "extra"] }
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
    "reports $verb in text and JSON using repo, file and explicit targets",
    async ({ verb, args, method, suffix, response, text }) => {
      const instance = await stubInstance((request, respond) => {
        if (request.method !== method || request.url !== `/api/patches/${patchId}${suffix}`)
          return respond(404, { ok: false, error: "Patch not found." });
        respond(200, response);
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
      const options = {
        cwd: dir,
        stateDir: dir,
        env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
      };
      for (const target of ["repo", "file", "explicit"]) {
        writeFileSync(path.join(dir, "patches.json"), JSON.stringify(cache));
        const selected =
          target === "explicit"
            ? [...args, "--patch", patchId]
            : target === "file"
              ? verb === "describe"
                ? [file, ...args]
                : [...args, file]
              : args;
        const result = await runCli(
          [verb, ...selected, ...(target === "repo" ? [] : ["--json"])],
          options
        );
        expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
        if (target === "repo") expect(result.stdout).toContain(text);
        else expect(JSON.parse(result.stdout)).toEqual(response);
        if (verb !== "delete") expect(readJson(path.join(dir, "patches.json"))).toEqual(cache);
      }
      expect(readJson(path.join(dir, "patchy.json"))).toEqual(
        verb === "describe"
          ? {
              ...config,
              description: "A useful tool",
              descriptionSyncedAt: "2026-09-15T00:00:00.000Z"
            }
          : config
      );
    }
  );

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
      verb: "rollback",
      args: ["99"],
      status: 422,
      code: "version_unavailable",
      fields: {},
      text: "refused"
    },
    {
      verb: "describe",
      args: ["New description"],
      status: 409,
      code: "wrong_state",
      fields: { state: "deleted" },
      text: "deleted"
    },
    {
      verb: "describe",
      args: ["New description"],
      status: 422,
      code: "invalid_description",
      fields: {},
      text: "refused"
    },
    ...cases.map(({ verb, args }) => ({
      verb,
      args,
      status: 403,
      code: "not_owner",
      fields: { owner },
      text: "Sam"
    }))
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

  it.each(cases)(
    "refuses conflicting and unpublished $verb targets locally",
    async ({ verb, args }) => {
      const instance = await stubInstance((_, respond) => respond(500, {}));
      const dir = projectTree(instance.url);
      const options = {
        cwd: dir,
        env: { PATCHY_API_TOKEN: "pp_owner", PATCHY_API_URL: instance.url }
      };
      const conflicting = verb === "describe" ? ["page.html", ...args] : [...args, "page.html"];
      for (const selected of [args, [...conflicting, "--patch", patchId]]) {
        const result = await runCli([verb, ...selected, "--json"], options);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stderr)).toMatchObject({ kind: "local" });
      }
      expect(instance.requests).toEqual([]);
    }
  );

  it("refuses empty description text, controls and overlong text locally", async () => {
    const instance = await stubInstance((request, respond) =>
      respond(200, {
        ok: true,
        patchId,
        description: decodeDescriptionRequest(request.body).description,
        descriptionUpdatedAt: null
      })
    );
    const options = { env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" } };
    for (const args of [
      [],
      [""],
      [" \n "],
      ["text\u0007"],
      ["x".repeat(501)],
      ["page.html", "text", "--clear"]
    ]) {
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
    for (const description of ["  ", "x".repeat(501), "bad\u0007"]) {
      const result = await runCli(
        ["publish", file, "--description", description, "--json"],
        options
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "invalid_description",
        kind: "local"
      });
    }
    expect(instance.requests.every((request) => request.url === "/api/me")).toBe(true);
  });

  it.each([
    {
      status: 403,
      code: "not_owner",
      fields: { owner: { id: "other", name: "Sam" } },
      text: "Sam"
    },
    { status: 409, code: "patch_retired", fields: {}, text: "Restore" },
    {
      status: 409,
      code: "patch_deleted",
      fields: { purgeAt: "2026-10-15T00:00:00.000Z" },
      text: "2026-10-15"
    },
    {
      status: 409,
      code: "has_dependants",
      fields: {
        dependants: [
          { patchId: "mnopqrstuvwx", name: "reader", owner: { id: "other", name: "Sam" } }
        ]
      },
      text: "reader"
    },
    { status: 422, code: "reserved_name", fields: {}, text: "Refused" }
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
      for (const json of [false, true]) {
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
          [
            "publish",
            "--description",
            "ignored during recovery",
            "--force",
            ...(json ? ["--json"] : [])
          ],
          { cwd: dir, env: { PATCHY_API_TOKEN: "pp_owner" } }
        );
        expect(result.status).toBe(2);
        const message = json ? JSON.parse(result.stderr).error : result.stderr;
        expect(message).toContain(text);
        expect(message).not.toMatch(/new patch|--new|Remove patch/i);
        if (json)
          expect(JSON.parse(result.stderr)).toMatchObject({ kind: "rejected", code, ...fields });
        expect(existsSync(attemptPath)).toBe(false);
        expect(readFileSync(repoFile, "utf8")).toBe(repo);
      }
      expect(instance.requests.map((request) => request.url)).toEqual([
        "/api/me",
        "/api/publish",
        "/api/me",
        "/api/publish"
      ]);
    }
  );
});

describe("repo description sync and change notices", () => {
  it("pulls only newer cloud descriptions on refresh, then publishes the pulled text and records its stamp", async () => {
    let cloud = {
      description: "Portal description",
      descriptionUpdatedAt: "2026-09-15T00:00:00.000Z"
    };
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/patches/abcdefghijkl?state=all")
        return respond(200, { ...projectSource, ...cloud });
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
    const packageBefore = readFileSync(path.join(dir, "package.json"));
    const repoFile = path.join(dir, "patchy.json");
    writeFileSync(
      repoFile,
      JSON.stringify({
        instance: instance.url,
        patch: "abcdefghijkl",
        description: "Replaced local text",
        descriptionSyncedAt: "2026-09-14T00:00:00.000Z",
        authorField: 7
      })
    );
    const options = { cwd: dir, env: { PATCHY_API_TOKEN: "pp_owner" } };
    const refreshed = await runCli(["refresh"], options);
    expect(refreshed.status, refreshed.stderr).toBe(0);
    expect(refreshed.stdout).toContain(
      "The description was changed in the portal to 'Portal description'; check it"
    );
    expect(refreshed.stdout).toContain("Replaced local text");
    expect(readJson(repoFile)).toEqual({
      instance: instance.url,
      patch: "abcdefghijkl",
      description: cloud.description,
      descriptionSyncedAt: cloud.descriptionUpdatedAt,
      authorField: 7
    });
    writeFileSync(
      repoFile,
      JSON.stringify({
        instance: instance.url,
        patch: "abcdefghijkl",
        description: "Local edit",
        descriptionSyncedAt: cloud.descriptionUpdatedAt,
        authorField: 7
      })
    );
    const local = await runCli(["refresh", "--json"], options);
    expect(local).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(local.stdout).warnings).toEqual([]);
    expect(readJson(repoFile)).toMatchObject({ description: "Local edit" });
    cloud = { description: "New portal text", descriptionUpdatedAt: "2026-09-16T00:00:00.000Z" };
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
    expect(readFileSync(path.join(dir, "package.json"))).toEqual(packageBefore);
  }, 30_000);

  it("carries definition-only reminders through refresh and publish without blocking either command", async () => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish")
        return respond(201, { ...publish(201, "abcdefghijkl", 1), tier: 1 });
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const config = path.join(dir, "patchy.config.ts");
    const original = readFileSync(config, "utf8");
    const options = { cwd: dir, env: { PATCHY_API_TOKEN: "pp_owner" } };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    writeFileSync(
      config,
      original.replace("title: t.text()", "title: t.text(), extra: t.text().optional()")
    );
    const published = await runCli(["publish", "--json"], options);
    expect(published, published.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(published.stdout).warnings).toContainEqual(
      expect.stringContaining("Table `notes` changed since its last generation")
    );
    writeFileSync(
      config,
      original.replace(
        "title: t.text()",
        "title: t.text(), extra: t.text().optional(), other: t.text().optional()"
      )
    );
    const refreshed = await runCli(["refresh", "--json"], options);
    expect(refreshed, refreshed.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(refreshed.stdout).warnings).toContainEqual(
      expect.stringContaining("Table `notes` changed since its last generation")
    );
    const unchanged = await runCli(["refresh", "--json"], options);
    expect(JSON.parse(unchanged.stdout).warnings).toEqual([]);
    writeFileSync(
      config,
      original
        .replace(
          "title: t.text()",
          "title: t.text(), extra: t.text().optional(), other: t.text().optional(), another: t.text().optional()"
        )
        .replace("One note", "A revised note")
    );
    const described = await runCli(["refresh", "--json"], options);
    expect(described.status, described.stderr).toBe(0);
    expect(JSON.parse(described.stdout).warnings).toEqual([]);
  }, 30_000);

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
  }, 30_000);

  it.each([
    ["src/main.ts", "const title: string = 42;", "Typecheck"],
    [
      "vite.config.ts",
      'throw new Error("synthetic build failure"); export default {};',
      "Vite build"
    ]
  ])(
    "reports discovered notices when %s fails before sending",
    async (file, source, stage) => {
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
      writeFileSync(path.join(dir, file), source);
      const failed = await runCli(["publish", "--json"], options);
      expect(failed).toMatchObject({ status: 1, stdout: "" });
      expect(JSON.parse(failed.stderr)).toMatchObject({
        ok: false,
        kind: "local",
        error: expect.stringContaining(stage),
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
    },
    30_000
  );

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
    expect(JSON.parse(refused.stderr)).toEqual({
      ok: false,
      error:
        "Other live patches read these tables.\n- mnopqrstuvwx reader (Sam)\nAsk the person you are working for before forcing.",
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
  }, 30_000);

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
  }, 30_000);
});

describe("patchy status", async () => {
  it("reports local state only, naming which link chose the instance", async () => {
    const dir = tempDir();
    const fresh = JSON.parse((await runCli(["status"], { stateDir: dir })).stdout);
    expect(fresh).toEqual({
      instanceUrl: "http://localhost:3000",
      instanceSource: "default",
      hasToken: false,
      tokenSource: null,
      stateDir: dir,
      hasDefaultStyle: false,
      cliVersion: "0.0.1"
    });

    // A worktree with a running dev instance is found from any directory
    // below it, and its seeded token counts as a token from the environment.
    const worktree = path.join(dir, "worktree");
    mkdirSync(path.join(worktree, ".local", "dev"), { recursive: true });
    mkdirSync(path.join(worktree, "deep", "er"), { recursive: true });
    writeFileSync(
      path.join(worktree, ".local", "dev", "env"),
      `PATCHY_API_URL=http://127.0.0.1:45678\nPATCHY_API_TOKEN=${DEV_SEED.token}\n`
    );
    writeFileSync(path.join(dir, "style.md"), "# style");
    const dev = JSON.parse(
      (
        await runCli(["status", "--json"], {
          stateDir: dir,
          cwd: path.join(worktree, "deep", "er")
        })
      ).stdout
    );
    expect(dev).toMatchObject({
      instanceUrl: "http://127.0.0.1:45678",
      instanceSource: "dev-env",
      hasToken: true,
      tokenSource: null,
      hasDefaultStyle: true
    });

    // Corrupt credentials are "no token we can vouch for", not an error.
    writeFileSync(path.join(dir, "credentials.json"), "not json");
    const unreadable = await runCli(["status"], { stateDir: dir });
    expect(unreadable.status).toBe(0);
    expect(JSON.parse(unreadable.stdout)).toMatchObject({ hasToken: false, tokenSource: null });
  });
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
            declarable: false,
            reason: "not_shareable",
            hint: "Not shareable yet."
          }
        ]
      },
      reads: [{ alias: "old", patchId: "zyxwvutsrqpo", table: "orders", state: "gone" }]
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
        expect(result.stdout).toContain("Not shareable yet.");
        expect(result.stdout).toContain("Reads:\n  old: zyxwvutsrqpo orders  gone");
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
          : { ...primitive, kind, name: "photos", shared: false, columns: [], indexes: [] };
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
    ["directory", "people", "--mine"],
    ["connections", "--mine"],
    ["--all"],
    ["patches", "--all"],
    ["directory", "--all"],
    ["directory", "people", "--all"],
    ["connections", "sales-db", "--all"],
    ["connections", "--state", "live"],
    ["connections", "sales-db", "--state", "all"],
    ["patches", "people"],
    ["directory/people"]
  ])("refuses wrong-level flags or paths locally: %s", async (...args) => {
    const instance = await stubInstance((_, respond) => respond(500, {}));
    const result = await runCli(["list", ...args, "--json", "--api-url", instance.url], { env });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests).toEqual([]);
  });

  it.each([
    { state: "retired", ref: "directory", filter: "retired", refusedFlags: [] },
    { state: "deleted", ref: summary.id, filter: "all", refusedFlags: [] },
    { state: "live", ref: "directory", filter: "live", refusedFlags: ["--state", "retired"] }
  ])(
    "preserves $state refusals and applies --state at both patch depths",
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
        respond(200, url.pathname.includes("/primitives/") ? primitive : detail);
      });
      for (const path of [[ref], [ref, "people"]]) {
        const args = ["list", ...path, "--api-url", instance.url];
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
        expect(JSON.parse(accepted.stdout)).toEqual(path.length === 1 ? detail : primitive);
      }
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
            declarable: false,
            reason: "not_shareable",
            hint: "File stores cannot be shared."
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
      release: { from: `${instance.url}/sdk/patchy.tgz`, to: CURRENT_RELEASE },
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
      if (args[0] === "shared-table")
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
        path.join(packageDir, `artifacts/patchy-${CURRENT_RELEASE}.tgz`)
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
      const originalPin = `${instance.url}/sdk/${pinChanges ? "previous.tgz" : "patchy.tgz"}`;
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
          npm_config_registry: instance.url,
          npm_config_store_dir: path.join(tempDir(), "store"),
          npm_config_cache: path.join(tempDir(), "cache"),
          npm_config_update_notifier: "false"
        }
      });
      const held = await barrier.wait(running);
      const authoredConfig = `${projectConfig}\n// A new author edit while generation is pending.\n`;
      writeFileSync(path.join(dir, "patchy.config.ts"), authoredConfig);
      const authoredPackage = {
        ...originalPackage,
        scripts: { typecheck: "tsc --noEmit", notes: "echo builder-owned" },
        description: "An author edit made after the release pin changed",
        devDependencies: { patchy: `${instance.url}/sdk/patchy.tgz` }
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

  it("initializes an unchanged typechecking tree offline and refuses to initialize it again", async () => {
    const registry = await localPackageRegistry();
    const instance = await stubInstance(
      projectHandler,
      () => CURRENT_RELEASE,
      readFileSync(path.join(packageDir, `artifacts/patchy-${CURRENT_RELEASE}.tgz`))
    );
    const parent = tempDir();
    const stateDir = tempDir();
    // Init targets the remembered instance, not the parent project's binding.
    writeFileSync(path.join(parent, "patchy.json"), '{"instance":"http://127.0.0.1:1"}\n');
    writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiUrl: instance.url }));
    const dir = path.join(parent, "notes-project");
    const options = { cwd: parent, stateDir, env: { ...env, ...registry } };
    const args = ["init", "notes-project", "--purpose", "Synthetic notes for CLI tests", "--json"];
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
      "src/main.ts",
      "index.html",
      "AGENTS.md",
      "CLAUDE.md"
    ];
    const before = Object.fromEntries(
      authoredPaths.map((name) => [name, readFileSync(path.join(dir, name))])
    );
    const generatedBefore = treeBytes(path.join(dir, "patchy/_generated"));
    const compiler = await exec(process.execPath, [
      path.join(dir, "node_modules/typescript/bin/tsc"),
      "--version"
    ]);
    expect(compiler.stdout.trim()).toBe("Version 7.0.2");
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
  }, 30_000); // Real package archive creation, isolated pnpm installation and tsc, not CLI startup.
});

describe("patchy delete target selection", () => {
  it.each([false, true])("refuses an ambiguous target locally (both: %s)", async (both) => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const result = await runCli(
      ["delete", ...(both ? [file, "--patch", "abcdefghijkl"] : []), "--json"],
      {
        stateDir: dir,
        env: { PATCHY_API_TOKEN: "pp_owner" }
      }
    );
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
  });
});

describe("repo publish recovery", () => {
  it.each(["flag", "dev-env", "env"])(
    "refuses a foreign %s target before refreshing or publishing a bound repo",
    async (source) => {
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
        env: { PATCHY_API_URL: foreign.url, PATCHY_API_TOKEN: "pp_owner" }
      };
      if (source === "dev-env") {
        mkdirSync(path.join(dir, ".local/dev"), { recursive: true });
        writeFileSync(
          path.join(dir, ".local/dev/env"),
          `PATCHY_API_URL=${foreign.url}\nPATCHY_API_TOKEN=dev-token\n`
        );
        options.env.PATCHY_API_URL = stored.url;
      }
      for (const command of ["refresh", "publish"]) {
        const result = await runCli(
          [command, "--json", ...(source === "flag" ? ["--api-url", foreign.url] : [])],
          options
        );
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
    }
  );

  it.each([0, 1])(
    "tier %s accepts shared navigation fixtures but refuses unbundled resources",
    async (tier) => {
      const instance = await stubInstance((request, respond, disconnect) => {
        if (request.url === "/api/publish")
          return respond(201, { ...publish(201, "abcdefghijkl", 1), tier });
        projectHandler(request, respond, disconnect);
      });
      const dir = publishTree(instance.url);
      const config = path.join(dir, "patchy.config.ts");
      writeFileSync(config, readFileSync(config, "utf8").replace("tier: 1", `tier: ${tier}`));
      const options = {
        cwd: dir,
        stateDir: tempDir(),
        env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
      };
      expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
      const fixtures = path.join(packageDir, "../core/fixtures/accept");
      const entry = path.join(dir, "index.html");
      writeFileSync(entry, readFileSync(path.join(fixtures, "portfolio.html")));
      const accepted = await runCli(["publish", "--json"], options);
      expect(accepted, accepted.stderr).toMatchObject({ status: 0, stderr: "" });
      const sent = instance.requests.filter((request) => request.url === "/api/publish");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toMatchObject({ manifest: { tier } });
      for (const href of ["https://example.com/case-study", "/reports", "reports/weekly", "#work"])
        expect(JSON.stringify(sent[0]!.body)).toContain(href);

      writeFileSync(entry, readFileSync(path.join(fixtures, "remote-image.html")));
      const refused = await runCli(["publish", "--json"], options);
      expect(refused).toMatchObject({ status: 1, stdout: "" });
      expect(JSON.parse(refused.stderr)).toMatchObject({ ok: false, kind: "local" });
      expect(instance.requests.filter((request) => request.url === "/api/publish")).toHaveLength(1);
    },
    30_000
  );

  it.each([
    [0, 512 * 1024],
    [1, 10 * 1024 * 1024]
  ])(
    "tier %s size refusals report too_large and the offending resource",
    async (tier, cap) => {
      const instance = await stubInstance((request, respond, disconnect) => {
        if (request.url === "/api/publish")
          return respond(201, { ...publish(201, "abcdefghijkl", 1), tier });
        projectHandler(request, respond, disconnect);
      });
      const dir = publishTree(instance.url);
      const config = path.join(dir, "patchy.config.ts");
      writeFileSync(config, readFileSync(config, "utf8").replace("tier: 1", `tier: ${tier}`));
      const options = {
        cwd: dir,
        stateDir: tempDir(),
        env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
      };
      expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
      const entry = path.join(dir, "index.html");
      const oversizedImage = `data:image/png;base64,${"A".repeat(cap)}`;
      writeFileSync(entry, validHtml.replace("</body>", `<img src="${oversizedImage}"></body>`));
      const refused = await runCli(["publish", "--json"], options);
      expect(refused).toMatchObject({ status: 1, stdout: "" });
      const error = JSON.parse(refused.stderr);
      expect(error).toMatchObject({ ok: false, kind: "local", code: "too_large" });
      expect(error.error).toContain(`${cap} bytes`);
      expect(error.error).toContain(`<img> src: ${Buffer.byteLength(oversizedImage)} bytes`);
      expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
      expect(existsSync(path.join(dir, ".patchy/publish"))).toBe(false);

      writeFileSync(entry, validHtml);
      const reduced = await runCli(["publish", "--json"], options);
      expect(reduced, reduced.stderr).toMatchObject({ status: 0, stderr: "" });
    },
    30_000
  );

  it.each([
    '<img src="blob:https://example.test/temporary">',
    '<object data="blob:https://example.test/temporary"></object>',
    `<iframe srcdoc="&lt;img src='blob:https://example.test/temporary'&gt;"></iframe>`,
    '<style>body { background-image: url("blob:https://example.test/temporary"); }</style>'
  ])("refuses document-local blob assets in built HTML: %s", async (asset) => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") return respond(201, publish(201, "abcdefghijkl", 1));
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const entry = path.join(dir, "index.html");
    writeFileSync(entry, readFileSync(entry, "utf8").replace("</body>", `${asset}</body>`));
    const result = await runCli(["publish", "--json"], options);
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
  });

  it.each([
    ["image-set", 'image-set("https://example.test/pixel.png" 1x)'],
    ["-webkit-image-set", '-webkit-image-set("blob:https://example.test/pixel" 1x)'],
    ["escaped image-set", String.raw`image\2d set("\68 ttps://example.test/pixel.png" 1x)`],
    ["escaped url", String.raw`\75rl("\62 lob:https://example.test/pixel")`]
  ])("refuses external %s resources in inline CSS", async (_, value) => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const entry = path.join(dir, "index.html");
    writeFileSync(
      entry,
      readFileSync(entry, "utf8").replace(
        "</body>",
        `<div style='background-image: ${value}'></div></body>`
      )
    );
    const result = await runCli(["publish", "--json"], options);
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
  });

  it("publishes harmless CSS strings and embedded image candidates", async () => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") return respond(201, publish(201, "abcdefghijkl", 1));
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const entry = path.join(dir, "index.html");
    writeFileSync(
      entry,
      readFileSync(entry, "utf8")
        .replace(
          "</head>",
          '<style>body::after { content: "@import url(foo) /* literal text */"; }</style></head>'
        )
        .replace(
          "</body>",
          String.raw`<div style='--label: "@import url(foo)"; background-image: image-set("data:image/png;base64,AA==" 1x type("image/png")); mask-image: -webkit-image-set("\23 icon" 1x); filter: url(#icon)'></div></body>`
        )
    );
    const result = await runCli(["publish", "--json"], options);
    expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
    const requests = instance.requests.filter((request) => request.url === "/api/publish");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toMatchObject({
      html: expect.stringContaining("@import url(foo)")
    });
  });

  it.each([
    String.raw`<style>@\69mport "https://example.test/external.css";</style>`,
    `<div style='color: red; broken; background-image: image-set("https://example.test/pixel.png" 1x)'></div>`
  ])("refuses CSS imports or parse failures without hiding dependencies: %s", async (asset) => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const entry = path.join(dir, "index.html");
    writeFileSync(entry, readFileSync(entry, "utf8").replace("</body>", `${asset}</body>`));
    const result = await runCli(["publish", "--json"], options);
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
  });

  it("inspects active noscript resources in a tier 0 bundle", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const config = path.join(dir, "patchy.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("tier: 1", "tier: 0"));
    writeFileSync(
      path.join(dir, "index.html"),
      validHtml.replace(
        "</body>",
        '<noscript><img src="https://example.test/pixel.png"></noscript></body>'
      )
    );
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const result = await runCli(["publish", "--json"], options);
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
  });

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

  it("infers server code from a directory, not a same-named regular file", async () => {
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/publish") return respond(201, publish(201, "abcdefghijkl", 1));
      projectHandler(request, respond, disconnect);
    });
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    const server = path.join(dir, "server");
    writeFileSync(server, "Documentation, not a server bundle.");
    const published = await runCli(["publish", "--json"], options);
    expect(published, published.stderr).toMatchObject({ status: 0, stderr: "" });
    rmSync(server);
    mkdirSync(server);
    const refused = await runCli(["publish", "--json"], options);
    expect(refused).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(refused.stderr)).toMatchObject({ code: "tier_mismatch" });
    expect(instance.requests.filter((request) => request.url === "/api/publish")).toHaveLength(1);
  }, 30_000); // Refresh and two repo publishes each execute config and build child processes.

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

  it("names both colliding primitives in publish and refresh refusals", async () => {
    const instance = await stubInstance(projectHandler);
    const dir = publishTree(instance.url);
    const options = {
      cwd: dir,
      stateDir: tempDir(),
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    };
    expect((await runCli(["refresh", "--json"], options)).status).toBe(0);
    writeFileSync(
      path.join(dir, "patchy.config.ts"),
      `export default {
        name: "name-collision", tier: 1,
        tables: { notes: { description: "Notes keyed by id.", columns: {}, indexes: {} } },
        files: { notes: { description: "Note attachments keyed by filename." } },
        uses: {}
      };`
    );
    for (const command of ["publish", "refresh"]) {
      const result = await runCli([command, "--json"], options);
      expect(result).toMatchObject({ status: 1, stdout: "" });
      const refusal = JSON.parse(result.stderr);
      expect(refusal).toMatchObject({ ok: false, code: "invalid_manifest" });
      expect(refusal.error).toMatch(/table "notes"/i);
      expect(refusal.error).toMatch(/file store "notes"/i);
    }
    expect(instance.requests.some((request) => request.url === "/api/publish")).toBe(false);
  });

  it("reapplies a moved update's legacy receipt and retains a conflicting author selection", async () => {
    let lost = true;
    const legacy = Struct.omit(publish(200, "abcdefghijkl", 2), [
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
    },
    30_000 // Refresh, refused publish, and recovery rebuild are one multi-process scenario.
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
  }, 30_000);

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
