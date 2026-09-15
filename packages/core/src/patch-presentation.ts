import * as DateTime from "effect/DateTime";
import { escapeAttribute, escapeHtml } from "./html.js";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const dateLabel = (iso: string): string => {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(iso));
  return `${parts.day} ${months[parts.month - 1]} ${parts.year}`;
};

export const daysLeft = (deadline: number, now: number): number =>
  Math.max(0, Math.ceil((deadline - now) / 86_400_000));

const recoveryEnded =
  '<p class="supporting-text">The recovery window has ended. This patch can no longer be restored.</p>';

/** Callers decide who may restore and supply their own action URL and page composition. */
export const renderOffPatch = (input: {
  readonly name: string;
  readonly state: "retired" | "deleted";
  readonly actorName: string | null;
  readonly stateAt: string | null;
  readonly purgeAt: string | null;
  readonly now: number;
  readonly restore: {
    readonly href: string;
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
    const { href, sourcesOff, currentVersion } = input.restore;
    const action = escapeAttribute(href);
    if (sourcesOff) {
      restoreControl = `<a class="btn btn-primary" href="${action}">Restore…</a>`;
      restoreHint =
        "It reads tables from patches that are off. Review those sources before restoring it.";
    } else {
      restoreControl = `<form method="post" action="${action}"><input type="hidden" name="expectedState" value="${escapeAttribute(state)}"><button class="btn btn-primary" type="submit">Restore</button></form>`;
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
