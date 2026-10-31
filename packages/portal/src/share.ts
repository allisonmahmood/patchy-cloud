import { guestReasonText } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import { avatar, escapeAttribute, escapeHtml, patchMark, patchTitle } from "@patchy/core";
import type { GuestGrants, Patches } from "@patchy/patches";
import { patchAddress } from "./allPatches.js";
import { hidden, refusal, turnedAwayTitle } from "./render.js";

type Viewer = RequireSession.Viewer["Service"];

/** Why Share didn't add the person whose email was typed, shown under the field. */
export type ShareRefusal =
  GuestGrants.NotOnPatchy | GuestGrants.AlreadyMember | GuestGrants.GuestsUnavailable;

/** The Share dialog's layout; every control is the shell's. */
export const shareStyles = `
  .share-head { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
  .share-dialog > .note { margin: 14px 0 0; }
  .share-add-row { display: flex; gap: 10px; align-items: start; }
  .share-add-row .field { flex: 1; min-width: 0; }
  .share-add .field-callout { margin-bottom: 0; }
  .share-guests { margin: 10px 0 0; }
  .share-guest { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
  .share-guest:last-child { border-bottom: 0; }
  .share-guest-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .share-guest form { margin: 0; }
  .share-audience { margin-top: 18px; padding-top: 6px; border-top: 1px solid var(--line-strong); }
  .share-audience fieldset { display: flex; flex-wrap: wrap; gap: 0 22px; min-width: 0; margin: 0; padding: 0; border: 0; }
  .share-audience legend { padding: 0; }
  .share-audience .field-choice { align-items: center; }
  .share-change { margin: 14px 0 0; }
  .share-change p { margin: 0; }
  /* The step after picking the other audience shows once it is picked; without :has() it always shows. */
  .share-audience:has(input[data-current]:checked) .share-change { display: none; }
  .share-foot { display: flex; justify-content: space-between; gap: 8px; margin-top: 22px; }
  .share-foot > [hidden] { display: none; }
  .share-foot > :last-child { margin-left: auto; }
`;

/** Each refusal as the callout under the field says it: what happened, then what to do, if anything. */
const refusalLines = (refused: ShareRefusal, viewer: Viewer): readonly [string, string?] => {
  switch (refused._tag) {
    case "NotOnPatchy":
      return [`${refused.email} isn’t on Patchy yet`, "They need their own Patchy account first."];
    case "AlreadyMember":
      return [`${refused.email} is already at ${viewer.company.name}`];
    case "GuestsUnavailable":
      return [turnedAwayTitle, guestReasonText(refused.reason)];
  }
};

/**
 * The Share dialog over the page it opened from: add a guest by email, with the people this
 * company has shared with before as suggestions; the current guests with Remove; who can open it,
 * going public confirmed in place; then Copy link and Done. Each form posts and comes back to
 * `back` with the dialog open. While the patch is public its guests stay, but adding waits. The
 * page behind loads the copy script.
 */
export const renderShareDialog = (input: {
  readonly row: Patches.ReadPatch;
  readonly viewer: Viewer;
  readonly publicBaseUrl: string;
  /** The page behind, as a path and query: where the forms return and Done goes. */
  readonly back: string;
  readonly guests: readonly GuestGrants.Guest[];
  readonly suggestions: readonly GuestGrants.Person[];
  /** What the last form here did. */
  readonly receipt?: string;
  /** Why the dialog's last act was refused, when it wasn't adding someone. */
  readonly notice?: string;
  /** The email just refused, with why. */
  readonly refused?: { readonly email: string; readonly refusal: ShareRefusal };
  /** Going public was asked without its confirmation, so the dialog asks. */
  readonly confirmPublic?: boolean;
}): string => {
  const { row, viewer } = input;
  const { patch } = row;
  const title = patchTitle(patch);
  const path = (act: string) => `/patches/${encodeURIComponent(patch.name)}/${act}`;
  const form = (act: string, className: string, body: string) =>
    `<form class="${className}" method="post" action="${escapeAttribute(path(act))}" novalidate>${hidden("expectedPatchId", patch.id)}${hidden("back", input.back)}${body}</form>`;
  const isPublic = patch.scope === "public";

  const refused = input.refused;
  const callout =
    refused === undefined
      ? ""
      : (() => {
          const [head, text] = refusalLines(refused.refusal, viewer);
          return `<div class="note note-refused field-callout" id="share-refusal" role="alert"><strong class="note-title">${escapeHtml(head)}</strong>${text === undefined ? "" : `<p>${escapeHtml(text)}</p>`}</div>`;
        })();
  const known = new Set(input.guests.map((guest) => guest.userId));
  const options = input.suggestions
    .filter((person) => !known.has(person.userId))
    .map(
      (person) =>
        `<option value="${escapeAttribute(person.email)}">${escapeHtml(`${person.name}, ${person.companyName}`)}</option>`
    )
    .join("");
  const add = isPublic
    ? ""
    : form(
        "add-guest",
        "share-add",
        `<label class="field-label" for="share-email">Add guests</label><div class="share-add-row"><input class="field" id="share-email" name="email" type="email" autocomplete="off" spellcheck="false" maxlength="320" value="${escapeAttribute(refused?.email ?? "")}"${options ? ' list="share-suggestions"' : ""} autofocus${refused === undefined ? "" : ' aria-invalid="true" aria-describedby="share-refusal"'}><button class="btn btn-primary" type="submit">Add</button></div>${callout}${options ? `<datalist id="share-suggestions">${options}</datalist>` : ""}`
      );

  const guestRow = (guest: GuestGrants.Guest) =>
    `<li class="list-row share-guest">${avatar(guest.userId, guest.name)}<span class="share-guest-name"><strong>${escapeHtml(guest.name)}</strong><br><span class="supporting-text">${escapeHtml(guest.email)} · ${escapeHtml(guest.companyName)}</span></span>${form("remove-guest", "share-remove", `${hidden("guest", guest.userId)}<button class="btn btn-quiet btn-danger" type="submit" aria-label="${escapeAttribute(`Remove ${guest.name}`)}">Remove</button>`)}</li>`;
  const guests = input.guests.length
    ? `${isPublic ? '<p class="field-label" id="share-guests-label">Guests</p>' : ""}<ul class="list share-guests" ${isPublic ? 'aria-labelledby="share-guests-label"' : 'aria-label="Guests"'}>${input.guests.map(guestRow).join("")}</ul>`
    : "";

  // The saved audience carries data-current, so picking the other one shows what comes next.
  const picked = input.confirmPublic === true ? "public" : patch.scope;
  const choice = (scope: Patches.Patch["scope"], label: string, disabled = false) =>
    `<label class="field-choice"><input class="field-radio" type="radio" name="scope" value="${scope}"${scope === picked ? " checked" : ""}${scope === patch.scope ? " data-current" : ""}${disabled ? " disabled" : ""}>${escapeHtml(label)}</label>`;
  // Tier 2 can't be public, so for a tool that choice is never one to make.
  const next = isPublic
    ? '<div class="actions share-change"><button class="btn" type="submit">Save</button></div>'
    : row.tier >= 2
      ? ""
      : `<div class="note note-warn share-change" role="group" aria-labelledby="share-public-title"><strong class="note-title" id="share-public-title">Make ${escapeHtml(title)} public?</strong><p>Anyone with the link can open it without signing in.</p><div class="actions"><button class="btn btn-primary" type="submit" name="confirm" value="public">Make public</button><button class="btn btn-quiet" type="reset">Cancel</button></div></div>`;
  const audience = form(
    "scope",
    "share-audience",
    `${hidden("expectedScope", patch.scope)}<fieldset><legend class="field-label">Who can open it</legend>${choice("company", `People at ${viewer.company.name}`)}${choice("public", "Anyone on the internet", row.tier >= 2)}</fieldset>${next}`
  );

  const url = `${input.publicBaseUrl.replace(/\/+$/u, "")}${patchAddress(patch)}`;
  const receipt =
    input.receipt === undefined
      ? ""
      : `<p class="note note-ok" role="status">${escapeHtml(input.receipt)}</p>`;
  return `<section class="modal-panel share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-heading"><div class="share-head">${patchMark(patch.name, row.tier)}<h2 id="share-heading">Share ${escapeHtml(title)}</h2></div>${receipt}${refusal(input.notice)}${add}${guests}${audience}<div class="share-foot"><button class="btn" type="button" data-copy="${escapeAttribute(url)}" aria-live="polite" hidden>Copy link</button><a class="btn btn-primary" href="${escapeAttribute(input.back)}">Done</a></div></section>`;
};

/**
 * The page before a guest takes a patch shared with them off their Home: what that means, then
 * Remove or Cancel. Only its company can share it with them again.
 */
export const renderLeaveConfirmation = (shared: GuestGrants.Shared): string => {
  const title = escapeHtml(patchTitle(shared));
  return `<article class="portal-subpage"><p><a href="/">Back to Home</a></p><h1 class="page-heading">Remove ${title}?</h1><form class="confirmation-form" method="post" action="${escapeAttribute(`/shared/${encodeURIComponent(shared.patchId)}/remove`)}"><p class="confirmation-consequence">You won’t be able to open it until someone at ${escapeHtml(shared.company.name)} shares it with you again.</p><div class="confirmation-actions"><button class="btn btn-danger" type="submit">Remove ${title}</button><a class="btn btn-quiet" href="/">Cancel</a></div></form></article>`;
};
