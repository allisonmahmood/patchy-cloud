// `patchy request` and `patchy feedback` through the bundled CLI: what they send, their two
// outputs, and how each refusal, an instance from before them and a lost answer exit.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Recorded, runCli, stubInstance, tempDir } from "./test/cli.js";

const env = (url: string) => ({ PATCHY_API_URL: url, PATCHY_API_TOKEN: "pp_member" });
const general = {
  id: "gen_encryption",
  title: "Postgres encryption options",
  status: "shipped",
  note: "Every Postgres connection is encrypted with TLS."
} as const;
const sibling = { id: "req_tls", title: "Postgres connection over TLS only", status: "open" };
const filed = { ok: true, id: "req_rsa", similar: [general, sibling] };
/** What an instance whose release predates requests answers on their routes. */
const unknownRoute = { ok: false, error: "Not found." };
type Log = ReadonlyArray<Recorded>;
/** What the CLI sent the API; a local port probe's stray `GET /` can land in the stub's log too. */
const api = (requests: Log) => requests.filter((request) => request.url.startsWith("/api/"));
const lastSent = (requests: Log) => api(requests).at(-1);
const posts = (requests: Log, url: string) =>
  api(requests).filter((request) => request.method === "POST" && request.url === url);

describe("patchy request", () => {
  it("stores the request and exits 0 with its matches, each with its link command, and what's next", async () => {
    const instance = await stubInstance((request, respond) =>
      request.method === "POST" && request.url === "/api/requests"
        ? respond(201, filed)
        : respond(404, unknownRoute)
    );
    const args = ["request", "Postgres encrypted with RSA", "--why", "Our auditors require RSA"];
    const json = await runCli([...args, "--json"], { env: env(instance.url) });
    expect(json, json.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      id: "req_rsa",
      similar: [
        { ...general, link: "patchy request link req_rsa gen_encryption" },
        { ...sibling, link: "patchy request link req_rsa req_tls" }
      ],
      next:
        "Nothing else is required. Link a match only when it fully meets the need: run its link " +
        "command, with --why saying why it does. A match has shipped: tell the person, using its note."
    });
    // Outside a patch repo the request names no patch.
    expect(lastSent(instance.requests)).toMatchObject({
      body: { text: "Postgres encrypted with RSA", why: "Our auditors require RSA" },
      patchyCli: expect.stringMatching(/^\S+ request \S+$/)
    });

    const text = await runCli(args, { env: env(instance.url) });
    expect(text, text.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(text.stdout.trim().split("\n")).toEqual([
      "Sent request req_rsa to Patchy's team.",
      "Similar requests:",
      "  gen_encryption  shipped  Postgres encryption options",
      "    Every Postgres connection is encrypted with TLS.",
      "    Link: patchy request link req_rsa gen_encryption",
      "  req_tls  open  Postgres connection over TLS only",
      "    Link: patchy request link req_rsa req_tls",
      expect.stringMatching(/^Nothing else is required\. Link a match only/)
    ]);
  });

  it("says nothing else is required when nothing is similar", async () => {
    const instance = await stubInstance((_request, respond) =>
      respond(201, { ok: true, id: "req_gmail", similar: [] })
    );
    const result = await runCli(["request", "Gmail integration", "--json"], {
      env: env(instance.url)
    });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      id: "req_gmail",
      similar: [],
      next: "Nothing else is required."
    });
  });

  it("names the patch of the repo it runs in, and none from a patchy.json it can't read", async () => {
    const instance = await stubInstance((request, respond) =>
      request.url === "/api/requests"
        ? respond(201, { ok: true, id: "req_gmail", similar: [] })
        : respond(201, { ok: true, id: "fbk_odd" })
    );
    const repo = tempDir();
    writeFileSync(
      path.join(repo, "patchy.json"),
      JSON.stringify({ instance: instance.url, patch: "abcdefghijkl", version: 3 })
    );
    for (const args of [
      ["request", "Gmail integration"],
      ["feedback", "Publish was slow"]
    ]) {
      const result = await runCli(args, { env: env(instance.url), cwd: repo });
      expect(result, result.stderr).toMatchObject({ status: 0 });
      expect(lastSent(instance.requests)?.body).toEqual({ text: args[1], patch: "abcdefghijkl" });
    }

    writeFileSync(path.join(repo, "patchy.json"), "{ not JSON");
    const broken = await runCli(["request", "Gmail integration"], {
      env: env(instance.url),
      cwd: repo
    });
    expect(broken, broken.stderr).toMatchObject({ status: 0 });
    expect(lastSent(instance.requests)?.body).toEqual({ text: "Gmail integration" });
  });

  it("reads `-` from stdin, for the request or --why, never both", async () => {
    const instance = await stubInstance((_request, respond) =>
      respond(201, { ok: true, id: "req_gmail", similar: [] })
    );
    const why = "Sales reads every reply.\nThey live in Gmail.\n";
    const piped = await runCli(["request", "Gmail integration", "--why", "-"], {
      env: env(instance.url),
      input: why
    });
    expect(piped, piped.stderr).toMatchObject({ status: 0 });
    expect(lastSent(instance.requests)?.body).toEqual({
      text: "Gmail integration",
      why: "Sales reads every reply.\nThey live in Gmail."
    });

    const both = await runCli(["request", "-", "--why", "-", "--json"], {
      env: env(instance.url),
      input: why
    });
    expect(both.status).toBe(1);
    expect(JSON.parse(both.stderr)).toMatchObject({ kind: "local" });
    expect(api(instance.requests)).toHaveLength(1);
  });

  it("links a request to a match, unlinks it and withdraws it", async () => {
    const instance = await stubInstance((request, respond) => {
      if (request.method === "PUT" && request.url === "/api/requests/req_rsa/link")
        return respond(200, { ok: true, id: "req_rsa", link: general });
      if (request.method === "DELETE" && request.url === "/api/requests/req_rsa/link")
        return respond(200, { ok: true, id: "req_rsa", link: null });
      if (request.method === "DELETE" && request.url === "/api/submissions/req_rsa")
        return respond(200, { ok: true, id: "req_rsa" });
      respond(404, unknownRoute);
    });
    const link = ["request", "link", "req_rsa", "gen_encryption", "--why", "TLS covers it"];
    const linked = await runCli([...link, "--json"], { env: env(instance.url) });
    expect(linked, linked.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(linked.stdout)).toEqual({ ok: true, id: "req_rsa", link: general });
    expect(lastSent(instance.requests)).toMatchObject({
      body: { to: "gen_encryption", why: "TLS covers it" },
      patchyCli: expect.stringMatching(/^\S+ request \S+$/)
    });
    expect((await runCli(link, { env: env(instance.url) })).stdout.trim().split("\n")).toEqual([
      "Linked req_rsa to gen_encryption  shipped  Postgres encryption options",
      "  Every Postgres connection is encrypted with TLS."
    ]);

    const unlinked = await runCli(["request", "unlink", "req_rsa", "--json"], {
      env: env(instance.url)
    });
    expect(JSON.parse(unlinked.stdout)).toEqual({ ok: true, id: "req_rsa", link: null });

    const withdrawn = await runCli(["request", "withdraw", "req_rsa"], { env: env(instance.url) });
    expect(withdrawn, withdrawn.stderr).toMatchObject({ status: 0 });
    expect(withdrawn.stdout.trim()).toBe("Withdrew req_rsa: it is deleted.");
    expect(
      JSON.parse(
        (await runCli(["request", "withdraw", "req_rsa", "--json"], { env: env(instance.url) }))
          .stdout
      )
    ).toEqual({ ok: true, id: "req_rsa" });
  });
});

describe("patchy feedback", () => {
  it("sends the note and prints its id", async () => {
    const instance = await stubInstance((request, respond) =>
      request.method === "POST" && request.url === "/api/feedback"
        ? respond(201, { ok: true, id: "fbk_odd" })
        : respond(404, unknownRoute)
    );
    const note = "Ran patchy publish; expected a URL; it printed nothing.";
    const json = await runCli(["feedback", note, "--json"], { env: env(instance.url) });
    expect(json, json.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, id: "fbk_odd" });
    expect(lastSent(instance.requests)).toMatchObject({
      body: { text: note },
      patchyCli: expect.stringMatching(/^\S+ feedback \S+$/)
    });

    const piped = await runCli(["feedback", "-"], { env: env(instance.url), input: `${note}\n` });
    expect(piped.stdout.trim()).toBe("Sent feedback fbk_odd to Patchy's team.");
    expect(lastSent(instance.requests)?.body).toEqual({ text: note });
  });

  it("lists a page of the person's own, then the next by its cursor", async () => {
    const page = {
      submissions: [
        {
          id: "fbk_odd",
          kind: "feedback",
          createdAt: "2026-11-03T17:50:00.000Z",
          surface: "cli",
          agent: "claude-code"
        },
        {
          id: "fbk_page",
          kind: "feedback",
          createdAt: "2026-11-03T17:40:00.000Z",
          surface: "dashboard",
          agent: null
        }
      ],
      nextCursor: "c_2"
    };
    const instance = await stubInstance((request, respond) => {
      const url = new URL(request.url, "http://instance.test");
      if (request.method !== "GET" || url.pathname !== "/api/submissions")
        return respond(404, unknownRoute);
      if (url.searchParams.get("cursor") === "bad")
        return respond(400, { ok: false, error: "Invalid cursor: send a page's `nextCursor`." });
      respond(200, url.searchParams.has("cursor") ? { submissions: [], nextCursor: null } : page);
    });
    const json = await runCli(["feedback", "list", "--json"], { env: env(instance.url) });
    expect(json, json.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual(page);
    expect(lastSent(instance.requests)?.url).toBe("/api/submissions?kind=feedback");

    const text = await runCli(["feedback", "list"], { env: env(instance.url) });
    expect(text.stdout.trim().split("\n")).toEqual([
      "fbk_odd  2026-11-03T17:50:00.000Z  (cli, claude-code)",
      "fbk_page  2026-11-03T17:40:00.000Z  (dashboard)",
      "More: patchy feedback list --cursor c_2"
    ]);

    const last = await runCli(["feedback", "list", "--cursor", "c_2"], { env: env(instance.url) });
    expect(lastSent(instance.requests)?.url).toBe("/api/submissions?kind=feedback&cursor=c_2");
    expect(last.stdout.trim()).toBe("You have sent no feedback.");

    const bad = await runCli(["feedback", "list", "--cursor", "bad"], { env: env(instance.url) });
    expect(bad).toMatchObject({
      status: 2,
      stderr: "Invalid cursor: send a page's `nextCursor`.\n"
    });
  });
});

describe("refusals", () => {
  it.each([
    {
      status: 422,
      body: {
        ok: false,
        code: "contains_secret",
        error:
          "Nothing was stored: `why` holds a GitHub token. Remove it, or replace it with <token>, and send it again.",
        secrets: [{ field: "why", kind: "github_token" }]
      }
    },
    {
      status: 422,
      body: {
        ok: false,
        code: "invalid_text",
        error: "Nothing was stored: `text` must be 3–200 characters, with no control characters.",
        field: "text"
      }
    },
    {
      status: 429,
      body: {
        ok: false,
        code: "rate_limited",
        error:
          "Nothing was stored: a person sends at most 10 requests and feedback a minute. Send it again in 42 seconds.",
        retryAfterSeconds: 42
      }
    }
  ])("$body.code is exit 2 in the instance's words", async ({ status, body }) => {
    const instance = await stubInstance((_request, respond) => respond(status, body));
    const json = await runCli(["request", "Gmail integration", "--json"], {
      env: env(instance.url)
    });
    expect(json).toMatchObject({ status: 2, stdout: "" });
    expect(JSON.parse(json.stderr)).toMatchObject({
      ok: false,
      error: body.error,
      kind: "rejected",
      code: body.code
    });
    const text = await runCli(["feedback", "Something odd"], { env: env(instance.url) });
    expect(text).toMatchObject({ status: 2, stderr: `${body.error}\n` });
  });

  it("relays not_found and invalid_link from link, unlink and withdraw as exit 2", async () => {
    const instance = await stubInstance((request, respond) =>
      request.method === "PUT"
        ? respond(422, { ok: false, code: "invalid_link", error: "Nothing changed: no." })
        : respond(404, { ok: false, code: "not_found", error: "You sent nothing with that id." })
    );
    for (const args of [
      ["request", "link", "req_rsa", "req_rsa"],
      ["request", "unlink", "req_gone"],
      ["feedback", "withdraw", "fbk_gone"]
    ]) {
      const result = await runCli([...args, "--json"], { env: env(instance.url) });
      expect(result.status, args.join(" ")).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        kind: "rejected",
        code: args[1] === "link" ? "invalid_link" : "not_found"
      });
    }
  });

  it("an instance from before requests and feedback is exit 2, saying it doesn't take them yet", async () => {
    const instance = await stubInstance((_request, respond) => respond(404, unknownRoute));
    for (const [kind, ...args] of [
      ["request", "Gmail integration"],
      ["request", "link", "req_rsa", "gen_encryption"],
      ["request", "unlink", "req_rsa"],
      ["request", "list"],
      ["request", "withdraw", "req_rsa"],
      ["feedback", "Something odd"],
      ["feedback", "list"],
      ["feedback", "withdraw", "fbk_odd"]
    ] as const) {
      const result = await runCli([kind, ...args, "--json"], { env: env(instance.url) });
      expect(result.status, `${kind} ${args.join(" ")}`).toBe(2);
      expect(JSON.parse(result.stderr)).toEqual({
        ok: false,
        kind: "rejected",
        error: `${instance.url} doesn't take ${kind === "request" ? "requests" : "feedback"} yet: it runs a Patchy release from before them.`
      });
    }
  });

  it("a send whose answer is lost is exit 3, sent once, and says to check the list first", async () => {
    let answer: "drop" | "502" | "garbled" = "drop";
    const instance = await stubInstance((_request, respond, disconnect) =>
      answer === "drop"
        ? disconnect()
        : answer === "502"
          ? respond(502, { message: "Bad gateway" })
          : respond(201, { ok: true })
    );
    const dropped = await runCli(["request", "Gmail integration"], { env: env(instance.url) });
    expect(dropped.status).toBe(3);
    expect(dropped.stderr).toBe(
      `${instance.url} could not be reached, or dropped the connection, so the request may have been stored anyway.\n` +
        "Run patchy request list to check before sending it again.\n"
    );
    expect(posts(instance.requests, "/api/requests")).toHaveLength(1);

    answer = "502";
    const failed = await runCli(["feedback", "Something odd", "--json"], {
      env: env(instance.url)
    });
    expect(failed.status).toBe(3);
    expect(JSON.parse(failed.stderr)).toEqual({
      ok: false,
      kind: "unreachable",
      error:
        `${instance.url} answered 502, so the feedback may have been stored anyway.\n` +
        "Run patchy feedback list to check before sending it again."
    });
    expect(posts(instance.requests, "/api/feedback")).toHaveLength(1);

    answer = "garbled";
    const garbled = await runCli(["feedback", "Something odd"], { env: env(instance.url) });
    expect(garbled.status).toBe(3);
    expect(garbled.stderr).toContain(
      "answered with a body the CLI could not read, so the feedback may have been stored anyway."
    );
  });
});
