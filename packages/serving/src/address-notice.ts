import type { RequireSession } from "@patchy/auth";
import { escapeHtml, indexPage, linkButton, renderOffPatch } from "@patchy/core";
import type { Patches } from "@patchy/patches";

/**
 * A retired or deleted patch's address, for someone at its company: an app page, never a door or
 * a stopping notice, saying who took it down and when, what happens next and, for its owner or an
 * admin, Restore while the window lasts. It spreads into `pageResponse` with the app shell.
 */
export const renderAddressNotice = (input: {
  readonly patch: Patches.Patch;
  readonly actorName: string | null;
  readonly sourcesOff: boolean;
  readonly viewer: RequireSession.Viewer["Service"];
  readonly now: number;
}) => {
  const { patch, actorName, sourcesOff, viewer, now } = input;
  // Its name, not its title: what a patch calls itself is its content, which is off with it.
  const title = `${patch.name} is ${patch.state}`;
  if (patch.state === "live") return { title, heading: "", body: "" };
  const card = `/patches/${encodeURIComponent(patch.name)}`;
  const canManage = viewer.user.id === patch.ownerUserId || viewer.role !== "member";
  const off = renderOffPatch({
    name: patch.name,
    state: patch.state,
    actorName,
    stateAt: patch.state === "retired" ? patch.retiredAt : patch.deletedAt,
    purgeAt: patch.purgeAt,
    now,
    restore: canManage ? { href: `${card}/restore`, patchId: patch.id, sourcesOff } : null
  });
  return {
    title,
    ...indexPage({
      title,
      // The address in the code type, as a patch's own page shows it; `mono` is a patch's monogram.
      meta: [
        `<span class="code">${escapeHtml(patch.companyHandle)}/${escapeHtml(patch.name)}</span>`
      ],
      actions: `${off.restoreControl}${linkButton("View patch", card)}`,
      content: `<dl class="facts">${off.stateFact}</dl>${off.note}${off.recoveryEnded}${off.restoreHint === "" ? "" : `<p class="meta">${off.restoreHint}</p>`}`
    })
  };
};
