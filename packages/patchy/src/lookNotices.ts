// @effect-diagnostics nodeBuiltinImport:off
// Directory entries let the page walk skip links, dependencies and builds without following them.
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { LookRevision } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Api from "./Api.js";
import * as Output from "./Output.js";

const INDEX = "patchy/_generated/index.json";
const LOOK_CSS = "patchy/_generated/look.css";
const LOGO = "patchy/_generated/logo.svg";

const decodeIndexLook = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ look: Schema.optionalKey(Schema.NullOr(LookRevision)) }))
);

/**
 * The revision an index.json names: null for the Patchy look, or for an index missing or from
 * before looks.
 */
const indexLook = (contents: string | undefined) =>
  (contents === undefined ? undefined : Option.getOrUndefined(decodeIndexLook(contents)))?.look ??
  null;

const readIndexLook = Effect.fn("lookNotices.readIndexLook")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  return indexLook(
    yield* fs.readFileString(path.join(root, INDEX)).pipe(Effect.orElseSucceed(() => undefined))
  );
});

/** Revision numbers restart in every company, so a revision is its number and its time. */
type Stamp = Pick<LookRevision, "revision" | "createdAt"> | null;
const sameLook = (a: Stamp, b: Stamp) =>
  a?.revision === b?.revision && a?.createdAt === b?.createdAt;

const pageFile = /\.(?:html|css|[cm]?[jt]sx?)$/;
const commentLine = /^(?:\/\/|\/\*|\*|<!--)/;

/**
 * Whether the page uses the look, and its logo: a line of its source that isn't a comment names
 * `patchy/_generated/look.css` or `logo.svg`. Every HTML, CSS and script file counts except in
 * dependencies, builds, dot folders and generated files; an alias or a file nothing imports is
 * outside the rule. A text check rather than the build's import walk, because dev start and
 * refresh run no build, and a build fails once a dropped logo is gone.
 */
const pageLook = (root: string) =>
  Effect.promise(async () => {
    let css = false;
    let logo = false;
    const visit = async (dir: string): Promise<void> => {
      const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const relative = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (
            !entry.name.startsWith(".") &&
            entry.name !== "node_modules" &&
            relative !== "dist" &&
            relative !== "patchy/_generated"
          )
            await visit(relative);
        } else if (entry.isFile() && pageFile.test(entry.name)) {
          const source = await readFile(path.join(root, relative), "utf8").catch(() => "");
          for (const line of source.split("\n")) {
            const text = line.trimStart();
            if (commentLine.test(text)) continue;
            css ||= text.includes(LOOK_CSS);
            logo ||= text.includes(LOGO);
          }
        }
      }
    };
    await visit("");
    return { uses: css || logo, logo };
  });

const revision = (look: LookRevision | null) => (look === null ? "none" : `rev ${look.revision}`);
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Dev start and refresh, before activating what generation returned: a notice when it brings a
 * different revision from the one the repo had and the page uses the look. `company` is read
 * only then. The caller remembers the notice once activation succeeds.
 */
export const lookNotices = Effect.fn("lookNotices")(function* <R>(
  root: string,
  generated: ReadonlyArray<{ readonly path: string; readonly contents: string }>,
  company: Effect.Effect<string, never, R>
) {
  const before = yield* readIndexLook(root);
  const after = indexLook(generated.find((file) => file.path === INDEX)?.contents);
  if (sameLook(before, after)) return [];
  const page = yield* pageLook(root);
  if (!page.uses) return [];
  const change =
    before !== null && after !== null
      ? `rev ${before.revision} → ${after.revision}`
      : `${revision(before)} → ${revision(after)}`;
  const by =
    after === null ? ", so the Patchy look stands in" : ` by ${after.author.name}: ${after.note}`;
  return [
    [
      sentence(`${yield* company}'s look changed, ${change}${by}`),
      // Settled by #547's prototype verdict: a revision recolours; restyling is the agent's job.
      "Colours and fonts follow; to restyle this tool's components, ask your agent to update it to the current look.",
      ...(page.logo && !generated.some((file) => file.path === LOGO)
        ? [
            `The new look has no logo, so remove the page's reference to ${LOGO}; the next build fails on it.`
          ]
        : [])
    ].join(" ")
  ];
});

/**
 * Repo publish ships the repo's own revision and never pulls a newer one: a page using the look
 * hears when that isn't the company's current revision, and how to catch up. The check is
 * advisory, so a failed read becomes a warning too.
 */
export const publishLookWarnings = Effect.fn("publishLookWarnings")(function* (
  root: string,
  token: Redacted.Redacted,
  company: string
) {
  if (!(yield* pageLook(root)).uses) return [];
  const own = yield* readIndexLook(root);
  const client = yield* Api.client(token);
  const warnings = yield* client.getLook().pipe(
    Effect.map(({ current }) => {
      if (sameLook(own, current)) return [];
      const has = own === null ? "the Patchy look" : `${company}'s look rev ${own.revision}`;
      const now =
        current === null
          ? `${company} has no look now.`
          : `the current look is rev ${current.revision} by ${current.author.name}: ${sentence(current.note)}`;
      return [
        `This repo has ${has}, but ${now} This version keeps the repo's look; run patchy refresh to bring it up to date.`
      ];
    }),
    Effect.catch((error) =>
      Api.classify(error, "The look could not be read.").pipe(
        Effect.flip,
        Effect.map((failure) => [
          `Could not check whether this repo's look is current: ${failure.message.split("\n")[0]}`
        ])
      )
    )
  );
  yield* Output.rememberWarnings(warnings);
  return warnings;
});
