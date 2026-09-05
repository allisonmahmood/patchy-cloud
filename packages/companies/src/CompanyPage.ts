import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import * as Companies from "./Companies.js";
import * as Invitations from "./Invitations.js";
import * as Users from "./Users.js";

interface Viewer {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly company: { readonly id: string; readonly handle: string; readonly name: string };
  readonly role: Users.Role;
}
export type Action =
  | { readonly kind: "view" | "invite" }
  | {
      readonly kind: "revoke" | "resend" | "role" | "deactivate" | "reactivate";
      readonly id: string;
    };

const decodeInvite = Schema.decodeUnknownEffect(
  Schema.Struct({
    email: Schema.String.check(
      Schema.isMaxLength(254),
      Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
    ),
    role: Users.Role
  })
);

export interface Page {
  readonly title: string;
  readonly body: string;
  readonly status?: number;
  readonly redirect?: string;
}
const decodeRole = Schema.decodeUnknownEffect(Schema.Struct({ role: Users.Role }));

export const styles = `
    .auth-card { width: min(800px, calc(100% - 32px)); }
    .company-section { margin-top: 32px; }
    .company-list { list-style: none; padding: 0; }
    .company-row { padding: 20px 0; border-bottom: 1px solid var(--line-strong); overflow-wrap: anywhere; }
    .company-row p { margin: 0 0 8px; }
    .company-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .company-invite button { margin-top: 20px; }
`;

const actionForm = (path: string, label: string, fields = "") =>
  `<form method="post" action="${escapeAttribute(path)}">${fields}<button class="auth-action" type="submit">${escapeHtml(label)}</button></form>`;

const render = Effect.fn("CompanyPage.render")(function* (
  viewer: Viewer,
  refusal?: { readonly message: string; readonly status: number }
): Effect.fn.Return<Page, SqlError, Users.Users | Companies.Companies> {
  const users = yield* (yield* Users.Users).list(viewer.company.id);
  const invites = yield* (yield* Companies.Companies).listInvites(viewer.company.id);
  const admin = viewer.role === "admin";
  const userRows = users.map((user) => {
    const path = `/company/users/${encodeURIComponent(user.id)}`;
    const role = user.role === "admin" ? "member" : "admin";
    const actions = admin
      ? `<div class="company-actions">${actionForm(`${path}/role`, role === "admin" ? "Promote to admin" : "Demote to member", `<input type="hidden" name="role" value="${role}">`)}${user.deactivatedAt ? actionForm(`${path}/reactivate`, "Reactivate") : user.id !== viewer.user.id ? actionForm(`${path}/deactivate`, "Deactivate") : ""}</div>`
      : "";
    return `<li class="company-row"><p><strong>${escapeHtml(user.name)}</strong><br><span class="auth-email">${escapeHtml(user.email)}</span></p><p>${user.role === "admin" ? "Admin" : "Member"} · ${user.deactivatedAt ? "Deactivated" : "Active"}${user.id === viewer.user.id ? " · You" : ""}</p>${actions}</li>`;
  });
  const inviteRows = invites.map((invite) => {
    const path = `/company/invites/${encodeURIComponent(invite.id)}`;
    return `<li class="company-row"><p><span class="auth-email">${escapeHtml(invite.email)}</span><br>${invite.role === "admin" ? "Admin" : "Member"} · Pending</p>${invite.clerkInvitationId === null ? '<p class="auth-hint">Invitation saved, but the email did not go out. An admin can resend it.</p>' : ""}${admin ? `<div class="company-actions">${actionForm(`${path}/resend`, "Resend invite")}${actionForm(`${path}/revoke`, "Revoke invite")}</div>` : ""}</li>`;
  });
  const notice = refusal
    ? `<div class="note note-warn" role="alert">${escapeHtml(refusal.message)}</div>`
    : "";
  return {
    title: viewer.company.name,
    body: `<p>Company · ${escapeHtml(viewer.company.handle)}</p>${notice}<section class="company-section" aria-labelledby="company-users"><h2 id="company-users">Users</h2><ul class="company-list">${userRows.join("")}</ul></section><section class="company-section" aria-labelledby="company-invites"><h2 id="company-invites">Pending invites</h2>${invites.length ? `<ul class="company-list">${inviteRows.join("")}</ul>` : "<p>No pending invites.</p>"}</section>${admin ? '<section class="company-section" aria-labelledby="company-invite"><h2 id="company-invite">Invite a user</h2><form class="company-invite" method="post" action="/company/invites"><label for="invite-email">Email</label><input id="invite-email" type="email" name="email" required maxlength="254" autocomplete="email"><label for="invite-role">Role</label><select id="invite-role" name="role"><option value="member">Member</option><option value="admin">Admin</option></select><button class="auth-action" type="submit">Send invite</button></form></section>' : ""}`,
    status: refusal?.status
  };
});

/** Auth supplies the viewer; Companies owns the forms and their company-scoped actions. */
export const handle = Effect.fn("CompanyPage.handle")(function* (viewer: Viewer, action: Action) {
  if (action.kind === "view") return yield* render(viewer);
  if (viewer.role !== "admin") {
    return yield* render(viewer, {
      message: "Only an admin can manage this company.",
      status: 403
    });
  }
  return yield* Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const users = yield* Users.Users;
    let mailFailed = false;
    if (action.kind === "invite") {
      const fields = Object.fromEntries(yield* request.urlParamsBody);
      const form = yield* decodeInvite({ ...fields, email: fields.email?.trim() });
      const result = yield* Invitations.create({
        ...form,
        companyId: viewer.company.id,
        invitedBy: viewer.user.id
      });
      mailFailed = result.mailFailed;
    } else if (action.kind === "revoke" || action.kind === "resend") {
      const input = { companyId: viewer.company.id, inviteId: action.id };
      const result = yield* action.kind === "revoke"
        ? Invitations.revoke(input)
        : Invitations.resend(input);
      mailFailed = result.mailFailed;
    } else if (action.kind === "role") {
      const form = yield* decodeRole(Object.fromEntries(yield* request.urlParamsBody));
      yield* users.setRole({ companyId: viewer.company.id, userId: action.id, role: form.role });
    } else if (action.kind === "deactivate") {
      yield* users.deactivate({ companyId: viewer.company.id, userId: action.id });
    } else if (action.kind === "reactivate") {
      yield* users.reactivate({ companyId: viewer.company.id, userId: action.id });
    }
    if (mailFailed) {
      return yield* render(viewer, {
        message:
          action.kind === "revoke"
            ? "Invitation revoked in Patchy, but Clerk could not revoke the emailed link. It can no longer be used to join this company."
            : "Invitation saved, but the email did not go out. Resend it to try again.",
        status: 502
      });
    }
    return { title: viewer.company.name, body: "", redirect: "/company" };
  }).pipe(
    Effect.catchTags({
      SchemaError: () =>
        render(viewer, { message: "Enter a valid email and choose Member or Admin.", status: 422 }),
      AlreadyInCompany: (error) => render(viewer, { message: error.message, status: 409 }),
      AlreadyInvited: (error) => render(viewer, { message: error.message, status: 409 }),
      InviteUnavailable: (error) => render(viewer, { message: error.message, status: 404 }),
      CompanyNotFound: (error) => render(viewer, { message: error.message, status: 404 }),
      UserNotFound: (error) => render(viewer, { message: error.message, status: 404 }),
      LastAdmin: (error) => render(viewer, { message: error.message, status: 409 })
    })
  );
});
