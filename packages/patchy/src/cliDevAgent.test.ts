// `patchy dev agent` through the bundled CLI against a stub dev daemon: what it asks, its two
// outputs, and the exit code for a result, the door's refusal, a local problem and no answer.
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { patchRefusal, toolAnswer } from "@patchy/api";
import { birth } from "./devState.js";
import { identity, runCli, servers, tempDir } from "./test/cli.js";

const instance = "http://127.0.0.1:9";
const nonce = "dev-agent-nonce";

interface Asked {
  readonly mount: "primary" | "colleague";
  readonly nonce: string | undefined;
  readonly body: unknown;
}

type Answer = (body: unknown, response: ServerResponse) => void;

const listen = async (name: Asked["mount"], root: string, asked: Asked[], answer: () => Answer) => {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers["x-patchy-dev"] !== nonce) return json(404, {});
      if (request.method === "GET" && request.url === "/healthz")
        return json(200, { nonce, root, instance });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      asked.push({ mount: name, nonce: request.headers["x-patchy-dev"], body });
      answer()(body, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/dev/localdev0000`;
};

/** A patch repo whose dev daemon is this test process, answering on two stub mounts. */
const running = async (options: { readonly daemon?: boolean } = {}) => {
  const root = realpathSync(tempDir());
  writeFileSync(path.join(root, "patchy.json"), JSON.stringify({ instance }));
  const asked: Asked[] = [];
  let answer: Answer = (_body, response) => response.end();
  const reply = (status: number, body: unknown) => {
    answer = (_body, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
  };
  if (options.daemon !== false) {
    const stateDir = path.join(
      root,
      ".patchy/dev",
      createHash("sha256").update(instance).digest("hex").slice(0, 16)
    );
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "daemon.json"),
      JSON.stringify({
        root,
        instance,
        release: "0.0.0",
        identity,
        nonce,
        pid: process.pid,
        birth: await birth(process.pid),
        url: await listen("primary", root, asked, () => answer),
        colleagueUrl: await listen("colleague", root, asked, () => answer)
      })
    );
  }
  const run = (args: readonly string[], input?: string) =>
    runCli(["dev", "agent", ...args], { cwd: root, ...(input === undefined ? {} : { input }) });
  return { asked, reply, run };
};

const open = toolAnswer({
  name: "notes",
  description: "Team notes.",
  owner: "Builder",
  address: "http://127.0.0.1:4000/dev/localdev0000",
  tools: []
});
const answered = (answer: unknown, rebuildFailed = false) => ({
  ok: true,
  person: "Builder",
  build: 3,
  rebuildFailed,
  answer
});

describe("patchy dev agent", () => {
  it("prints open_patch's answer and calls a tool with its arguments, naming the build", async () => {
    const dev = await running();
    dev.reply(200, answered(open));
    const listed = await dev.run(["--json"]);
    expect(listed, listed.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(listed.stdout)).toEqual(open.structuredContent);
    expect(dev.asked).toEqual([{ mount: "primary", nonce, body: {} }]);

    const success = toolAnswer({ result: { id: "note_1" }, version: 3 });
    dev.reply(200, answered(success));
    const called = await dev.run(["addNote", '{"title":"Hi"}', "--json"]);
    expect(called, called.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(called.stdout)).toEqual({ result: { id: "note_1" }, version: 3 });
    expect(dev.asked.at(-1)?.body).toEqual({ call: { tool: "addNote", args: { title: "Hi" } } });

    const text = await dev.run(["addNote", "-", "--colleague"], '{"title":"From stdin"}');
    expect(text, text.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(text.stdout.trim().split("\n")).toEqual([
      ...JSON.stringify({ result: { id: "note_1" }, version: 3 }, null, 2).split("\n"),
      "Server build 3 answered as Builder via patchy dev."
    ]);
    expect(dev.asked.at(-1)).toEqual({
      mount: "colleague",
      nonce,
      body: { call: { tool: "addNote", args: { title: "From stdin" } } }
    });
    // No arguments are {}.
    await dev.run(["addNote"]);
    expect(dev.asked.at(-1)?.body).toEqual({ call: { tool: "addNote", args: {} } });
  });

  it("says when the last good build answered because the latest rebuild failed", async () => {
    const dev = await running();
    dev.reply(200, answered(toolAnswer({ result: 1, version: 3 }), true));
    const stale =
      "Server build 3, the last good one, answered as Builder via patchy dev: the latest rebuild failed. Read `pnpm patchy dev logs`.";
    const json = await dev.run(["count", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({ result: 1, version: 3, warnings: [stale] });
    const text = await dev.run(["count"]);
    expect(text.stdout.trim().split("\n").at(-1)).toBe(stale);
  });

  it("exits 2 with the door's refusal, its from, details and retry", async () => {
    const dev = await running();
    const refusal = patchRefusal("notes", "addNote", {
      code: "blank",
      details: { message: "give the note a title", field: "title" }
    });
    dev.reply(200, answered(refusal));
    const json = await dev.run(["addNote", '{"title":" "}', "--json"]);
    expect(json).toMatchObject({ status: 2, stdout: "" });
    expect(JSON.parse(json.stderr)).toEqual({
      ok: false,
      error: refusal.content[0].text,
      kind: "rejected",
      code: "blank",
      from: "patch",
      details: { message: "give the note a title", field: "title" }
    });
    const text = await dev.run(["addNote", '{"title":" "}']);
    expect(text).toMatchObject({ status: 2, stdout: "" });
    expect(text.stderr.trim().split("\n")).toEqual([
      "Server build 3 answered as Builder via patchy dev.",
      refusal.content[0].text
    ]);

    dev.reply(
      200,
      answered({
        content: [{ type: "text", text: "Busy." }],
        structuredContent: {
          error: { code: "busy", from: "patchy", message: "Busy.", retryAfterSeconds: 1 }
        },
        isError: true
      })
    );
    const busy = await dev.run(["addNote", "--json"]);
    expect(busy.status).toBe(2);
    expect(JSON.parse(busy.stderr)).toEqual({
      ok: false,
      error: "Busy.",
      kind: "rejected",
      code: "busy",
      from: "patchy",
      retryAfterSeconds: 1
    });
  });

  it("exits 1 for local problems, before asking when the arguments are wrong", async () => {
    const dev = await running();
    for (const args of ["[1]", "{oops", '"text"']) {
      const result = await dev.run(["addNote", args, "--json"]);
      expect(result.status, args).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    }
    expect(dev.asked).toEqual([]);

    dev.reply(200, { ok: false, code: "no_agent_tools", error: "This patch has no agent tools." });
    const none = await dev.run(["--json"]);
    expect(none.status).toBe(1);
    expect(JSON.parse(none.stderr)).toEqual({
      ok: false,
      error: "This patch has no agent tools.",
      kind: "local",
      code: "no_agent_tools"
    });

    const stopped = await (await running({ daemon: false })).run(["--json"]);
    expect(stopped.status).toBe(1);
    expect(JSON.parse(stopped.stderr)).toMatchObject({ kind: "local", code: "not_running" });
  });

  it("exits 3 when a started call gets no usable answer", async () => {
    const dev = await running();
    for (const [status, body] of [
      [500, { ok: false }],
      [200, { surprise: true }]
    ] as const) {
      dev.reply(status, body);
      const result = await dev.run(["addNote", "--json"]);
      expect(result.status).toBe(3);
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        kind: "unreachable",
        error:
          "The dev runtime gave no usable answer, so addNote may or may not have run. Read `pnpm patchy dev logs` before calling it again."
      });
    }
  });
});
