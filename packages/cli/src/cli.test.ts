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
  accountId: "acct_1",
  accountName: "Account One",
  apiTokenId: "tok_1",
  apiTokenName: "laptop",
  scopes: ["upload"]
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
      stdout: "Account: Account One (acct_1)\nAPI token: laptop (tok_1)\nScopes: upload\n",
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

  it("reports a missing token locally instead of minting one", async () => {
    const result = await runCli(["whoami", "--api-url", "http://127.0.0.1:1"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^No publishing token is stored for http:\/\/127\.0\.0\.1:1\./);
  });
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
  it("mints on first upload, announces it, then republishes with the saved token", async () => {
    const instance = await stubInstance((request, respond) => {
      if (request.url === "/api/tokens/self-service")
        return respond(201, { ok: true, token: "pp_minted" });
      const body = request.body as { patchId?: string };
      return body.patchId
        ? respond(200, upload(200, body.patchId, 2))
        : respond(201, upload(201, "abcdefghijkl", 1));
    });
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);

    const first = await runCli(["upload", file, "--api-url", instance.url], { stateDir: dir });
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(
      new RegExp(
        `^Publishing to ${instance.url} \\(target came from --api-url\\)\\.\nMinted a new publishing token for ${instance.url};.*\nUploaded draft\nURL: http://instance\\.test/d/abcdefghijkl\nDraft ID: abcdefghijkl\nVersion: 1\n$`
      )
    );
    expect(first.stderr).toBe("Warning: No <title> found.\n");
    expect(`${first.stdout}${first.stderr}`).not.toContain("pp_minted");
    expect(instance.requests.map((r) => r.url)).toEqual([
      "/api/tokens/self-service",
      "/api/uploads"
    ]);
    expect(instance.requests[1]).toMatchObject({ authorization: "Bearer pp_minted" });
    expect(instance.requests[1]?.body).toMatchObject({
      html: validHtml,
      filename: "page.html",
      metadata: { cliVersion: "0.0.1" }
    });
    expect(readJson(path.join(dir, "credentials.json"))).toMatchObject({
      hosts: { [instance.url]: { token: "pp_minted", source: "mint" } }
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
    expect(instance.requests[2]?.body).toMatchObject({ patchId: "abcdefghijkl" });
    expect(instance.requests[2]).toMatchObject({ authorization: "Bearer pp_minted" });

    // --new ignores the cache; the environment token beats the stored one.
    const fresh = await runCli(["upload", file, "--new"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_env" }
    });
    expect(fresh.status).toBe(0);
    expect(instance.requests[3]?.body).not.toHaveProperty("patchId");
    expect(instance.requests[3]).toMatchObject({ authorization: "Bearer pp_env" });
  });

  it("under --json, the mint announcement is the only thing on stderr", async () => {
    const instance = await stubInstance((request, respond) =>
      request.url === "/api/tokens/self-service"
        ? respond(201, { ok: true, token: "pp_minted" })
        : respond(201, upload(201, "abcdefghijkl", 1))
    );
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const result = await runCli(["upload", file, "--json"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url }
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(upload(201, "abcdefghijkl", 1));
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("Minted a new publishing token");
  });

  it("never mints for an unpublishable file, and never re-mints after a rejected token", async () => {
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

  it("explains each refusal to mint, with the exit code for a rejection", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const cases: ReadonlyArray<[unknown, RegExp]> = [
      [
        { ok: false, error: "off", code: "self_service_disabled" },
        /does not hand them out on request/
      ],
      [{ ok: false, error: "quota", code: "mint_quota_exceeded", quota: 5 }, /limit of new tokens/],
      [{ ok: false, error: "slow", code: "rate_limited", retryAfterSeconds: 7 }, /Wait 7 seconds/]
    ];
    for (const [body, expected] of cases) {
      const status = (body as { code: string }).code === "self_service_disabled" ? 403 : 429;
      const instance = await stubInstance((_, respond) => respond(status, body));
      const result = await runCli(["upload", file, "--api-url", instance.url], { stateDir: dir });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(expected);
      expect(result.stderr).toMatch(/^Could not get a publishing token/m);
    }
  });

  it("reports an unavailable update target without retrying as a create", async () => {
    const instance = await stubInstance((_, respond) =>
      respond(404, { ok: false, error: "Patch not found." })
    );
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp" };

    const explicit = await runCli(["upload", file, "--draft", "abcdefghijkl"], {
      stateDir: dir,
      env
    });
    expect(explicit.status).toBe(2);
    expect(explicit.stderr).toBe(
      "Draft is unavailable for update. --draft never creates a new draft.\n"
    );

    writeFileSync(
      path.join(dir, "drafts.json"),
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
      "Cached draft is unavailable for update. Use --new to create a new draft.\n"
    );
    // The pre-rename `draftId` entry was read as the same page.
    expect(instance.requests[1]?.body).toMatchObject({ patchId: "mnopqrstuvwx" });
    expect(instance.requests).toHaveLength(2);

    const conflict = await runCli(["upload", file, "--draft", "abcdefghijkl", "--new"], {
      stateDir: dir,
      env
    });
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toBe("--draft and --new cannot be used together.\n");
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
      "PATCHY_API_URL=http://127.0.0.1:45678\nPATCHY_API_TOKEN=pp_dev\n"
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
