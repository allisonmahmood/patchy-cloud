// The CLI contract from outside: the exit-code ladder, login, keys and status.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import {
  cliPath,
  htmlFile,
  identity,
  readJson,
  runCli,
  stubInstance,
  tempDir
} from "./test/cli.js";

describe("the exit-code ladder", async () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "exits 130 on %s, as Effect's interruption",
    async (signal) => {
      const instance = await stubInstance(() => undefined);
      const child = spawn(process.execPath, [cliPath, "whoami", "--api-url", instance.url], {
        env: { PATH: process.env.PATH ?? "", PATCHY_STATE_DIR: tempDir(), PATCHY_API_TOKEN: "t" }
      });
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const poll = () => (instance.requests.length > 0 ? resolve() : setTimeout(poll, 20));
        poll();
      });
      child.kill(signal);
      const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(status).toBe(130);
    }
  );

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

  // An empty PATCHY_API_TOKEN acts as unset; a set one keeps precedence over the saved login.
  it.each(["", "environment-key"])(
    "reports a saved login and any environment override (PATCHY_API_TOKEN=%j)",
    async (token) => {
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
      const options = { stateDir: dir, env: { PATCHY_API_TOKEN: token } };
      const warnings = token
        ? ["Login saved. PATCHY_API_TOKEN is still set and takes precedence over this login."]
        : [];
      const result = await runCli(
        ["login", "--complete", "--api-url", instance.url, "--json"],
        options
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
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
