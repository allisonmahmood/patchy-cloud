import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectEvidence,
  deploymentRange,
  makeDraft,
  requestNotes,
  validateResponse
} from "./release-notes.mjs";

let cwd, base, feature, internal, reverted, other;
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const commit = (title, content) => {
  writeFileSync(join(cwd, "packages/page.txt"), content);
  git("add", ".");
  git("commit", "-qm", title);
  return git("rev-parse", "HEAD");
};
beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "patchy-notes-"));
  git("init", "-q");
  git("config", "user.name", "Notes test");
  git("config", "user.email", "notes@patchy.local");
  mkdirSync(join(cwd, "packages"));
  mkdirSync(join(cwd, "docs"));
  writeFileSync(
    join(cwd, "docs/product.md"),
    "People can open company tools and invite teammates."
  );
  base = commit("baseline", "Old sign-in");
  feature = commit("fix(ui): show the waitlist", "Join the waitlist");
  internal = commit("chore: internal metadata", "Join the waitlist\ninternal");
  reverted = commit("revert feature", "Old sign-in");
  git("checkout", "-qb", "other", base);
  other = commit("other branch", "Different");
  git("checkout", "--detach", reverted);
});
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
const evidence = () => ({
  repository: "patchy/cloud",
  from: base,
  to: internal,
  kind: "forward",
  commits: [{ sha: feature }, { sha: internal }]
});
const response = () => ({
  title: "Clearer sign-in",
  summary: "Find the right way into Patchy.",
  changes: [
    {
      kind: "Fixed",
      title: "Join the waitlist",
      detail: "The sign-in page now offers a waitlist link.",
      sources: [feature]
    }
  ],
  omitted: [{ commit: internal, reason: "internal" }]
});

describe("deployment evidence", () => {
  it("uses the explicit deployed range, not HEAD, and distinguishes rollback and repeat", () => {
    expect(deploymentRange(cwd, base, internal)).toMatchObject({
      kind: "forward",
      commits: [feature, internal]
    });
    expect(deploymentRange(cwd, internal, base).kind).toBe("rollback");
    expect(deploymentRange(cwd, internal, internal).kind).toBe("unchanged");
    expect(deploymentRange(cwd, null, internal).kind).toBe("initial");
    expect(() => deploymentRange(cwd, other, internal)).toThrow("diverged");
    expect(() => deploymentRange(cwd, "--all", internal)).toThrow("full commit");
  });
  it("keeps direct commits, ignores unrelated PRs, and supplies the net diff to catch reversions", async () => {
    const result = await collectEvidence({
      cwd,
      from: base,
      to: reverted,
      repository: "patchy/cloud",
      loadPullRequests: async (sha) => [
        {
          number: 2,
          title: "Wrong PR",
          body: "Do not announce",
          merged_at: "today",
          merge_commit_sha: other,
          base: { repo: { full_name: "patchy/cloud" } }
        },
        ...(sha === feature
          ? [
              {
                number: 1,
                title: "Clearer sign-in",
                body: "Start at the invitation email.",
                merged_at: "today",
                merge_commit_sha: feature,
                base: { repo: { full_name: "patchy/cloud" } }
              }
            ]
          : [])
      ]
    });
    expect(result.commits).toHaveLength(3);
    expect(result.commits[0].pullRequests.map((pr) => pr.number)).toEqual([1]);
    expect(result.commits[1].pullRequests).toEqual([]);
    expect(result.netDiff).toBe("");
  });
});
describe("draft validation", () => {
  it("keeps provenance outside display notes and does not assign a publication sequence or date", () => {
    const draft = makeDraft(evidence(), response(), "test-model");
    expect(draft.notes.changes[0]).not.toHaveProperty("sources");
    expect(draft.provenance.changes).toEqual([[feature]]);
    expect(draft).not.toHaveProperty("sequence");
    expect(draft).not.toHaveProperty("publishedAt");
  });
  it.each(["foreign", "missing", "both", "markup", "uncertain", "extra"])(
    "rejects %s evidence/output",
    (kind) => {
      const value = response();
      if (kind === "foreign") value.changes[0].sources = [other];
      if (kind === "missing") value.omitted = [];
      if (kind === "both") value.omitted.push({ commit: feature, reason: "internal" });
      if (kind === "markup") value.changes[0].detail = "<script>alert(1)</script>";
      if (kind === "uncertain") value.omitted[0].reason = "insufficient-evidence";
      if (kind === "extra") value.sequence = 7;
      expect(() => validateResponse(value, evidence())).toThrow();
    }
  );
  it("preserves concrete internal-work summaries and neutral repeat/rollback copy", () => {
    const value = {
      title: "More complete activity reporting",
      summary: "Patchy now records company membership changes in its internal usage reports.",
      changes: [],
      omitted: [feature, internal].map((commit) => ({ commit, reason: "internal" }))
    };
    expect(makeDraft(evidence(), value).notes).toMatchObject({
      title: value.title,
      summary: value.summary,
      changes: []
    });
    for (const kind of ["unchanged", "rollback"]) {
      expect(makeDraft({ ...evidence(), kind }, null).notes.changes).toEqual([]);
    }
  });
});
describe("model boundary", () => {
  it("sends only bounded evidence with strict JSON output and no tools or persistence", async () => {
    let payload;
    const result = await requestNotes(evidence(), {
      apiKey: "test-key",
      model: "test-model",
      request: async (url, init) => {
        expect(url).toBe("https://api.openai.com/v1/responses");
        payload = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: JSON.stringify(response()) }]
              }
            ]
          })
        };
      }
    });
    expect(result).toEqual(response());
    expect(payload.store).toBe(false);
    expect(payload.text.format.strict).toBe(true);
    expect(payload).not.toHaveProperty("tools");
  });
  it("does not turn an API failure, refusal or truncation into maintenance notes", async () => {
    await expect(requestNotes(evidence(), { apiKey: "" })).rejects.toThrow("RELEASE_NOTES_API_KEY");
    for (const body of [
      { status: "incomplete" },
      {
        status: "completed",
        output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }]
      }
    ]) {
      await expect(
        requestNotes(evidence(), {
          apiKey: "test",
          model: "test",
          request: async () => ({ ok: true, json: async () => body })
        })
      ).rejects.toThrow();
    }
    await expect(
      requestNotes(evidence(), {
        apiKey: "test",
        model: "test",
        request: async () => ({ ok: false, status: 429 })
      })
    ).rejects.toThrow("HTTP 429");
  });
});

it("counts a merge once instead of duplicating the branch's commits", () => {
  git("checkout", "-qb", "notes-side", base);
  writeFileSync(join(cwd, "packages/side.txt"), "Another change");
  git("add", ".");
  git("commit", "-qm", "side change");
  const side = git("rev-parse", "HEAD");
  git("checkout", "--detach", reverted);
  git("merge", "--no-ff", "-m", "Merge side", "notes-side");
  const merged = git("rev-parse", "HEAD");
  expect(deploymentRange(cwd, base, merged).commits).toEqual([feature, internal, reverted, merged]);
  expect(deploymentRange(cwd, base, merged).commits).not.toContain(side);
});

it("refuses oversized evidence instead of silently dropping part of the release", async () => {
  await expect(
    collectEvidence({
      cwd,
      from: base,
      to: feature,
      repository: "patchy/cloud",
      loadPullRequests: async () => [
        {
          number: 1,
          title: "Large PR",
          body: "x".repeat(180_001),
          merged_at: "today",
          merge_commit_sha: feature,
          base: { repo: { full_name: "patchy/cloud" } }
        }
      ]
    })
  ).rejects.toThrow("exceeds 180 KB");
});

it("removes a stale draft even when collecting the next range fails", () => {
  const out = join(cwd, "notes-output");
  mkdirSync(out);
  writeFileSync(join(out, "draft.json"), "old candidate");
  expect(() =>
    execFileSync(
      process.execPath,
      [
        new URL("./release-notes.mjs", import.meta.url).pathname,
        "--from",
        "bad-revision",
        "--to",
        feature,
        "--repo",
        "patchy/cloud",
        "--out",
        out
      ],
      { cwd, stdio: "pipe" }
    )
  ).toThrow();
  expect(existsSync(join(out, "draft.json"))).toBe(false);
});

it("requires an explanation even when a deployment has only internal changes", () => {
  expect(() =>
    makeDraft(evidence(), {
      title: "",
      summary: "",
      changes: [],
      omitted: [feature, internal].map((commit) => ({ commit, reason: "internal" }))
    })
  ).toThrow("concrete title and summary");
});

it("summarizes the first confirmed version from that version's product snapshot", async () => {
  writeFileSync(join(cwd, "docs/product.md"), "Unreleased feature that must not appear");
  const first = await collectEvidence({ cwd, from: null, to: base, repository: "patchy/cloud" });
  expect(first.productSnapshot).toBe("People can open company tools and invite teammates.");
  expect(first.commits.map((commit) => commit.sha)).toEqual([base]);
  const notes = {
    title: "Tools and teammates",
    summary: "Open company tools and invite your team.",
    changes: [
      { kind: "New", title: "Company tools", detail: "Open your company’s tools.", sources: [base] }
    ],
    omitted: []
  };
  expect(makeDraft(first, notes).notes.summary).toBe(notes.summary);
});
