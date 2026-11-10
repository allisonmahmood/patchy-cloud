import * as DateTime from "effect/DateTime";
import { escapeAttribute, escapeHtml } from "./escape.js";

import { isPage } from "./patch-marks.js";

export { isPage, patchTitle } from "./patch-marks.js";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const dateLabel = (iso: string): string => {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(iso));
  return `${parts.day} ${months[parts.month - 1]} ${parts.year}`;
};

/** "4 minutes ago", "just now": a reader's sense of how long since `iso`. */
export const ago = (iso: string, now: number): string => {
  const seconds = Math.max(
    0,
    Math.round((now - DateTime.toEpochMillis(DateTime.makeUnsafe(iso))) / 1000)
  );
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"} ago`;
  if (seconds < 45) return "just now";
  if (seconds < 3600) return unit(Math.max(1, Math.round(seconds / 60)), "minute");
  if (seconds < 86_400) return unit(Math.round(seconds / 3600), "hour");
  return unit(Math.round(seconds / 86_400), "day");
};

/**
 * A person's welcome page, as onboarding publishes it: a page named `welcome`, or `welcome-<n>`
 * when the name was taken. Home's live note, the guide and the activation event read it.
 */
export const isWelcomePage = (patch: { readonly name: string; readonly tier: number }): boolean =>
  isPage(patch) && /^welcome(-\d+)?$/u.test(patch.name);

export const daysLeft = (deadline: number, now: number): number =>
  Math.max(0, Math.ceil((deadline - now) / 86_400_000));

const recoveryEnded =
  '<p class="supporting-text">The recovery window has ended. This patch can no longer be restored.</p>';

/**
 * Where a retired or deleted patch stands: who took it down and when, and, once deleted, when it
 * is reclaimed for good. A retired patch can always be restored; a deleted one until `reclaimAt`.
 * The patch's page and the notice at its old address both read it.
 */
export interface Recovery {
  readonly state: "retired" | "deleted";
  readonly actorName: string | null;
  /** When it was retired or deleted. */
  readonly at: string | null;
  /** When a deleted patch is reclaimed for good; null while retired. */
  readonly reclaimAt: string | null;
  /** Whole days until `reclaimAt`, 0 once it has passed; null while retired. */
  readonly daysLeft: number | null;
  readonly restorable: boolean;
}

export const recovery = (input: {
  readonly state: "retired" | "deleted";
  readonly actorName: string | null;
  readonly stateAt: string | null;
  readonly purgeAt: string | null;
  readonly now: number;
}): Recovery => {
  const retired = input.state === "retired";
  const deadline =
    input.purgeAt === null ? null : DateTime.toEpochMillis(DateTime.makeUnsafe(input.purgeAt));
  return {
    state: input.state,
    actorName: input.actorName,
    at: input.stateAt,
    reclaimAt: retired ? null : input.purgeAt,
    daysLeft: retired ? null : deadline === null ? 0 : daysLeft(deadline, input.now),
    restorable: retired || (deadline !== null && input.now < deadline)
  };
};

const timeLabel = (iso: string) =>
  `<time datetime="${escapeAttribute(iso)}">${escapeHtml(dateLabel(iso))}</time>`;

/**
 * The status line's words for a retired or deleted patch, as HTML: who and when, then what that
 * means now. "Deleted by Sam on 5 Nov 2026. Gone for good on 5 Dec 2026 unless restored."
 */
export const recoveryLine = (state: Recovery): string => {
  const who = `${state.state === "retired" ? "Retired" : "Deleted"}${state.actorName === null ? "" : ` by ${escapeHtml(state.actorName)}`}${state.at === null ? "" : ` on ${timeLabel(state.at)}`}.`;
  const then =
    state.state === "retired"
      ? "Nobody can open it until it’s restored."
      : state.restorable && state.reclaimAt !== null
        ? `Gone for good on ${timeLabel(state.reclaimAt)} unless restored.`
        : "The recovery window has ended, so it can no longer be restored.";
  return `${who} ${then}`;
};

/**
 * Callers decide who may restore and supply their own action URL and page composition. The
 * restore form carries the patch id, which the portal checks before acting on the name.
 */
export const renderOffPatch = (input: {
  readonly name: string;
  readonly state: "retired" | "deleted";
  readonly actorName: string | null;
  readonly stateAt: string | null;
  readonly purgeAt: string | null;
  readonly now: number;
  readonly restore: {
    readonly href: string;
    readonly patchId: string;
    readonly sourcesOff: boolean;
    readonly currentVersion?: number;
  } | null;
}) => {
  const { name, state, actorName, stateAt } = input;
  const retired = state === "retired";
  const standing = recovery(input);
  const expired = !standing.restorable;
  const when =
    stateAt === null
      ? ""
      : `, <time datetime="${escapeAttribute(stateAt)}">${escapeHtml(dateLabel(stateAt))}</time>`;
  const stateFact = `<dt>State</dt><dd>${retired ? "Retired" : "Deleted"}${actorName === null ? "" : ` by ${escapeHtml(actorName)}`}${when}</dd>`;
  const note = retired
    ? `<div class="note"><span class="note-title">Off the shelf, kept as it was</span>Its tables, files and all its versions are kept for as long as you like; nobody can open <code>${escapeHtml(name)}</code> until it is restored.</div>`
    : `<div class="note note-warn"><span class="note-title">Gone for good in ${standing.daysLeft ?? 0} days</span>Until then the owner or an admin can restore it; after that the page, its versions, tables, files and the name are all reclaimed.</div>`;
  let restoreControl = "";
  let restoreHint = "";
  if (input.restore !== null && !expired) {
    const { href, patchId, sourcesOff, currentVersion } = input.restore;
    const action = escapeAttribute(href);
    if (sourcesOff) {
      restoreControl = `<a class="btn btn-primary" href="${action}">Restore…</a>`;
      restoreHint =
        "It reads tables from patches that are off. Review those sources before restoring it.";
    } else {
      restoreControl = `<form method="post" action="${action}"><input type="hidden" name="expectedPatchId" value="${escapeAttribute(patchId)}"><input type="hidden" name="expectedState" value="${escapeAttribute(state)}"><button class="btn btn-primary" type="submit">Restore</button></form>`;
      if (currentVersion !== undefined) {
        restoreHint = `Restore brings it back live at v${escapeHtml(currentVersion)} with the same address.`;
      }
    }
  }
  return {
    stateFact,
    note,
    restoreControl,
    restoreHint,
    recoveryEnded: expired ? recoveryEnded : ""
  };
};
