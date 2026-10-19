/**
 * Evidence in a PR body: keyed sections, and their files uploaded with
 * `gh pr edit --attach`. Every `pnpm dev` command that shows a change in a PR
 * publishes through here: `compare`, `film`, `transcript` and `trial`.
 *
 * A section sits between markers on lines of their own,
 *
 *   <!-- patchy-dev:<command>:<key> -->
 *   …
 *   <!-- /patchy-dev:<command>:<key> -->
 *
 * so a re-run replaces its own section wherever it was moved to and leaves the
 * rest of the body alone. A section names its local files as
 * `![alt](<path from the worktree root>)`; `gh` rewrites each attached one to
 * its upload, inside tables and `<details>` too, and turns a video's reference
 * into a bare URL GitHub plays inline. The command that made the files names
 * them; nothing is attached from parsing the text, which quotes page errors.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { spawnStep, stepOutput } from "./steps.js";

/** `gh pr edit --attach` uploads at most this many files per command. */
export const MAX_ATTACHMENTS = 50;
/** GitHub refuses attachments above this size. */
export const MAX_ATTACHMENT_BYTES = 10_000_000;
/** The first gh release whose `pr edit` takes `--attach`. */
const MIN_GH: readonly [number, number] = [2, 102];

export class DuplicateSection extends Schema.TaggedError<DuplicateSection>()("DuplicateSection", {
  marker: Schema.String,
  count: Schema.Int
}) {
  override get message() {
    return `The PR body has ${this.count} \`${this.marker}\` markers. Remove all but one section, then run again.`;
  }
}

export class UnclosedSection extends Schema.TaggedError<UnclosedSection>()("UnclosedSection", {
  marker: Schema.String
}) {
  override get message() {
    return `The PR body's \`${this.marker}\` section is missing its opening or closing marker. Fix or remove it, then run again.`;
  }
}

export class TooManyAttachments extends Schema.TaggedError<TooManyAttachments>()(
  "TooManyAttachments",
  { count: Schema.Int }
) {
  override get message() {
    return `This would attach ${this.count} files, and \`gh\` takes at most ${MAX_ATTACHMENTS} per command. Capture fewer pages or widths.`;
  }
}

export class NotTheRunsFile extends Schema.TaggedError<NotTheRunsFile>()("NotTheRunsFile", {
  file: Schema.String,
  runDir: Schema.String
}) {
  override get message() {
    return `${this.file} is outside this run's folder, ${this.runDir}; only files the command made are attached. Nothing was published.`;
  }
}

export class AttachmentTooLarge extends Schema.TaggedError<AttachmentTooLarge>()(
  "AttachmentTooLarge",
  { file: Schema.String, bytes: Schema.Int }
) {
  override get message() {
    return `${this.file} is ${(this.bytes / 1_000_000).toFixed(1)} MB, over GitHub's ${MAX_ATTACHMENT_BYTES / 1_000_000} MB limit. Nothing was published; the file is kept.`;
  }
}

export class GhTooOld extends Schema.TaggedError<GhTooOld>()("GhTooOld", {
  found: Schema.String
}) {
  override get message() {
    return `--pr needs gh ${MIN_GH.join(".")} or later for \`pr edit --attach\`; found ${this.found}. Upgrade gh, or run without --pr and publish the printed section yourself.`;
  }
}

export class PrHeadMismatch extends Schema.TaggedError<PrHeadMismatch>()("PrHeadMismatch", {
  pr: Schema.Int,
  prHead: Schema.String,
  local: Schema.String
}) {
  override get message() {
    return `PR #${this.pr}'s head is ${this.prHead.slice(0, 7)}, but HEAD here is ${this.local.slice(0, 7)}. Push this branch (or check out the PR's head) so the evidence is of the commit the PR shows.`;
  }
}

export class PartialPublication extends Schema.TaggedError<PartialPublication>()(
  "PartialPublication",
  { url: Schema.String, failed: Schema.Array(Schema.String) }
) {
  override get message() {
    return `${this.url} was updated, but ${this.failed.length} file(s) did not upload and are still local paths in its body: ${this.failed.join(", ")}. Run the same command again to replace the section.`;
  }
}

export class GhEditFailed extends Schema.TaggedError<GhEditFailed>()("GhEditFailed", {
  pr: Schema.Int,
  exitCode: Schema.Int
}) {
  override get message() {
    return `gh did not update PR #${this.pr} (exit ${this.exitCode}); its output is above. Nothing was published; the files are kept.`;
  }
}

const markersOf = (command: string, key: string) => ({
  open: `<!-- patchy-dev:${command}:${key} -->`,
  close: `<!-- /patchy-dev:${command}:${key} -->`
});

/** A section key: lowercase letters, digits and single hyphens, so it reads well in a marker. */
export const sectionKey = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

/** `markdown` between its command's and key's markers. */
export const keyedSection = (command: string, key: string, markdown: string) => {
  const { open, close } = markersOf(command, key);
  return `${open}\n\n${markdown.trim()}\n\n${close}`;
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * `body`'s lines, which are inside (or the edge of) a fenced code block, and
 * where the keyed section's markers sit outside them. Markers inside code
 * fences are text, not markers.
 */
const scan = (body: string, command: string, key: string) => {
  const { open, close } = markersOf(command, key);
  const lines = body.split(/\r?\n/);
  const opens: Array<number> = [];
  const closes: Array<number> = [];
  const fenced: Array<boolean> = [];
  let fence: { readonly char: string; readonly length: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const match = FENCE.exec(line);
    if (fence !== undefined) {
      fenced.push(true);
      const run = match?.[1];
      if (
        run !== undefined &&
        run[0] === fence.char &&
        run.length >= fence.length &&
        line.trim() === run
      )
        fence = undefined;
      continue;
    }
    if (match?.[1] !== undefined) {
      fence = { char: match[1][0]!, length: match[1].length };
      fenced.push(true);
      continue;
    }
    fenced.push(false);
    if (line.trim() === open) opens.push(index);
    else if (line.trim() === close) closes.push(index);
  }
  return { open, close, lines, opens, closes, fenced };
};

/**
 * `body` with the keyed section in place: replacing the one already there, or
 * inserted before a final paragraph starting "Made by" (the attribution line),
 * or appended. More than one section for the key, or one missing a marker,
 * fails rather than guessing.
 */
export const placeSection = (
  body: string,
  command: string,
  key: string,
  markdown: string
): Effect.Effect<string, DuplicateSection | UnclosedSection> => {
  const section = keyedSection(command, key, markdown).split("\n");
  const { open, close, lines, opens, closes, fenced } = scan(body, command, key);
  if (opens.length > 1)
    return Effect.fail(new DuplicateSection({ marker: open, count: opens.length }));
  if (closes.length > 1)
    return Effect.fail(new DuplicateSection({ marker: close, count: closes.length }));
  const [start] = opens;
  const [end] = closes;
  if (start !== undefined && end !== undefined && start < end)
    return Effect.succeed(
      [...lines.slice(0, start), ...section, ...lines.slice(end + 1)].join("\n")
    );
  if (start !== undefined || end !== undefined)
    return Effect.fail(new UnclosedSection({ marker: start === undefined ? close : open }));

  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === "") last--;
  const kept = lines.slice(0, last + 1);
  let first = last;
  while (first > 0 && lines[first - 1]!.trim() !== "") first--;
  const attribution =
    last >= 0 && !fenced[first] && !fenced[last] && lines[first]!.trimStart().startsWith("Made by");
  if (!attribution)
    return Effect.succeed([...kept, ...(kept.length === 0 ? [] : [""]), ...section, ""].join("\n"));
  return Effect.succeed(
    [...kept.slice(0, first), ...section, "", ...kept.slice(first), ""].join("\n")
  );
};

/**
 * Fails before anything uploads when a file isn't the run's own, or when `gh`
 * or GitHub would refuse the files. `files` and `runDir` are relative to the
 * worktree root.
 */
export const checkAttachments = Effect.fn("Publish.checkAttachments")(function* (
  root: string,
  runDir: string,
  files: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const file of files) {
    const inside = path.relative(path.resolve(root, runDir), path.resolve(root, file));
    if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside))
      return yield* new NotTheRunsFile({ file, runDir });
  }
  if (files.length > MAX_ATTACHMENTS) return yield* new TooManyAttachments({ count: files.length });
  for (const file of files) {
    const bytes = Number((yield* fs.stat(path.resolve(root, file))).size);
    if (bytes > MAX_ATTACHMENT_BYTES) return yield* new AttachmentTooLarge({ file, bytes });
  }
});

const GhPr = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  headRefOid: Schema.String,
  baseRefName: Schema.String
});
const decodeGhPr = Schema.decodeUnknownEffect(Schema.fromJsonString(GhPr));
const decodeGhBody = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ body: Schema.String }))
);

/** The PR `--pr` names, once it is known to match this checkout. */
export interface PrTarget {
  readonly number: number;
  readonly url: string;
  readonly baseRefName: string;
}

/**
 * Checks, before anything is captured, that gh can attach files and that the
 * PR's head is this checkout's `HEAD`, the commit the evidence will show;
 * that also means it is pushed. Returns the PR, whose base branch decides "before".
 */
export const checkPr = Effect.fn("Publish.checkPr")(function* (root: string, pr: number) {
  const version = yield* stepOutput("Reading gh's version", "gh", ["--version"], {
    cwd: root,
    prefix: "gh"
  });
  const found = /gh version (\d+)\.(\d+)\.(\d+)/.exec(version);
  const [major, minor] = [Number(found?.[1] ?? 0), Number(found?.[2] ?? 0)];
  if (major < MIN_GH[0] || (major === MIN_GH[0] && minor < MIN_GH[1]))
    return yield* new GhTooOld({ found: found?.slice(1).join(".") ?? version.split("\n")[0]! });
  const target = yield* decodeGhPr(
    yield* stepOutput(
      `Reading PR #${pr}`,
      "gh",
      ["pr", "view", String(pr), "--json", "number,url,headRefOid,baseRefName"],
      { cwd: root, prefix: "gh" }
    )
  );
  const head = yield* stepOutput("Reading HEAD", "git", ["rev-parse", "HEAD"], {
    cwd: root,
    prefix: "git"
  });
  if (target.headRefOid !== head)
    return yield* new PrHeadMismatch({ pr, prHead: target.headRefOid, local: head });
  return {
    number: target.number,
    url: target.url,
    baseRefName: target.baseRefName
  } satisfies PrTarget;
});

const prBody = (root: string, pr: number) =>
  stepOutput(`Reading PR #${pr}'s body`, "gh", ["pr", "view", String(pr), "--json", "body"], {
    cwd: root,
    prefix: "gh"
  }).pipe(
    Effect.flatMap(decodeGhBody),
    Effect.map((view) => view.body)
  );

/**
 * The files whose references in the published body's keyed section are still
 * local paths: gh updates the body when only some uploads fail, and leaves
 * those references as they were.
 */
export const notUploaded = (
  body: string,
  command: string,
  key: string,
  files: ReadonlyArray<string>
) => {
  const { lines, opens, closes } = scan(body, command, key);
  const [start] = opens;
  const [end] = closes;
  const section =
    opens.length === 1 && closes.length === 1 && start! < end!
      ? lines.slice(start, end! + 1).join("\n")
      : body;
  return files.filter((file) => section.includes(`](${file})`));
};

/**
 * Puts the keyed section in PR `pr`'s body and uploads the files it
 * references, in one `gh pr edit` run from the worktree root. The new body is
 * kept beside the files as `body.md`. gh's own failures (authentication,
 * permissions, the installation token Actions provides) pass through. When gh
 * updated the body but some uploads failed, their references are still local
 * paths: those come back as `failed`, a partial publication the caller
 * reports and exits non-zero on.
 */
export const publishSection = Effect.fn("Publish.publishSection")(function* (input: {
  readonly root: string;
  readonly pr: PrTarget;
  readonly command: string;
  readonly key: string;
  readonly markdown: string;
  /** The files the section references, all under `runDir`; both relative to the worktree root. */
  readonly files: ReadonlyArray<string>;
  readonly runDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = input.files;
  yield* checkAttachments(input.root, input.runDir, files);
  const before = yield* prBody(input.root, input.pr.number);
  const body = yield* placeSection(before, input.command, input.key, input.markdown);
  const bodyFile = path.join(input.root, input.runDir, "body.md");
  yield* fs.writeFileString(bodyFile, body);
  yield* Console.error(`Publishing to ${input.pr.url}, attaching ${files.length} file(s)`);
  const { exitCode } = yield* spawnStep(
    `Publishing to PR #${input.pr.number}`,
    "gh",
    [
      "pr",
      "edit",
      String(input.pr.number),
      "--body-file",
      path.relative(input.root, bodyFile),
      ...files.flatMap((file) => ["--attach", file])
    ],
    { cwd: input.root, prefix: "gh" }
  );
  const after = yield* prBody(input.root, input.pr.number);
  const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();
  if (exitCode !== 0 && normalize(after) === normalize(before))
    return yield* new GhEditFailed({ pr: input.pr.number, exitCode });
  const failed = notUploaded(after, input.command, input.key, files);
  return { url: input.pr.url, attached: files.length - failed.length, failed, bodyFile };
});

/**
 * Without `--pr`: the section, markers included, written beside its files for
 * the developer to place, and the one `gh` line that publishes it.
 */
export const draftSection = Effect.fn("Publish.draftSection")(function* (input: {
  readonly root: string;
  readonly command: string;
  readonly key: string;
  readonly markdown: string;
  readonly files: ReadonlyArray<string>;
  readonly runDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* checkAttachments(input.root, input.runDir, input.files);
  const file = path.join(input.runDir, `${input.command}-${input.key}.md`);
  yield* fs.writeFileString(
    path.join(input.root, file),
    `${keyedSection(input.command, input.key, input.markdown)}\n`
  );
  return {
    file,
    gh: [
      "gh pr edit <number> --body-file <body.md>",
      ...input.files.map((f) => `--attach ${f}`)
    ].join(" ")
  };
});
