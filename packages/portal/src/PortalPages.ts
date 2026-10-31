import * as Clock from "effect/Clock";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import * as WideEvents from "@patchy/analytics/wide-events";
import { agentTools, PatchName, PatchState, SharingScope } from "@patchy/api";
import {
  MachineTokens,
  pageResponse,
  Receipt,
  RequireSession,
  Session,
  SetupLinks,
  SetupPrompts
} from "@patchy/auth";
import {
  Cryptography,
  ago,
  copyScript,
  copyScriptPath,
  escapeAttribute,
  escapeHtml,
  rowMenu
} from "@patchy/core";
import { Companies, Users } from "@patchy/companies";
import { GuestGrants, Patches } from "@patchy/patches";
import { ConnectionStore } from "@patchy/integrations";
import { Limits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import { InvocationLog, Prewarm } from "@patchy/runtime";
import {
  listStyles,
  manages,
  openItems,
  renderAllPatches,
  searchQuery,
  shows
} from "./allPatches.js";
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
import { type LogNames, outcomeFilters, renderLog, renderRecentActivity } from "./log.js";
import {
  type CardTab,
  type ConfirmationAction,
  type PatchAction,
  renderAgentPanel,
  renderCardFrame,
  renderConfirmation,
  renderOverview,
  renderSettings,
  renderVersions,
  patchTitle,
  styles
} from "./render.js";
import {
  renderLeaveConfirmation,
  renderShareDialog,
  type ShareRefusal,
  shareStyles
} from "./share.js";
import * as UserLifecyclePage from "./UserLifecyclePage.js";

const isName = Schema.is(PatchName);
const maxNameLength = 32;
const decodeDescription = Schema.decodeUnknownEffect(
  Schema.Struct({
    description: Schema.String,
    expectedDescriptionUpdatedAt: Schema.String
  })
);
const decodeScope = Schema.decodeUnknownEffect(
  Schema.Struct({
    scope: SharingScope,
    expectedScope: SharingScope
  })
);
const decodeRollback = Schema.decodeUnknownEffect(
  Schema.Struct({
    versionNumber: Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(2147483647)
    ),
    expectedCurrentVersionId: Schema.String
  })
);
const decodeRestore = Schema.decodeUnknownEffect(Schema.Struct({ expectedState: PatchState }));
const decodeRetire = Schema.decodeUnknownEffect(
  Schema.Struct({ expectedState: Schema.Literal("live") })
);
const decodeDelete = Schema.decodeUnknownEffect(
  Schema.Struct({
    expectedState: Schema.Literal("not-deleted"),
    confirm: Schema.String
  })
);
const decodeReassign = Schema.decodeUnknownEffect(
  Schema.Struct({ expectedOwnerUserId: Schema.String, user: Schema.String })
);

const forbidden = "Only the owner or an admin can do that. Nothing was done.";
const logForbidden = "Only the owner or an admin can read this patch's log.";
const isOutcomeFilter = Schema.is(Schema.Literals(outcomeFilters.map(([value]) => value)));
const maxFilterLength = 256;
const adminRequired = "Only an admin can reassign this patch. Nothing was done.";

const context = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const canOpen = yield* Patches.Openability;
  const url = new URL(request.url, session.publicBaseUrl);
  return {
    viewer,
    session,
    url,
    query: request.method === "GET" ? (url.searchParams.get("q") ?? "") : "",
    access: {
      companyId: viewer.company.id,
      userId: viewer.user.id,
      canOpen: (patch: Patches.Patch) => canOpen(patch, viewer.user.id)
    }
  };
});

const errorPage = Effect.fn("PortalPages.errorPage")(function* (
  status: number,
  title: string,
  message: string
) {
  const { viewer, session } = yield* context;
  return pageResponse(
    {
      title,
      status,
      body: `<p>${escapeHtml(message)}</p><p><a href="/">Back to Home</a></p>`,
      app: { viewer, section: "patches" }
    },
    session
  );
});

/**
 * Stored ids in the reader's words: the names of the people in these entries, the patch's guests
 * from other companies included, version numbers and the patch's title.
 */
const logNames = Effect.fn("PortalPages.logNames")(function* (
  card: Patches.PortalCard,
  entries: ReadonlyArray<InvocationLog.Entry>,
  viewerIds: ReadonlyArray<string> = []
) {
  const people = yield* (yield* Users.Users).names([
    ...viewerIds,
    ...entries.flatMap(({ invocation, tree }) => [
      invocation.initiatingViewerId,
      ...tree.flatMap((item) =>
        item.effectivePrincipal === "patch" ? [] : [item.effectivePrincipal]
      )
    ])
  ]);
  return {
    people,
    versions: new Map(card.versions.map((version) => [version.id, version.versionNumber])),
    patch: patchTitle(card.patch),
    connections: new Map<string, string>()
  } satisfies LogNames;
});

/** W-2 on the card: the owner's and admins' last three entries, once the patch has any or serves tier 2. */
const recentActivity = Effect.fn("PortalPages.recentActivity")(function* (
  card: Patches.PortalCard,
  now: number
) {
  const { viewer } = yield* context;
  if (viewer.role !== "admin" && card.owner.id !== viewer.user.id) return "";
  const { entries } = yield* (yield* InvocationLog.InvocationLog).page({
    companyId: viewer.company.id,
    patchId: card.patch.id,
    limit: 3,
    trees: false
  });
  if (entries.length === 0 && card.tier < 2) return "";
  const names = yield* logNames(card, entries);
  return renderRecentActivity({ patch: card.patch, now, names, entries });
});

/**
 * What agents can do beside a card's Overview: the agent tools of the version the card shows,
 * and while agent access is off, who can turn it on. Empty without tools.
 */
const agentPanel = Effect.fn("PortalPages.agentPanel")(function* (card: Patches.PortalCard) {
  const versionId = card.patch.currentVersionId;
  if (card.patch.state !== "live" || card.tier !== 2 || versionId === null) return "";
  // The card's version, not whatever is current now, so a publish between the reads can't mix them.
  const served = yield* (yield* Patches.Patches).find(card.patch.id, undefined, versionId);
  const tools = Option.match(served, {
    onNone: () => [],
    onSome: ({ version }) => agentTools(version.manifest)
  });
  if (tools.length === 0) return "";
  const { viewer } = yield* context;
  // The viewer's own company: it exists for as long as they can open this page.
  const access = yield* (yield* Companies.Companies)
    .agentAccess(viewer.company.id)
    .pipe(Effect.catchTags({ CompanyNotFound: Effect.die }));
  const admins = access.on
    ? null
    : (yield* (yield* Users.Users).list(viewer.company.id))
        .filter((user) => user.role === "admin" && user.deactivatedAt === null)
        .sort((a, b) => a.name.localeCompare(b.name));
  return renderAgentPanel({ tools, viewer, admins });
});

const overlongName = errorPage(
  414,
  "Patch name is too long",
  `Patch names have at most ${maxNameLength} characters.`
);

/** The machine most recently logged in as this user, while any is live. */
const newestMachine = Effect.fn("PortalPages.newestMachine")(function* (userId: string) {
  const machines = yield* (yield* MachineTokens.MachineTokens).list(userId);
  const newest = machines.reduce<(typeof machines)[number] | undefined>(
    (latest, machine) =>
      latest === undefined || machine.createdAt > latest.createdAt ? machine : latest,
    undefined
  );
  return newest === undefined ? null : { name: newest.name, createdAt: newest.createdAt };
});

/**
 * A Share dialog a page shows over itself: the patch it shares, the page's own URL, and what a
 * refused form of the dialog's left to say. `?share=<name>` asks for one on Home, All patches and
 * a card's tabs.
 */
interface Sharing {
  readonly name: string;
  readonly at: URL;
  readonly status?: number;
  readonly notice?: string;
  readonly refused?: { readonly email: string; readonly refusal: ShareRefusal };
  readonly confirmPublic?: boolean;
}

/** The Share dialog `url` asks for, if it asks. */
const asked = (url: URL): Sharing | undefined => {
  const name = url.searchParams.get("share");
  return name === null || name === "" ? undefined : { name, at: url };
};

/** A page's own path and query without the dialog: where Share's forms return and Done goes. */
const pagePath = (url: URL) => {
  const params = new URLSearchParams(url.search);
  params.delete("share");
  const search = params.toString();
  return `${url.pathname}${search ? `?${search}` : ""}`;
};

/**
 * Where a Share dialog's form returns: the page it opened over, when that is Home, All patches or
 * the patch's own card, with only the query those pages read. Anything else is the card.
 */
const behind = (back: string | undefined, name: string, base: string): URL => {
  const card = `/patches/${encodeURIComponent(name)}`;
  const fallback = new URL(card, base);
  if (back === undefined || !back.startsWith("/") || back.startsWith("//")) return fallback;
  const url = new URL(back, base);
  if (
    url.origin !== fallback.origin ||
    !["/", "/patches", card, `${card}/versions`, `${card}/settings`].includes(url.pathname)
  )
    return fallback;
  const kept = new URL(url.pathname, base);
  for (const key of ["q", "show"]) {
    const value = url.searchParams.get(key);
    if (value) kept.searchParams.set(key, value);
  }
  return kept;
};

/**
 * The Share dialog over a page, for a live patch among `rows` the viewer manages; none otherwise,
 * so a stale or foreign `?share=` shows just the page. It shows the receipt its last form left,
 * which the page behind then leaves out.
 */
const shareOverlay = Effect.fn("PortalPages.shareOverlay")(function* (
  rows: readonly Patches.ReadPatch[],
  sharing: Sharing | undefined
) {
  if (sharing === undefined) return undefined;
  const { viewer, session } = yield* context;
  const row = rows.find((candidate) => candidate.patch.name === sharing.name);
  if (row === undefined || row.patch.state !== "live" || !manages(row, viewer)) return undefined;
  const grants = yield* GuestGrants.GuestGrants;
  return renderShareDialog({
    row,
    viewer,
    publicBaseUrl: session.publicBaseUrl,
    back: pagePath(sharing.at),
    guests: yield* grants.guests(row.patch.id),
    suggestions: yield* grants.sharedBefore(viewer.company.id),
    ...(viewer.receipt === undefined ? {} : { receipt: viewer.receipt }),
    ...(sharing.notice === undefined ? {} : { notice: sharing.notice }),
    ...(sharing.refused === undefined ? {} : { refused: sharing.refused }),
    ...(sharing.confirmPublic === true ? { confirmPublic: true } : {})
  });
});

/** The app shell's options for a page with or without the Share dialog over it. */
const withOverlay = (
  viewer: RequireSession.Viewer["Service"],
  overlay: string | undefined
): { viewer: RequireSession.Viewer["Service"]; overlay?: string } =>
  overlay === undefined ? { viewer } : { viewer: { ...viewer, receipt: undefined }, overlay };

/** A card tab that is not the log: Overview at `/patches/<name>`, then `/versions` and `/settings`. */
type PageTab = Exclude<CardTab, "log">;
const tabOf: Record<PatchAction, PageTab> = {
  description: "settings",
  rollback: "versions",
  retire: "overview",
  delete: "overview",
  restore: "overview",
  reassign: "overview"
};
const settingsForbidden = "Only the owner or an admin can change this patch's settings.";

/**
 * The card header's menu, Share… opening over `here`. The card already holds its other acts:
 * Settings, and Restore while it's off.
 */
const cardMenu = (
  row: Patches.ReadPatch,
  viewer: RequireSession.Viewer["Service"],
  publicBaseUrl: string,
  here: string
) => {
  const items = openItems(row, viewer, publicBaseUrl, here, false);
  return items.length ? rowMenu(`card-${row.patch.id}`, patchTitle(row.patch), items) : undefined;
};

/** One patch's card at `/patches/<name>` on one of its tabs. A member asking for Settings gets Overview. */
const render = Effect.fn("PortalPages.render")(function* (
  name: string,
  options: {
    tab?: PageTab;
    status?: number;
    notice?: string;
    submittedDescription?: string;
    descriptionError?: string;
    /** No forms at all, for a refusal of a form that was rendered for another patch. */
    readOnly?: boolean;
    /** The Share dialog a refused form of it shows again; a GET asks with `?share=`. */
    sharing?: Sharing;
  } = {}
) {
  const { viewer, session, access, url } = yield* context;
  if (name.length > maxNameLength) return yield* overlongName;
  if (!isName(name))
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  const patches = yield* Patches.Patches;
  const selected = (yield* patches.read({ ...access, state: "all" })).find(
    (row) => row.patch.name === name
  );
  if (selected === undefined)
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  yield* WideEvents.enrich(Patches.eventFields(selected.patch));
  const card = yield* patches.portalCard(selected.patch.id, access);
  const now = yield* Clock.currentTimeMillis;
  const manages = viewer.role === "admin" || card.owner.id === viewer.user.id;
  const refused = options.tab === "settings" && !manages;
  const tab = refused ? "overview" : (options.tab ?? "overview");
  const body =
    tab === "settings"
      ? renderSettings({
          card,
          viewer,
          submittedDescription: options.submittedDescription,
          descriptionError: options.descriptionError
        })
      : tab === "versions"
        ? renderVersions({ card, viewer, now })
        : renderOverview({
            card,
            viewer,
            now,
            activity: yield* recentActivity(card, now),
            turnedAway: (yield* turnedAway([selected]))?.get(card.patch.id)
          });
  const panel = tab === "overview" ? yield* agentPanel(card) : "";
  const here = `/patches/${encodeURIComponent(name)}${tab === "overview" ? "" : `/${tab}`}`;
  const sharing = options.sharing ?? (options.readOnly ? undefined : asked(url));
  const overlay = yield* shareOverlay([selected], sharing);
  return pageResponse(
    {
      title: `${patchTitle(card.patch)}${tab === "overview" ? "" : ` ${tab}`}`,
      heading: "",
      body: renderCardFrame({
        card,
        viewer,
        now,
        publicBaseUrl: session.publicBaseUrl,
        tab,
        notice: refused ? settingsForbidden : options.notice,
        readOnly: options.readOnly,
        body,
        panel,
        menu: options.readOnly ? undefined : cardMenu(selected, viewer, session.publicBaseUrl, here)
      }),
      styles: styles + shareStyles,
      status: refused ? 403 : (options.status ?? sharing?.status ?? 200),
      app: { ...withOverlay(viewer, overlay), section: "patches" }
    },
    session
  );
});

/** How long after a computer connects Home keeps watching for the first publication. */
const watchWindow = 30 * 60 * 1_000;

/**
 * Where the viewer's setup stands. With a live machine token they are connected, and live once one
 * of their live keys published something still live, preferring the key their setup line made;
 * attribution is by the publishing key, so a patch reassigned to them never counts. Without one,
 * the line's link says how far the agent got and how its login ended.
 */
const setupState = Effect.fn("PortalPages.setupState")(function* () {
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
const setupLine = Effect.fn("PortalPages.setupLine")(function* () {
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
 * unless they pressed Later.
 */
const home = Effect.fn("PortalPages.home")(function* (refused?: Sharing) {
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
        failures: yield* recentFailures(rows),
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

/** `/guide`, the Final step panel as a page, for anyone not yet connected; others go Home. */
const guidePage = Effect.fn("PortalPages.guidePage")(function* () {
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
const guideSteps = Effect.fn("PortalPages.guideSteps")(function* () {
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
const guideLater = Effect.fn("PortalPages.guideLater")(function* () {
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
const guideNewLine = Effect.fn("PortalPages.guideNewLine")(function* () {
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

const confirmationPage = Effect.fn("PortalPages.confirmationPage")(function* (
  name: string,
  action: ConfirmationAction,
  form: {
    status?: number;
    notice?: string;
    submittedName?: string;
    nameError?: string;
    selectedOwnerId?: string;
    acknowledged?: boolean;
  } = {}
) {
  const { viewer, session, access, query } = yield* context;
  if (name.length > maxNameLength) return yield* overlongName;
  if (!isName(name))
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  const patches = yield* Patches.Patches;
  const rows = yield* patches.read({ ...access, state: "all" });
  const selected = rows.find((row) => row.patch.name === name);
  if (selected === undefined)
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  yield* WideEvents.enrich(Patches.eventFields(selected.patch));
  const card = yield* patches.portalCard(selected.patch.id, access);
  if (viewer.role !== "admin" && (action === "reassign" || card.owner.id !== viewer.user.id))
    return yield* render(name, {
      status: 403,
      notice: action === "reassign" ? adminRequired : forbidden
    });
  if (action === "restore" && form.status === undefined && card.offSources.length === 0)
    return HttpServerResponse.redirect(`/patches/${encodeURIComponent(card.patch.name)}`, {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    });
  if (
    (action === "retire" && card.patch.state !== "live") ||
    (action === "delete" && card.patch.state === "deleted") ||
    (action === "restore" && card.patch.state === "live")
  )
    return yield* render(name, {
      status: 409,
      notice: `This patch is ${card.patch.state}. This action is not available. Nothing was done.`
    });
  const members = action === "reassign" ? yield* (yield* Users.Users).list(viewer.company.id) : [];
  const now = yield* Clock.currentTimeMillis;
  return pageResponse(
    {
      title: `${card.patch.name} ${action}`,
      heading: "",
      body: renderConfirmation({
        card,
        viewer,
        now,
        action,
        members,
        query,
        notice: form.notice,
        submittedName: form.submittedName,
        nameError: form.nameError,
        selectedOwnerId: form.selectedOwnerId,
        acknowledged: form.acknowledged
      }),
      styles,
      status: form.status ?? 200,
      app: { viewer, section: "patches" }
    },
    session
  );
});

/** The patch's log for its current owner and admins: newest first, filtered and paged by cursor. */
const logPage = Effect.fn("PortalPages.logPage")(function* (name: string) {
  const { viewer, session, access } = yield* context;
  if (name.length > maxNameLength) return yield* overlongName;
  if (!isName(name))
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  const patches = yield* Patches.Patches;
  const selected = (yield* patches.read({ ...access, state: "all" })).find(
    (row) => row.patch.name === name
  );
  if (selected === undefined)
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  yield* WideEvents.enrich(Patches.eventFields(selected.patch));
  // Ownership is read now, so reassignment moves who may read the log.
  if (viewer.role !== "admin" && selected.owner.id !== viewer.user.id)
    return yield* render(name, { status: 403, notice: logForbidden });
  const card = yield* patches.portalCard(selected.patch.id, access);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const query = new URL(request.url, session.publicBaseUrl).searchParams;
  const param = (key: string) => {
    const value = query.get(key);
    return value === null || value === "" || value.length > maxFilterLength ? undefined : value;
  };
  const outcome = param("outcome");
  const filter = {
    outcome: isOutcomeFilter(outcome) ? outcome : undefined,
    viewerId: param("person"),
    handler: param("handler")
  };
  const before = param("before");
  const log = yield* InvocationLog.InvocationLog;
  const scope = { companyId: viewer.company.id, patchId: card.patch.id };
  const page = yield* log.page({ ...scope, before, filter, limit: 25 });
  const choices = yield* log.choices(scope);
  const names = yield* logNames(card, page.entries, choices.viewerIds);
  const now = yield* Clock.currentTimeMillis;
  // Calls record the connection's id; readers know it by its handle. A connection deleted
  // since, or a store that cannot answer, leaves the id.
  const connections = page.entries.some((entry) =>
    entry.tree.some((item) => item.connectionId !== null)
  )
    ? yield* (yield* ConnectionStore.ConnectionStore)
        .list(viewer.company.id)
        .pipe(Effect.orElseSucceed(() => []))
    : [];
  return pageResponse(
    {
      title: `${card.patch.name} log`,
      heading: "",
      body: renderCardFrame({
        card,
        viewer,
        now,
        publicBaseUrl: session.publicBaseUrl,
        tab: "log",
        body: renderLog({
          patch: card.patch,
          now,
          names: {
            ...names,
            connections: new Map(
              connections.map((connection) => [
                connection.id,
                `${connection.integration}/${connection.handle}`
              ])
            )
          },
          entries: page.entries,
          next: page.next,
          windowEnded: page.windowEnded,
          before,
          filter,
          choices
        }),
        // Share opens over Overview: the dialog's forms return only to the pages `behind` keeps.
        menu: cardMenu(
          selected,
          viewer,
          session.publicBaseUrl,
          `/patches/${encodeURIComponent(name)}`
        )
      }),
      styles,
      app: { viewer, section: "patches" }
    },
    session
  );
});

const post = Effect.fn("PortalPages.post")(function* (name: string, action: PatchAction) {
  if (name.length > maxNameLength) return yield* overlongName;
  if (!isName(name))
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  const { viewer, session, access } = yield* context;
  const patches = yield* Patches.Patches;
  const rows = yield* patches.read({ ...access, state: "all" });
  const selected = rows.find((row) => row.patch.name === name);
  if (!selected)
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  yield* WideEvents.enrich(Patches.eventFields(selected.patch));
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = Object.fromEntries(
    new URLSearchParams(
      yield* request.text.pipe(
        Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(16_384))
      )
    )
  );
  // Every form carries the id of the patch it was rendered for. A form without it, or
  // whose name now belongs to another patch, stops on the card before any other check:
  // a re-rendered form would post at whichever patch holds the name now.
  if (form.expectedPatchId !== selected.patch.id)
    return yield* render(name, {
      status: 409,
      readOnly: true,
      notice: form.expectedPatchId
        ? "This name now belongs to a different patch. Nothing was done."
        : "This form is out of date. Nothing was done."
    });
  if (viewer.role !== "admin" && (action === "reassign" || selected.owner.id !== viewer.user.id))
    return yield* render(name, {
      status: 403,
      notice: action === "reassign" ? adminRequired : forbidden
    });
  const actor = { userId: viewer.user.id, admin: viewer.role === "admin" };
  const confirmation =
    action === "retire" || action === "delete" || action === "restore" || action === "reassign"
      ? action
      : undefined;
  // A refusal of a permitted act shows the tab its form is on; identity and permission refusals stay on Overview.
  const tab = tabOf[action];
  const redisplay = (status: number, notice: string, nameError?: string) =>
    confirmation === undefined
      ? render(name, { tab, status, notice })
      : confirmationPage(name, confirmation, {
          status,
          notice: nameError === undefined ? notice : undefined,
          nameError,
          submittedName: form.confirm ?? "",
          selectedOwnerId: form.user ?? "",
          acknowledged: form.ack === "1"
        });
  const title = patchTitle(selected.patch);
  // A done act lands on its tab with a receipt naming what it did, from the patch as read.
  const landed = (receipt: string) =>
    Receipt.set(
      HttpServerResponse.redirect(
        `/patches/${encodeURIComponent(name)}${tab === "overview" ? "" : `/${tab}`}`,
        { status: 303, headers: { "cache-control": "private, no-store" } }
      ),
      { userId: viewer.user.id, text: receipt, publicBaseUrl: session.publicBaseUrl }
    );
  const run = Effect.gen(function* () {
    switch (action) {
      case "description": {
        const fields = yield* decodeDescription(form);
        yield* patches.setDescription(
          selected.patch.id,
          actor,
          fields.description,
          fields.expectedDescriptionUpdatedAt || null
        );
        return landed(`Saved ${title}’s description`);
      }
      case "rollback": {
        const fields = yield* decodeRollback(form);
        const rolledBack = yield* patches.rollback(
          selected.patch.id,
          actor,
          fields.versionNumber,
          fields.expectedCurrentVersionId || null
        );
        yield* WideEvents.enrich(Patches.eventFields(rolledBack.patch));
        return landed(`${patchTitle(rolledBack.patch)} now serves v${rolledBack.currentVersion}`);
      }
      case "restore": {
        const fields = yield* decodeRestore(form);
        yield* patches.restore(selected.patch.id, actor, form.ack === "1", fields.expectedState);
        return landed(`Restored ${title}`);
      }
      case "retire": {
        yield* decodeRetire(form);
        yield* patches.retire(selected.patch.id, actor, form.ack === "1");
        return landed(`Retired ${title}`);
      }
      case "delete": {
        const fields = yield* decodeDelete(form);
        if (fields.confirm !== selected.patch.name) {
          const message = `Type ${selected.patch.name} to confirm. Nothing was done.`;
          return yield* redisplay(422, message, message);
        }
        yield* patches.delete(selected.patch.id, actor, form.ack === "1");
        return landed(`Deleted ${title}; it can be restored for 30 days`);
      }
      case "reassign": {
        const fields = yield* decodeReassign(form);
        yield* patches.reassign(selected.patch.id, actor, fields.user, fields.expectedOwnerUserId);
        const members = yield* (yield* Users.Users).list(viewer.company.id);
        const owner = members.find((member) => member.id === fields.user)?.name ?? "them";
        return landed(`${title} now belongs to ${owner}`);
      }
    }
  });
  // A refused description keeps the person's draft, whatever refused it.
  const draft = action === "description" ? { submittedDescription: form.description ?? "" } : {};
  const stale = Effect.fn("PortalPages.stale")(function* (state?: Patches.Patch["state"]) {
    return yield* render(name, {
      tab,
      status: 409,
      ...draft,
      notice: yield* staleNotice(selected.patch.id, state)
    });
  });
  const invalid = (notice: string) =>
    confirmation === undefined
      ? render(name, {
          tab,
          status: 422,
          ...(action === "description"
            ? { submittedDescription: form.description ?? "", descriptionError: notice }
            : { notice })
        })
      : redisplay(422, notice);
  return yield* run.pipe(
    Effect.catchTags({
      StaleAction: () => stale(),
      NotOwner: () => render(name, { status: 403, notice: forbidden }),
      AdminRequired: () => render(name, { status: 403, notice: adminRequired }),
      WrongState: (error) => stale(error.state),
      PatchDeleted: (error) =>
        render(name, { tab, status: 409, ...draft, notice: `${error.message} Nothing was done.` }),
      PatchRetired: (error) =>
        render(name, { tab, status: 409, ...draft, notice: `${error.message} Nothing was done.` }),
      SourcesOff: () => redisplay(409, "Some sources are off. Nothing was done."),
      InvalidDescription: (error) => invalid(`${error.message} Nothing was done.`),
      Tier2NotPublic: (error) => invalid(`${error.message} Nothing was done.`),
      SchemaError: () => invalid("Check the submitted fields and try again. Nothing was done."),
      VersionUnavailable: (error) => invalid(`${error.message} Nothing was done.`),
      HasDependants: () =>
        redisplay(
          409,
          "These patches read this patch's tables. Acknowledge that they will break before continuing. Nothing was done."
        ),
      ReservedName: (error) => invalid(error.message),
      InvalidOwner: () =>
        redisplay(409, "Choose an active member of this company. Nothing was done.")
    })
  );
});

/**
 * What a form posted after its patch changed says: what changed, by whom and when, and the state
 * it's in now when that's why. Nothing was done.
 */
const staleNotice = Effect.fn("PortalPages.staleNotice")(function* (
  patchId: string,
  state?: Patches.Patch["state"]
) {
  const { access } = yield* context;
  const fresh = yield* (yield* Patches.Patches).portalCard(patchId, access);
  const when =
    fresh.patch.lastChangedAt === null
      ? ""
      : ` ${ago(fresh.patch.lastChangedAt, yield* Clock.currentTimeMillis)}`;
  return `${state === undefined ? "" : `This patch is ${state}. `}This patch changed while you had this page open: ${fresh.lastChangedAction ?? "updated"} by ${fresh.actorNames.lastChanged ?? fresh.owner.name}${when}. Nothing was done.`;
});

/** The forms of the Share dialog, each posted to `/patches/<name>/<act>`. */
type ShareAct = "add-guest" | "remove-guest" | "scope";

/**
 * A Share dialog form: add a guest, remove one, or change who can open the patch, as its owner or
 * an admin. Done, it lands back on the page the dialog opened over, open, with a receipt; going
 * public unasked asks in the dialog, and a refusal shows there, with the email kept.
 */
const shareAct = Effect.fn("PortalPages.shareAct")(function* (name: string, act: ShareAct) {
  if (name.length > maxNameLength) return yield* overlongName;
  if (!isName(name))
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  const { viewer, session, access } = yield* context;
  const patches = yield* Patches.Patches;
  const selected = (yield* patches.read({ ...access, state: "all" })).find(
    (row) => row.patch.name === name
  );
  if (!selected)
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  yield* WideEvents.enrich(Patches.eventFields(selected.patch));
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = Object.fromEntries(
    new URLSearchParams(
      yield* request.text.pipe(
        Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(16_384))
      )
    )
  );
  // As every patch form: one rendered for whichever patch had this name stops here.
  if (form.expectedPatchId !== selected.patch.id)
    return yield* render(name, {
      status: 409,
      readOnly: true,
      notice: form.expectedPatchId
        ? "This name now belongs to a different patch. Nothing was done."
        : "This form is out of date. Nothing was done."
    });
  if (!manages(selected, viewer)) return yield* render(name, { status: 403, notice: forbidden });
  const actor = { userId: viewer.user.id, admin: viewer.role === "admin" };
  const at = behind(form.back, name, session.publicBaseUrl);
  const title = patchTitle(selected.patch);
  const grants = yield* GuestGrants.GuestGrants;
  /** Back to the page behind with the dialog open, and a receipt for it when something changed. */
  const reopened = (receipt?: string) => {
    const response = HttpServerResponse.redirect(
      pagePath(at) + `${at.search ? "&" : "?"}share=${encodeURIComponent(name)}`,
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
    const shown = { ...sharing, name, at };
    if (at.pathname === "/") return yield* home(shown);
    if (at.pathname === "/patches") return yield* allPatchesPage(shown);
    const tab = at.pathname.endsWith("/versions")
      ? "versions"
      : at.pathname.endsWith("/settings")
        ? "settings"
        : undefined;
    return yield* render(name, { ...(tab === undefined ? {} : { tab }), sharing: shown });
  });
  const email = (form.email ?? "").trim();
  const run = Effect.gen(function* () {
    // The dialog opens only over a live patch, so a form from it for one that's off is stale.
    if (selected.patch.state !== "live")
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
        return reopened(named === undefined ? undefined : `Stopped sharing ${title} with ${named}`);
      }
      case "scope": {
        const fields = yield* decodeScope(form);
        // Going public asks first, and only its answer applies it, re-running every check.
        if (fields.scope === "public" && form.confirm !== "public") {
          if (selected.tier >= 2) return yield* new Patches.Tier2NotPublic();
          return yield* again({ confirmPublic: true });
        }
        yield* patches.setScope(selected.patch.id, actor, fields.scope, fields.expectedScope);
        return reopened(
          `${title} is open to ${fields.scope === "public" ? "anyone on the internet" : `people at ${viewer.company.name}`}`
        );
      }
    }
  });
  const nothing = (notice: string) => `${notice} Nothing was done.`;
  // setScope's type names every lifecycle refusal; one that can't answer a scope change still says why.
  const onCard = (error: { readonly message: string }) =>
    render(name, { status: 409, notice: nothing(error.message) });
  return yield* run.pipe(
    Effect.catchTags({
      PatchRetired: onCard,
      PatchDeleted: onCard,
      HasDependants: onCard,
      SourcesOff: onCard,
      ReservedName: onCard,
      InvalidDescription: onCard,
      VersionUnavailable: onCard,
      InvalidOwner: onCard,
      NotOnPatchy: (refusal) => again({ status: 422, refused: { email, refusal } }),
      AlreadyMember: (refusal) => again({ status: 409, refused: { email, refusal } }),
      GuestsUnavailable: (refusal) => again({ status: 422, refused: { email, refusal } }),
      NotOwner: () => render(name, { status: 403, notice: forbidden }),
      WrongState: (error) =>
        Effect.flatMap(staleNotice(selected.patch.id, error.state), (notice) =>
          render(name, { status: 409, notice })
        ),
      StaleAction: () =>
        Effect.flatMap(staleNotice(selected.patch.id), (notice) => again({ status: 409, notice })),
      Tier2NotPublic: (error) => again({ status: 422, notice: nothing(error.message) }),
      SchemaError: () =>
        again({ status: 422, notice: nothing("Check the submitted fields and try again.") }),
      ConnectionStorageFailed: Effect.die
    })
  );
});

/**
 * Remove… on a patch shared with the viewer: GET asks, POST ends their own grant and lands Home
 * with a receipt. A patch no longer shared with them is not found.
 */
const leave = Effect.fn("PortalPages.leave")(function* (patchId: string, method: "GET" | "POST") {
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
        title: `Remove ${patchTitle(shared)}?`,
        heading: "",
        body: renderLeaveConfirmation(shared),
        styles,
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
      text: `Removed ${patchTitle(shared)}`,
      publicBaseUrl: session.publicBaseUrl
    }
  );
});

/** Refusals keep their status and never leak database or authentication diagnostics. */
export const errors = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  app.pipe(
    Effect.catchTags({
      SqlError: () =>
        Effect.succeed(
          pageResponse({
            title: "Patches unavailable",
            body: "<p>Please try again.</p>",
            status: 503
          })
        ),
      SessionError: () =>
        Effect.succeed(
          pageResponse({
            title: "Sign-in service unavailable",
            body: "<p>Please try again.</p>",
            status: 502
          })
        )
    })
  );

const pageErrors = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  app.pipe(
    Effect.catchTags({
      PatchUnavailable: () =>
        errorPage(404, "Patch not found", "The requested patch is unavailable."),
      WrongState: () =>
        errorPage(
          409,
          "Patch changed",
          "This action is not available in the patch's current state. Nothing was done."
        ),
      HttpServerError: () =>
        errorPage(
          422,
          "Request refused",
          "Check the submitted form and try again. Nothing was done."
        )
    })
  );

const DAY = 86_400_000;

/**
 * The last day's failed calls for each live tier 2 patch the viewer manages, or nothing when they
 * manage none, so a member's pages never query the log.
 */
const recentFailures = Effect.fn("PortalPages.recentFailures")(function* (
  rows: readonly Patches.ReadPatch[]
) {
  const { viewer } = yield* context;
  const managed = rows.filter(
    (row) =>
      row.patch.state === "live" &&
      row.tier >= 2 &&
      (viewer.role === "admin" || row.owner.id === viewer.user.id)
  );
  if (managed.length === 0) return undefined;
  const counts = yield* (yield* InvocationLog.InvocationLog).failures({
    companyId: viewer.company.id,
    since: (yield* Clock.currentTimeMillis) - DAY
  });
  return new Map(managed.map((row) => [row.patch.id, counts.get(row.patch.id) ?? 0]));
});

/**
 * Why guests can't open each of the company's patches that has guests and turns them away, or
 * nothing when the viewer manages no live patch here, so a member's pages never read grants.
 */
const turnedAway = Effect.fn("PortalPages.turnedAway")(function* (
  rows: readonly Patches.ReadPatch[]
) {
  const { viewer } = yield* context;
  if (
    !rows.some(
      (row) =>
        row.patch.state === "live" && (viewer.role === "admin" || row.owner.id === viewer.user.id)
    )
  )
    return undefined;
  return yield* (yield* GuestGrants.GuestGrants)
    .unavailableToGuests(viewer.company.id)
    .pipe(Effect.catchTags({ ConnectionStorageFailed: Effect.die }));
});

/**
 * Starts readying the viewer's company task and the live tier 2 tools they are likeliest to open,
 * theirs by how much they open them and then everyone's by visits, without waiting. Hosts without
 * the execution fleet have nothing to ready.
 */
const prewarm = Effect.fn("PortalPages.prewarm")(function* (
  rows: readonly Patches.ReadPatch[],
  opens: ReadonlyMap<string, Patches.Open>
) {
  const service = yield* Effect.serviceOption(Prewarm.Prewarm);
  if (Option.isNone(service)) return;
  const { viewer } = yield* context;
  const score = (row: Patches.ReadPatch) => opens.get(row.patch.id)?.score ?? 0;
  const candidates = rows
    .filter((row) => row.patch.state === "live" && row.tier === 2)
    .sort((a, b) => score(b) - score(a) || b.visits - a.visits)
    .flatMap(({ patch }) =>
      patch.currentVersionId === null
        ? []
        : [{ patchId: patch.id, versionId: patch.currentVersionId }]
    );
  if (candidates.length === 0) return;
  yield* service.value.prewarm({
    companyId: viewer.company.id,
    viewerId: viewer.user.id,
    candidates
  });
});

/** All patches at `/patches`: every patch the viewer can open, in `?show=` tabs, searched by `?q=`. */
const allPatchesPage = Effect.fn("PortalPages.allPatchesPage")(function* (refused?: Sharing) {
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
        failures: yield* recentFailures(rows),
        turnedAway: yield* turnedAway(rows)
      }),
      styles: styles + listStyles + shareStyles,
      status: sharing?.status ?? 200,
      app: { ...withOverlay(viewer, overlay), section: "patches" }
    },
    session
  );
});

/** The server owns GET / and its signed-out door alongside the catch-all. */
export const index = home().pipe(pageErrors);

const patchRoutes = [
  {
    method: "GET" as const,
    path: "/patches/:name" as const,
    handle: (name: string) => render(name)
  },
  {
    method: "GET" as const,
    path: "/patches/:name/versions" as const,
    handle: (name: string) => render(name, { tab: "versions" })
  },
  {
    method: "GET" as const,
    path: "/patches/:name/settings" as const,
    handle: (name: string) => render(name, { tab: "settings" })
  },
  {
    method: "GET" as const,
    path: "/patches/:name/log" as const,
    handle: logPage
  },
  ...(["retire", "delete", "restore", "reassign"] as const).map((action) => ({
    method: "GET" as const,
    path: `/patches/:name/${action}` as const,
    handle: (name: string) => confirmationPage(name, action)
  })),
  ...(["description", "rollback", "retire", "delete", "restore", "reassign"] as const).map(
    (action) => ({
      method: "POST" as const,
      path: `/patches/:name/${action}` as const,
      handle: (name: string) => post(name, action)
    })
  )
];

export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      | Cryptography.Cryptography
      | Session.Session
      | Companies.Companies
      | Users.Users
      | Patches.Patches
      | GuestGrants.GuestGrants
      | MachineTokens.MachineTokens
      | InvocationLog.InvocationLog
      | ConnectionStore.ConnectionStore
      | Analytics.Analytics
      | Limits.Limits
      | SqlClient.SqlClient
    >
> = HttpRouter.use((router) =>
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
      copyScriptPath,
      HttpServerResponse.text(copyScript, {
        contentType: "text/javascript",
        headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" }
      })
    );
    for (const action of ["deactivate", "reactivate"] as const) {
      for (const method of ["GET", "POST"] as const) {
        const handler = RequireSession.withViewer(
          Effect.flatMap(HttpRouter.params, (params) =>
            UserLifecyclePage.handle(params.id ?? "", action)
          )
        );
        yield* router.add(
          method,
          `/company/users/:id/${action}`,
          errors(method === "POST" ? RequireSession.sameOrigin(handler) : handler)
        );
      }
    }
    for (const route of patchRoutes) {
      const handler = RequireSession.withViewer(
        Effect.flatMap(HttpRouter.params, (params) => route.handle(params.name ?? "")).pipe(
          pageErrors
        )
      );
      yield* router.add(
        route.method,
        route.path,
        errors(route.method === "POST" ? RequireSession.sameOrigin(handler) : handler)
      );
    }
    for (const act of ["add-guest", "remove-guest", "scope"] as const)
      yield* router.add(
        "POST",
        `/patches/:name/${act}`,
        errors(
          RequireSession.sameOrigin(
            RequireSession.withViewer(
              Effect.flatMap(HttpRouter.params, (params) => shareAct(params.name ?? "", act)).pipe(
                pageErrors
              )
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
    // The wildcard also answers `/patches` itself, which is All patches.
    yield* router.add(
      "GET",
      "/patches/*",
      errors(
        RequireSession.withViewer(
          Effect.flatMap(HttpRouter.params, (params) => {
            const rest = params["*"] ?? "";
            if (rest === "") return allPatchesPage();
            return rest.split("/", 1)[0]!.length > maxNameLength
              ? overlongName
              : errorPage(404, "Patch not found", "The requested patch is unavailable.");
          }).pipe(pageErrors)
        )
      )
    );
  })
);
