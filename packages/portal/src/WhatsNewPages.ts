import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as SqlClient from "effect/sql/SqlClient";
import { pageResponse, RequireSession, Session } from "@patchy/auth";
import { escapeHtml, WhatsNew, whatsNewKind } from "@patchy/core";
import { type Companies, Users } from "@patchy/companies";
import { errors } from "./PortalPages.js";

/** Page layout only; the rows, tags, tint and rule are the shell's What's new components. */
const styles = `
  .whats-new { max-width: 880px; margin-inline: auto; }
  .whats-new-day { margin-top: 36px; }
  .whats-new-day > .list { margin: 0; }
`;

/** Consecutive releases written the same day read as one day. */
const byDay = (releases: ReadonlyArray<WhatsNew.Release>) =>
  releases.reduce<Array<Array<WhatsNew.Release>>>((grouped, release) => {
    const last = grouped.at(-1);
    if (last?.[0]?.date === release.date) last.push(release);
    else grouped.push([release]);
    return grouped;
  }, []);

/** "Tuesday, October 6", with the year once it differs from `year`, the newest release's. */
const dayLabel = (date: string, year: string | undefined) =>
  DateTime.formatUtc(DateTime.makeUnsafe(`${date}T00:00:00Z`), {
    locale: "en-US",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.slice(0, 4) === year ? undefined : "numeric"
  });

const rule = (tag: "p" | "li") =>
  `<${tag} class="whats-new-seen supporting-text">You’ve seen everything below</${tag}>`;

/**
 * The changelog newest first, tinting changes released after `seen`. A rule marks where the
 * changes they have seen begin: before a day they saw whole, or between two releases of one day.
 */
export const render = (releases: ReadonlyArray<WhatsNew.Release>, seen: number): string => {
  const days = byDay(releases);
  const rowsByDay = days.map((day) =>
    day.flatMap((release) =>
      release.changes.map((change) => ({ change, unseen: release.id > seen }))
    )
  );
  const missed = rowsByDay.some((rows) => rows.some(({ unseen }) => unseen));
  const seenWhole = (day: ReadonlyArray<WhatsNew.Release>) =>
    day.every((release) => release.id <= seen);
  const ruleDay = missed
    ? days.findIndex(
        (day, index) => seenWhole(day) || (rowsByDay[index] ?? []).some(({ unseen }) => !unseen)
      )
    : -1;
  const sections = days.map((day, index) => {
    const rows = rowsByDay[index] ?? [];
    const ruleRow =
      index === ruleDay && !seenWhole(day) ? rows.findIndex(({ unseen }) => !unseen) : -1;
    const items = rows.map(
      ({ change, unseen }, row) =>
        `${row === ruleRow ? rule("li") : ""}<li class="list-row whats-new-change${unseen ? " whats-new-unseen" : ""}">${whatsNewKind(change.kind)}<div><p><strong>${escapeHtml(change.title)}</strong></p><p>${escapeHtml(change.detail)}</p></div></li>`
    );
    const behind = day.flatMap((release) => release.behindTheScenes);
    const behindRow = behind.length
      ? `<li class="list-row"><details><summary class="supporting-text">Behind the scenes · ${behind.length} ${behind.length === 1 ? "change" : "changes"}</summary><ul class="list list-compact">${behind.map((line) => `<li class="list-row supporting-text">${escapeHtml(line)}</li>`).join("")}</ul></details></li>`
      : "";
    return `${index === ruleDay && seenWhole(day) ? rule("p") : ""}<section class="whats-new-day"><div class="whats-new-day-head"><h2 class="section-heading">${dayLabel(day[0]?.date ?? "", releases[0]?.date.slice(0, 4))}</h2><span class="supporting-text">${WhatsNew.tally(rows.map(({ change }) => change))}</span></div><ul class="list">${items.join("")}${behindRow}</ul></section>`;
  });
  return `<article class="whats-new"><h1 class="page-heading">What’s new in Patchy</h1><p class="supporting-text">Everything we’ve shipped, newest first.${missed ? " What’s new since your last visit is highlighted." : ""}</p>${sections.join("")}</article>`;
};

/** Opening the bell's panel reports what it showed; the panel's own markup carries `through`. */
const bellScript = `(() => {
  const panel = document.getElementById("whats-new");
  const dot = document.querySelector(".whats-new-dot");
  if (!panel || !dot) return;
  panel.addEventListener("toggle", (event) => {
    if (event.newState !== "open" || !dot.isConnected) return;
    dot.remove();
    document.querySelector(".whats-new-bell")?.setAttribute("aria-label", "What's new");
    void fetch("/whats-new/seen", {
      method: "POST",
      body: new URLSearchParams({ through: panel.dataset.through ?? "0" })
    }).catch(() => {});
  });
})();
`;

const decodeSeen = Schema.decodeUnknownEffect(
  Schema.Struct({ through: Schema.NumberFromString.check(Schema.isInt()) })
);

/** A failed marker write only leaves the dot for next time; the page still answers. */
const markSeen = (userId: string, through: number) =>
  Effect.flatMap(Users.Users, (users) =>
    users.markWhatsNewSeen({ userId, through: Math.min(through, WhatsNew.latestRelease) })
  ).pipe(Effect.catchTags({ SqlError: () => Effect.void }));

const page = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const body = render(WhatsNew.releases, viewer.whatsNewSeen);
  yield* markSeen(viewer.user.id, WhatsNew.latestRelease);
  return pageResponse(
    {
      title: "What’s new in Patchy",
      heading: "",
      body,
      styles,
      app: {
        viewer: { ...viewer, whatsNewSeen: WhatsNew.latestRelease },
        section: "whats-new"
      }
    },
    session
  );
});

const seen = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = Object.fromEntries(
    yield* request.urlParamsBody.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(1_024))
    )
  );
  const { through } = yield* decodeSeen(form);
  yield* markSeen(viewer.user.id, through);
  return HttpServerResponse.empty({ status: 204 });
}).pipe(
  Effect.catchTags({
    SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 }))
  })
);

export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      Session.Session | Companies.Companies | Users.Users | SqlClient.SqlClient
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/whats-new", errors(RequireSession.withViewer(page)));
    yield* router.add(
      "POST",
      "/whats-new/seen",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(seen)))
    );
    yield* router.add(
      "GET",
      "/whats-new/bell.js",
      HttpServerResponse.text(bellScript, {
        contentType: "text/javascript",
        headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" }
      })
    );
  })
);
