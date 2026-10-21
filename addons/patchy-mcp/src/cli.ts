#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  apiUrl,
  getToken,
  loginCommand,
  normalizeUrl,
  request,
} from "./api.js";

import { version, buildId } from "./version.js";
const args = process.argv.slice(2);

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    child.once("error", () =>
      reject(
        new Error(
          `Could not run ${command}. Install it and check it is on PATH.`,
        ),
      ),
    );
    child.once("exit", (code, signal) =>
      resolve(code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 130 : 1)),
    );
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.once("close", () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    });
  });
}

function urlOption(rest: string[]): string {
  if (rest.length === 0) return normalizeUrl(apiUrl);
  if (rest.length !== 2 || rest[0] !== "--api-url")
    throw new Error("Expected --api-url <url>.");
  return normalizeUrl(rest[1]);
}

function connectionOptions(rest: string[], allowUrl: boolean) {
  let name = "patchy";
  let url = apiUrl;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!value || seen.has(flag))
      throw new Error("Provide each option once, with its value.");
    seen.add(flag);
    if (flag === "--name") name = value;
    else if (flag === "--api-url" && allowUrl) url = value;
    else throw new Error(`Unknown option '${flag}'. Run: patchy-mcp --help`);
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name))
    throw new Error(
      "Start the Codex registration name with a letter, number or underscore; use only letters, numbers, underscores or hyphens.",
    );
  return { name, url };
}

async function main() {
  if (args[0] === "--version") {
    console.log(version);
    return;
  }
  if (args[0] === "--build-info") {
    console.log(JSON.stringify({ version, buildId }));
    return;
  }
  if (args[0] === "--help") {
    console.log(`Patchy MCP ${version}
Usage: patchy-mcp                         Start the local stdio MCP server
       patchy-mcp --build-info            Identify the installed build
       patchy-mcp serve --api-url URL [--port PORT] [--state-dir DIR]  Local HTTP with per-user OAuth
       patchy-mcp login [Patchy flags]    Existing Patchy device login
       patchy-mcp logout [Patchy flags]   Existing machine logout
       patchy-mcp doctor [--api-url URL]  Verify identity and Page/Tool credential access
       patchy-mcp setup codex [--api-url URL] [--name NAME]
       patchy-mcp remove codex [--name NAME]  Disconnect MCP; keep the Patchy login

HTTP defaults to port 38143; --state-dir keeps OAuth sign-ins across restarts.
Requires Node 22.22+. Saved login needs the matching Patchy CLI on PATH.
PATCHY_API_TOKEN supports direct test launches without the CLI.
Registration defaults to 'patchy'; use --name patchy-local-test to keep it separate.
An empty terminal is normal with no command: stdio waits for an MCP client.
See SETUP.md in this package.`);
    return;
  }
  if (args[0] === "serve") {
    let selected: string | undefined,
      port = 38143,
      stateDir: string | undefined;
    const seen = new Set<string>();
    for (let i = 1; i < args.length; i += 2) {
      if (!args[i + 1] || seen.has(args[i]))
        throw new Error(
          "Expected serve --api-url URL [--port PORT] [--state-dir DIR].",
        );
      seen.add(args[i]);
      if (args[i] === "--api-url" && selected === undefined)
        selected = normalizeUrl(args[i + 1]);
      else if (args[i] === "--port" && /^\d+$/.test(args[i + 1]))
        port = Number(args[i + 1]);
      else if (args[i] === "--state-dir") stateDir = args[i + 1];
      else
        throw new Error(
          "Expected serve --api-url URL [--port PORT] [--state-dir DIR].",
        );
    }
    if (!selected || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(
        "Choose an explicit Cloud instance: serve --api-url URL [--port PORT] [--state-dir DIR].",
      );
    const { serveHttp } = await import("./http.js");
    await serveHttp(selected, port, stateDir);
    return;
  }
  if (args[0] === "login" || args[0] === "logout") {
    // The existing CLI owns device codes, completion, expiry, saved state and revocation.
    const flags = args.slice(1);
    const hasUrl = flags.some(
      (flag) => flag === "--api-url" || flag.startsWith("--api-url="),
    );
    process.exitCode = await run("patchy", [
      args[0],
      ...(hasUrl ? [] : ["--api-url", normalizeUrl(apiUrl)]),
      ...flags,
    ]);
    return;
  }
  if (args[0] === "remove" && args[1] === "codex") {
    const { name } = connectionOptions(args.slice(2), false);
    process.exitCode = await run("codex", ["mcp", "remove", name]);
    return;
  }
  if (args[0] === "doctor" || (args[0] === "setup" && args[1] === "codex")) {
    const connection =
      args[0] === "setup"
        ? connectionOptions(args.slice(2), true)
        : { name: "patchy", url: urlOption(args.slice(1)) };
    const url = normalizeUrl(connection.url);
    if (args[0] === "setup" && process.env.PATCHY_API_TOKEN)
      throw new Error(
        "Unset PATCHY_API_TOKEN before setup so Patchy can verify the saved login it will reuse in Codex.",
      );
    const identity = await request("/api/me", undefined, url);
    // Discovery's public CLI commands can work on an older CLI that cannot read Pages.
    // Check credential access too; never print the secret-bearing response.
    await getToken(url);
    if (args[0] === "setup") {
      // Codex owns its config format. No credential is placed in the registration.
      const code = await run("codex", [
        "mcp",
        "add",
        connection.name,
        "--env",
        `PATCHY_API_URL=${url}`,
        "--env",
        `PATH=${process.env.PATH ?? ""}`,
        "--env",
        "PATCHY_API_TOKEN=",
        ...(process.env.PATCHY_LAUNCH_QUEUE_PATCH
          ? [
              "--env",
              `PATCHY_LAUNCH_QUEUE_PATCH=${process.env.PATCHY_LAUNCH_QUEUE_PATCH}`,
            ]
          : []),
        ...(process.env.PATCHY_STATE_DIR
          ? ["--env", `PATCHY_STATE_DIR=${process.env.PATCHY_STATE_DIR}`]
          : []),
        "--",
        process.execPath,
        fileURLToPath(import.meta.url),
      ]);
      if (code !== 0) {
        process.exitCode = code;
        return;
      }
    }
    console.log(
      JSON.stringify({
        ok: true,
        version,
        instanceUrl: url,
        credentialSource: process.env.PATCHY_API_TOKEN
          ? "environment"
          : "patchy-cli",
        identity,
        ...(args[0] === "setup"
          ? {
              registrationName: connection.name,
              next: `Restart Codex or start a new session. Ask: Use ${connection.name} MCP to list the Patchy patches I can access.`,
            }
          : {}),
      }),
    );
    return;
  }
  if (args.length > 0)
    throw new Error("Unknown command. Run: patchy-mcp --help");
  await import("./stdio.js");
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : `Patchy setup failed. Run ${loginCommand(apiUrl)}.`,
  );
  process.exitCode = 1;
});
