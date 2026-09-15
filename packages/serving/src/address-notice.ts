import type { RequireSession } from "@patchy/auth";
import { escapeAttribute, escapeHtml, renderOffPatch } from "@patchy/core";
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
  if (patch.state === "live") return "";
  const card = `/patches/${encodeURIComponent(patch.name)}`;
  const canManage = viewer.user.id === patch.ownerUserId || viewer.role === "admin";
  const off = renderOffPatch({
    name: patch.name,
    state: patch.state,
    actorName,
    stateAt: patch.state === "retired" ? patch.retiredAt : patch.deletedAt,
    purgeAt: patch.purgeAt,
    now,
    restore: canManage ? { href: `${card}/restore`, sourcesOff } : null
  });
  const address = `<p class="supporting-text">${escapeHtml(patch.companyHandle)} / ${escapeHtml(patch.name)}</p>`;
  const facts = `<dl class="facts">${off.stateFact}</dl>`;
  const cardLink = `<a class="btn btn-quiet" href="${escapeAttribute(card)}">View patch card</a>`;
  const actions = `<div class="actions">${off.restoreControl}${cardLink}</div>`;
  const restoreHint =
    off.restoreHint === "" ? "" : `<p class="supporting-text">${off.restoreHint}</p>`;
  return `${address}${facts}${off.note}${off.recoveryEnded}${actions}${restoreHint}`;
};
