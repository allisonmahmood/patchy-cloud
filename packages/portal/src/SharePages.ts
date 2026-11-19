// Owns the Share dialog's forms, posted to `/patches/<name>/<act>`, and Remove… on a patch shared
// with the viewer. Renders with `share.ts`; what other surfaces need is in `shared/`.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { capBody } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { pageResponse, Receipt, RequireSession } from "@patchy/auth";
import { patchTitle } from "@patchy/core";
import { Users } from "@patchy/companies";
import { GuestGrants, Patches } from "@patchy/patches";
import { renderLeaveConfirmation } from "./share.js";
import {
  actionSelection,
  behind,
  context,
  errorPage,
  errors,
  forbidden,
  isName,
  maxNameLength,
  overlongName,
  pageErrors,
  pagePath,
  type PagesBehind,
  type Routes,
  type Sharing,
  staleNotice
} from "./shared/handlers.js";
import { accessLabel, manages } from "./shared/presentation.js";

/** General access as its form posts it; `teams` names them in `teamIds`. */
const decodeScope = Schema.decodeUnknownEffect(
  Schema.Struct({ scope: Schema.Literals(["company", "public", "teams"]) })
);

/** The forms of the Share dialog, each posted to `/patches/<name>/<act>`. */
type ShareAct = "add-guest" | "remove-guest" | "scope";

/**
 * Remove… on a patch shared with the viewer: GET asks, POST ends their own grant and lands Home
 * with a receipt. A patch no longer shared with them is not found.
 */
const leave = Effect.fn("SharePages.leave")(function* (patchId: string, method: "GET" | "POST") {
  const { viewer, session } = yield* context;
  const grants = yield* GuestGrants.GuestGrants;
  const shared = (yield* grants
    .sharedWith(viewer.user.id)
    .pipe(Effect.catchTags({ ConnectionStorageFailed: Effect.die }))).find(
    (entry) => entry.patchId === patchId
  );
  if (shared === undefined)
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  if (method === "GET")
    return pageResponse(
      {
        title: `Remove ${patchTitle(shared, shared.company.name)}?`,
        ...renderLeaveConfirmation(shared),
        app: { viewer, section: "home" }
      },
      session
    );
  yield* grants.revoke({ patchId, userId: viewer.user.id });
  return Receipt.set(
    HttpServerResponse.redirect("/", {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    }),
    {
      userId: viewer.user.id,
      text: `Removed ${patchTitle(shared, shared.company.name)}`,
      publicBaseUrl: session.publicBaseUrl
    }
  );
});

/**
 * The Share dialog's forms and Remove…. `pages` are the pages the dialog opens over, which a
 * refused form draws again with the dialog open; the portal's route list supplies them.
 */
export const layer = (pages: PagesBehind): Routes => {
  /**
   * A Share dialog form: add a guest, remove one, or change who can open the patch, as its owner or
   * an admin. Done, it lands back on the page the dialog opened over, open, with a receipt; going
   * public unasked lands on the dialog asking (`&confirm=public`), and a refusal shows in the
   * dialog, with the email kept.
   */
  const shareAct = Effect.fn("SharePages.shareAct")(function* (name: string, act: ShareAct) {
    if (name.length > maxNameLength) return yield* overlongName;
    if (!isName(name))
      return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
    const { viewer, session } = yield* context;
    const patches = yield* Patches.Patches;
    const selected = yield* actionSelection(name);
    if (!selected)
      return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
    yield* WideEvents.enrich({ patchId: selected.patch.id });
    const request = yield* HttpServerRequest.HttpServerRequest;
    const values = new URLSearchParams(yield* request.text.pipe(capBody(16_384)));
    const form = Object.fromEntries(values);
    // As every patch form: one rendered for whichever patch had this name stops here.
    if (form.expectedPatchId !== selected.patch.id)
      return yield* pages.card(name, {
        status: 409,
        readOnly: true,
        notice: form.expectedPatchId
          ? "This name now belongs to a different patch. Nothing was done."
          : "This form is out of date. Nothing was done."
      });
    if (!manages(selected)) return yield* pages.card(name, { status: 403, notice: forbidden });
    const actor = { userId: viewer.user.id, admin: viewer.role === "admin" };
    const at = behind(form.back, name, session.publicBaseUrl);
    const title = patchTitle(selected.patch, viewer.company.name);
    const grants = yield* GuestGrants.GuestGrants;
    /**
     * Back to the page behind with the dialog open, asking about going public when `confirm`, and a
     * receipt for it when something changed.
     */
    const reopened = (receipt?: string, confirm = false) => {
      const response = HttpServerResponse.redirect(
        pagePath(at) +
          `${at.search ? "&" : "?"}share=${encodeURIComponent(name)}${confirm ? "&confirm=public" : ""}`,
        { status: 303, headers: { "cache-control": "private, no-store" } }
      );
      return receipt === undefined
        ? response
        : Receipt.set(response, {
            userId: viewer.user.id,
            text: receipt,
            publicBaseUrl: session.publicBaseUrl
          });
    };
    /** The page behind again, with the dialog open and what it has to say. */
    const again = Effect.fnUntraced(function* (sharing: Omit<Sharing, "name" | "at">) {
      const shown = {
        ...sharing,
        name,
        at,
        ...(act === "scope"
          ? {
              submitted: {
                scope: form.scope ?? selected.audience.kind,
                teamIds: values.getAll("teamIds")
              }
            }
          : {})
      };
      if (at.pathname === "/") return yield* pages.home(shown);
      if (at.pathname === "/patches") return yield* pages.allPatches(shown);
      const tab = at.pathname.endsWith("/versions")
        ? "versions"
        : at.pathname.endsWith("/settings")
          ? "settings"
          : undefined;
      return yield* pages.card(name, { ...(tab === undefined ? {} : { tab }), sharing: shown });
    });
    const email = (form.email ?? "").trim();
    const run = Effect.gen(function* () {
      // Off its address, only its audience changes; a guest form for it is stale.
      if (act !== "scope" && selected.patch.state !== "live")
        return yield* new Patches.WrongState({ state: selected.patch.state });
      switch (act) {
        case "add-guest": {
          if (email === "") return reopened();
          const { guest } = yield* grants.share({ patchId: selected.patch.id, actor, email });
          return reopened(`Shared ${title} with ${guest.name}`);
        }
        case "remove-guest": {
          const userId = form.guest ?? "";
          const { removed } = yield* grants.remove({
            patchId: selected.patch.id,
            actor,
            guest: userId
          });
          const named = removed
            ? (yield* (yield* Users.Users).names([userId])).get(userId)
            : undefined;
          return reopened(
            named === undefined ? undefined : `Stopped sharing ${title} with ${named}`
          );
        }
        case "scope": {
          const fields = yield* decodeScope(form);
          // Going public asks first, at its own address, and only its answer applies it,
          // re-running every check.
          if (fields.scope === "public" && form.confirm !== "public") {
            if (selected.tier >= 2) return yield* new Patches.Tier2NotPublic();
            return reopened(undefined, true);
          }
          const shared = yield* patches.setSharing({
            patchId: selected.patch.id,
            actor,
            audience:
              fields.scope === "teams"
                ? { kind: "teams", teamIds: values.getAll("teamIds") }
                : { kind: fields.scope },
            expectedLifecycleRevision: form.expectedLifecycleRevision,
            force: form.force === "true"
          });
          const open =
            shared.audience.kind === "public"
              ? "anyone on the internet"
              : shared.audience.kind === "company"
                ? `people at ${viewer.company.name}`
                : `people on ${accessLabel(shared.audience)}`;
          return reopened(`${title} is open to ${open}`);
        }
      }
    });
    const nothing = (notice: string) => `${notice} Nothing was done.`;
    // setSharing's type names every lifecycle refusal; one that can't answer it still says why.
    const onCard = (error: { readonly message: string }) =>
      pages.card(name, { status: 409, notice: nothing(error.message) });
    return yield* run.pipe(
      Effect.catchTags({
        PatchRetired: onCard,
        PatchDeleted: onCard,
        HasDependants: (error) =>
          again({
            status: 409,
            narrowing: { dependants: error.dependants, hiddenCount: error.hiddenCount ?? 0 }
          }),
        SourcesOff: onCard,
        ReservedName: onCard,
        InvalidDescription: onCard,
        VersionUnavailable: onCard,
        InvalidOwner: onCard,
        NotOnPatchy: (refusal) => again({ status: 422, refused: { email, refusal } }),
        AlreadyMember: (refusal) => again({ status: 409, refused: { email, refusal } }),
        GuestsUnavailable: (refusal) => again({ status: 422, refused: { email, refusal } }),
        OwnerAccessLost: (error) => pages.card(name, { status: 403, notice: error.message }),
        InvalidAudienceTeams: (error) => again({ status: 422, notice: error.message }),
        AudienceExcludesOwner: (error) => again({ status: 422, notice: error.message }),
        UpgradeRequired: Effect.die,
        NotOwner: () => pages.card(name, { status: 403, notice: forbidden }),
        WrongState: (error) =>
          Effect.flatMap(staleNotice(selected.patch.id, error.state), (notice) =>
            pages.card(name, { status: 409, notice })
          ),
        StaleAction: () =>
          Effect.flatMap(staleNotice(selected.patch.id), (notice) =>
            again({ status: 409, notice })
          ),
        Tier2NotPublic: (error) => again({ status: 422, notice: nothing(error.message) }),
        SchemaError: () =>
          again({ status: 422, notice: nothing("Check the submitted fields and try again.") }),
        ConnectionStorageFailed: Effect.die
      })
    );
  });

  return HttpRouter.use((router) =>
    Effect.gen(function* () {
      for (const act of ["add-guest", "remove-guest", "scope"] as const)
        yield* router.add(
          "POST",
          `/patches/:name/${act}`,
          errors(
            RequireSession.sameOrigin(
              RequireSession.withViewer(
                Effect.flatMap(HttpRouter.params, (params) =>
                  shareAct(params.name ?? "", act)
                ).pipe(pageErrors)
              )
            )
          )
        );
      for (const method of ["GET", "POST"] as const) {
        const handler = RequireSession.withViewer(
          Effect.flatMap(HttpRouter.params, (params) => leave(params.patchId ?? "", method)).pipe(
            pageErrors
          )
        );
        yield* router.add(
          method,
          "/shared/:patchId/remove",
          errors(method === "POST" ? RequireSession.sameOrigin(handler) : handler)
        );
      }
    })
  );
};
