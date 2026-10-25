import * as DateTime from "effect/DateTime";
import { escapeAttribute, escapeHtml } from "./html.js";

/**
 * What people see a patch called: its title, else its name. Addresses, and anything typed to
 * confirm, use the name.
 */
export const patchTitle = (patch: { readonly name: string; readonly title: string }): string =>
  patch.title.trim() || patch.name;

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
 * A person's welcome page, as onboarding publishes it: a tier 0 patch named `welcome`, or
 * `welcome-<n>` when the name was taken. Home's live note and the activation event read it.
 */
export const isWelcomePage = (patch: { readonly name: string; readonly tier: number }): boolean =>
  patch.tier === 0 && /^welcome(-\d+)?$/u.test(patch.name);

export const daysLeft = (deadline: number, now: number): number =>
  Math.max(0, Math.ceil((deadline - now) / 86_400_000));

const recoveryEnded =
  '<p class="supporting-text">The recovery window has ended. This patch can no longer be restored.</p>';

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
  const { name, state, actorName, stateAt, now } = input;
  const retired = state === "retired";
  const deadline =
    input.purgeAt === null ? null : DateTime.toEpochMillis(DateTime.makeUnsafe(input.purgeAt));
  const expired = !retired && (deadline === null || now >= deadline);
  const when =
    stateAt === null
      ? ""
      : `, <time datetime="${escapeAttribute(stateAt)}">${escapeHtml(dateLabel(stateAt))}</time>`;
  const stateFact = `<dt>State</dt><dd>${retired ? "Retired" : "Deleted"}${actorName === null ? "" : ` by ${escapeHtml(actorName)}`}${when}</dd>`;
  const note = retired
    ? `<div class="note"><span class="note-title">Off the shelf, kept as it was</span>Its tables, files and all its versions are kept for as long as you like; nobody can open <code>${escapeHtml(name)}</code> until it is restored.</div>`
    : `<div class="note note-warn"><span class="note-title">Gone for good in ${deadline === null ? 0 : daysLeft(deadline, now)} days</span>Until then the owner or an admin can restore it; after that the page, its versions, tables, files and the name are all reclaimed.</div>`;
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
