import type { Teams } from "@patchy/companies";
import { type GuestReason, guestReasonText } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import {
  checkbox,
  avatar,
  badge,
  button,
  copyButton,
  dialog,
  escapeAttribute,
  escapeHtml,
  field,
  flowPage,
  input as textInput,
  linkButton,
  notice,
  patchMark,
  patchTitle,
  receipt,
  row,
  rows,
  select
} from "@patchy/core";
import type { GuestGrants, Patches } from "@patchy/patches";
import { hidden, patchAddress, shareHref, turnedAwayTitle } from "./shared/presentation.js";

type Viewer = RequireSession.Viewer["Service"];

/** Why Share didn't add the person whose email was typed, shown under the field. */
export type ShareRefusal =
  GuestGrants.NotOnPatchy | GuestGrants.AlreadyMember | GuestGrants.GuestsUnavailable;

/** Each refusal as the field's error says it: what happened, then what to do, if anything. */
const refusalText = (refused: ShareRefusal, viewer: Viewer): string => {
  switch (refused._tag) {
    case "NotOnPatchy":
      return `${refused.email} isn’t on Patchy yet. They need their own Patchy account first.`;
    case "AlreadyMember":
      return `${refused.email} is already at ${viewer.company.name}.`;
    case "GuestsUnavailable":
      return `${turnedAwayTitle}. ${guestReasonText(refused.reason)}`;
  }
};

/**
 * The Share dialog over the page it opened from: invite a guest by email, with the people this
 * company has shared with before as suggestions; the people with access, its owner and its guests
 * with Remove; general access, where going public asks first and a tool says why it can't; then
 * Copy link and Done. Each form posts and comes back to `back` with the dialog open. While the
 * patch is public its guests keep their access, but inviting waits. The page behind loads the
 * copy script.
 */
export const renderShareDialog = (input: {
  readonly row: Patches.ReadPatch | Patches.ManagementCard;
  readonly dependants?: {
    readonly dependants: readonly { readonly patchId: string; readonly name: string }[];
    readonly hiddenCount: number;
  };
  readonly submitted?: { readonly scope: string; readonly teamIds: readonly string[] };
  readonly teams?: readonly Teams.Team[];
  readonly viewer: Viewer;
  readonly publicBaseUrl: string;
  /** The page behind, as a path and query: where the forms return and Done goes. */
  readonly back: string;
  readonly guests: readonly GuestGrants.Guest[];
  readonly suggestions: readonly GuestGrants.Person[];
  /** Why its guests can't open it now, while it has guests and they can't. */
  readonly turnedAway?: GuestReason;
  /** What the last form here did. */
  readonly receipt?: string;
  /** Why General access's last change was refused. */
  readonly notice?: string;
  /** The email just refused, with why. */
  readonly refused?: { readonly email: string; readonly refusal: ShareRefusal };
  /** Going public was asked for (`&confirm=public`), so the dialog asks before it applies. */
  readonly confirmPublic?: boolean;
}): string => {
  const { viewer } = input;
  const { patch, owner, tier } = input.row;
  const title = patchTitle(patch, viewer.company.name);
  const company = viewer.company.name;
  const isPublic = patch.scope === "public";
  // Tools require sign-in; pages can also offer public access after confirmation.
  const tool = tier >= 2 && !isPublic;
  const confirming = input.confirmPublic === true && !isPublic && !tool;
  const refused = input.refused;
  // Inviting waits while it's public, unless an invite sent before it went public was refused:
  // that one keeps its email and why.
  const inviting = !isPublic || refused !== undefined;
  // Focus starts where the dialog's state needs it, never on a guest's Remove: Cancel while it
  // asks about going public, General access after a refusal there or while it's public, and
  // otherwise the invite field.
  const focus = confirming
    ? "cancel"
    : input.notice !== undefined || !inviting
      ? "scope"
      : "invite";
  const form = (act: "add-guest" | "remove-guest" | "scope", body: string) =>
    `<form method="post" action="${escapeAttribute(`/patches/${encodeURIComponent(patch.name)}/${act}`)}" novalidate>${hidden("expectedPatchId", patch.id)}${hidden("expectedOwnerUserId", patch.ownerUserId)}${hidden("back", input.back)}${body}</form>`;

  const known = new Set(input.guests.map((guest) => guest.userId));
  const suggestions = input.suggestions
    .filter((person) => !known.has(person.userId))
    .map(
      (person) =>
        `<option value="${escapeAttribute(person.email)}">${escapeHtml(`${person.name}, ${person.companyName}`)}</option>`
    )
    .join("");
  const invite = !inviting
    ? ""
    : form(
        "add-guest",
        `${field({
          id: "share-email",
          label: "Invite a guest",
          ...(refused === undefined ? {} : { error: refusalText(refused.refusal, viewer) }),
          control: (aria) =>
            `<div class="pair"><span class="grow">${textInput(aria, {
              name: "email",
              type: "email",
              value: refused?.email ?? "",
              placeholder: "Email of someone at another company",
              autocomplete: "off",
              maxlength: 320,
              autofocus: focus === "invite",
              ...(suggestions ? { list: "share-suggestions" } : {})
            })}</span>${button("Invite", { kind: "primary" })}</div>`
        })}${suggestions ? `<datalist id="share-suggestions">${suggestions}</datalist>` : ""}`
      );

  const people = `<div class="fieldset"><h3 class="field-label" id="share-people">People with access</h3><div class="rows-flush" role="group" aria-labelledby="share-people">${rows(
    [
      row({
        lead: avatar(owner.id, owner.name, owner.deactivated ? "off" : undefined),
        name: `${owner.name}${owner.id === viewer.user.id ? " (you)" : ""}`,
        ...(owner.deactivated ? { description: "Deactivated" } : {}),
        end: '<span class="meta">Owner</span>'
      }),
      ...input.guests.map((guest) =>
        row({
          lead: avatar(guest.userId, guest.name),
          name: guest.name,
          description: `${guest.email} · ${guest.companyName}`,
          end: `${badge("Guest")}${form("remove-guest", `${hidden("guest", guest.userId)}${button("Remove", { kind: "quiet", size: "sm", ariaLabel: `Remove ${guest.name}` })}`)}`
        })
      )
    ]
  )}</div></div>`;

  // A refusal of General access shows in it, above its Save. Going public asks first, and only
  // its answer applies it; a public patch's guests keep their grants for its way back.
  const refusalId = "share-scope-refusal";
  const refusal =
    input.notice === undefined
      ? ""
      : `<div id="${refusalId}">${notice({ tone: "danger", title: input.notice })}</div>`;
  const dependants = input.dependants;
  const impact =
    dependants && (dependants.dependants.length || dependants.hiddenCount)
      ? notice({
          tone: "warning",
          title: "Other patches use this patch",
          body: `${rows(
            dependants.dependants.map((item) => row({ name: item.name })),
            true
          )}${dependants.hiddenCount ? `<p>${dependants.hiddenCount} other ${dependants.hiddenCount === 1 ? "patch" : "patches"}</p>` : ""}${hidden("expectedDependants", dependants.dependants.map((item) => item.patchId).join(",") + ":" + dependants.hiddenCount)}${checkbox({ name: "force", value: "true", label: "Allow dependent patches to lose access if narrowing access" })}`
        })
      : "";
  const audience = confirming
    ? form(
        "scope",
        `${hidden("expectedScope", patch.scope)}${hidden("expectedLifecycleRevision", patch.lifecycleRevision)}${hidden("scope", "public")}${notice(
          {
            tone: "warning",
            title: `Make ${title} public?`,
            body: "<p>Anyone with the link can open it without signing in.</p>",
            action: `<div class="cluster">${button("Make public", { kind: "primary", name: "confirm", value: "public" })}${linkButton("Cancel", shareHref(input.back, patch.name), { kind: "quiet", autofocus: true })}</div>`
          }
        )}`
      )
    : (() => {
        const audienceField = field({
          id: "share-scope",
          label: "General access",
          ...(isPublic
            ? {
                hint: `Anyone with the link can open it without signing in.${input.guests.length ? ` Its guests keep their access if it goes back to people at ${company}.` : ""}`
              }
            : {}),
          control: (aria) => {
            // The control describes why it is the only choice, and why its last change was refused.
            const reason = "share-scope-reason";
            const describedBy = [
              aria.describedBy,
              tool ? reason : undefined,
              refusal ? refusalId : undefined
            ]
              .filter((id) => id !== undefined)
              .join(" ");
            const choice = select(
              {
                ...aria,
                describedBy: describedBy === "" ? undefined : describedBy,
                invalid: refusal !== ""
              },
              {
                name: "scope",
                value: input.submitted?.scope ?? patch.scope,
                width: "md",
                autofocus: focus === "scope",
                choices: [
                  { value: "company", label: `People at ${company}` },
                  ...((input.teams?.length ?? 0) > 0
                    ? [{ value: "teams", label: "Selected teams" }]
                    : []),
                  ...(tool ? [] : [{ value: "public", label: "Anyone on the internet" }])
                ]
              }
            );
            return `<div class="pair">${choice}${button("Save")}</div>`;
          }
        });
        const ids = new Set(
          input.submitted?.teamIds ??
            (patch.audience.members.kind === "teams" ? patch.audience.members.teamIds : [])
        );
        const choices = (input.teams ?? [])
          .map((team) =>
            checkbox({
              name: "teamIds",
              value: team.id,
              label: team.name,
              checked: ids.has(team.id)
            })
          )
          .join("");
        return form(
          "scope",
          `${hidden("expectedScope", patch.scope)}${hidden("expectedLifecycleRevision", patch.lifecycleRevision)}<div class="share-audience">${refusal}${audienceField}${choices ? `<div class="share-teams">${choices}</div>` : ""}${impact}${tool ? '<p class="meta" id="share-scope-reason">People must sign in to use this tool.</p>' : ""}</div>`
        );
      })();

  const warning =
    input.turnedAway === undefined
      ? ""
      : notice({
          tone: "warning",
          title: turnedAwayTitle,
          body: `<p>${escapeHtml(guestReasonText(input.turnedAway))}</p>`
        });
  const link = `${input.publicBaseUrl.replace(/\/+$/u, "")}${patchAddress(patch)}`;
  return dialog({
    id: "share",
    title: `Share ${title}`,
    mark: patchMark(patch.name, tier),
    size: "lg",
    closeHref: input.back,
    body: `${input.receipt === undefined ? "" : receipt(input.receipt)}${warning}${invite}${people}${audience}`,
    foot: `<span class="dialog-foot-start">${copyButton(link, { label: "Copy link", size: "sm" })}</span>${linkButton("Done", input.back, { kind: "primary" })}`
  });
};

/**
 * The page before a guest takes a patch shared with them off their Home: what that means, then
 * Remove or Cancel. Only its company can share it with them again.
 */
export const renderLeaveConfirmation = (shared: GuestGrants.Shared) => {
  const title = patchTitle(shared, shared.company.name);
  return flowPage({
    parent: { label: "Home", href: "/" },
    title: `Remove ${title}?`,
    sections: [],
    outcome: `<p class="prose">You won’t be able to open it until someone at ${escapeHtml(shared.company.name)} shares it with you again.</p>`,
    submit: `${button(`Remove ${title}`, { kind: "danger-solid" })}${linkButton("Cancel", "/", { kind: "quiet" })}`,
    form: { action: `/shared/${encodeURIComponent(shared.patchId)}/remove` }
  });
};
