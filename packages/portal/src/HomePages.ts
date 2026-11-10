// Owns Home at `/` and the guide: `/guide`, its steps, Later, a new setup line and its script.
// Renders with `home.ts` and `guide.ts`; anything another surface needs comes from `shared/`.
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Analytics } from "@patchy/analytics";
import {
  MachineTokens,
  pageResponse,
  RequireSession,
  SetupLinks,
  SetupPrompts
} from "@patchy/auth";
import { escapeAttribute } from "@patchy/core";
import { GuestGrants, Patches } from "@patchy/patches";
import { Limits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import {
  finalStepStyles,
  firstPatch,
  guideScript,
  guideScriptPath,
  renderFinalStep,
  renderSetupSteps,
  renderWatch,
  type SetupState
} from "./guide.js";
import { homeStyles, renderHome, renderPublishedNote } from "./home.js";
import {
  asked,
  callSummary,
  context,
  errorPage,
  errors,
  type Page,
  pageErrors,
  prewarm,
  shareOverlay,
  shareStyles,
  type Routes,
  type Sharing,
  withOverlay
} from "./shared/handlers.js";
import { searchQuery, styles } from "./shared/presentation.js";

/** The machine most recently logged in as this user, while any is live. */
const newestMachine = Effect.fn("HomePages.newestMachine")(function* (userId: string) {
  const machines = yield* (yield* MachineTokens.MachineTokens).list(userId);
  const newest = machines.reduce<(typeof machines)[number] | undefined>(
    (latest, machine) =>
      latest === undefined || machine.createdAt > latest.createdAt ? machine : latest,
    undefined
  );
  return newest === undefined ? null : { name: newest.name, createdAt: newest.createdAt };
});

/** How long after a computer connects Home keeps watching for the first publication. */
const watchWindow = 30 * 60 * 1_000;

/**
 * Where the viewer's setup stands. With a live machine token they are connected, and live once one
 * of their live keys published something still live, preferring the key their setup line made;
 * attribution is by the publishing key, so a patch reassigned to them never counts. Without one,
 * the line's link says how far the agent got and how its login ended.
 */
const setupState = Effect.fn("HomePages.setupState")(function* () {
  const { viewer, access } = yield* context;
  const machines = yield* (yield* MachineTokens.MachineTokens).list(viewer.user.id);
  const link = yield* SetupLinks.status(viewer.user.id);
  const setupLink = Option.isSome(link) && link.value.live ? link.value.value : undefined;
  if (machines.length > 0) {
    const bound = Option.isSome(link)
      ? machines.find((machine) => machine.id === link.value.machineTokenId)
      : undefined;
    const patches = yield* Patches.Patches;
    const published = yield* patches.publishedWith(
      bound === undefined ? machines.map((machine) => machine.id) : [bound.id]
    );
    const [row] = Option.isSome(published)
      ? yield* patches.read({ ...access, state: "all", patchRef: published.value })
      : [];
    const state: SetupState = row === undefined ? { kind: "connected" } : { kind: "live", row };
    return { connected: true, setupLink, state };
  }
  const now = yield* Clock.currentTimeMillis;
  const state = Option.match(link, {
    onNone: (): SetupState => ({ kind: "waiting" }),
    onSome: (line): SetupState =>
      !line.live
        ? { kind: "fallback", reason: "ran_out" }
        : line.outcome === "pending" &&
            line.loginExpiresAt !== null &&
            line.loginExpiresAt.getTime() <= now
          ? { kind: "fallback", reason: "expired" }
          : line.outcome === null
            ? { kind: line.pickedUp ? "picked_up" : "waiting" }
            : line.outcome === "pending"
              ? line.loginState === "pending"
                ? line.userCode !== null && line.machineNameHint !== null
                  ? {
                      kind: "login_pending",
                      login: {
                        userCode: line.userCode,
                        machineNameHint: line.machineNameHint,
                        oldMachineName: line.oldMachineName
                      }
                    }
                  : { kind: "login_pending" }
                : line.loginState === "confirmed"
                  ? { kind: "confirming" }
                  : {
                      kind: "fallback",
                      reason: line.loginState === "denied" ? "denied" : "expired"
                    }
              : line.outcome === "connected"
                ? { kind: "fallback", reason: "ran_out" }
                : { kind: "fallback", reason: line.outcome }
  });
  return { connected: false, setupLink, state };
});

/** The viewer's live setup line, made for the panel when they have none; a new one is reported. */
const setupLine = Effect.fn("HomePages.setupLine")(function* () {
  const { viewer } = yield* context;
  const line = yield* SetupLinks.current(viewer.user.id);
  if (line.created)
    yield* (yield* Analytics.Analytics).track({
      name: "setup.line_shown",
      principalId: viewer.user.id,
      companyId: viewer.company.id,
      properties: { setupId: line.setupId }
    });
  return line.value;
});

/**
 * Home at `/`: the viewer's usual patches, the company's tools and pages, or what `?q=` finds,
 * which the sidebar's search keeps. Until the viewer connects an agent, the Final step panel sits
 * over it at each sign-in for their first week or first three sign-ins, whichever lasts longer,
 * unless they pressed Later. A refused Share form draws it again with the dialog open.
 */
export const page: (refused?: Sharing) => Page = Effect.fn("HomePages.page")(function* (
  refused?: Sharing
) {
  const { viewer, session, access, url } = yield* context;
  const signedIn = yield* RequireSession.SignedIn;
  const at = refused?.at ?? url;
  const query = searchQuery(at.searchParams.get("q"));
  const patches = yield* Patches.Patches;
  const rows = yield* patches.read({ ...access, state: "all" });
  const opens = new Map((yield* patches.opens(viewer.user.id)).map((open) => [open.patchId, open]));
  yield* prewarm(rows, opens);
  const now = yield* Clock.currentTimeMillis;
  const machine = yield* newestMachine(viewer.user.id);
  // Everyone's sign-ins count, so someone who connects and later revokes every key stays out.
  const prompt = yield* SetupPrompts.seen(viewer.user.id, signedIn.sid);
  const first = firstPatch(rows, viewer.user.id, now);
  // Without the panel, Home still watches for the first publication: after Later, or for a
  // while after a computer connects.
  const watch =
    machine === null
      ? prompt.later
      : now - Date.parse(machine.createdAt) < watchWindow &&
        (yield* setupState()).state.kind === "connected";
  const sharing = refused ?? asked(at);
  const overlay = yield* shareOverlay(rows, sharing);
  const shared = yield* (yield* GuestGrants.GuestGrants)
    .sharedWith(viewer.user.id)
    .pipe(Effect.catchTags({ ConnectionStorageFailed: Effect.die }));
  return pageResponse(
    {
      title: "Home",
      heading: "",
      body: `${renderHome({
        rows,
        viewer,
        opens,
        now,
        publicBaseUrl: session.publicBaseUrl,
        query,
        connected: machine !== null,
        note: first === undefined ? undefined : renderPublishedNote(first, session.publicBaseUrl),
        calls: yield* callSummary(rows),
        shared
      })}${watch ? renderWatch(machine === null ? "waiting" : "connected", viewer.user.id) : ""}`,
      styles: styles + homeStyles + finalStepStyles + shareStyles,
      status: sharing?.status ?? 200,
      app: {
        section: "home",
        query,
        ...(overlay === undefined && machine === null && prompt.show
          ? {
              viewer,
              overlay: renderFinalStep({
                state: (yield* setupState()).state,
                setupLink: yield* setupLine(),
                viewer,
                publicBaseUrl: session.publicBaseUrl,
                mode: "modal"
              })
            }
          : withOverlay(viewer, overlay))
      }
    },
    session
  );
});

/** The server owns GET / and its signed-out door alongside the catch-all. */
export const index = page().pipe(pageErrors);

/** `/guide`, the Final step panel as a page, for anyone not yet connected; others go Home. */
const guidePage = Effect.fn("HomePages.guidePage")(function* () {
  const { viewer, session } = yield* context;
  const { connected, state } = yield* setupState();
  if (connected)
    return HttpServerResponse.redirect("/", {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    });
  return pageResponse(
    {
      title: "Final step",
      heading: "",
      body: renderFinalStep({
        state,
        setupLink: yield* setupLine(),
        viewer,
        publicBaseUrl: session.publicBaseUrl,
        mode: "page"
      }),
      styles: styles + finalStepStyles,
      app: { viewer, section: "home" }
    },
    session
  );
});

/**
 * `/guide/steps`, the panel's steps as Patchy's records give them, for the guide script. With
 * `?mode=watch` it is only Home's live note, once the first publication lands.
 */
const guideSteps = Effect.fn("HomePages.guideSteps")(function* () {
  const { viewer, session } = yield* context;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const watching = new URL(request.url, session.publicBaseUrl).searchParams.get("mode") === "watch";
  const { state, setupLink } = yield* setupState();
  const html = watching
    ? `<div data-guide-steps data-viewer="${escapeAttribute(viewer.user.id)}" data-state="${state.kind}">${state.kind === "live" ? renderPublishedNote(state.row, session.publicBaseUrl) : ""}</div>`
    : renderSetupSteps({
        state,
        viewer,
        publicBaseUrl: session.publicBaseUrl,
        ...(setupLink === undefined ? {} : { setupLink })
      });
  return HttpServerResponse.text(html, {
    contentType: "text/html",
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      // It carries the inline confirmation, so nothing may frame it or post its forms elsewhere.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    }
  });
});

/** Later: the panel stays away for the rest of this sign-in. A form from another account changes nothing. */
const guideLater = Effect.fn("HomePages.guideLater")(function* () {
  const { viewer } = yield* context;
  const signedIn = yield* RequireSession.SignedIn;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = new URLSearchParams(
    yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(1_024))
    )
  );
  if (form.get("user") !== viewer.user.id)
    return yield* errorPage(
      409,
      "Signed in as someone else",
      "This page was open for another account. Nothing changed."
    );
  yield* SetupPrompts.later(viewer.user.id, signedIn.sid);
  return HttpServerResponse.redirect("/", {
    status: 303,
    headers: { "cache-control": "private, no-store" }
  });
});

/** Get a new line: the live one retires and the panel's next render makes a fresh one. */
const guideNewLine = Effect.fn("HomePages.guideNewLine")(function* () {
  const { viewer } = yield* context;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = new URLSearchParams(
    yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(1_024))
    )
  );
  if (form.get("user") !== viewer.user.id)
    return yield* errorPage(
      409,
      "Signed in as someone else",
      "This page was open for another account. Nothing changed."
    );
  const limit = yield* (yield* Limits.Limits).consume({
    key: `setup-line:${viewer.user.id}`,
    limit: registry["rate.setupLine.perMinute"].default,
    window: "1 minute"
  });
  if (!limit.allowed)
    return yield* errorPage(429, "Too many new lines", "Wait a minute, then get a new line.");
  yield* SetupLinks.retire(viewer.user.id);
  return HttpServerResponse.redirect("/guide", {
    status: 303,
    headers: { "cache-control": "private, no-store" }
  });
});

/** Home itself is the server's to register (`index`); these are the guide's routes. */
export const layer: Routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "GET",
      guideScriptPath,
      HttpServerResponse.text(guideScript, {
        contentType: "text/javascript",
        headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" }
      })
    );
    yield* router.add(
      "GET",
      "/guide",
      errors(RequireSession.withViewer(guidePage().pipe(pageErrors)))
    );
    yield* router.add(
      "GET",
      "/guide/steps",
      errors(RequireSession.withViewer(guideSteps().pipe(pageErrors)))
    );
    yield* router.add(
      "POST",
      "/guide/new-line",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(guideNewLine().pipe(pageErrors))))
    );
    yield* router.add(
      "POST",
      "/guide/later",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(guideLater().pipe(pageErrors))))
    );
  })
);
