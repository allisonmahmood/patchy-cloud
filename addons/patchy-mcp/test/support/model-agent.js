import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { cloud, entry } from "./business.js";

const exec = promisify(execFile);

// Real model turns, with only this local MCP available. No global client registration.
export async function ask(identity, prompt, label) {
  const cwd = await mkdtemp(path.join(tmpdir(), "patchy-business-agent-"));
  try {
    // Keep the person's model choice without loading their MCP registrations.
    const settings = await readFile(
      path.join(
        process.env.CODEX_HOME || path.join(homedir(), ".codex"),
        "config.toml",
      ),
      "utf8",
    ).catch(() => "");
    const model =
      process.env.PATCHY_TEST_AGENT_MODEL ||
      /^model\s*=\s*"([^"]+)"/m.exec(settings)?.[1];
    const output = path.join(cwd, "answer.txt");
    const running = exec(
      process.env.PATCHY_TEST_CODEX_COMMAND || "codex",
      [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        ...(model ? ["--model", model] : []),
        "--sandbox",
        "read-only",
        "--output-last-message",
        output,
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.unified_exec=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        'web_search="disabled"',
        "-c",
        'approval_policy="never"',
        "-c",
        ...(identity.httpUrl
          ? [
              `mcp_servers.patchy.url=${JSON.stringify(identity.httpUrl)}`,
              "-c",
              'mcp_servers.patchy.bearer_token_env_var="PATCHY_HTTP_ACCEPTANCE_TOKEN"',
            ]
          : [
              `mcp_servers.patchy.command=${JSON.stringify(process.execPath)}`,
              "-c",
              `mcp_servers.patchy.args=${JSON.stringify([entry])}`,
              "-c",
              'mcp_servers.patchy.env_vars=["PATCHY_API_URL","PATCHY_API_TOKEN"]',
            ]),
        "-c",
        'mcp_servers.patchy.tools.run_mutation.approval_mode="approve"',
        prompt,
      ],
      {
        cwd,
        env: {
          ...process.env,
          PATCHY_API_URL: cloud,
          PATCHY_API_TOKEN: identity.httpUrl ? "" : identity.token,
          PATCHY_HTTP_ACCEPTANCE_TOKEN: identity.httpUrl ? identity.token : "",
        },
        timeout: 180000,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    running.child.stdin.end();
    const { stdout } = await running.catch((error) => {
      const events = (error.stdout || "").split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const failures = events.filter((e) =>
        ["error", "turn.failed"].includes(e.type),
      );
      throw new Error(
        `Agent process failed: ${JSON.stringify(failures).slice(0, 1500) || "No completed model turn"}`,
      );
    });
    const events = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some((e) => e.type === "turn.completed"),
      "Agent did not complete a model turn",
    );
    const calls = events.flatMap((e) =>
      e.type === "item.completed" && e.item.type === "mcp_tool_call"
        ? [
            {
              name: `mcp__${e.item.server}__${e.item.tool}`,
              input: e.item.arguments,
              result: e.item.result,
              error: e.item.error,
            },
          ]
        : [],
    );
    assert.ok(calls.length > 0, "A prose answer alone is not MCP acceptance");
    assert.ok(calls.every((c) => c.name.startsWith("mcp__patchy__")));
    assert.ok(
      !events.some((e) => e.item?.type === "command_execution"),
      "The agent must use MCP",
    );
    const evidence = {
      label,
      model: model || "Codex default",
      transport: identity.httpUrl ? "streamable-http" : "stdio",
      prompt,
      calls,
      answer: await readFile(output, "utf8"),
    };
    if (process.env.PATCHY_TEST_BUSINESS_EVIDENCE) {
      await writeFile(
        path.join(process.env.PATCHY_TEST_BUSINESS_EVIDENCE, `${label}.json`),
        JSON.stringify(evidence, null, 2),
      );
    }
    console.log(
      JSON.stringify({
        label,
        calls: calls.map((call) => ({
          tool: call.name,
          handler: call.input?.handler,
        })),
        answer: evidence.answer,
      }),
    );
    return evidence;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
