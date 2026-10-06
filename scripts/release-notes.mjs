/** Generate draft content only. No deployment, release or shared-history writes. */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const shaPattern = /^[a-f0-9]{40}$/;
const object = (properties) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties)
});
const string = { type: "string" };
export const responseSchema = object({
  title: string,
  summary: string,
  changes: {
    type: "array",
    items: object({
      kind: { type: "string", enum: ["New", "Improved", "Fixed"] },
      title: string,
      detail: string,
      sources: { type: "array", items: string }
    })
  },
  omitted: {
    type: "array",
    items: object({
      commit: string,
      reason: { type: "string", enum: ["internal", "reverted", "insufficient-evidence"] }
    })
  }
});
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const ancestor = (cwd, from, to) => {
  try {
    git(cwd, "merge-base", "--is-ancestor", from, to);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
};
export function deploymentRange(cwd, from, to) {
  for (const sha of [from, to].filter(Boolean)) {
    if (!shaPattern.test(sha)) throw new Error("Deployment revisions must be full commit SHAs.");
    git(cwd, "cat-file", "-e", `${sha}^{commit}`);
  }
  if (!to) throw new Error("A target deployment commit is required.");
  if (!from) return { kind: "initial", from: null, to, commits: [] };
  if (from === to) return { kind: "unchanged", from, to, commits: [] };
  const kind = ancestor(cwd, from, to)
    ? "forward"
    : ancestor(cwd, to, from)
      ? "rollback"
      : "diverged";
  if (kind === "diverged")
    throw new Error("Deployment revisions have diverged; select the actual deployed baseline.");
  const range = kind === "forward" ? `${from}..${to}` : `${to}..${from}`;
  // First-parent units avoid announcing both a merge and each commit it contains.
  const commits = git(cwd, "rev-list", "--first-parent", "--reverse", range)
    .trim()
    .split("\n")
    .filter(Boolean);
  return { kind, from, to, commits };
}

export async function collectEvidence({ cwd, from, to, repository, loadPullRequests }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Expected an owner/repository name.");
  const range = deploymentRange(cwd, from, to);
  if (range.kind !== "forward") return { ...range, repository, commits: [], netDiff: "" };
  if (range.commits.length > 100)
    throw new Error(
      "More than 100 changes in this deployment; prepare notes explicitly rather than silently truncating history."
    );
  const commits = [];
  for (const sha of range.commits) {
    const pullRequests = (await loadPullRequests(sha)).filter(
      (pr) => pr.merged_at && pr.merge_commit_sha === sha && pr.base?.repo?.full_name === repository
    );
    commits.push({
      sha,
      message: git(cwd, "show", "-s", "--format=%B", sha).trim(),
      files: git(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", `${sha}^`, sha)
        .trim()
        .split("\n")
        .filter(Boolean),
      pullRequests: pullRequests.map((pr) => ({
        number: pr.number,
        title: pr.title,
        body: pr.body ?? ""
      }))
    });
  }
  // Source evidence only: omit generated files, lockfiles, fixtures and common credential files.
  const netDiff = git(
    cwd,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=2",
    from,
    to,
    "--",
    "packages",
    "apps/server/src",
    "docs/product.md",
    ":(exclude)**/*.test.*",
    ":(exclude)**/fixtures/**",
    ":(exclude)**/dist/**",
    ":(exclude)**/pnpm-lock.yaml",
    ":(exclude)**/.env*",
    ":(exclude)**/*.pem",
    ":(exclude)**/*.key"
  );
  const evidence = { ...range, repository, commits, netDiff };
  if (Buffer.byteLength(JSON.stringify(evidence)) > 180_000)
    throw new Error(
      "Deployment evidence exceeds 180 KB; prepare notes explicitly rather than sending an incomplete diff."
    );
  return evidence;
}

const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const prose = (value, maximum) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maximum &&
  !/[<>\u0000-\u001f]/.test(value);
export function validateResponse(value, evidence) {
  if (
    !exactKeys(value, ["title", "summary", "changes", "omitted"]) ||
    !Array.isArray(value.changes) ||
    !Array.isArray(value.omitted) ||
    value.changes.length > 20
  )
    throw new Error("Invalid release-note response shape.");
  if (
    value.changes.length
      ? !prose(value.title, 100) || !prose(value.summary, 280)
      : value.title !== "" || value.summary !== ""
  )
    throw new Error("Expected a short title/summary, or empty text for a maintenance deployment.");
  const allowed = new Set(evidence.commits.map((commit) => commit.sha));
  const included = new Set();
  for (const change of value.changes) {
    if (
      !exactKeys(change, ["kind", "title", "detail", "sources"]) ||
      !["New", "Improved", "Fixed"].includes(change.kind) ||
      !prose(change.title, 100) ||
      !prose(change.detail, 800) ||
      !Array.isArray(change.sources) ||
      change.sources.length === 0
    )
      throw new Error("A change needs a category, concise text and supporting commits.");
    for (const source of change.sources) {
      if (!allowed.has(source))
        throw new Error("A release note cited a commit outside this deployment.");
      included.add(source);
    }
  }
  const omitted = new Set();
  for (const item of value.omitted) {
    if (
      !exactKeys(item, ["commit", "reason"]) ||
      !allowed.has(item.commit) ||
      included.has(item.commit) ||
      omitted.has(item.commit) ||
      !["internal", "reverted", "insufficient-evidence"].includes(item.reason)
    )
      throw new Error("Invalid omitted-commit accounting.");
    omitted.add(item.commit);
  }
  if (included.size + omitted.size !== allowed.size)
    throw new Error("The notes must account for every deployment commit.");
  if (value.omitted.some((item) => item.reason === "insufficient-evidence"))
    throw new Error(
      "Some changes lack enough evidence. Resolve those before generating a publication candidate."
    );
  return value;
}

/** @param {string | null} [model] */
export function makeDraft(evidence, response, model = null) {
  const defaults = {
    initial: {
      title: "Patchy is live",
      summary: "This deployment starts Patchy’s update history.",
      changes: []
    },
    unchanged: {
      title: "Platform maintenance",
      summary: "This deployment uses the same application version.",
      changes: []
    },
    rollback: {
      title: "An earlier version has been restored",
      summary:
        "Patchy has returned to an earlier release. Recent changes may no longer be available.",
      changes: []
    },
    forward: {
      title: "Platform maintenance",
      summary: "No user-facing changes to announce in this deployment.",
      changes: []
    }
  };
  const checked = evidence.kind === "forward" ? validateResponse(response, evidence) : null;
  const notes = checked?.changes.length
    ? {
        title: checked.title,
        summary: checked.summary,
        changes: checked.changes.map(({ kind, title, detail }) => ({ kind, title, detail }))
      }
    : defaults[evidence.kind];
  if (!notes) throw new Error("Unsupported deployment direction.");
  return {
    version: 1,
    status: "draft",
    repository: evidence.repository,
    from: evidence.from,
    to: evidence.to,
    direction: evidence.kind,
    notes,
    provenance: {
      model,
      changes: checked?.changes.map(({ sources }) => sources) ?? [],
      omitted: checked?.omitted ?? []
    }
  };
}

export async function requestNotes(evidence, { apiKey, model, request = fetch }) {
  if (!apiKey)
    throw new Error(
      "Set RELEASE_NOTES_API_KEY (an OpenAI API key), or use --prepare-only to inspect the evidence without a model call."
    );
  const instructions = await readFile(
    new URL("./release-notes-prompt.txt", import.meta.url),
    "utf8"
  );
  const result = await request("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      store: false,
      instructions,
      input: JSON.stringify(evidence),
      max_output_tokens: 6000,
      text: {
        format: { type: "json_schema", name: "release_notes", strict: true, schema: responseSchema }
      }
    })
  });
  // Never echo provider bodies: they may contain source text or request details.
  if (!result.ok)
    throw new Error(`Release-note provider returned HTTP ${result.status}. No draft was produced.`);
  const body = await result.json();
  if (body.status !== "completed")
    throw new Error("Release-note response was incomplete. No draft was produced.");
  const text = body.output
    ?.filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
  if (!text) throw new Error("Release-note provider returned no text.");
  return validateResponse(JSON.parse(text), evidence);
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      to: { type: "string" },
      repo: { type: "string" },
      out: { type: "string" },
      "prepare-only": { type: "boolean" },
      "response-file": { type: "string" }
    }
  });
  if (!values.to || !values.repo || !values.out)
    throw new Error(
      "Usage: node scripts/release-notes.mjs --from <previous-sha> --to <deployed-sha> --repo owner/repo --out <directory> [--prepare-only | --response-file <json>] (omit --from only for the first deployment)"
    );
  if (values["prepare-only"] && values["response-file"])
    throw new Error("Choose prepare-only or response-file, not both.");
  const out = resolve(values.out);
  await mkdir(out, { recursive: true });
  // Clear candidates before collection too: even a failed git/API read must not leave stale notes.
  await rm(resolve(out, "draft.json"), { force: true });
  const evidence = await collectEvidence({
    cwd: process.cwd(),
    from: values.from || null,
    to: values.to,
    repository: values.repo,
    loadPullRequests: (sha) =>
      JSON.parse(
        execFileSync(
          "gh",
          [
            "api",
            "--paginate",
            "--slurp",
            `repos/${values.repo}/commits/${sha}/pulls?per_page=100`
          ],
          { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
        )
      ).flat()
  });
  await writeFile(resolve(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  if (values["prepare-only"]) {
    console.log(`Prepared ${evidence.kind} deployment evidence in ${out}`);
    return;
  }
  const model = process.env.RELEASE_NOTES_MODEL || "gpt-4.1-mini";
  const response =
    evidence.kind !== "forward"
      ? null
      : values["response-file"]
        ? JSON.parse(await readFile(values["response-file"], "utf8"))
        : await requestNotes(evidence, { apiKey: process.env.RELEASE_NOTES_API_KEY, model });
  const draft = makeDraft(
    evidence,
    response,
    evidence.kind !== "forward" ? null : values["response-file"] ? "local-response-file" : model
  );
  await writeFile(resolve(out, "draft.json.tmp"), JSON.stringify(draft, null, 2));
  await rename(resolve(out, "draft.json.tmp"), resolve(out, "draft.json"));
  console.log(`Draft notes: ${out}/draft.json (${draft.notes.changes.length} user-facing changes)`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
