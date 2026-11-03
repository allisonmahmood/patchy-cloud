// `patchy request` and `patchy feedback` through the bundled CLI: what they send, their two
// outputs, what they check before sending, and how each refusal, an instance without them and a
// lost answer exit.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cliPath, exec, type Recorded, runCli, stubInstance, tempDir } from "./test/cli.js";

const env = (url: string) => ({ PATCHY_API_URL: url, PATCHY_API_TOKEN: "pp_member" });
/** An id of the shape the store mints: its prefix, then 24 lowercase letters and digits. */
const minted = (prefix: "req" | "fbk", name: string) => `${prefix}_${name.padEnd(24, "0")}`;
const rsa = minted("req", "rsa");
const tls = minted("req", "tls");
const gmail = minted("req", "gmail");
const odd = minted("fbk", "odd");
const slow = minted("fbk", "slow");
const general = {
  id: "gen_encryption",
  title: "Postgres encryption options",
  status: "shipped",
  note: "Every Postgres connection is encrypted with TLS."
} as const;
const sibling = { id: tls, title: "Postgres connection over TLS only", status: "open" };
const filed = { ok: true, id: rsa, similar: [general, sibling] };
/** What an instance without the requests and feedback routes answers on them. */
const unknownRoute = { ok: false, error: "Not found." };
type Log = ReadonlyArray<Recorded>;
/** What the CLI sent the API; a local port probe's stray `GET /` can land in the stub's log too. */
const api = (requests: Log) => requests.filter((request) => request.url.startsWith("/api/"));
const lastSent = (requests: Log) => api(requests).at(-1);
const posts = (requests: Log, url: string) =>
  api(requests).filter((request) => request.method === "POST" && request.url === url);

/** The bundled CLI with stdin from a shell producer, such as `yes`, which never ends by itself. */
const pipeInto = async (producer: string, args: ReadonlyArray<string>, url: string) => {
  const home = tempDir();
  try {
    const { stdout, stderr } = await exec(
      "sh",
      ["-c", `${producer} | "$0" "$@"`, process.execPath, cliPath, ...args],
      { env: { PATH: process.env.PATH ?? "", HOME: home, PATCHY_STATE_DIR: home, ...env(url) } }
    );
    return { status: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { status: code, stdout, stderr };
  }
};

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
      id: rsa,
      similar: [
        { ...general, link: `patchy request link ${rsa} gen_encryption` },
        { ...sibling, link: `patchy request link ${rsa} ${tls}` }
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
      `Sent request ${rsa} to Patchy's team.`,
      "Similar requests:",
      "  gen_encryption  shipped  Postgres encryption options",
      "    Every Postgres connection is encrypted with TLS.",
      `    Link: patchy request link ${rsa} gen_encryption`,
      `  ${tls}  open  Postgres connection over TLS only`,
      `    Link: patchy request link ${rsa} ${tls}`,
      expect.stringMatching(/^Nothing else is required\. Link a match only/)
    ]);
  });

  it("quotes a match id the shell would split, so its link command runs as one command", async () => {
    const ids = ["gen_demo; printf injected", "gen_it's $(id)"];
    const instance = await stubInstance((_request, respond) =>
      respond(201, {
        ok: true,
        id: rsa,
        similar: ids.map((id) => ({ id, title: "Postgres encryption", status: "open" }))
      })
    );
    const result = await runCli(["request", "Postgres encrypted with RSA", "--json"], {
      env: env(instance.url)
    });
    const links: ReadonlyArray<string> = JSON.parse(result.stdout).similar.map(
      (match: { link: string }) => match.link
    );
    expect(links).toEqual([
      `patchy request link ${rsa} 'gen_demo; printf injected'`,
      `patchy request link ${rsa} 'gen_it'\\''s $(id)'`
    ]);
    // Followed verbatim, each is one command whose last argument is the id as the instance sent it.
    for (const [index, link] of links.entries()) {
      const { stdout } = await exec("sh", ["-c", `patchy() { printf '%s\\n' "$@"; }; ${link}`]);
      expect(stdout).toBe(`request\nlink\n${rsa}\n${ids[index]}\n`);
    }
  });

  it("says nothing else is required when nothing is similar", async () => {
    const instance = await stubInstance((_request, respond) =>
      respond(201, { ok: true, id: gmail, similar: [] })
    );
    const result = await runCli(["request", "Gmail integration", "--json"], {
      env: env(instance.url)
    });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      id: gmail,
      similar: [],
      next: "Nothing else is required."
    });
  });

  it("names the patch of the repo it runs in, and none from a patchy.json it can't read", async () => {
    const instance = await stubInstance((request, respond) =>
      request.url === "/api/requests"
        ? respond(201, { ok: true, id: gmail, similar: [] })
        : respond(201, { ok: true, id: odd })
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
      respond(201, { ok: true, id: gmail, similar: [] })
    );
    const why = "Sales reads every reply.\nThey live in Gmail.\n";
    const piped = await runCli(["request", "Gmail integration", "--why", "-"], {
      env: env(instance.url),
      input: why
    });
    expect(piped, piped.stderr).toMatchObject({ status: 0 });
    expect(lastSent(instance.requests)?.body).toEqual({ text: "Gmail integration", why });

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
      if (request.method === "PUT" && request.url === `/api/requests/${rsa}/link`)
        return respond(200, { ok: true, id: rsa, link: general });
      if (request.method === "DELETE" && request.url === `/api/requests/${rsa}/link`)
        return respond(200, { ok: true, id: rsa, link: null });
      if (request.method === "DELETE" && request.url === `/api/submissions/${rsa}`)
        return respond(200, { ok: true, id: rsa });
      respond(404, unknownRoute);
    });
    const link = ["request", "link", rsa, "gen_encryption", "--why", "TLS covers it"];
    const linked = await runCli([...link, "--json"], { env: env(instance.url) });
    expect(linked, linked.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(linked.stdout)).toEqual({ ok: true, id: rsa, link: general });
    expect(lastSent(instance.requests)).toMatchObject({
      body: { to: "gen_encryption", why: "TLS covers it" },
      patchyCli: expect.stringMatching(/^\S+ request \S+$/)
    });
    expect((await runCli(link, { env: env(instance.url) })).stdout.trim().split("\n")).toEqual([
      `Linked ${rsa} to gen_encryption  shipped  Postgres encryption options`,
      "  Every Postgres connection is encrypted with TLS."
    ]);

    const unlinked = await runCli(["request", "unlink", rsa, "--json"], {
      env: env(instance.url)
    });
    expect(JSON.parse(unlinked.stdout)).toEqual({ ok: true, id: rsa, link: null });

    const withdrawn = await runCli(["request", "withdraw", rsa], { env: env(instance.url) });
    expect(withdrawn, withdrawn.stderr).toMatchObject({ status: 0 });
    expect(withdrawn.stdout.trim()).toBe(`Withdrew ${rsa}: it is deleted.`);
    expect(
      JSON.parse(
        (await runCli(["request", "withdraw", rsa, "--json"], { env: env(instance.url) })).stdout
      )
    ).toEqual({ ok: true, id: rsa });
  });
});

describe("patchy feedback", () => {
  it("sends the note and prints its id", async () => {
    const instance = await stubInstance((request, respond) =>
      request.method === "POST" && request.url === "/api/feedback"
        ? respond(201, { ok: true, id: odd })
        : respond(404, unknownRoute)
    );
    const note = "Ran patchy publish; expected a URL; it printed nothing.";
    const json = await runCli(["feedback", note, "--json"], { env: env(instance.url) });
    expect(json, json.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, id: odd });
    expect(lastSent(instance.requests)).toMatchObject({
      body: { text: note },
      patchyCli: expect.stringMatching(/^\S+ feedback \S+$/)
    });

    const piped = await runCli(["feedback", "-"], { env: env(instance.url), input: `${note}\n` });
    expect(piped.stdout.trim()).toBe(`Sent feedback ${odd} to Patchy's team.`);
    expect(lastSent(instance.requests)?.body).toEqual({ text: `${note}\n` });
  });

  it("lists a page of the person's own, then the next by its cursor", async () => {
    const page = {
      submissions: [
        {
          id: odd,
          kind: "feedback",
          createdAt: "2026-11-03T17:50:00.000Z",
          surface: "cli",
          agent: "claude-code"
        },
        {
          id: slow,
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
      `${odd}  2026-11-03T17:50:00.000Z  (cli, claude-code)`,
      `${slow}  2026-11-03T17:40:00.000Z  (dashboard)`,
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

describe("before sending", () => {
  it("checks each text against the store's bounds, in characters, and sends nothing past them", async () => {
    const instance = await stubInstance((request, respond) =>
      request.method === "POST" && request.url === "/api/requests"
        ? respond(201, { ok: true, id: gmail, similar: [] })
        : respond(404, unknownRoute)
    );
    const long = "x".repeat(4_001);
    for (const [args, input, error] of [
      [["request", "-"], "", "The request must be 3–200 characters; it is 0. Nothing was sent."],
      [
        ["request", "x".repeat(201)],
        "",
        "The request must be 3–200 characters; it is 201. Nothing was sent."
      ],
      [
        ["request", "Gmail", "--why", long],
        "",
        "--why must be at most 4,000 characters; it is 4,001. Nothing was sent."
      ],
      [
        ["request", "link", rsa, "gen_encryption", "--why", long],
        "",
        "--why must be at most 4,000 characters; it is 4,001. Nothing was sent."
      ],
      [
        ["feedback", "  "],
        "",
        "The feedback must be 1–4,000 characters; it is 0. Nothing was sent."
      ],
      [
        ["feedback", "-"],
        "y".repeat(100_000),
        "The feedback on stdin is longer than 4,000 characters. Nothing was sent."
      ]
    ] as const) {
      const result = await runCli([...args, "--json"], { env: env(instance.url), input });
      expect(result.status, args.join(" ").slice(0, 60)).toBe(1);
      expect(JSON.parse(result.stderr)).toEqual({ ok: false, kind: "local", error });
    }
    expect(api(instance.requests)).toHaveLength(0);

    // A title at the bound counts characters, not UTF-16 code units, as the store does.
    const emoji = await runCli(["request", "🙂".repeat(200)], { env: env(instance.url) });
    expect(emoji, emoji.stderr).toMatchObject({ status: 0 });
    expect(api(instance.requests)).toHaveLength(1);
  });

  it("stops reading an endless stdin at the bound, and refuses stdin that isn't UTF-8", async () => {
    const instance = await stubInstance((_request, respond) => respond(201, { ok: true, id: odd }));
    // `timeout` ends `yes` only if the CLI kept reading, which would fail the expectation below.
    const endless = await pipeInto("timeout 20 yes", ["feedback", "-", "--json"], instance.url);
    expect(endless.status).toBe(1);
    expect(JSON.parse(endless.stderr).error).toBe(
      "The feedback on stdin is longer than 4,000 characters. Nothing was sent."
    );

    const latin1 = await pipeInto("printf 'caf\\351'", ["feedback", "-", "--json"], instance.url);
    expect(latin1.status).toBe(1);
    expect(JSON.parse(latin1.stderr).error).toBe("stdin isn't valid UTF-8. Nothing was sent.");
    expect(api(instance.requests)).toHaveLength(0);
  });

  it("refuses an id the store couldn't have minted, before it goes in a path", async () => {
    const instance = await stubInstance((_request, respond) =>
      respond(200, { ok: true, id: rsa, link: { id: "gen_it's", title: "TLS", status: "open" } })
    );
    for (const [args, error] of [
      [
        ["request", "unlink", `req_${"a".repeat(97)}`],
        `"req_${"a".repeat(97)}" isn't a request id`
      ],
      [["feedback", "withdraw", rsa], `"${rsa}" isn't a feedback id`],
      [["request", "link", odd, "gen_encryption"], `"${odd}" isn't a request id`]
    ] as const) {
      const result = await runCli([...args, "--json"], { env: env(instance.url) });
      expect(result.status, args.join(" ")).toBe(1);
      expect(JSON.parse(result.stderr).error).toContain(error);
    }
    expect(api(instance.requests)).toHaveLength(0);

    // A match id travels in the body and is the instance's to judge: a general request's has no shape.
    const linked = await runCli(["request", "link", rsa, "gen_it's"], { env: env(instance.url) });
    expect(linked, linked.stderr).toMatchObject({ status: 0 });
    expect(lastSent(instance.requests)?.body).toEqual({ to: "gen_it's" });
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
      ["request", "link", rsa, rsa],
      ["request", "unlink", tls],
      ["feedback", "withdraw", slow]
    ]) {
      const result = await runCli([...args, "--json"], { env: env(instance.url) });
      expect(result.status, args.join(" ")).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        kind: "rejected",
        code: args[1] === "link" ? "invalid_link" : "not_found"
      });
    }
  });

  it("an instance without requests and feedback is exit 2, saying it doesn't take them yet", async () => {
    const instance = await stubInstance((_request, respond) => respond(404, unknownRoute));
    for (const [kind, ...args] of [
      ["request", "Gmail integration"],
      ["request", "link", rsa, "gen_encryption"],
      ["request", "unlink", rsa],
      ["request", "list"],
      ["request", "withdraw", rsa],
      ["feedback", "Something odd"],
      ["feedback", "list"],
      ["feedback", "withdraw", odd]
    ] as const) {
      const result = await runCli([kind, ...args, "--json"], { env: env(instance.url) });
      expect(result.status, `${kind} ${args.join(" ")}`).toBe(2);
      expect(JSON.parse(result.stderr)).toEqual({
        ok: false,
        kind: "rejected",
        error: `${instance.url} doesn't take ${kind === "request" ? "requests" : "feedback"} yet.`
      });
    }
  });

  it("a send whose answer is lost or unreadable is exit 3, sent once, and says to check the list first", async () => {
    let answer: "drop" | "502" | "garbled" | "unreadable refusal" = "drop";
    const instance = await stubInstance((_request, respond, disconnect) =>
      answer === "drop"
        ? disconnect()
        : answer === "502"
          ? respond(502, { message: "Bad gateway" })
          : answer === "garbled"
            ? respond(201, { ok: true })
            : // A declared refusal's status with a body that isn't JSON at all.
              respond(422, undefined)
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

    for (const unreadable of ["garbled", "unreadable refusal"] as const) {
      answer = unreadable;
      const result = await runCli(["feedback", "Something odd", "--json"], {
        env: env(instance.url)
      });
      expect(result.status, unreadable).toBe(3);
      expect(JSON.parse(result.stderr)).toEqual({
        ok: false,
        kind: "unreachable",
        error:
          `${instance.url} answered with a body the CLI could not read, so the feedback may have been stored anyway.\n` +
          "Run patchy feedback list to check before sending it again."
      });
    }
    expect(posts(instance.requests, "/api/feedback")).toHaveLength(3);
  });
});
