/**
 * The contract, seen from outside: the bundled CLI as a child process against
 * a stub instance. Exit codes per the ladder, one-line stderr, the `--json`
 * shapes, the token never in argv or output, and the state dir's fail-closed
 * files. What the commands do between those edges is the commands' own tests.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEV_SEED } from "@patchy/auth/seed";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageDir, "dist/index.js");
const tempDirs: string[] = [];
const servers: Server[] = [];

beforeAll(() => {
  execFileSync(process.execPath, [path.resolve(packageDir, "../../scripts/build-cli-bundle.mjs")], {
    cwd: packageDir,
    stdio: "pipe"
  });
});

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

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

type Handler = (request: Recorded, respond: (status: number, body: unknown) => void) => void;

/** A stub instance: every request recorded, answered by `handler`. */
const stubInstance = async (handler: Handler) => {
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
      handler(recorded, (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
};

const upload = (status: 200 | 201, patchId: string, versionNumber: number) => ({
  ok: true,
  patchId,
  versionId: `${patchId}-v${versionNumber}`,
  versionNumber,
  title: "Page",
  publicUrl: `http://instance.test/d/${patchId}`,
  warnings: status === 201 ? ["No <title> found."] : []
});

const identity = {
  user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
  company: { id: DEV_SEED.companyId, handle: DEV_SEED.companyHandle, name: DEV_SEED.companyName },
  role: DEV_SEED.role,
  machine: { id: DEV_SEED.tokenId, name: DEV_SEED.tokenName }
};

/** Asynchronous on purpose: the stub instance answers from this same event loop. */
const runCli = (
  args: ReadonlyArray<string>,
  options: { stateDir?: string; env?: Record<string, string>; input?: string; cwd?: string } = {}
) =>
  new Promise<{ status: number | null; stdout: string; stderr: string; stateDir: string }>(
    (resolve, reject) => {
      const stateDir = options.stateDir ?? tempDir();
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: options.cwd ?? stateDir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: stateDir,
          PATCHY_STATE_DIR: stateDir,
          ...options.env
        }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr, stateDir }));
      child.stdin.end(options.input ?? "");
    }
  );

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

  it("reports a parse error as one stderr line, exit 1, and as one document under --json", async () => {
    const text = await runCli(["upload"]);
    expect(text.status).toBe(1);
    expect(text.stderr).toBe("Missing required argument: file\n");

    const json = await runCli(["upload", "--json"]);
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stderr)).toEqual({
      ok: false,
      error: "Missing required argument: file",
      kind: "local"
    });
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

describe("patchy auth set", async () => {
  it("saves a token from stdin under the resolved instance, never echoing it", async () => {
    const result = await runCli(["auth", "set", "--token-stdin", "--api-url", "http://one.test/"], {
      input: "pp_secret_one\n"
    });
    expect(result).toMatchObject({
      status: 0,
      stdout: "Patchy Cloud credentials saved for http://one.test.\n",
      stderr: ""
    });
    expect(readJson(path.join(result.stateDir, "credentials.json"))).toMatchObject({
      hosts: { "http://one.test": { token: "pp_secret_one", source: "auth-set" } }
    });
    expect(readJson(path.join(result.stateDir, "config.json"))).toEqual({
      apiUrl: "http://one.test"
    });

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
    expect(Object.keys(hosts).sort()).toEqual(["http://one.test", "http://two.test"]);
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
  it.each(["whoami", "upload", "delete"])(
    "refuses %s locally without a request",
    async (command) => {
      const instance = await stubInstance((_, respond) => respond(200, identity));
      const dir = tempDir();
      const target =
        command === "upload"
          ? [htmlFile(dir, "page.html", validHtml)]
          : command === "delete"
            ? ["--patch", "abcdefghijkl"]
            : [];
      const result = await runCli([command, ...target, "--api-url", instance.url, "--json"], {
        stateDir: dir
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        kind: "local",
        error: expect.stringContaining(`patchy auth set --api-url ${instance.url}`)
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

describe("patchy upload", async () => {
  it("publishes with a saved key, then republishes with the cached patch id", async () => {
    const instance = await stubInstance((request, respond) => {
      const body = request.body as { patchId?: string };
      return body.patchId
        ? respond(200, upload(200, body.patchId, 2))
        : respond(201, upload(201, "abcdefghijkl", 1));
    });
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    await runCli(["auth", "set", "--token-stdin", "--api-url", instance.url], {
      stateDir: dir,
      input: `${DEV_SEED.token}\n`
    });

    const first = await runCli(["upload", file, "--api-url", instance.url], { stateDir: dir });
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(
      new RegExp(
        `^Publishing to ${instance.url} \\(target came from --api-url\\)\\.\nUploaded patch\nURL: http://instance\\.test/d/abcdefghijkl\nPatch ID: abcdefghijkl\nVersion: 1\n$`
      )
    );
    expect(first.stderr).toBe("Warning: No <title> found.\n");
    expect(`${first.stdout}${first.stderr}`).not.toContain(DEV_SEED.token);
    expect(instance.requests.map((r) => r.url)).toEqual(["/api/uploads"]);
    expect(instance.requests[0]).toMatchObject({ authorization: `Bearer ${DEV_SEED.token}` });
    expect(instance.requests[0]?.body).toMatchObject({
      html: validHtml,
      filename: "page.html",
      metadata: { cliVersion: "0.0.1" }
    });

    // The cache turns the second upload of the same file into an update, and
    // under --json the document is the wire shape alone.
    const second = await runCli(["upload", file, "--json"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url }
    });
    expect(second.status).toBe(0);
    expect(second.stderr).toBe("");
    expect(JSON.parse(second.stdout)).toEqual(upload(200, "abcdefghijkl", 2));
    expect(instance.requests[1]?.body).toMatchObject({ patchId: "abcdefghijkl" });
    expect(instance.requests[1]).toMatchObject({ authorization: `Bearer ${DEV_SEED.token}` });

    // --new ignores the cache; the environment token beats the stored one.
    const fresh = await runCli(["upload", file, "--new"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_env" }
    });
    expect(fresh.status).toBe(0);
    expect(instance.requests[2]?.body).not.toHaveProperty("patchId");
    expect(instance.requests[2]).toMatchObject({ authorization: "Bearer pp_env" });
  });

  it("publishes with the worktree seed and leaves stderr empty under --json", async () => {
    const instance = await stubInstance((_, respond) =>
      respond(201, upload(201, "abcdefghijkl", 1))
    );
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    mkdirSync(path.join(dir, ".local", "dev"), { recursive: true });
    writeFileSync(
      path.join(dir, ".local", "dev", "env"),
      `PATCHY_API_URL=${instance.url}\nPATCHY_API_TOKEN=${DEV_SEED.token}\n`
    );
    const result = await runCli(["upload", file, "--json"], {
      stateDir: dir
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(upload(201, "abcdefghijkl", 1));
    expect(result.stderr).toBe("");
    expect(instance.requests[0]).toMatchObject({ authorization: `Bearer ${DEV_SEED.token}` });

    // A stored key outranks the seed, and an explicit environment key outranks both.
    await runCli(["auth", "set", "--token-stdin"], {
      stateDir: dir,
      input: "pp_saved\n"
    });
    const saved = await runCli(["upload", file, "--new", "--json"], { stateDir: dir });
    expect(saved.status).toBe(0);
    expect(instance.requests[1]).toMatchObject({ authorization: "Bearer pp_saved" });
    const savedStatus = await runCli(["status"], { stateDir: dir });
    expect(JSON.parse(savedStatus.stdout)).toMatchObject({
      hasToken: true,
      tokenSource: "auth-set"
    });

    const env = { PATCHY_API_TOKEN: "pp_environment" };
    const explicit = await runCli(["upload", file, "--new", "--json"], { stateDir: dir, env });
    expect(explicit.status).toBe(0);
    expect(instance.requests[2]).toMatchObject({ authorization: "Bearer pp_environment" });
    const environmentStatus = await runCli(["status"], { stateDir: dir, env });
    expect(JSON.parse(environmentStatus.stdout)).toMatchObject({
      hasToken: true,
      tokenSource: null
    });
  });

  it("rejects an unpublishable file locally and does not retry a refused key", async () => {
    const instance = await stubInstance((_, respond) =>
      respond(401, { ok: false, error: "Missing or invalid API token." })
    );
    const dir = tempDir();
    const bad = htmlFile(dir, "bad.html", "<!doctype html><script>1</script>");
    const local = await runCli(["upload", bad, "--api-url", instance.url], { stateDir: dir });
    expect(local.status).toBe(1);
    expect(instance.requests).toHaveLength(0);

    const good = htmlFile(dir, "good.html", validHtml);
    const rejected = await runCli(["upload", good, "--api-url", instance.url], {
      stateDir: dir,
      env: { PATCHY_API_TOKEN: "pp_bad" }
    });
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("Missing or invalid API token.");
    expect(instance.requests.map((r) => r.url)).toEqual(["/api/uploads"]);
  });

  it("reports an unavailable update target without retrying as a create", async () => {
    const instance = await stubInstance((_, respond) =>
      respond(404, { ok: false, error: "Patch not found." })
    );
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp" };

    const explicit = await runCli(["upload", file, "--patch", "abcdefghijkl"], {
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
    const cached = await runCli(["upload", file], { stateDir: dir, env });
    expect(cached.status).toBe(2);
    expect(cached.stderr).toBe(
      "Cached patch is unavailable for update. Use --new to create a new patch.\n"
    );
    // The pre-rename `draftId` entry was read as the same page.
    expect(instance.requests[1]?.body).toMatchObject({ patchId: "mnopqrstuvwx" });
    expect(instance.requests).toHaveLength(2);

    const conflict = await runCli(["upload", file, "--patch", "abcdefghijkl", "--new"], {
      stateDir: dir,
      env
    });
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toBe("--patch and --new cannot be used together.\n");
  });

  it("refuses to publish past a patch cache still named drafts.json", async () => {
    const instance = await stubInstance((_, respond) =>
      respond(201, upload(201, "abcdefghijkl", 1))
    );
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    // Refused even beside a patches.json: the CLI never guesses which one is current.
    for (const name of ["drafts.json", "patches.json"]) {
      writeFileSync(path.join(dir, name), JSON.stringify({ hosts: {} }));
    }

    const result = await runCli(["upload", file], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp" }
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `The patch cache is now ${path.join(dir, "patches.json")} but the old file is still here: ${path.join(dir, "drafts.json")}\n` +
        "Rename it to patches.json to keep updating the patches it remembers, or delete it to start a fresh cache.\n"
    );
    expect(instance.requests).toHaveLength(0);
  });

  it("fails closed on invalid stored credentials for this instance, and only this instance", async () => {
    const instance = await stubInstance((_, respond) => respond(200, identity));
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({ hosts: { [instance.url]: { token: "" }, "http://other.test": 42 } })
    );
    const file = htmlFile(dir, "page.html", validHtml);
    const broken = await runCli(["upload", file, "--api-url", instance.url], { stateDir: dir });
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

describe("patchy delete", async () => {
  it("takes down the patch a file was uploaded from with the key that published it, then the patch is gone", async () => {
    // The stub remembers what is live, so a delete after a delete is a real 404.
    const live = new Set<string>();
    const instance = await stubInstance((request, respond) => {
      if (request.url === "/api/uploads") {
        const body = request.body as { patchId?: string };
        if (body.patchId !== undefined) {
          return live.has(body.patchId)
            ? respond(200, upload(200, body.patchId, 2))
            : respond(404, { ok: false, error: "Patch not found." });
        }
        live.add("abcdefghijkl");
        return respond(201, upload(201, "abcdefghijkl", 1));
      }
      const patchId = request.url.replace("/api/patches/", "");
      if (request.method === "DELETE" && live.delete(patchId)) return respond(200, { ok: true });
      return respond(404, { ok: false, error: "Patch not found." });
    });
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const copy = htmlFile(dir, "copy.html", validHtml);
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    expect((await runCli(["upload", file], { stateDir: dir, env })).status).toBe(0);
    // A second file pointed at the same patch by hand; the cache now names it twice.
    expect(
      (await runCli(["upload", copy, "--patch", "abcdefghijkl"], { stateDir: dir, env })).status
    ).toBe(0);

    const deleted = await runCli(["delete", file, "--json"], { stateDir: dir, env });
    expect(deleted).toMatchObject({ status: 0, stdout: '{"ok":true}\n', stderr: "" });
    expect(instance.requests[2]).toMatchObject({
      method: "DELETE",
      url: "/api/patches/abcdefghijkl",
      authorization: "Bearer pp_owner"
    });
    // Every file that pointed at the patch is forgotten, not only the one named,
    // so no later upload tries to update a patch that is gone.
    expect(readJson(path.join(dir, "patches.json"))).toEqual({
      hosts: { [instance.url]: { files: {} } }
    });

    const forgotten = await runCli(["delete", file], { stateDir: dir, env });
    expect(forgotten.status).toBe(1);
    expect(forgotten.stderr).toMatch(/^No patch on .* was uploaded from /);
    expect(instance.requests).toHaveLength(3);

    const gone = await runCli(["delete", "--patch", "abcdefghijkl"], { stateDir: dir, env });
    expect(gone.status).toBe(2);
    expect(gone.stderr).toBe(
      `Patch abcdefghijkl is unavailable for deletion: it is not on ${instance.url}, or this publishing key does not own it.\n`
    );

    // Neither target and both targets are told what to pass, in different words.
    const neither = await runCli(["delete"], { stateDir: dir, env });
    expect(neither.status).toBe(1);
    expect(neither.stderr).toBe(
      "Pass the file the patch was uploaded from, or --patch <patch-id>.\n"
    );
    const both = await runCli(["delete", file, "--patch", "abcdefghijkl"], { stateDir: dir, env });
    expect(both.status).toBe(1);
    expect(both.stderr).toBe(
      "Pass the file the patch was uploaded from, or --patch <patch-id>, not both.\n"
    );

    // With no key the deletion is refused locally.
    const keyless = await runCli(["delete", "--patch", "abcdefghijkl", "--api-url", instance.url]);
    expect(keyless.status).toBe(1);
    expect(keyless.stderr).toContain(`patchy auth set --api-url ${instance.url}`);
    expect(instance.requests).toHaveLength(4);
  });
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
