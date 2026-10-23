/**
 * The catalogue calls, `find_patches` and `open_patch`: what a worker agent sees of its
 * company's patches (docs/product.md › The door › The tools). Both start from the list the
 * portal shows the person, Patches' read through the same openability rule, so an agent never
 * finds or opens a patch its person can't. They read manifests only, and never start a patch.
 *
 * Every refusal here is a tool result. A patch the person can't open is "not found" in the
 * same words however it is missing, and an address on another instance or under another
 * company's handle never resolves to a local namesake.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as WideEvents from "@patchy/analytics/wide-events";
import {
  agentTools,
  type AgentToolSummary,
  openPatchAnswer,
  openPatchBytes,
  PatchName,
  readAnswerChars,
  toolAnswer,
  toolRefusal
} from "@patchy/api";
import type { AgentConnections } from "@patchy/auth";
import { Patches } from "@patchy/patches";
import * as Tools from "./Tools.js";

/** The most patches one find answers. */
const PAGE_SIZE = 50;

const FindArgs = Schema.Struct({
  search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(Tools.SEARCH_CHARS))),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(Tools.CURSOR_CHARS))),
  detail: Schema.optionalKey(Schema.Literal("tools"))
});
const OpenArgs = Schema.Struct({
  patch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(Tools.PATCH_CHARS))
});
const strict = { onExcessProperty: "error" } as const;
const decodeFind = Schema.decodeUnknownResult(FindArgs, strict);
const decodeOpen = Schema.decodeUnknownResult(OpenArgs, strict);

/** Where a walk stands: after which entry, and the search and detail it walks with. */
const Cursor = Schema.Struct({
  after: Schema.Struct({ tools: Schema.Boolean, name: Schema.String, id: Schema.String }),
  search: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.Literal("tools"))
});
type Cursor = typeof Cursor.Type;
const CursorText = Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(Cursor)));
const decodeCursor = Schema.decodeUnknownOption(CursorText, strict);
const encodeCursor = Schema.encodeSync(CursorText);
const isPatchName = Schema.is(PatchName);
/** The characters of a value's compact JSON text, as `toolAnswer` writes it. */
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const jsonLength = (value: unknown) => jsonText(value).length;

/** One of the door's own tools given arguments its input schema refuses, and how to fix them. */
export const invalidArgs = (tool: string, problem: string, fix: string) =>
  toolRefusal({
    code: "invalid_args",
    from: "patchy",
    message: `${tool}'s arguments don't fit its schema: ${problem}. ${fix}`
  });

/** The most of the schema's words a refusal repeats, so its own instructions always fit. */
const PROBLEM_CHARS = 2_000;

/** The schema's own words for what is wrong and where, on one line and cut short. */
export const problemOf = (error: Schema.SchemaError) => {
  const words = [...error.message.replace(/\s*\n\s*/g, " ")];
  return words.length > PROBLEM_CHARS
    ? `${words.slice(0, PROBLEM_CHARS - 1).join("")}…`
    : words.join("");
};

const findFix =
  "Send search, cursor and detail as tools/list describes them, or {} to list them all.";
const cursorFix =
  "That cursor continues a find with its own search and detail. Send the cursor alone to go on, or leave it out to start a new find.";

/** A patch the person can open, with the agent tools its current version has. */
interface Listed {
  readonly row: Patches.ListedPatch;
  readonly tools: readonly AgentToolSummary[];
}

/** Patches with agent tools first, then by name and id, by code unit: a stable order. */
type Key = Cursor["after"];
const keyOf = ({ row, tools }: Listed): Key => ({
  tools: tools.length > 0,
  name: row.patch.name,
  id: row.patch.id
});
const byCodeUnit = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const compare = (left: Key, right: Key) =>
  (left.tools === right.tools ? 0 : left.tools ? -1 : 1) ||
  byCodeUnit(left.name, right.name) ||
  byCodeUnit(left.id, right.id);

/** A search's words, lowercased, joined by one space; nothing for no words. */
const wordsOf = (search: string | undefined) => {
  const words = (search ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== "");
  return words.length === 0 ? undefined : words.join(" ");
};

/** Every word appears in the name, title, description or owner's name. */
const matches = (row: Patches.ListedPatch, words: string | undefined) => {
  if (words === undefined) return true;
  const fields = [row.patch.name, row.patch.title, row.patch.description, row.owner.name].map(
    (field) => field.toLowerCase()
  );
  return words.split(" ").every((word) => fields.some((field) => field.includes(word)));
};

/**
 * The live patches the person can open, by the portal's rule, without the sharing edges its
 * cards show, so a call never scans every version's declarations.
 */
const visible = (identity: AgentConnections.AgentIdentity) =>
  Effect.gen(function* () {
    const canOpen = yield* Patches.Openability;
    return yield* (yield* Patches.Patches)
      .list({
        companyId: identity.company.id,
        userId: identity.user.id,
        canOpen: (patch) => canOpen(patch, identity.user.id),
        state: "live"
      })
      .pipe(Effect.catchTags({ PatchUnavailable: Effect.die, WrongState: Effect.die }));
  });

/** Each patch with its current version's agent tools, read from the manifests' marks alone. */
const withTools = Effect.fn("Catalogue.withTools")(function* (
  rows: ReadonlyArray<Patches.ListedPatch>
) {
  const tools = yield* (yield* Patches.Patches).agentToolSummaries(
    rows.flatMap(({ patch }) => (patch.currentVersionId === null ? [] : [patch.currentVersionId]))
  );
  return rows.map((row): Listed => ({
    row,
    tools: row.patch.currentVersionId === null ? [] : (tools.get(row.patch.currentVersionId) ?? [])
  }));
});

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** The most of a name an answer repeats, as `open_patch` cuts its owner. */
const NAME_CHARS = 200;
const cut = (name: string) => [...name].slice(0, NAME_CHARS).join("");

/** The answer's first fields, which every page of one find shares. */
const actingFor = (identity: AgentConnections.AgentIdentity) => ({
  person: cut(identity.user.name),
  company: cut(identity.company.name)
});

/**
 * `find_patches { search?, cursor?, detail? }`: up to 50 of the patches the person can open,
 * ending a page early to stay under the read cap, and `next` while more remain. The cursor
 * carries the walk's search and detail, so it alone continues the walk.
 */
export const find = Effect.fn("Catalogue.find")(
  function* (identity: AgentConnections.AgentIdentity, args: unknown, publicUrl: URL) {
    const decoded = decodeFind(args ?? {});
    if (Result.isFailure(decoded))
      return invalidArgs("find_patches", problemOf(decoded.failure), findFix);
    const given = decoded.success;
    const words = wordsOf(given.search);
    let walk: { readonly search?: string; readonly detail?: "tools"; readonly after?: Key } = {
      ...(words === undefined ? {} : { search: words }),
      ...(given.detail === undefined ? {} : { detail: given.detail })
    };
    if (given.cursor !== undefined) {
      const cursor = decodeCursor(given.cursor);
      if (Option.isNone(cursor))
        return invalidArgs(
          "find_patches",
          "cursor isn't one find_patches gave",
          "Leave it out to start from the first page."
        );
      const { search, detail } = cursor.value;
      if (
        (given.search !== undefined && words !== search) ||
        (given.detail !== undefined && given.detail !== detail)
      )
        return toolRefusal({ code: "invalid_args", from: "patchy", message: cursorFix });
      walk = cursor.value;
    }

    const entries = (yield* withTools(yield* visible(identity)))
      .filter(({ row }) => matches(row, walk.search))
      .map((listed) => ({ listed, key: keyOf(listed) }))
      .sort((left, right) => compare(left.key, right.key));
    const after = walk.after;
    const remaining =
      after === undefined ? entries : entries.filter(({ key }) => compare(key, after) > 0);

    const head = { actingFor: actingFor(identity), total: entries.length };
    const entryOf = (
      { row, tools }: Listed,
      form: "detail" | "names" | "none" = walk.detail === "tools" ? "detail" : "names"
    ) =>
      openPatchAnswer(
        {
          name: row.patch.name,
          description: row.patch.description,
          owner: row.owner.name,
          address: Patches.address(publicUrl.href, row.patch.companyHandle, row.patch.name)
        },
        form === "detail" ? tools : form === "names" ? tools.map(({ name }) => name) : []
      );
    const nextAfter = (key: Key) =>
      encodeCursor({
        after: key,
        ...(walk.search === undefined ? {} : { search: walk.search }),
        ...(walk.detail === undefined ? {} : { detail: walk.detail })
      });

    // Measured as the page grows: `{...head,"patches":[...]}` plus `,"next":"..."` while any remain.
    const page: Array<ReturnType<typeof entryOf>> = [];
    let chars = jsonLength({ ...head, patches: [] });
    let endedEarly = false;
    for (const [index, { listed, key }] of remaining.entries()) {
      if (page.length === PAGE_SIZE) break;
      // A cursor is base64url, which JSON never escapes.
      const next = index < remaining.length - 1 ? `,"next":""`.length + nextAfter(key).length : 0;
      const grown = (entry: ReturnType<typeof entryOf>) =>
        chars + jsonLength(entry) + (page.length === 0 ? 0 : 1);
      const fits = (entry: ReturnType<typeof entryOf>) => grown(entry) + next <= readAnswerChars;
      let entry = entryOf(listed);
      if (!fits(entry)) {
        if (page.length > 0) {
          endedEarly = true;
          break;
        }
        // Alone over the cap, which only tools that skipped the publish check can be: the
        // patch is listed with its tools' names, or without them, so the walk goes on.
        entry = fits(entryOf(listed, "names")) ? entryOf(listed, "names") : entryOf(listed, "none");
      }
      chars = grown(entry);
      page.push(entry);
    }
    const last = remaining[page.length - 1];
    const answer = toolAnswer({
      ...head,
      patches: page,
      ...(page.length < remaining.length && last !== undefined ? { next: nextAfter(last.key) } : {})
    });
    yield* WideEvents.enrich({
      catalogueTotal: entries.length,
      catalogueListed: page.length,
      catalogueEndedEarly: endedEarly,
      catalogueSearched: walk.search !== undefined,
      catalogueDetail: walk.detail === "tools",
      catalogueContinued: given.cursor !== undefined,
      resultBytes: utf8Bytes(answer.content[0].text)
    });
    return answer;
  },
  Effect.catchTags({ SqlError: Effect.die })
);

type PatchRef = "name" | "id" | "address";

/**
 * The patch `patch` names among `rows`, those the person can open, and how it named it: an
 * address on this instance under their company's handle, an id, or a name, a former one
 * following its rename as the address does. Anything else is none.
 */
export const resolve = Effect.fn("Catalogue.resolve")(function* (
  identity: AgentConnections.AgentIdentity,
  rows: ReadonlyArray<Patches.ListedPatch>,
  patch: string,
  publicUrl: URL
) {
  const ref = patch.trim();
  const byId = new Map(rows.map((row) => [row.patch.id, row] as const));
  const named = (name: string, by: PatchRef) =>
    Effect.gen(function* () {
      if (!isPatchName(name)) return undefined;
      const resolved = yield* (yield* Patches.Patches).resolveName(identity.company.handle, name);
      const row = Option.isSome(resolved) ? byId.get(resolved.value.patchId) : undefined;
      return row === undefined ? undefined : { row, by };
    });
  if (/^https?:/iu.test(ref)) {
    const url = URL.parse(ref);
    const base = publicUrl.pathname.replace(/\/+$/u, "");
    if (url === null || url.origin !== publicUrl.origin || !url.pathname.startsWith(`${base}/`))
      return undefined;
    // `/<company>/<name>`, and whatever path into the patch follows.
    const [handle, name] = url.pathname.slice(base.length + 1).split("/");
    if (handle !== identity.company.handle || name === undefined) return undefined;
    return yield* named(name, "address");
  }
  const own = byId.get(ref);
  if (own !== undefined) return { row: own, by: "id" as const };
  return yield* named(ref, "name");
});

/** One refusal for every patch the person can't open, so none of them can be told apart. */
export const notFound = (identity: AgentConnections.AgentIdentity) =>
  toolRefusal({
    code: "not_found",
    from: "patchy",
    message: `No patch you can open at ${identity.company.name} goes by that. Call find_patches to see the ones you can, and open one by the name it lists.`
  });

/** `open_patch { patch }`: the patch's own document, `{ name, description, owner, address, tools }`. */
export const open = Effect.fn("Catalogue.open")(
  function* (identity: AgentConnections.AgentIdentity, args: unknown, publicUrl: URL) {
    const decoded = decodeOpen(args ?? {});
    if (Result.isFailure(decoded))
      return invalidArgs(
        "open_patch",
        problemOf(decoded.failure),
        "Send { patch } with a name find_patches listed, the patch's id or its address."
      );
    const found = yield* resolve(
      identity,
      yield* visible(identity),
      decoded.success.patch,
      publicUrl
    );
    if (found === undefined) return notFound(identity);
    const { row } = found;
    yield* WideEvents.enrich({ patchRef: found.by, ...Patches.eventFields(row.patch) });
    // The version the list read, so a publish between the two reads can't mix them.
    const served =
      row.patch.currentVersionId === null
        ? Option.none()
        : yield* (yield* Patches.Patches).find(row.patch.id, undefined, row.patch.currentVersionId);
    if (Option.isNone(served)) return notFound(identity);
    const answer = toolAnswer(
      openPatchAnswer(
        {
          name: row.patch.name,
          description: row.patch.description,
          owner: row.owner.name,
          address: Patches.address(publicUrl.href, row.patch.companyHandle, row.patch.name)
        },
        agentTools(served.value.version.manifest)
      )
    );
    const bytes = utf8Bytes(answer.content[0].text);
    yield* WideEvents.enrich({ resultBytes: bytes });
    // The publish check keeps every version's tools inside it; this keeps the promise regardless.
    if (bytes > openPatchBytes)
      return toolRefusal({
        code: "too_large",
        from: "patchy",
        message: `${row.patch.name}'s agent tools are more than the ${openPatchBytes / 1024} KiB an agent reads in one answer, so it can't be opened. Tell the person its owner, ${row.owner.name}, can shorten their descriptions.`
      });
    return answer;
  },
  Effect.catchTags({ SqlError: Effect.die })
);
