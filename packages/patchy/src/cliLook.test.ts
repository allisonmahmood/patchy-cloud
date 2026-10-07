// `patchy look`, `look publish`, `look restore` and `look preview` through the bundled CLI.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateHtml } from "@patchy/core";
import { lookFixtureDir, readLookFixture } from "../../../test/look-fixtures.js";
import { runCli, stubInstance, tempDir } from "./test/cli.js";

const ada = { id: "usr_ada", name: "Ada Lovelace" };
const second = {
  revision: 2,
  author: ada,
  createdAt: "2026-10-07T09:30:00.000Z",
  note: "darker green"
};
const first = {
  revision: 1,
  author: ada,
  createdAt: "2026-10-06T16:00:00.000Z",
  note: "first capture"
};
const admins = [ada, { id: "usr_cleo", name: "Cleo Park" }];
const memberRefusal = {
  ok: false,
  code: "admin_required",
  error: "Only an admin can change Acme Co's look. Ask Ada Lovelace or Cleo Park.",
  admins
};
const env = (url: string) => ({ PATCHY_API_URL: url, PATCHY_API_TOKEN: "pp_token" });
const lookDir = () => {
  const dir = path.join(tempDir(), "look");
  cpSync(lookFixtureDir("patchy"), dir, { recursive: true });
  return dir;
};

describe("patchy look", () => {
  it("prints the current revision, its files and the history, with contents under --json", async () => {
    const look = {
      current: { ...second, files: readLookFixture("patchy") },
      revisions: [second, first]
    };
    const instance = await stubInstance((request, respond) =>
      request.method === "GET" && request.url === "/api/look"
        ? respond(200, look)
        : respond(404, { ok: false, error: "Not found." })
    );
    const json = await runCli(["look", "--json"], { env: env(instance.url) });
    expect(json, json.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual(look);
    expect(instance.requests[0]?.patchyCli).toMatch(/^\S+ look \S+$/);

    const text = await runCli(["look"], { env: env(instance.url) });
    expect(text, text.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(text.stdout).toContain("Revision 2 is the company's look.");
    expect(text.stdout).toContain("By Ada Lovelace on 2026-10-07: darker green");
    expect(text.stdout).toMatch(/look\.css \(\d+\.\d KiB\), LOOK\.md \(\d+\.\d KiB\), logo\.svg/);
    expect(text.stdout).toContain("1  2026-10-06  Ada Lovelace  first capture");
  });

  it("says when the company has no look", async () => {
    const instance = await stubInstance((_request, respond) =>
      respond(200, { current: null, revisions: [first] })
    );
    const text = await runCli(["look"], { env: env(instance.url) });
    expect(text, text.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(text.stdout).toContain("The company has no look.");
    expect(text.stdout).toContain("1  2026-10-06  Ada Lovelace  first capture");
  });
});

describe("patchy look publish", () => {
  it("sends the folder's three files and the note, and prints the new revision", async () => {
    const instance = await stubInstance((request, respond) =>
      request.method === "POST" && request.url === "/api/look/publish"
        ? respond(201, { ok: true, current: second })
        : respond(404, { ok: false, error: "Not found." })
    );
    const dir = lookDir();
    const result = await runCli(["look", "publish", dir, "--note", "darker green", "--json"], {
      env: env(instance.url)
    });
    expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, current: second });
    expect(instance.requests.at(-1)?.body).toEqual({
      note: "darker green",
      files: readLookFixture("patchy")
    });
    expect(instance.requests.at(-1)?.patchyCli).toMatch(/^\S+ look \S+$/);

    // Anything else in the folder is named, not sent.
    writeFileSync(path.join(dir, "logo.png"), "png");
    writeFileSync(path.join(dir, ".DS_Store"), "");
    const ignored =
      "Not published: logo.png. A look is look.css, LOOK.md and an optional logo.svg; embed fonts and images in them as data: URLs.";
    const json = await runCli(["look", "publish", dir, "--note", "darker green", "--json"], {
      env: env(instance.url)
    });
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, current: second, warnings: [ignored] });
    const text = await runCli(["look", "publish", dir, "--note", "darker green"], {
      env: env(instance.url)
    });
    expect(text, text.stderr).toMatchObject({ status: 0, stderr: `Warning: ${ignored}\n` });
  });

  it("refuses a look that fails its checks, an incomplete folder and an empty note before sending", async () => {
    const instance = await stubInstance((_request, respond) =>
      respond(201, { ok: true, current: second })
    );
    const faint = lookDir();
    const css = readLookFixture("patchy")["look.css"];
    writeFileSync(
      path.join(faint, "look.css"),
      css.replace("--look-muted: #69645a;", "--look-muted: #7d786d;")
    );
    const failing = await runCli(["look", "publish", faint, "--note", "faint", "--json"], {
      env: env(instance.url)
    });
    expect(failing.status).toBe(1);
    expect(JSON.parse(failing.stderr)).toEqual({
      ok: false,
      kind: "local",
      code: "invalid_look",
      error:
        "The look failed its checks; nothing was published.\n" +
        "- --look-muted on --look-bg is 4.31:1; text colours need 4.5:1.\n" +
        "- --look-muted on --look-surface is 4.35:1; text colours need 4.5:1."
    });

    const incomplete = lookDir();
    rmSync(path.join(incomplete, "LOOK.md"));
    const missing = await runCli(["look", "publish", incomplete, "--note", "no brief"], {
      env: env(instance.url)
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`No LOOK.md in ${incomplete}.`);

    const blank = await runCli(["look", "publish", lookDir(), "--note", "  "], {
      env: env(instance.url)
    });
    expect(blank.status).toBe(1);
    expect(blank.stderr).toContain("A look note must not be empty.");
    expect(instance.requests.filter(({ url }) => url.startsWith("/api/look"))).toEqual([]);
  });

  it("relays a member's refusal with the admins to ask", async () => {
    const instance = await stubInstance((_request, respond) => respond(403, memberRefusal));
    const json = await runCli(["look", "publish", lookDir(), "--note", "mine", "--json"], {
      env: env(instance.url)
    });
    expect(json.status).toBe(2);
    expect(JSON.parse(json.stderr)).toEqual({ ...memberRefusal, kind: "rejected" });
    const text = await runCli(["look", "restore", "1"], { env: env(instance.url) });
    expect(text.status).toBe(2);
    expect(text.stderr.trim()).toBe(memberRefusal.error);
  });
});

describe("patchy look restore", () => {
  it("restores a revision or none, and refuses anything else", async () => {
    const instance = await stubInstance((request, respond) => {
      const body = request.body as { revision: number | null };
      if (body.revision === 7)
        return respond(422, {
          ok: false,
          code: "revision_unavailable",
          error: "Acme Co has no look revision 7."
        });
      respond(200, { ok: true, current: body.revision === null ? null : first });
    });
    const one = await runCli(["look", "restore", "1", "--json"], { env: env(instance.url) });
    expect(one, one.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(one.stdout)).toEqual({ ok: true, current: first });
    const none = await runCli(["look", "restore", "none"], { env: env(instance.url) });
    expect(none, none.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(none.stdout).toContain("The company has no look now.");
    expect(instance.requests.map(({ url, body }) => [url, body])).toEqual([
      ["/api/look/restore", { revision: 1 }],
      ["/api/look/restore", { revision: null }]
    ]);

    const unknown = await runCli(["look", "restore", "7", "--json"], { env: env(instance.url) });
    expect(unknown.status).toBe(2);
    expect(JSON.parse(unknown.stderr)).toMatchObject({ code: "revision_unavailable" });
    const invalid = await runCli(["look", "restore", "latest"], { env: env(instance.url) });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Pass a revision number, or none");
  });
});

describe("patchy look preview", () => {
  const preview = (stateDir: string) =>
    readFileSync(path.join(stateDir, "look-preview.html"), "utf8");

  it("renders a candidate offline with its logo, and names each failure exactly as publish would", async () => {
    const instance = await stubInstance((_request, respond) => respond(404, {}));
    const dir = lookDir();
    const css = readLookFixture("patchy")["look.css"];
    writeFileSync(
      path.join(dir, "look.css"),
      css.replace("--look-muted: #69645a;", "--look-muted: #7d786d;")
    );
    const json = await runCli(["look", "preview", dir, "--json"], { env: env(instance.url) });
    expect(json, json.stderr).toMatchObject({ status: 0, stderr: "" });
    const failures = [
      "--look-muted on --look-bg is 4.31:1; text colours need 4.5:1.",
      "--look-muted on --look-surface is 4.35:1; text colours need 4.5:1."
    ];
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      path: path.join(json.stateDir, "look-preview.html"),
      failures
    });
    const page = preview(json.stateDir);
    expect(page).toContain("--look-muted: #7d786d;");
    const logo = readLookFixture("patchy")["logo.svg"] ?? "";
    expect(page).toContain(`data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`);
    expect(page).not.toContain("<iframe");
    // A member's agent can publish it as a tier 0 page to show an admin.
    expect(validateHtml(page)).toMatchObject({ ok: true });

    const text = await runCli(["look", "preview", dir], { env: env(instance.url) });
    expect(text, text.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(text.stdout).toContain(
      `Wrote the look preview: ${path.join(text.stateDir, "look-preview.html")}`
    );
    expect(text.stdout).toContain(
      `look publish would refuse this look:\n- ${failures.join("\n- ")}`
    );
    expect(instance.requests).toEqual([]);
  });

  it("shows the candidate beside the current look, or alone when the company has none", async () => {
    let current: unknown = { ...second, files: readLookFixture("linear") };
    const instance = await stubInstance((request, respond) =>
      request.method === "GET" && request.url === "/api/look"
        ? respond(200, { current, revisions: [second, first] })
        : respond(404, { ok: false, error: "Not found." })
    );
    const dir = lookDir();
    const beside = await runCli(["look", "preview", dir, "--compare", "--json"], {
      env: env(instance.url)
    });
    expect(beside, beside.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(beside.stdout)).toMatchObject({ ok: true, failures: [] });
    const frames = [...preview(beside.stateDir).matchAll(/<iframe title="([^"]*)"/g)];
    expect(frames.map(([, title]) => title)).toEqual([
      "Candidate",
      "Revision 2, the company&#39;s look"
    ]);
    expect(instance.requests.at(-1)?.patchyCli).toMatch(/^\S+ look \S+$/);

    current = null;
    const alone = await runCli(["look", "preview", dir, "--compare"], { env: env(instance.url) });
    expect(alone, alone.stderr).toMatchObject({ status: 0, stderr: "" });
    const page = preview(alone.stateDir);
    expect(page).not.toContain("<iframe");
    expect(page).toContain("The company has no look yet.");
  });

  it("renders the company's look without a folder, and says when there is none", async () => {
    let current: unknown = { ...second, files: readLookFixture("linear") };
    const instance = await stubInstance((_request, respond) =>
      respond(200, { current, revisions: [second] })
    );
    const json = await runCli(["look", "preview", "--json"], { env: env(instance.url) });
    expect(json, json.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, failures: [] });
    expect(preview(json.stateDir)).toContain("<strong>Revision 2, the company's look</strong>");

    current = null;
    const none = await runCli(["look", "preview"], { env: env(instance.url) });
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("The company has no look yet.");
    const requests = instance.requests.length;
    const compare = await runCli(["look", "preview", "--compare"], { env: env(instance.url) });
    expect(compare.status).toBe(1);
    expect(compare.stderr).toContain("patchy look preview <dir> --compare");
    expect(instance.requests).toHaveLength(requests);
  });
});
