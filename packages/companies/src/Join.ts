import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import * as Companies from "./Companies.js";
import type { Claims } from "./Users.js";

const decodeForm = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({
      action: Schema.Literal("join"),
      inviteId: Schema.String.check(Schema.isMinLength(1))
    }),
    Schema.Struct({
      action: Schema.Literal("create"),
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      handle: Schema.String
    })
  ])
);

export interface JoinPage {
  readonly title: string;
  readonly body: string;
  readonly status?: number;
  readonly redirect?: string;
}

/** Server-side suggestion: plain forms need no client code to create a company. */
const suggestedHandle = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");

const signOut = `<form class="auth-signout" method="post" action="/logout">Not you? <button type="submit">Sign out</button></form>`;

const render = Effect.fn("Join.render")(function* (
  claims: Claims,
  returnTo: string | null,
  fields?: { readonly name: string; readonly handle: string },
  refusal?: { readonly message: string; readonly status: number }
): Effect.fn.Return<JoinPage, SqlError, Companies.Companies> {
  const companies = yield* Companies.Companies;
  const invites = yield* companies.findInvitesByEmail(claims.email);
  const action = `/join${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ""}`;
  const notice = refusal
    ? `<div class="note note-warn" role="alert">${escapeHtml(refusal.message)}</div>`
    : "";
  if (invites.length > 0) {
    const rows = yield* Effect.forEach(
      invites,
      Effect.fn(function* (invite) {
        const company = yield* companies.findById(invite.companyId);
        if (!company) return yield* Effect.die(new Error("Invited company is missing"));
        return `<form class="auth-invite" method="post" action="${escapeAttribute(action)}"><p><strong>${escapeHtml(company.name)}</strong><br>${escapeHtml(invite.role)}</p><input type="hidden" name="action" value="join"><input type="hidden" name="inviteId" value="${escapeAttribute(invite.id)}"><button class="auth-action" type="submit" aria-label="Join ${escapeAttribute(company.name)}">Join</button></form>`;
      })
    );
    return {
      title: "Join your company",
      body: `<p>Invitations for <span class="auth-email">${escapeHtml(claims.email)}</span>.</p>${notice}${rows.join("")}${signOut}`,
      status: refusal?.status
    };
  }
  const name = fields?.name ?? `${claims.name}'s company`;
  const handle = fields?.handle ?? suggestedHandle(name);
  return {
    title: "Create your company",
    body: `<p>There is no invite for <span class="auth-email">${escapeHtml(claims.email)}</span>.</p>${notice}<form method="post" action="${escapeAttribute(action)}"><input type="hidden" name="action" value="create"><label for="company-name">Company name</label><input id="company-name" name="name" value="${escapeAttribute(name)}" required maxlength="200" autocomplete="organization"><label for="company-handle">Company handle</label><input id="company-handle" name="handle" value="${escapeAttribute(handle)}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" aria-describedby="handle-hint" autocapitalize="none" spellcheck="false"><p id="handle-hint" class="auth-hint">Pre-filled from the company name and editable. 3–32 lowercase letters, digits or hyphens; no hyphen at either end. Fixed once created.</p><button class="auth-action" type="submit">Create company</button></form>${signOut}`,
    status: refusal?.status
  };
});

/** Auth supplies verified claims and membership; Companies owns the page and its transactions. */
export const handle = Effect.fn("Join.handle")(function* (
  claims: Claims,
  membership: { readonly company: { readonly name: string } } | null,
  returnTo: string | null
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (membership) {
    return {
      title: `You are in ${membership.company.name}`,
      body: `${request.method === "POST" ? '<div class="note note-warn" role="alert">Already in a company.</div>' : ""}<p>Signed in as <span class="auth-email">${escapeHtml(claims.email)}</span>.</p>${signOut}`,
      status: request.method === "POST" ? 409 : 200,
      ...(request.method !== "POST" && returnTo ? { redirect: returnTo } : {})
    } satisfies JoinPage;
  }
  if (request.method !== "POST") return yield* render(claims, returnTo);
  const fields = Object.fromEntries(yield* request.urlParamsBody);
  const entered = { name: (fields.name ?? "").trim(), handle: fields.handle ?? "" };
  const companies = yield* Companies.Companies;
  return yield* Effect.gen(function* () {
    const form = yield* decodeForm({ ...fields, name: entered.name });
    if (form.action === "join") {
      yield* companies.consumeInvite({ ...claims, inviteId: form.inviteId });
    } else {
      yield* companies.create({
        clerkUserId: claims.clerkUserId,
        email: claims.email,
        userName: claims.name,
        name: form.name,
        handle: form.handle
      });
    }
    return { title: "Company joined", body: "", redirect: returnTo ?? "/join" } satisfies JoinPage;
  }).pipe(
    Effect.catchTags({
      SchemaError: () =>
        render(claims, returnTo, entered, {
          message: "Enter a company name and a valid handle, or choose an invitation.",
          status: 422
        }),
      InvalidHandle: () =>
        render(claims, returnTo, entered, {
          message: "Use 3–32 lowercase letters, digits or hyphens, with no hyphen at either end.",
          status: 422
        }),
      ReservedHandle: () =>
        render(claims, returnTo, entered, {
          message: "This handle is reserved. Choose another.",
          status: 422
        }),
      HandleTaken: () =>
        render(claims, returnTo, entered, {
          message: "This handle is taken. Choose another.",
          status: 409
        }),
      AlreadyInCompany: () =>
        render(claims, returnTo, entered, { message: "Already in a company.", status: 409 }),
      InviteUnavailable: () =>
        render(claims, returnTo, entered, {
          message: "This invitation is no longer available.",
          status: 409
        })
    })
  );
});
