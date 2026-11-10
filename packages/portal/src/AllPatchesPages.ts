// Owns All patches at `/patches`, its `?show=` tabs and search, and `/patches/*` paths no patch has.
// Renders with `allPatches.ts`; anything another surface needs comes from `shared/`.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import { pageResponse, RequireSession } from "@patchy/auth";
import { Users } from "@patchy/companies";
import { Patches } from "@patchy/patches";
import { listStyles, renderAllPatches, shows } from "./allPatches.js";
import {
  asked,
  callSummary,
  context,
  errorPage,
  errors,
  maxNameLength,
  overlongName,
  type Page,
  pageErrors,
  prewarm,
  shareOverlay,
  shareStyles,
  type Sharing,
  turnedAway,
  type Routes,
  withOverlay
} from "./shared/handlers.js";
import { searchQuery, styles } from "./shared/presentation.js";

/**
 * All patches at `/patches`: every patch the viewer can open, in `?show=` tabs, searched by `?q=`.
 * A refused Share form draws it again with the dialog open.
 */
export const page: (refused?: Sharing) => Page = Effect.fn("AllPatchesPages.page")(function* (
  refused?: Sharing
) {
  const { viewer, session, access, url } = yield* context;
  const at = refused?.at ?? url;
  const params = at.searchParams;
  const show = shows.find((candidate) => candidate === params.get("show")) ?? "all";
  const query = searchQuery(params.get("q"));
  const patches = yield* Patches.Patches;
  const rows = yield* patches.read({ ...access, state: "all" });
  const opens = new Map((yield* patches.opens(viewer.user.id)).map((open) => [open.patchId, open]));
  yield* prewarm(rows, opens);
  const members = yield* (yield* Users.Users).list(viewer.company.id);
  const sharing = refused ?? asked(at);
  const overlay = yield* shareOverlay(rows, sharing);
  return pageResponse(
    {
      title: "All patches",
      heading: "",
      body: renderAllPatches({
        rows,
        viewer,
        show,
        query,
        now: yield* Clock.currentTimeMillis,
        publicBaseUrl: session.publicBaseUrl,
        opens,
        names: new Map(members.map((member) => [member.id, member.name])),
        calls: yield* callSummary(rows),
        turnedAway: yield* turnedAway(rows)
      }),
      styles: styles + listStyles + shareStyles,
      status: sharing?.status ?? 200,
      app: { ...withOverlay(viewer, overlay), section: "patches" }
    },
    session
  );
});

export const layer: Routes = HttpRouter.use((router) =>
  // The wildcard also answers `/patches` itself, which is All patches.
  router.add(
    "GET",
    "/patches/*",
    errors(
      RequireSession.withViewer(
        Effect.flatMap(HttpRouter.params, (params) => {
          const rest = params["*"] ?? "";
          if (rest === "") return page();
          return rest.split("/", 1)[0]!.length > maxNameLength
            ? overlongName
            : errorPage(404, "Patch not found", "The requested patch is unavailable.");
        }).pipe(pageErrors)
      )
    )
  )
);
