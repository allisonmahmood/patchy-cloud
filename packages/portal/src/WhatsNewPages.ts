// Owns What's new: a page per month at `/whats-new/YYYY-MM`, the newest at `/whats-new`, the bell's
// seen marker and script, and the public feed at `/whats-new.json`. What other surfaces need is in
// `shared/`.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as SqlClient from "effect/sql/SqlClient";
import { capBody } from "@patchy/api";
import { pageResponse, RequireSession, Session } from "@patchy/auth";
import {
  behindTheScenes,
  changeEntry,
  emptyState,
  indexPage,
  linkButton,
  section,
  WhatsNew,
  WhatsNewLinks
} from "@patchy/core";
import { type Companies, Users } from "@patchy/companies";
import { errors } from "./shared/handlers.js";

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
] as const;
const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
] as const;

/** "November 2026", for a month's `YYYY-MM`. */
export const monthLabel = (month: string) =>
  `${monthNames[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;

/** "Saturday, 7 November": the month page names its year. */
const dayLabel = (date: string) => {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(`${date}T00:00:00Z`));
  return `${weekdays[parts.weekDay]}, ${parts.day} ${monthNames[parts.month - 1]}`;
};

/** Consecutive releases written the same day read as one day. */
const byDay = (releases: ReadonlyArray<WhatsNew.Release>) =>
  releases.reduce<Array<Array<WhatsNew.Release>>>((grouped, release) => {
    const last = grouped.at(-1);
    if (last?.[0]?.date === release.date) last.push(release);
    else grouped.push([release]);
    return grouped;
  }, []);

/** One day: its changes, newest first, then the work nobody would notice. */
const day = (releases: ReadonlyArray<WhatsNew.Release>, seen: number) => {
  const changes = releases.flatMap((release) => release.changes);
  const behind = releases.flatMap((release) => release.behindTheScenes);
  const tally = WhatsNew.tally(changes);
  return section({
    title: dayLabel(releases[0]?.date ?? ""),
    ...(tally === "" ? {} : { action: `<span class="meta">${tally}</span>` }),
    body: `${releases
      .flatMap((release) =>
        release.changes.map((change, n) =>
          changeEntry({
            id: WhatsNewLinks.changeId(release, n),
            href: WhatsNewLinks.permalink(release, n),
            kind: change.kind,
            title: change.title,
            detail: change.detail,
            unseen: release.id > seen
          })
        )
      )
      .join("")}${behind.length > 0 ? behindTheScenes(behind) : ""}`
  });
};

/**
 * The month `month` of `releases` (newest first), or nothing when no release shipped in it: its
 * days newest first, each change open and marked when it shipped after `seen`, and links to the
 * months either side. While anything is newer than `seen`, those links carry it, so the month
 * they open marks what is new to the viewer after this page has raised their marker.
 */
export const render = (releases: ReadonlyArray<WhatsNew.Release>, month: string, seen: number) => {
  const months = [...new Set(releases.map(WhatsNewLinks.monthOf))];
  const at = months.indexOf(month);
  if (at === -1) return undefined;
  const since = seen < (releases[0]?.id ?? 0) ? seen : undefined;
  const shown = releases.filter((release) => WhatsNewLinks.monthOf(release) === month);
  const unseen = shown
    .filter((release) => release.id > seen)
    .flatMap((release) => release.changes).length;
  const neighbour = (other: string | undefined, earlier: boolean) =>
    other === undefined
      ? ""
      : linkButton(monthLabel(other), WhatsNewLinks.monthHref(other, since), {
          size: "sm",
          ...(earlier ? { icon: "back" as const } : {})
        });
  const nav = `${neighbour(months[at + 1], true)}${neighbour(months[at - 1], false)}`;
  return indexPage({
    title: "What’s new",
    meta: [monthLabel(month), ...(unseen > 0 ? [`${unseen} new to you`] : [])],
    ...(nav === "" ? {} : { actions: nav, pagination: nav }),
    content: byDay(shown)
      .map((releases) => day(releases, seen))
      .join("")
  });
};

/**
 * The changelog as anyone may read it, for patchyhq.com: New and Improved changes only, without
 * their PRs, `through` or behind-the-scenes lines. A release with none of those is left out.
 */
export const publicReleases = (releases: ReadonlyArray<WhatsNew.Release>) =>
  releases.flatMap(({ id, date, changes }) => {
    const shown = changes.flatMap(({ kind, title, detail }) =>
      kind === "New" || kind === "Improved" ? [{ kind, title, detail }] : []
    );
    return shown.length > 0 ? [{ id, date, changes: shown }] : [];
  });

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
/** `?since=`, written in digits; anything else, an empty value included, is as if it were absent. */
const decodeSince = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isPattern(/^\d+$/u)).pipe(
    Schema.decodeTo(Schema.NumberFromString.check(Schema.isInt()))
  )
);

/** A failed marker write only leaves the dot for next time; the page still answers. */
const markSeen = (userId: string, through: number) =>
  Effect.flatMap(Users.Users, (users) =>
    users.markWhatsNewSeen({ userId, through: Math.min(through, WhatsNew.latestRelease) })
  ).pipe(Effect.catchTags({ SqlError: () => Effect.void }));

const newestMonth =
  WhatsNew.releases[0] === undefined ? "" : WhatsNewLinks.monthOf(WhatsNew.releases[0]);

/**
 * A month's page, the newest when `month` is missing. It marks what shipped after the viewer's
 * marker, or after `?since=` when that is lower, as a link out of a panel or page drawn before
 * the marker moved says. Opening the newest month raises the marker; an older one leaves it.
 */
const page = (month: string | undefined) =>
  Effect.gen(function* () {
    const viewer = yield* RequireSession.Viewer;
    const session = yield* Session.Session;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const since = decodeSince(
      new URL(request.url, session.publicBaseUrl).searchParams.get("since") ?? undefined
    ).pipe(Option.getOrElse(() => viewer.whatsNewSeen));
    const shown = month ?? newestMonth;
    // `since` can only mark more, never hide what the viewer hasn't seen.
    const content = render(WhatsNew.releases, shown, Math.min(since, viewer.whatsNewSeen));
    if (content === undefined)
      return pageResponse(
        {
          title: "What’s new",
          status: 404,
          ...indexPage({
            title: "What’s new",
            content: emptyState({
              title: "Nothing shipped that month",
              action: linkButton("See what’s new", WhatsNewLinks.monthHref())
            })
          }),
          app: { viewer, section: "whats-new" }
        },
        session
      );
    const newest = shown === newestMonth;
    if (newest) yield* markSeen(viewer.user.id, WhatsNew.latestRelease);
    return pageResponse(
      {
        title: `${monthLabel(shown)} – What’s new`,
        ...content,
        app: {
          viewer: newest ? { ...viewer, whatsNewSeen: WhatsNew.latestRelease } : viewer,
          section: "whats-new"
        }
      },
      session
    );
  });

const seen = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = Object.fromEntries(yield* request.urlParamsBody.pipe(capBody(1_024)));
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
    yield* router.add("GET", "/whats-new", errors(RequireSession.withViewer(page(undefined))));
    yield* router.add(
      "GET",
      "/whats-new/:month",
      errors(
        RequireSession.withViewer(
          Effect.flatMap(HttpRouter.params, (params) => page(params.month ?? ""))
        )
      )
    );
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
    // No session: the website fetches it server-side, so it needs no CORS either.
    yield* router.add(
      "GET",
      "/whats-new.json",
      HttpServerResponse.jsonUnsafe(
        { releases: publicReleases(WhatsNew.releases) },
        { headers: { "cache-control": "public, max-age=300" } }
      )
    );
  })
);
