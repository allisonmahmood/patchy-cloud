import * as DateTime from "effect/DateTime";
import type { RequireSession } from "@patchy/auth";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import type { Patches } from "@patchy/patches";

/** First-party content only; pageResponse supplies the app shell and form-safe headers. */
export const renderAddressNotice = (input: {
  readonly patch: Patches.Patch;
  readonly actorName: string | null;
  readonly sourcesOff: boolean;
  readonly viewer: RequireSession.Viewer["Service"];
  readonly now: number;
}): string => {
  const { patch, actorName, sourcesOff, viewer, now } = input;
  const retired = patch.state === "retired";
  const at = retired ? patch.retiredAt : patch.deletedAt;
  const when =
    at === null
      ? ""
      : `<time datetime="${escapeAttribute(at)}">${escapeHtml(DateTime.format(DateTime.makeUnsafe(at), { day: "numeric", month: "short", year: "numeric", locale: "en-GB" }))}</time>`;
  const purgeAt =
    patch.purgeAt === null ? null : DateTime.toEpochMillis(DateTime.makeUnsafe(patch.purgeAt));
  const days = purgeAt === null ? 0 : Math.max(0, Math.ceil((purgeAt - now) / 86_400_000));
  const canRestore =
    (viewer.user.id === patch.ownerUserId || viewer.role === "admin") &&
    (retired || (purgeAt !== null && now < purgeAt));
  const card = `/patches/${encodeURIComponent(patch.name)}`;
  const restore = !canRestore
    ? ""
    : sourcesOff
      ? `<a class="btn btn-primary" href="${escapeAttribute(`${card}/restore`)}">Restore…</a>`
      : `<form method="post" action="${escapeAttribute(`${card}/restore`)}"><input type="hidden" name="expectedState" value="${escapeAttribute(patch.state)}"><button class="btn btn-primary" type="submit">Restore</button></form>`;
  const note = retired
    ? `<div class="note"><span class="note-title">Off the shelf, kept as it was</span>Its tables, files and all its versions are kept for as long as you like; nobody can open <code>${escapeHtml(patch.name)}</code> until it is restored.</div>`
    : `<div class="note note-warn"><span class="note-title">Gone for good in ${days} days</span>Until then the owner or an admin can restore it; after that the page, its versions, tables, files and the name are all reclaimed.</div>`;
  return `<p class="supporting-text">${escapeHtml(patch.companyHandle)} / ${escapeHtml(patch.name)}</p><dl class="facts"><dt>State</dt><dd>${retired ? "Retired" : "Deleted"}${actorName === null ? "" : ` by ${escapeHtml(actorName)}`}${when === "" ? "" : `, ${when}`}</dd></dl>${note}${!retired && purgeAt !== null && now >= purgeAt ? '<p class="supporting-text">The recovery window has ended. This patch can no longer be restored.</p>' : ""}<div class="actions">${restore}<a class="btn btn-quiet" href="${escapeAttribute(card)}">View patch card</a></div>${canRestore && sourcesOff ? '<p class="supporting-text">It reads tables from patches that are off. Review those sources before restoring it.</p>' : ""}`;
};
