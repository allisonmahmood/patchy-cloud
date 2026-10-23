// `patchy logs` through the bundled CLI: the route it asks, its two outputs and its refusals.
import { describe, expect, it } from "vitest";
import { runCli, stubInstance } from "./test/cli.js";

describe("patchy logs", () => {
  const patchId = "abcdefghijkl";
  const env = (url: string) => ({ PATCHY_API_URL: url, PATCHY_API_TOKEN: "pp_owner" });
  // An entry as an instance from before agents sends it, without `agent`.
  const before = {
    id: "inv_new",
    correlationId: "cor_new",
    startedAt: "2026-10-19T10:00:01.000Z",
    settledAt: "2026-10-19T10:00:01.040Z",
    version: 12,
    handler: "leads.import",
    kind: "action",
    viewer: { id: "usr_alice", name: "Alice" },
    outcome: "failure",
    code: "handler_failed",
    durationMs: 40,
    guestMs: 30,
    dbMs: 5,
    callbacks: 2,
    attempts: 1,
    replyDelivered: true,
    logLines: [
      {
        message: "Cannot read properties of undefined (reading 'email')",
        details: { stack: "TypeError: Cannot read properties of undefined\n    at server.js:1:20" }
      }
    ],
    steps: [
      {
        type: "call",
        id: "call_1",
        parentId: "inv_new",
        at: "2026-10-19T10:00:01.010Z",
        name: "tables.insert",
        kind: null,
        resource: "leads",
        connection: null,
        effectivePrincipal: "patch",
        outcome: "success",
        code: null,
        durationMs: 3,
        attempts: 1,
        rowCount: 1,
        logLines: []
      }
    ],
    stepsTruncated: false
  };
  const entry = { ...before, agent: { name: "Codex" } };
  const page = { ok: true, patchId, entries: [entry], next: "inv_new", windowEnded: false };

  it("asks for one page by its flags and prints the document or readable lines", async () => {
    const instance = await stubInstance((request, respond) => {
      if (request.method !== "GET" || !request.url.startsWith(`/api/patches/${patchId}/log?`))
        return respond(404, { ok: false, error: "Patch not found." });
      respond(200, page);
    });
    const args = ["logs", "--patch", patchId, "--failed", "--limit", "5", "--before", "inv_old"];
    const json = await runCli([...args, "--json"], { env: env(instance.url) });
    expect(json, json.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual(page);
    const query = new URL(instance.requests.at(-1)!.url, instance.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({ limit: "5", before: "inv_old", failed: "true" });

    const text = await runCli(args, { env: env(instance.url) });
    expect(text, text.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(text.stdout.trim().split("\n")).toEqual([
      "2026-10-19T10:00:01.000Z · v12 · leads.import (action) · failure handler_failed · 40 ms · Alice via Codex",
      "  entry inv_new · correlation cor_new",
      "  log: Cannot read properties of undefined (reading 'email')",
      "    TypeError: Cannot read properties of undefined",
      "        at server.js:1:20",
      "  - tables.insert leads · as the patch · success · 3 ms · 1 rows",
      "",
      `Older entries: patchy logs --patch ${patchId} --failed --before inv_new`
    ]);
  });

  it("reads a page from an instance before agents as people's own calls", async () => {
    const instance = await stubInstance((_, respond) =>
      respond(200, { ...page, entries: [before], next: null })
    );
    const json = await runCli(["logs", "--patch", patchId, "--json"], { env: env(instance.url) });
    expect(json, json.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(json.stdout).entries[0].agent).toBeNull();
    const text = await runCli(["logs", "--patch", patchId], { env: env(instance.url) });
    expect(text.stdout.split("\n")[0]).toMatch(/ · 40 ms · Alice$/u);
  });

  it("relays the instance's refusal for someone who isn't the owner or an admin", async () => {
    const owner = { id: "usr_sam", name: "Sam" };
    const instance = await stubInstance((_, respond) =>
      respond(403, {
        ok: false,
        code: "not_owner",
        error: "Only Sam or an admin can read this patch's log.",
        owner
      })
    );
    const result = await runCli(["logs", "--patch", patchId, "--json"], {
      env: env(instance.url)
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      kind: "rejected",
      code: "not_owner",
      owner,
      error: "Only Sam or an admin can read this patch's log."
    });
  });

  it("refuses a page size outside 1 to 25 before asking the instance", async () => {
    const instance = await stubInstance((_, respond) => respond(200, page));
    const result = await runCli(["logs", "--patch", patchId, "--limit", "26"], {
      env: env(instance.url)
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--limit must be between 1 and 25.");
    expect(instance.requests.filter((request) => request.url.includes("/log"))).toEqual([]);
  });
});
