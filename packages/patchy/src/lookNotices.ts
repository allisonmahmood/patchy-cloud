import { LookRevision } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
  const path = yield* Path.Path;
  return indexLook(
    yield* fs.readFileString(path.join(root, INDEX)).pipe(Effect.orElseSucceed(() => undefined))
  );
});

const pageFile = /\.(?:html|css|[cm]?[jt]sx?)$/;

/**
 * Whether the page uses the look, and its logo: its source names `patchy/_generated/look.css` or
 * `logo.svg`. A text check over `index.html`, `src/` and `helpers/` rather than the build's import
 * walk, because dev start and refresh run no build, and a build fails once a dropped logo is gone.
 */
const pageLook = Effect.fn("lookNotices.pageLook")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = ["index.html"];
  for (const dir of ["src", "helpers"])
    for (const entry of yield* fs
      .readDirectory(path.join(root, dir), { recursive: true })
      .pipe(Effect.orElseSucceed((): string[] => [])))
      if (pageFile.test(entry)) files.push(path.join(dir, entry));
  let css = false;
  let logo = false;
  for (const file of files) {
    const source = yield* fs
      .readFileString(path.join(root, file))
      .pipe(Effect.orElseSucceed(() => ""));
    css ||= source.includes(LOOK_CSS);
    logo ||= source.includes(LOGO);
  }
  return { uses: css || logo, logo };
});

const revision = (look: LookRevision | null) => (look === null ? "none" : `rev ${look.revision}`);
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Dev start and refresh, before activating what generation returned: a notice when it brings a
 * different revision from the one the repo had and the page uses the look. `company` is read
 * only then.
 */
export const lookNotices = Effect.fn("lookNotices")(function* <E, R>(
  root: string,
  generated: ReadonlyArray<{ readonly path: string; readonly contents: string }>,
  company: Effect.Effect<string, E, R>
) {
  const before = yield* readIndexLook(root);
  const after = indexLook(generated.find((file) => file.path === INDEX)?.contents);
  if (before?.revision === after?.revision) return [];
  const page = yield* pageLook(root);
  if (!page.uses) return [];
  const change =
    before !== null && after !== null
      ? `rev ${before.revision} → ${after.revision}`
      : `${revision(before)} → ${revision(after)}`;
  const by =
    after === null ? ", so the Patchy look stands in" : ` by ${after.author.name}: ${after.note}`;
  const notice = [
    sentence(`${yield* company}'s look changed, ${change}${by}`),
    // Settled by #547's prototype verdict: a revision recolours; restyling is the agent's job.
    "Colours and fonts follow; to restyle this tool's components, ask your agent to update it to the current look.",
    ...(page.logo && !generated.some((file) => file.path === LOGO)
      ? [
          `The new look has no logo, so remove the page's reference to ${LOGO}; the next build fails on it.`
        ]
      : [])
  ].join(" ");
  yield* Output.rememberWarnings([notice]);
  return [notice];
});

/**
 * Repo publish ships the repo's own revision and never pulls a newer one: a page using the look
 * hears when that isn't the company's current revision, and how to catch up.
 */
export const publishLookWarnings = Effect.fn("publishLookWarnings")(function* (
  root: string,
  token: Redacted.Redacted,
  company: string
) {
  if (!(yield* pageLook(root)).uses) return [];
  const own = yield* readIndexLook(root);
  const client = yield* Api.client(token);
  const { current } = yield* client
    .getLook()
    .pipe(Effect.catch((error) => Api.classify(error, "Could not read the company's look.")));
  if (own?.revision === current?.revision) return [];
  const has = own === null ? "the Patchy look" : `${company}'s look rev ${own.revision}`;
  const now =
    current === null
      ? `${company} has no look now.`
      : `the current look is rev ${current.revision} by ${current.author.name}: ${sentence(current.note)}`;
  return [
    `This repo has ${has}, but ${now} This version keeps the repo's look; run patchy refresh to bring it up to date.`
  ];
});
