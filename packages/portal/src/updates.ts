import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ContentStore } from "@patchy/content-store";
import { escapeHtml } from "@patchy/core";

/** A generated document shared by every company, outside patch-owned storage. */
export const objectKey = "platform-updates/history.json";
export const Entry = Schema.Struct({
  sequence: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  ),
  publishedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    Schema.makeFilter((value) => Option.isSome(DateTime.make(value)), {
      message: "Expected a valid date"
    })
  ),
  title: Schema.String,
  summary: Schema.String,
  deployment: Schema.optional(
    Schema.Struct({
      runId: Schema.Int.check(Schema.isGreaterThan(0)),
      attempt: Schema.Int.check(Schema.isGreaterThan(0)),
      commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
      url: Schema.String.check(
        Schema.isPattern(
          /^https:\/\/github\.com\/allisonmahmood\/patchy-cloud\/actions\/runs\/[0-9]+\/attempts\/[0-9]+$/
        )
      )
    })
  ),
  changes: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["New", "Improved", "Fixed"]),
      title: Schema.String,
      detail: Schema.String
    })
  )
});
export type Entry = typeof Entry.Type;
export const History = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(Entry).check(
    Schema.makeFilter(
      (entries) => new Set(entries.map((entry) => entry.sequence)).size === entries.length,
      { message: "Update sequences must be unique" }
    )
  )
});
export const decodeHistory = Schema.decodeUnknownEffect(Schema.fromJsonString(History));

export const read = Effect.gen(function* () {
  const store = yield* ContentStore.ContentStore;
  const document = yield* store
    .get(objectKey)
    .pipe(Effect.catchTag("ObjectNotFound", () => Effect.succeed('{"version":1,"entries":[]}')));
  const history = yield* decodeHistory(document);
  return [...history.entries].sort((a, b) => b.sequence - a.sequence);
});

const date = (value: string) =>
  DateTime.formatUtc(DateTime.makeUnsafe(value), {
    locale: "en-US",
    month: "long",
    day: "numeric",
    year: "numeric"
  });

/** Entries arrive newest first. A bell link still locates its update after newer pages arrive. */
export const paginate = (
  entries: ReadonlyArray<Entry>,
  query: { page?: string | null; release?: string | null } = {}
) => {
  const size = 10;
  const pages = Math.max(1, Math.ceil(entries.length / size));
  const requested = Number(query.page);
  const release = Number(query.release);
  const index =
    Number.isSafeInteger(release) && release > 0
      ? entries.findIndex((entry) => entry.sequence === release)
      : -1;
  const page =
    index >= 0
      ? Math.floor(index / size) + 1
      : Number.isSafeInteger(requested) && requested > 0
        ? Math.min(requested, pages)
        : 1;
  const start = (page - 1) * size;
  return { page, pages, start, entries: entries.slice(start, start + size) };
};

const navigation = (page: number, pages: number) => {
  if (pages === 1) return "";
  const numbers =
    pages <= 7
      ? Array.from({ length: pages }, (_, index) => index + 1)
      : [
          ...new Set(
            [1, pages, page - 1, page, page + 1].filter((value) => value >= 1 && value <= pages)
          )
        ].sort((a, b) => a - b);
  return `<nav class="actions updates-pagination" aria-label="Update history pages">
    ${page > 1 ? `<a class="btn btn-quiet" rel="prev" href="/updates?page=${page - 1}">Previous</a>` : ""}
    ${numbers.map((number, index) => `${index > 0 && number > numbers[index - 1]! + 1 ? '<span aria-hidden="true">…</span>' : ""}${number === page ? `<span class="btn btn-primary" aria-current="page" aria-label="Page ${number}">${number}</span>` : `<a class="btn btn-quiet" href="/updates?page=${number}" aria-label="Page ${number}">${number}</a>`}`).join("")}
    ${page < pages ? `<a class="btn btn-quiet" rel="next" href="/updates?page=${page + 1}">Next</a>` : ""}
  </nav>`;
};

export const render = (
  entries: ReadonlyArray<Entry>,
  query: { page?: string | null; release?: string | null } = {}
) => {
  const selected = paginate(entries, query);
  return `
  <div class="updates-page" data-updates-through="${entries[0]?.sequence ?? 0}">
    <h1 class="page-heading">What’s new in Patchy</h1>
    <p class="supporting-text">The latest improvements, all in one place.</p>
    <div class="updates-list" aria-label="Deployment updates">${selected.entries
      .map(
        (entry) => `
      <details class="update-entry" id="update-${entry.sequence}"><summary>
        <span class="update-date"><time datetime="${escapeHtml(entry.publishedAt)}">${date(entry.publishedAt)}</time>${entry.sequence === entries[0]?.sequence ? '<span class="pill">Latest</span>' : ""}</span>
        <span class="update-title">${escapeHtml(entry.title)}</span><span class="update-summary">${escapeHtml(entry.summary)}</span>
        <span class="update-chevron" aria-hidden="true">⌄</span>
      </summary><div class="update-content">${entry.changes
        .map(
          (change) => `
        <section class="update-change"><span class="pill ${change.kind === "New" ? "pill-done" : ""}">${escapeHtml(change.kind)}</span><div><h2>${escapeHtml(change.title)}</h2><p>${escapeHtml(change.detail)}</p></div></section>`
        )
        .join("")}
        <p class="supporting-text update-published">Available since ${date(entry.publishedAt)}.</p>
      </div></details>`
      )
      .join("")}</div>
    <p class="supporting-text updates-end">${entries.length ? `Showing ${selected.start + 1}–${selected.start + selected.entries.length} of ${entries.length} updates` : "No updates published yet."}</p>
    ${navigation(selected.page, selected.pages)}
  </div>`;
};
