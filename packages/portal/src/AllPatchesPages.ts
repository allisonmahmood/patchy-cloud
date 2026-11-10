// Owns All patches at `/patches`, its `?show=` filters, the sidebar's search and paging, and
// `/patches/*` paths no patch has. Renders with `allPatches.ts`; anything another surface needs
// comes from `shared/`.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import { MachineTokens, pageResponse, RequireSession } from "@patchy/auth";
import { Users } from "@patchy/companies";
import { GuestGrants, Patches } from "@patchy/patches";
import { renderAllPatches, shows } from "./allPatches.js";
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
  type Sharing,
  turnedAway,
  type Routes,
  withOverlay
} from "./shared/handlers.js";
import { searchQuery } from "./shared/presentation.js";

/**
 * All patches at `/patches`: every patch the viewer can open, in `?show=` filters, searched by the
 * sidebar's `?q=` and paged by `?page=`. A refused Share form draws it again with the dialog open.
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
  // How many guests each patch has, by name, from the company's guests and what each holds.
  const guests = new Map<string, number>();
  for (const guest of yield* (yield* GuestGrants.GuestGrants).companyGuests(viewer.company.id))
    for (const shared of guest.patches) guests.set(shared.name, (guests.get(shared.name) ?? 0) + 1);
  // Only a search asks whether the viewer has connected an agent, for what finding nothing offers.
  const connected =
    query === "" || (yield* (yield* MachineTokens.MachineTokens).list(viewer.user.id)).length > 0;
  const sharing = refused ?? asked(at);
  const overlay = yield* shareOverlay(rows, sharing);
  return pageResponse(
    {
      title: "All patches",
      ...renderAllPatches({
        rows,
        viewer,
        show,
        query,
        page: Number.parseInt(params.get("page") ?? "", 10) || 1,
        now: yield* Clock.currentTimeMillis,
        publicBaseUrl: session.publicBaseUrl,
        opens,
        names: new Map(members.map((member) => [member.id, member.name])),
        guests,
        connected,
        calls: yield* callSummary(rows),
        turnedAway: yield* turnedAway(rows)
      }),
      status: sharing?.status ?? 200,
      app: { ...withOverlay(viewer, overlay), section: "patches", query }
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
