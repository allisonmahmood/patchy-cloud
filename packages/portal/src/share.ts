import type { Teams } from "@patchy/companies";
import { type GuestReason, guestReasonText } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import {
  avatar,
  checkbox,
  choiceGroup,
  productMark,
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
import {
  canReassign,
  cardPath,
  hidden,
  patchAddress,
  shareHref,
  turnedAwayTitle
} from "./shared/presentation.js";

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
 * company has shared with before as suggestions; who has access, its owner, its audience and its
 * guests with Remove; general access, where going public asks first and a tool can't; then Copy
 * link, Close and Save. Each form posts and comes back to `back` with the dialog open. Off its
 * address, only its audience changes, so a team it names can be deleted. While the patch is
 * public its guests keep their access, but inviting waits. The page behind loads the copy script.
 */
export const renderShareDialog = (input: {
  readonly row: Patches.ReadPatch;
  /** Every team in the company, to choose from. */
  readonly teams: readonly Teams.Team[];
  readonly viewer: Viewer;
  readonly publicBaseUrl: string;
  /** The page behind, as a path and query: where the forms return and Close goes. */
  readonly back: string;
  readonly guests: readonly GuestGrants.Guest[];
  readonly suggestions: readonly GuestGrants.Person[];
  /** Why its guests can't open it now, while it has guests and they can't. */
  readonly turnedAway?: GuestReason;
  /** Who its audience reaches that its shared sources or connections don't. */
  readonly reach: readonly string[];
  /** What the last form here did. */
  readonly receipt?: string;
  /** Why General access's last change was refused. */
  readonly notice?: string;
  /** The email just refused, with why. */
  readonly refused?: { readonly email: string; readonly refusal: ShareRefusal };
  /** What General access's refused form chose. */
  readonly submitted?: { readonly scope: string; readonly teamIds: readonly string[] };
  /** The patches a narrowing would leave without readers; Save then acknowledges them. */
  readonly narrowing?: {
    readonly dependants: readonly { readonly patchId: string; readonly name: string }[];
    readonly hiddenCount: number;
  };
  /** Going public was asked for (`&confirm=public`), so the dialog asks before it applies. */
  readonly confirmPublic?: boolean;
}): string => {
  const { viewer } = input;
  const { patch, owner, tier, audience } = input.row;
  const title = patchTitle(patch, viewer.company.name);
  const company = viewer.company.name;
  const live = patch.state === "live";
  const isPublic = audience.kind === "public";
  // Tools require sign-in; pages can also offer public access after confirmation.
  const tool = tier >= 2 && !isPublic;
  const confirming = input.confirmPublic === true && !isPublic && !tool;
  const refused = input.refused;
  // Inviting waits while it's public or off, unless an invite sent before was refused: that one
  // keeps its email and why.
  const inviting = (live && !isPublic) || refused !== undefined;
  // Focus starts where the dialog's state needs it, never on a guest's Remove: Cancel while it
  // asks about going public, General access after a refusal there or while it can't invite, and
  // otherwise the invite field.
  const focus = confirming
    ? "cancel"
    : input.notice !== undefined || input.narrowing !== undefined || !inviting
      ? "scope"
      : "invite";
  const form = (act: "add-guest" | "remove-guest" | "scope", body: string) =>
    `<form${act === "scope" ? ' id="share-access-form"' : ""} method="post" action="${escapeAttribute(`/patches/${encodeURIComponent(patch.name)}/${act}`)}" novalidate>${hidden("expectedPatchId", patch.id)}${hidden("back", input.back)}${body}</form>`;

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

  // The saved audience, apart from the unsaved General access controls below.
  const audienceRows =
    audience.kind === "teams"
      ? audience.teams.map((team) =>
          row({
            lead: productMark({ icon: "people" }),
            name: team.name,
            end: '<span class="meta">Team</span>'
          })
        )
      : [
          row({
            lead: productMark({ icon: isPublic ? "external" : "people" }),
            name: isPublic ? "Anyone on the internet" : `People at ${company}`,
            end: `<span class="meta">${isPublic ? "Public" : "Company"}</span>`
          })
        ];
  const people = `<div class="fieldset"><h3 class="field-label" id="share-people">Who has access</h3><div class="rows-flush" role="group" aria-labelledby="share-people">${rows(
    [
      row({
        lead: avatar(owner.id, owner.name, owner.deactivated ? "off" : undefined),
        name: `${owner.name}${owner.id === viewer.user.id ? " (you)" : ""}`,
        ...(owner.deactivated
          ? { description: "Deactivated" }
          : !input.row.access.ownerCanOpen
            ? { description: "Can’t open it" }
            : {}),
        end: `<span class="meta">Owner</span>${canReassign(viewer) ? linkButton("Change owner…", cardPath(patch, "reassign"), { kind: "quiet", size: "sm" }) : ""}`
      }),
      ...audienceRows,
      ...input.guests.map((guest) =>
        row({
          lead: avatar(guest.userId, guest.name),
          name: guest.name,
          description: `${guest.email} · ${guest.companyName}`,
          end: `${badge("Guest")}${live ? form("remove-guest", `${hidden("guest", guest.userId)}${button("Remove", { kind: "quiet", danger: true, size: "sm", ariaLabel: `Remove ${guest.name}` })}`) : ""}`
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
  const revision = hidden("expectedLifecycleRevision", patch.lifecycleRevision);
  // Saving again after a narrowing was refused accepts that its readers lose these patches.
  const narrowing = input.narrowing;
  const impact =
    narrowing === undefined
      ? ""
      : notice({
          tone: "warning",
          title: "These patches read its tables and lose readers",
          body: `${rows(
            narrowing.dependants.map((item) => row({ name: item.name })),
            true
          )}${narrowing.hiddenCount ? `<p>${narrowing.hiddenCount} more you can’t open.</p>` : ""}${hidden("force", "true")}`
        });
  const chosenScope =
    input.submitted?.scope ?? (audience.kind === "teams" ? "teams" : audience.kind);
  const chosenTeams = new Set(
    input.submitted?.teamIds ?? (audience.kind === "teams" ? audience.teams.map((t) => t.id) : [])
  );
  const access = confirming
    ? form(
        "scope",
        `${revision}${hidden("scope", "public")}${notice({
          tone: "warning",
          title: `Make ${title} public?`,
          body: "<p>Anyone with the link can open it without signing in.</p>",
          action: `<div class="cluster">${button("Make public", { kind: "primary", name: "confirm", value: "public" })}${linkButton("Cancel", shareHref(input.back, patch.name), { kind: "quiet", autofocus: true })}</div>`
        })}`
      )
    : form(
        "scope",
        `${revision}${refusal}${field({
          id: "share-scope",
          label: "General access",
          ...(isPublic
            ? {
                hint: `Anyone with the link can open it without signing in.${input.guests.length ? ` Its guests keep their access if it goes back to people at ${company}.` : ""}`
              }
            : {}),
          control: (aria) =>
            select(
              {
                ...aria,
                describedBy:
                  [aria.describedBy, refusal ? refusalId : undefined]
                    .filter((id) => id !== undefined)
                    .join(" ") || undefined,
                invalid: refusal !== ""
              },
              {
                name: "scope",
                value: chosenScope,
                width: "md",
                autofocus: focus === "scope",
                choices: [
                  { value: "company", label: `People at ${company}` },
                  ...(input.teams.length > 0 ? [{ value: "teams", label: "Selected teams" }] : []),
                  ...(tool ? [] : [{ value: "public", label: "Anyone on the internet" }])
                ]
              }
            )
        })}${
          input.teams.length === 0
            ? ""
            : choiceGroup({
                id: "share-teams",
                legend: "Teams",
                choices: (aria) =>
                  input.teams
                    .map((team) =>
                      checkbox({
                        name: "teamIds",
                        value: team.id,
                        label: team.name,
                        checked: chosenTeams.has(team.id),
                        aria
                      })
                    )
                    .join("")
              })
        }${impact}`
      );

  const warnings = [
    ...(input.turnedAway === undefined
      ? []
      : [
          notice({
            tone: "warning",
            title: turnedAwayTitle,
            body: `<p>${escapeHtml(guestReasonText(input.turnedAway))}</p>`
          })
        ]),
    ...(input.reach.length === 0
      ? []
      : [
          notice({
            tone: "warning",
            title: "Its audience is wider than what it uses",
            body: input.reach.map((line) => `<p>${escapeHtml(line)}</p>`).join("")
          })
        ])
  ].join("");
  const link = `${input.publicBaseUrl.replace(/\/+$/u, "")}${patchAddress(patch)}`;
  return dialog({
    id: "share",
    title: `Share ${title}`,
    mark: patchMark(patch.name, tier),
    size: "lg",
    closeHref: input.back,
    body: `${input.receipt === undefined ? "" : receipt(input.receipt)}${warnings}${invite}${people}${access}`,
    foot: `${live ? `<span class="dialog-foot-start">${copyButton(link, { label: "Copy link", size: "sm" })}</span>` : ""}${linkButton("Close", input.back, { kind: "quiet" })}${confirming ? "" : button("Save", { kind: "primary", form: "share-access-form" })}`
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
