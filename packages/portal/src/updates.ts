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

export const render = (entries: ReadonlyArray<Entry>) => `
  <div class="updates-page" data-updates-through="${entries[0]?.sequence ?? 0}">
    <h1 class="page-heading">What’s new in Patchy</h1>
    <p class="supporting-text">The latest improvements, all in one place.</p>
    <div class="updates-list" aria-label="Deployment updates">${entries
      .map(
        (entry, index) => `
      <details class="update-entry" id="update-${entry.sequence}"><summary>
        <span class="update-date"><time datetime="${escapeHtml(entry.publishedAt)}">${date(entry.publishedAt)}</time>${index === 0 ? '<span class="pill">Latest</span>' : ""}</span>
        <span class="update-title">${escapeHtml(entry.title)}</span><span class="update-summary">${escapeHtml(entry.summary)}</span>
        <span class="update-chevron" aria-hidden="true">⌄</span>
      </summary><div class="update-content">${entry.changes
        .map(
          (change) => `
        <section class="update-change"><span class="pill ${change.kind === "New" ? "pill-done" : ""}">${escapeHtml(change.kind)}</span><div><h2>${escapeHtml(change.title)}</h2><p>${escapeHtml(change.detail)}</p></div></section>`
        )
        .join("")}
        <p class="supporting-text update-published">Available since ${date(entry.publishedAt)}.</p>
        ${entry.deployment ? `<p class="supporting-text update-published"><a href="${escapeHtml(entry.deployment.url)}" target="_blank" rel="noopener noreferrer">View Deploy run on GitHub</a></p>` : ""}
      </div></details>`
      )
      .join("")}</div>
    <p class="supporting-text updates-end">${entries.length ? "You’ve reached the beginning." : "No updates published yet."}</p>
  </div>`;
