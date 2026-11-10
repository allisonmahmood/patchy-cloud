// Owns a patch's page at `/patches/<name>`: Overview, Log, Versions and Settings, the dialogs its
// acts ask in, and their forms. Renders with `render.ts` and `log.ts`; what other surfaces need is
// in `shared/`.
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as WideEvents from "@patchy/analytics/wide-events";
import { agentTools, PatchState } from "@patchy/api";
import { AgentConnections, pageResponse, Receipt, RequireSession } from "@patchy/auth";
import { Companies, Users } from "@patchy/companies";
import { Patches } from "@patchy/patches";
import { ConnectionStore } from "@patchy/integrations";
import { InvocationLog } from "@patchy/runtime";
import { type LogNames, outcomeFilters, renderLog, renderRecentActivity } from "./log.js";
import {
  canManage,
  type CardTab,
  type ConfirmationAction,
  type ConfirmationState,
  type PatchAction,
  renderAgentAside,
  renderConfirmation,
  renderOverview,
  renderPatchPage,
  renderSettings,
  renderVersions,
  shownTitle,
  tabTitle
} from "./render.js";
import {
  asked,
  callSummary,
  context,
  errorPage,
  errors,
  forbidden,
  isName,
  maxNameLength,
  overlongName,
  type Page,
  pageErrors,
  shareOverlay,
  type Sharing,
  staleNotice,
  turnedAway,
  type Routes,
  withOverlay
} from "./shared/handlers.js";
import { cardPath } from "./shared/presentation.js";

const decodeDescription = Schema.decodeUnknownEffect(
  Schema.Struct({
    description: Schema.String,
    expectedDescriptionUpdatedAt: Schema.String
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

const logForbidden = "Only the owner or an admin can read this patch's log.";
const isOutcomeFilter = Schema.is(Schema.Literals(outcomeFilters.map(([value]) => value)));
const maxFilterLength = 256;
const adminRequired = "Only an admin can reassign this patch. Nothing was done.";

/**
 * Stored ids in the reader's words: the names of the people in these entries, the patch's guests
 * from other companies included, version numbers and the patch's title.
 */
const logNames = Effect.fn("PatchPages.logNames")(function* (
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
    connections: new Map<string, string>()
  } satisfies LogNames;
});

/** Overview's recent log for the owner and admins: the last three entries, once it has any or serves tier 2. */
const recentActivity = Effect.fn("PatchPages.recentActivity")(function* (
  card: Patches.PortalCard,
  now: number
) {
  const { viewer } = yield* context;
  if (!canManage(card, viewer)) return "";
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
 * Beside a live tool's Overview: the agent tools of the version it serves, and while agent access
 * is off, who can turn it on. Empty without tools.
 */
const agentAside = Effect.fn("PatchPages.agentAside")(function* (card: Patches.PortalCard) {
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
  // The viewer's own apps, never the company's: only they say whether this person can use these.
  const apps = access.on
    ? (yield* (yield* AgentConnections.AgentConnections).list(viewer.user.id)).map(
        (app) => app.clientName
      )
    : [];
  return renderAgentAside({ tools, viewer, admins, apps });
});

/**
 * Overview's main column: the patch's facts, why its guests can't open it, and the recent log.
 * A page holds one notice, so a refusal over it leaves out the guests' warning until the next look.
 */
const overview = Effect.fn("PatchPages.overview")(function* (
  card: Patches.PortalCard,
  selected: Patches.ReadPatch,
  now: number,
  here: string,
  options: { readonly readOnly: boolean; readonly refused: boolean }
) {
  const { viewer } = yield* context;
  const { readOnly } = options;
  const reason = options.refused ? undefined : (yield* turnedAway([selected]))?.get(card.patch.id);
  return renderOverview({
    card,
    viewer,
    now,
    here,
    activity: yield* recentActivity(card, now),
    ...(readOnly ? { readOnly } : {}),
    ...(reason === undefined ? {} : { turnedAway: reason })
  });
});

/** A tab that is not the log: Overview at `/patches/<name>`, then `/versions` and `/settings`. */
type PageTab = Exclude<CardTab, "log">;
/** Where each act lands once done, and where a stale or refused form of it says so. */
const tabOf: Record<PatchAction, PageTab> = {
  description: "settings",
  rollback: "versions",
  retire: "overview",
  delete: "overview",
  restore: "overview",
  reassign: "overview"
};
const settingsForbidden = "Only the owner or an admin can change this patch's settings.";
const tabPath = (patch: Patches.Patch, tab: CardTab) =>
  cardPath(patch, tab === "overview" ? "" : tab);

/** A dialog an act asks in over its tab, with what a refused form of it left to say. */
type Confirm = ConfirmationState &
  (
    | { readonly action: Exclude<ConfirmationAction, "reassign"> }
    | { readonly action: "reassign" }
    | { readonly action: "rollback"; readonly versionNumber: number }
  );
/** An act's dialog, with what a refused form of it left to say. */
const confirmOf = (action: ConfirmationAction, state: ConfirmationState = {}): Confirm =>
  action === "reassign" ? { ...state, action } : { ...state, action };
/** The tab each act's dialog opens over, where its Cancel and Close go. */
const behindOf: Record<Confirm["action"], PageTab> = {
  retire: "settings",
  delete: "settings",
  reassign: "settings",
  restore: "overview",
  rollback: "versions"
};
const confirmTitles: Record<Confirm["action"], string> = {
  retire: "Retire",
  delete: "Delete",
  restore: "Restore",
  reassign: "Reassign",
  rollback: "Serve a version"
};

/** How a patch's page is drawn: its tab, a dialog over it, and what a refused form of it left to say. */
interface CardOptions {
  readonly tab?: PageTab;
  readonly status?: number;
  readonly notice?: string;
  readonly submittedDescription?: string;
  readonly descriptionError?: string;
  /** No forms at all, for a refusal of a form that was rendered for another patch. */
  readonly readOnly?: boolean;
  /** The Share dialog a refused form of it shows again; a GET asks with `?share=`. */
  readonly sharing?: Sharing;
  /** An act's dialog over the page, as its GET route asks or a refusal of its form draws again. */
  readonly confirm?: Confirm;
}

const notAvailable = (state: Patches.Patch["state"]) =>
  `This patch is ${state}. This action is not available. Nothing was done.`;

/**
 * One patch's page at `/patches/<name>` on one of its tabs, with any dialog over it. A member
 * asking for Settings gets Overview. An act's dialog checks first that the viewer may do it and
 * that the patch is in a state it applies to; the Share dialog shows its own refusals.
 */
export const render: (name: string, options?: CardOptions) => Page = Effect.fn("PatchPages.render")(
  function* (name: string, options: CardOptions = {}) {
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
    const { patch } = card;
    const now = yield* Clock.currentTimeMillis;
    const manages = canManage(card, viewer);
    const { confirm } = options;
    if (confirm !== undefined) {
      // Identity and permission before state: someone who can't act learns nothing more.
      if (viewer.role !== "admin" && (confirm.action === "reassign" || !manages))
        return yield* render(name, {
          status: 403,
          notice: confirm.action === "reassign" ? adminRequired : forbidden
        });
      if (
        confirm.action === "restore" &&
        options.status === undefined &&
        card.offSources.length === 0
      )
        return HttpServerResponse.redirect(cardPath(patch), {
          status: 303,
          headers: { "cache-control": "private, no-store" }
        });
      if (
        ((confirm.action === "retire" || confirm.action === "rollback") &&
          patch.state !== "live") ||
        (confirm.action === "delete" && patch.state === "deleted") ||
        (confirm.action === "restore" && patch.state === "live")
      )
        return yield* render(name, { status: 409, notice: notAvailable(patch.state) });
      // A version that isn't kept, or already serves, has nothing to ask about: Versions says
      // why when a refusal brought it here, and is simply where it goes otherwise.
      if (
        confirm.action === "rollback" &&
        !card.versions.some(
          (version) =>
            version.versionNumber === confirm.versionNumber && version.id !== patch.currentVersionId
        )
      )
        return options.status === undefined
          ? HttpServerResponse.redirect(cardPath(patch, "versions"), {
              status: 303,
              headers: { "cache-control": "private, no-store" }
            })
          : yield* render(name, {
              tab: "versions",
              status: options.status,
              ...(confirm.notice === undefined ? {} : { notice: confirm.notice })
            });
    }
    const refused = options.tab === "settings" && !manages;
    const tab = refused ? "overview" : (options.tab ?? "overview");
    const here = tabPath(patch, tab);
    const main =
      tab === "settings"
        ? renderSettings({
            card,
            viewer,
            here,
            ...(options.submittedDescription === undefined
              ? {}
              : { submittedDescription: options.submittedDescription }),
            ...(options.descriptionError === undefined
              ? {}
              : { descriptionError: options.descriptionError })
          })
        : tab === "versions"
          ? renderVersions({ card, viewer, now })
          : yield* overview(card, selected, now, here, {
              readOnly: options.readOnly === true,
              refused: options.notice !== undefined
            });
    const aside = tab === "overview" ? yield* agentAside(card) : "";
    const failures =
      tab === "overview" ? (yield* callSummary([selected]))?.get(patch.id)?.failures : undefined;
    const title = shownTitle(patch, viewer.company.name);
    const confirmation =
      confirm === undefined
        ? undefined
        : confirm.action === "reassign"
          ? renderConfirmation({
              ...confirm,
              action: "reassign",
              card,
              viewer,
              now,
              close: here,
              members: yield* (yield* Users.Users).list(viewer.company.id)
            })
          : renderConfirmation({ ...confirm, card, viewer, now, close: here });
    const sharing =
      confirmation === undefined
        ? (options.sharing ?? (options.readOnly ? undefined : asked(url)))
        : undefined;
    const share = yield* shareOverlay([selected], sharing);
    return pageResponse(
      {
        title:
          confirm === undefined
            ? tabTitle(title, tab)
            : `${confirmTitles[confirm.action]} – ${title}`,
        ...renderPatchPage({
          card,
          viewer,
          now,
          publicBaseUrl: session.publicBaseUrl,
          tab,
          here,
          ...(refused
            ? { notice: settingsForbidden }
            : options.notice === undefined
              ? {}
              : { notice: options.notice }),
          ...(options.readOnly === true ? { readOnly: true } : {}),
          ...(failures === undefined ? {} : { failures }),
          main,
          aside
        }),
        status: refused ? 403 : (options.status ?? sharing?.status ?? 200),
        app: {
          ...(confirmation === undefined
            ? withOverlay(viewer, share)
            : { viewer, overlay: confirmation }),
          section: "patches"
        }
      },
      session
    );
  }
);

/** An act's dialog over the tab its form sits on: Retire, Delete, Restore, Reassign. */
const confirmationPage = (name: string, action: ConfirmationAction) =>
  render(name, { tab: behindOf[action], confirm: confirmOf(action) });

/** Serve this version…: the dialog over Versions for the `?version=` it names. */
const servePage = Effect.fn("PatchPages.servePage")(function* (name: string) {
  const { url } = yield* context;
  const versionNumber = Number(url.searchParams.get("version") ?? "");
  return yield* render(name, {
    tab: behindOf.rollback,
    // Anything that isn't a kept version's number finds no version and goes back to Versions.
    confirm: {
      action: "rollback",
      versionNumber: Number.isSafeInteger(versionNumber) ? versionNumber : 0
    }
  });
});

/** The patch's log for its current owner and admins: newest first, filtered and paged by cursor. */
const logPage = Effect.fn("PatchPages.logPage")(function* (name: string) {
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
  if (!canManage(selected, viewer))
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
  const title = shownTitle(card.patch, viewer.company.name);
  return pageResponse(
    {
      title: tabTitle(title, "log"),
      ...renderPatchPage({
        card,
        viewer,
        now,
        publicBaseUrl: session.publicBaseUrl,
        tab: "log",
        // Share opens over Overview: the dialog's forms return only to the pages `behind` keeps.
        here: cardPath(card.patch),
        main: renderLog({
          patch: card.patch,
          title,
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
        })
      }),
      app: { viewer, section: "patches" }
    },
    session
  );
});

const post = Effect.fn("PatchPages.post")(function* (name: string, action: PatchAction) {
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
  if (viewer.role !== "admin" && (action === "reassign" || !canManage(selected, viewer)))
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
  // A refused act draws its dialog again over its tab, with the person's answers.
  const redisplay = (status: number, notice: string, nameError?: string) =>
    confirmation === undefined
      ? render(name, { tab, status, notice })
      : render(name, {
          tab: behindOf[confirmation],
          status,
          confirm: confirmOf(confirmation, {
            ...(nameError === undefined ? { notice } : { nameError }),
            submittedName: form.confirm ?? "",
            selectedOwnerId: form.user ?? ""
          })
        });
  const title = shownTitle(selected.patch, viewer.company.name);
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
        return landed(
          `${shownTitle(rolledBack.patch, viewer.company.name)} now serves v${rolledBack.currentVersion}`
        );
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
  const stale = Effect.fn("PatchPages.stale")(function* (state?: Patches.Patch["state"]) {
    return yield* render(name, {
      tab,
      status: 409,
      ...draft,
      notice: yield* staleNotice(selected.patch.id, state)
    });
  });
  // A refused version draws its Serve dialog again over Versions, while that version is still one
  // to ask about.
  const versionNumber = Number(form.versionNumber ?? "");
  const invalid = (notice: string) =>
    confirmation !== undefined
      ? redisplay(422, notice)
      : action === "rollback"
        ? render(name, {
            tab: behindOf.rollback,
            status: 422,
            confirm: {
              action: "rollback",
              versionNumber: Number.isSafeInteger(versionNumber) ? versionNumber : 0,
              notice
            }
          })
        : render(name, {
            tab,
            status: 422,
            ...(action === "description"
              ? { submittedDescription: form.description ?? "", descriptionError: notice }
              : { notice })
          });
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
        render(name, {
          tab: behindOf.reassign,
          status: 409,
          confirm: {
            action: "reassign",
            ownerError: "Choose an active member of this company. Nothing was done.",
            selectedOwnerId: form.user ?? ""
          }
        })
    })
  );
});

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
  {
    method: "GET" as const,
    path: "/patches/:name/rollback" as const,
    handle: servePage
  },
  ...(["description", "rollback", "retire", "delete", "restore", "reassign"] as const).map(
    (action) => ({
      method: "POST" as const,
      path: `/patches/:name/${action}` as const,
      handle: (name: string) => post(name, action)
    })
  )
];

export const layer: Routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
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
  })
);
