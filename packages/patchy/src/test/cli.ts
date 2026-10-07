/**
 * The contract, seen from outside: the bundled CLI as a child process against
 * a stub instance. Exit codes per the ladder, one-line stderr, the `--json`
 * shapes, the token never in argv or output, and the state dir's fail-closed
 * files. What the commands do between those edges is the commands' own tests.
 *
 * This is the harness the `cli*.test.ts` suites share. They are separate files
 * so vitest runs them in parallel; each file gets its own copy of this module,
 * hooks included.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, vi } from "vitest";
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
import { generateClient, generateSharedStoreClient } from "../../../sdk/src/generateClient.js";
import { generateServer } from "../../../sdk/src/generateServer.js";
import { generate as generatePostgres } from "../../../integrations/src/postgres/Generate.js";
import { starterFiles } from "../initProject.js";
import toolchain from "../toolchain.json" with { type: "json" };
import { lookRevision, readLookFixture } from "../../../../test/look-fixtures.js";
import { sdkCapabilities } from "../../../sdk/src/sdkCapabilities.js";

// Every case launches the bundled CLI; pure in-process tests belong in their module suites.
vi.setConfig({ testTimeout: 30_000 });

export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const cliPath = path.join(packageDir, "dist/index.js");
export const releaseArtifact = JSON.parse(
  readFileSync(path.join(packageDir, "artifacts/release.json"), "utf8")
) as { digest: string; integrity: string };
export const tarballPath = `/sdk/patchy-${CURRENT_RELEASE}-${releaseArtifact.digest}.tgz`;
export const tempDirs: string[] = [];
export const servers: Server[] = [];
export const cliChildren = new Set<ChildProcess>();

afterEach(async () => {
  await Promise.all(
    [...cliChildren].map(
      (child) =>
        new Promise<void>((resolve) => {
          // Let the CLI interrupt its install child, then bound cleanup if shutdown stalls.
          const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
          child.once("close", () => {
            clearTimeout(force);
            resolve();
          });
          child.kill("SIGTERM");
        })
    )
  );
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

afterAll(() => {
  for (const server of servers) server.close();
});

export const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "patchy-cli-test-"));
  tempDirs.push(dir);
  return dir;
};

export const pendingFile = (directory: string) => path.join(directory, readdirSync(directory)[0]!);

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  /** The `Patchy-Cli` header: release, command and coding agent. */
  readonly patchyCli: string | string[] | undefined;
  readonly body: unknown;
}

export type Handler = (
  request: Recorded,
  respond: (status: number, body: unknown) => void,
  disconnect: () => void
) => void;

/** A stub instance: every request recorded, answered by `handler`. */
export const stubInstance = async (
  handler: Handler,
  release = () => CURRENT_RELEASE,
  tarball?: Buffer,
  releaseToolchain = toolchain
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
        patchyCli: request.headers["patchy-cli"],
        body: raw ? JSON.parse(raw) : undefined
      };
      requests.push(recorded);
      const respond = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      // Every digest serves the same archive, so a repo can start from an older release's pin.
      if (tarball && /^\/sdk\/patchy-[^/]+\.tgz$/.test(recorded.url)) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(tarball);
        return;
      }
      if (recorded.url === "/api/release") {
        respond(200, {
          release: release(),
          package: { tarball: tarballPath, integrity: releaseArtifact.integrity },
          manifestVersion: MANIFEST_VERSION,
          wireVersion: WIRE_VERSION,
          toolchain: releaseToolchain
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

export const publish = (
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
  artifacts: { html: { sha256: sha256(validHtml), bytes: Buffer.byteLength(validHtml) } },
  schemaRevision: 0,
  provisioned: { tables: [], columns: [], indexes: [], stores: [] },
  unused: { tables: [], columns: [], indexes: [], stores: [] },
  warnings: status === 201 ? ["No <title> found."] : []
});

export const identity = {
  user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
  company: { id: DEV_SEED.companyId, handle: DEV_SEED.companyHandle, name: DEV_SEED.companyName },
  role: DEV_SEED.role,
  machine: { id: DEV_SEED.tokenId, name: DEV_SEED.tokenName }
};

/** Publish fixtures still dispatch identity refusals explicitly through stubInstance. */
export const stubPublishingInstance = (handler: Handler, release = () => CURRENT_RELEASE) =>
  stubInstance((request, respond, disconnect) => {
    if (request.url === "/api/me") return respond(200, identity);
    handler(request, respond, disconnect);
  }, release);

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stateDir: string;
}

/** Asynchronous on purpose: the stub instance answers from this same event loop. */
export const runCli = (
  args: ReadonlyArray<string>,
  options: {
    stateDir?: string;
    env?: Record<string, string>;
    input?: string;
    terminalInput?: string;
    cwd?: string;
    onSpawn?: (child: ChildProcess) => void;
    /** Another CLI entrypoint, such as a repo's installed release; defaults to the checkout's. */
    cli?: string;
  } = {}
) =>
  new Promise<CliResult>((resolve, reject) => {
    const stateDir = options.stateDir ?? tempDir();
    const cli = options.cli ?? cliPath;
    const command = [process.execPath, cli, ...args];
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
        : [cli, ...args],
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
    cliChildren.add(child);
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
    child.on("close", (status) => {
      cliChildren.delete(child);
      resolve({ status, stdout, stderr, stateDir });
    });
    if (!terminal) child.stdin.end(options.input ?? "");
    options.onSpawn?.(child);
  });

export interface HeldRequest {
  readonly request: Recorded;
  readonly respond: (status: number, body: unknown) => void;
}

/** Hold a real HTTP request until the test explicitly answers it. */
export const requestBarrier = () => {
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

export const exec = promisify(execFile);
export const require = createRequire(import.meta.url);
export const decodeGenerateRequest = Schema.decodeUnknownSync(GenerateRequest);
export const decodeForceRequest = Schema.decodeUnknownSync(ForceRequest);
export const decodeDescriptionRequest = Schema.decodeUnknownSync(DescriptionRequest);
export const decodePublishRequest = Schema.decodeUnknownSync(PublishRequest);
export const decodePackageFixture = Schema.decodeUnknownSync(
  Schema.StructWithRest(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
    }),
    [Schema.Record(Schema.String, Schema.Unknown)]
  )
);
export const coreProjectSkills = [
  "patchy-files",
  "patchy-look",
  "patchy-loop",
  "patchy-preact",
  "patchy-tables"
];
export const projectConfig =
  'import { defineConfig, table, t } from "patchy/config";\n\n' +
  'export default defineConfig({ name: "cli-project", tier: 1,\n' +
  '  tables: { notes: table("One note per id, with a title.", { title: t.text() }) }, files: {},\n' +
  "  uses: {}\n});\n";
export const projectConnections = {
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
export const projectSource = {
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
    stores: [{ name: "photos", description: "Profile photos.", shared: true, declarable: true }]
  },
  reads: []
};

/** Patchy's look as generation writes it for a company with no look: no logo. */
export const patchyLookFiles = { "look.css": readLookFixture("patchy")["look.css"] };

/** A company look carrying its font as a captured look does: #564's Inter subset, embedded. */
export const embeddedFontLook = (() => {
  const fixture = readFileSync(
    path.join(packageDir, "../core/fixtures/accept/embedded-font.html"),
    "utf8"
  );
  const fontFace = /@font-face\s*{[^}]*}/.exec(fixture)![0];
  const font = /url\("(data:font\/woff2;base64,[^"]+)"\)/.exec(fontFace)![1]!;
  return { "look.css": `${fontFace}\n${readLookFixture("linear")["look.css"]}`, font };
})();

/**
 * Only the instance metadata is stubbed: these are the shipped client generators. `look` stands
 * in for the company's current look, `revision` its stamp, absent for the Patchy look; skills
 * are served as their release templates.
 */
export const generateProjectResponse = (
  body: unknown,
  look: {
    readonly "look.css": string;
    readonly "logo.svg"?: string;
    readonly revision?: ReturnType<typeof lookRevision>;
  } = patchyLookFiles
): typeof Generated.Type => {
  const { manifest, serverModules } = decodeGenerateRequest(body);
  const files: Array<{ path: string; contents: string }> = [];
  const uses: Array<{
    alias: string;
    id: string;
    revision: number;
    declaration: (typeof GenerateRequest.Type)["manifest"]["uses"][string];
  }> = [];
  const postgres: Record<string, (typeof DeclarationMetadata.Type)["postgres"][string]> = {};
  const sharedMetadata: Record<string, (typeof DeclarationMetadata.Type)["shared"][string]> = {};
  const shared: Record<string, string> = {};
  const connections: Record<string, string> = {};
  const skills = new Set(coreProjectSkills);
  if (manifest.tier === 2) skills.add("patchy-server");
  for (const [alias, declaration] of Object.entries(manifest.uses)) {
    if (declaration.kind === "members") {
      skills.add("patchy-members");
      continue;
    }
    if (declaration.kind === "sharedStore") {
      const stamp = {
        ...declaration,
        id: `${declaration.patchId}/${declaration.store}`,
        revision: 3
      };
      sharedMetadata[alias] = {
        declaration: stamp,
        definition: { description: "Profile photos.", shared: true }
      };
      files.push(
        { path: `patchy/_generated/uses/${alias}.ts`, contents: generateSharedStoreClient() },
        {
          path: `fixtures/shared-${alias}/README.md`,
          contents: `Put invented files from ${stamp.patchId}/${stamp.store} here.\n`
        }
      );
      shared[alias] = `./uses/${alias}.js`;
      uses.push({ alias, id: stamp.id, revision: stamp.revision, declaration: stamp });
      skills.add("patchy-shared-stores");
      continue;
    }
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
    {
      path: "patchy/_generated/client.ts",
      contents: generateClient({ connections, shared, tier: manifest.tier })
    },
    {
      path: "patchy/_generated/index.json",
      contents: JSON.stringify({
        release: CURRENT_RELEASE,
        manifestVersion: MANIFEST_VERSION,
        capabilities: sdkCapabilities,
        uses,
        skills: [...skills].sort(),
        look: look.revision ?? null
      })
    }
  );
  files.push({ path: "patchy/_generated/look.css", contents: look["look.css"] });
  if (look["logo.svg"] !== undefined)
    files.push({ path: "patchy/_generated/logo.svg", contents: look["logo.svg"] });
  if (manifest.tier === 2)
    files.push({
      path: "patchy/_generated/server.ts",
      contents: generateServer({ modules: serverModules, connections, shared })
    });
  for (const skill of [...skills].sort())
    files.push({
      path: `.agents/skills/${skill}/SKILL.md`,
      contents: readFileSync(path.join(packageDir, "../sdk/skills", skill, "SKILL.md"), "utf8")
    });
  return { ok: true, files, metadata: { postgres, shared: sharedMetadata }, uses };
};

export const projectHandler: Handler = (request, respond) => {
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
  if (request.url === "/api/look") return respond(200, { current: null, revisions: [] });
  respond(404, { ok: false, error: "Unexpected fixture route." });
};

export const projectTree = (instance: string, source = projectConfig) => {
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
      devDependencies: { patchy: `${instance}${tarballPath}` }
    }) + "\n"
  );
  mkdirSync(path.join(dir, "node_modules"));
  symlinkSync(packageDir, path.join(dir, "node_modules/patchy"), "dir");
  return dir;
};

/** Real repo tools, linked from the checkout instead of reinstalling them for each scenario. */
export const publishTree = (instance: string) => {
  const dir = projectTree(instance);
  for (const [file, source] of Object.entries(
    starterFiles({
      instance,
      name: "cli-project",
      tier: 1,
      purpose: "Synthetic notes",
      tarball: `${instance}${tarballPath}`
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

export const treeBytes = (root: string): Record<string, Buffer> => {
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
export const localPackageRegistry = async () => {
  const dir = tempDir();
  const packages = new Map<
    string,
    { manifest: Record<string, unknown>; version: string; tarball: string; integrity: string }
  >();
  const seen = new Set<string>();
  const resolvePackage = (name: string, from: string): string => {
    const resolver = createRequire(from);
    // pnpm links a skipped optional platform package to the workspace root, so a
    // resolution only counts when it lands on the package that was asked for.
    const named = (file: string) => decodePackageFixture(readJson(file)).name === name;
    try {
      const file = resolver.resolve(`${name}/package.json`);
      if (named(file)) return file;
    } catch {
      // ESM-only tooling may export neither package.json nor a require entry.
      for (const directory of resolver.resolve.paths(name) ?? []) {
        const candidate = path.join(directory, name, "package.json");
        if (existsSync(candidate) && named(candidate)) return candidate;
      }
    }
    throw new Error(`The offline CLI fixture needs the real installed package ${name}.`);
  };
  const pack = async (file: string): Promise<void> => {
    file = realpathSync(file);
    if (seen.has(file)) return;
    seen.add(file);
    const manifest = decodePackageFixture(readJson(file));
    const tarball = path.join(dir, `${seen.size}.tgz`);
    // pnpm links identical store files to one inode; registry tarballs never carry hard links.
    await exec("tar", [
      "-czf",
      tarball,
      "--hard-dereference",
      "--exclude=node_modules",
      "--transform=s,^\\.,package,",
      "-C",
      path.dirname(file),
      "."
    ]);
    packages.set(`${manifest.name}@${manifest.version}`, {
      manifest,
      version: manifest.version,
      tarball,
      integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`
    });
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
  for (const name of [
    "typescript",
    "vite-plugin-singlefile",
    "@types/node",
    "eslint",
    "typescript-eslint"
  ])
    await pack(resolvePackage(name, import.meta.url));
  await pack(resolvePackage("vite", require.resolve("vitest/package.json")));
  await pack(resolvePackage("eslint-plugin-react-hooks", path.join(packageDir, "package.json")));
  await pack(resolvePackage("workerd", path.join(packageDir, "../execution/package.json")));
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
              dist: {
                tarball: `${url}/tarballs/${path.basename(entry.tarball)}`,
                integrity: entry.integrity
              }
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
    // pnpm 11 reads its own config prefix; npm_config_* leaves the public registry active.
    pnpm_config_registry: url,
    pnpm_config_store_dir: path.join(dir, "store"),
    pnpm_config_cache_dir: path.join(dir, "cache"),
    pnpm_config_optional: "false",
    pnpm_config_auto_install_peers: "false",
    pnpm_config_update_notifier: "false"
  };
};

export const htmlFile = (dir: string, name: string, html: string) => {
  const file = path.join(dir, name);
  writeFileSync(file, html);
  return file;
};

export const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

export const validHtml =
  "<!doctype html><html><head><title>Ok</title></head><body><p>hi</p></body></html>";
