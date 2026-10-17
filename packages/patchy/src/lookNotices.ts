// @effect-diagnostics nodeBuiltinImport:off
// Directory entries let the page walk skip links, dependencies and builds without following them.
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { LookRestore, LookRevision } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const INDEX = "patchy/_generated/index.json";
const LOOK_CSS = "patchy/_generated/look.css";
const LOGO = "patchy/_generated/logo.svg";

const decodeIndexLook = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      look: Schema.optionalKey(Schema.NullOr(LookRevision)),
      lookRestore: Schema.optionalKey(Schema.NullOr(LookRestore))
    })
  )
);

/**
 * The revision an index.json names, null for the Patchy look or for an index missing or from
 * before looks, and who restored it, null for none or for an index from before restores were
 * recorded.
 */
const indexLook = (contents: string | undefined) => {
  const index =
    contents === undefined ? undefined : Option.getOrUndefined(decodeIndexLook(contents));
  return { look: index?.look ?? null, restored: index?.lookRestore ?? null };
};

const readIndexLook = Effect.fn("lookNotices.readIndexLook")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  return indexLook(
    yield* fs.readFileString(path.join(root, INDEX)).pipe(Effect.orElseSucceed(() => undefined))
  ).look;
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
/** Ends `text` with a full stop unless it already ends a sentence. */
export const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Dev start and refresh, before activating what generation returned: a notice when it brings a
 * different revision from the one the repo had and the page uses the look. It credits the
 * restorer when a restore set the incoming look, and otherwise the revision's author. `company`
 * is read only then. The caller remembers the notice once activation succeeds.
 */
export const lookNotices = Effect.fn("lookNotices")(function* <R>(
  root: string,
  generated: ReadonlyArray<{ readonly path: string; readonly contents: string }>,
  company: Effect.Effect<string, never, R>
) {
  const before = yield* readIndexLook(root);
  const { look: after, restored } = indexLook(
    generated.find((file) => file.path === INDEX)?.contents
  );
  if (sameLook(before, after)) return [];
  const page = yield* pageLook(root);
  if (!page.uses) return [];
  const change =
    before !== null && after !== null
      ? `rev ${before.revision} → ${after.revision}`
      : `${revision(before)} → ${revision(after)}`;
  const credit =
    restored !== null
      ? `, restored by ${restored.by.name}${restored.note === null ? "" : `: ${restored.note}`}`
      : after === null
        ? ", so the Patchy look stands in"
        : ` by ${after.author.name}: ${after.note}`;
  return [
    [
      sentence(`${yield* company}'s look changed, ${change}${credit}`),
      ...(restored !== null && after === null ? ["The Patchy look stands in."] : []),
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
 * Repo publish ships the repo's own revision and never pulls a newer one. A page using the look
 * sends the revision `index.json` names, null for the Patchy look, and the publish response warns
 * when that isn't the company's current look. A page that doesn't use it sends no stamp.
 */
export const publishLookStamp = Effect.fn("publishLookStamp")(function* (root: string) {
  if (!(yield* pageLook(root)).uses) return {};
  const own = yield* readIndexLook(root);
  return { look: own === null ? null : { revision: own.revision, createdAt: own.createdAt } };
});
