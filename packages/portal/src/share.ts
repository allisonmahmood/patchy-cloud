import type * as Effect from "effect/Effect";
import type { Patches } from "@patchy/patches";
import { avatar, copyLine, copyScriptPath, escapeAttribute, escapeHtml } from "@patchy/core";

export type NamedGuest = Effect.Success<
  ReturnType<Patches.Patches["Service"]["namedGrants"]>
>[number];

/** Presentation only; Patches rechecks eligibility and management authority on every operation. */
export const guestShareable = (row: Patches.ReadPatch): boolean =>
  row.patch.state === "live" && row.patch.scope === "company" && (row.tier === 0 || row.tier === 1);

export const sharePath = (patch: Patches.Patch): string =>
  `/patches/${encodeURIComponent(patch.name)}/settings#share`;

export const renderShare = (input: {
  card: Patches.PortalCard;
  guests: readonly NamedGuest[];
  publicBaseUrl: string;
  email?: string;
  error?: string;
}): string => {
  const { card, guests } = input;
  const { patch } = card;
  const path = `/patches/${encodeURIComponent(patch.name)}`;
  const patchId = `<input type="hidden" name="expectedPatchId" value="${escapeAttribute(patch.id)}">`;
  const shareable = guestShareable(card);
  const form = shareable
    ? `<form method="post" action="${path}/guest-share" novalidate>${patchId}<label class="field-label" for="guest-email">Existing Patchy account email</label><input class="field" id="guest-email" name="email" type="email" maxlength="320" required value="${escapeAttribute(input.email ?? "")}" aria-describedby="guest-email-hint${input.error ? " guest-email-error" : ""}"${input.error ? ' aria-invalid="true" autofocus' : ""}><p class="field-hint" id="guest-email-hint">Use an existing Patchy member’s email. A deactivated member of this company receives guest access only. Access starts immediately. Send them the link; Patchy sends no email.</p>${input.error ? `<p class="note note-refused field-callout" role="alert" id="guest-email-error">${escapeHtml(input.error)}</p>` : ""}<div class="actions"><button class="btn btn-primary" type="submit">Share</button></div></form>`
    : `<p class="supporting-text">Guest sharing requires a live, company-private tier 0 or tier 1 patch.${patch.scope === "public" ? " Anyone with the link can already open this public patch." : ""}</p>${input.error ? `<p class="note note-refused" role="alert">${escapeHtml(input.error)}</p>` : ""}`;
  const rows = guests
    .map((guest) => {
      const status =
        guest.endedAt !== null
          ? guest.endReason === "revoked"
            ? "Revoked"
            : guest.endReason === "public"
              ? "Ended when made public"
              : "Ended"
          : guest.guestEndedAt !== null
            ? "Guest relationship ended"
            : guest.guestDeactivatedAt !== null
              ? "Guest deactivated · access blocked"
              : shareable
                ? "Has access"
                : "Grant kept · patch unavailable to guests";
      const revoke =
        guest.endedAt === null
          ? `<form method="post" action="${path}/guest-revoke">${patchId}<input type="hidden" name="guestId" value="${escapeAttribute(guest.guestId)}"><button class="btn btn-quiet btn-danger" type="submit" aria-label="${escapeAttribute(`Revoke access for ${guest.name}`)}">Revoke</button></form>`
          : "";
      return `<li class="list-row share-guest">${avatar(guest.guestId, guest.name)}<div><p><strong>${escapeHtml(guest.name)}</strong><br>${escapeHtml(guest.email)}</p><p class="supporting-text">${status}</p></div>${revoke}</li>`;
    })
    .join("");
  const url = `${input.publicBaseUrl.replace(/\/+$/u, "")}/${encodeURIComponent(patch.companyHandle)}/${encodeURIComponent(patch.name)}`;
  return `<section class="section" id="share" aria-labelledby="share-heading"><h2 class="section-heading" id="share-heading">Share</h2>${shareable ? "<p>Guests can read this patch after signing in with the account you share with. A grant follows future eligible versions, including newly declared owned tables and file stores.</p>" : ""}${shareable && card.tier === 1 ? renderGuestDataScope(card.manifest) : ""}${form}${patch.state === "live" ? `${copyLine(url, "Patch link", "patch link")}<p class="supporting-text">The link alone does not give access to a private patch.</p><script defer src="${copyScriptPath}"></script>` : ""}<h3>Named guests</h3>${rows ? `<ul class="list" aria-label="Named guests">${rows}</ul>` : '<p class="supporting-text">No named guests yet.</p>'}<p class="supporting-text">Revoking a grant stops new page loads and fresh data reads. Information already delivered cannot be recalled.</p></section>`;
};

/** Show the served declarations, never the cumulative provisioned inventory. */
export const renderGuestDataScope = (manifest: Patches.PortalCard["manifest"]): string => {
  const rows = [
    ...Object.entries(manifest.tables).map(([name, table]) => ({
      kind: "Table",
      name,
      description: table.description
    })),
    ...Object.entries(manifest.files).map(([name, store]) => ({
      kind: "File store",
      name,
      description: store.description
    }))
  ]
    .map(
      ({ kind, name, description }) =>
        `<li class="list-row"><div><strong>${kind}: <code>${escapeHtml(name)}</code></strong><p class="supporting-text">${escapeHtml(description)}</p></div></li>`
    )
    .join("");
  return `<div aria-labelledby="guest-data-heading"><h3 id="guest-data-heading">What guests can read</h3><p>Guests can read all declared patch-owned tables and files, including raw rows and files this page does not display. Only share this patch if every guest may read all of that data. Filtering the page does not restrict access.</p>${rows ? `<ul class="list" aria-label="Declared guest data">${rows}</ul>` : '<p class="supporting-text">This version declares no owned tables or file stores.</p>'}<p class="supporting-text">Guest access is read-only. Writes, uploads, other patches’ shared resources, the member directory and company connections are refused. Publishing or showing another eligible version updates this scope for every guest without another share.</p></div>`;
};
