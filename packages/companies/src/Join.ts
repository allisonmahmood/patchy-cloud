import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type { SqlError } from "effect/sql/SqlError";
import { Analytics } from "@patchy/analytics";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import { withReportedCommit } from "@patchy/sql";
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

export const styles = `
    .join-invite { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
`;

/** Server-side suggestion, for the first render and for a refused handle: plain forms run no client code. */
const suggestedHandle = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");

/** Where the form posts back to, and the instance whose address the handle opens. */
export interface Door {
  readonly returnTo: string | null;
  readonly publicBaseUrl: string;
}

type FieldRefusal = {
  readonly status: number;
  readonly field: "name" | "handle";
  readonly title: string;
  readonly detail?: string;
  readonly suggestion?: string;
};

/** A refusal sits under the field at fault, or above the form when no field is. */
type Refusal = { readonly status: number; readonly message: string } | FieldRefusal;

/** Names the first rule a refused handle breaks; the order mirrors `Companies.Handle`. */
const handleRefusal = (handle: string): FieldRefusal => {
  const suggestion = suggestedHandle(handle);
  const offer =
    Companies.isHandle(suggestion) &&
    !Companies.RESERVED_HANDLES.includes(suggestion) &&
    suggestion !== handle
      ? { suggestion }
      : {};
  const title =
    handle.length === 0
      ? "Choose a handle"
      : /[A-Z]/.test(handle) && !/[^A-Za-z0-9-]/.test(handle)
        ? "Handles are lowercase"
        : /[^a-z0-9-]/.test(handle)
          ? "Use only lowercase letters, digits and hyphens"
          : handle.length < 3
            ? "Use at least 3 characters"
            : handle.length > 32
              ? "Use at most 32 characters"
              : "Start and end with a letter or digit";
  return { status: 422, field: "handle", title, ...offer };
};

const nameRefusal = (name: string): FieldRefusal | undefined =>
  name.length === 0
    ? { status: 422, field: "name", title: "Enter a company name" }
    : name.length > 200
      ? { status: 422, field: "name", title: "Use at most 200 characters" }
      : undefined;

const callout = (id: string, refusal: FieldRefusal) => {
  const detail = [
    refusal.detail === undefined ? "" : escapeHtml(refusal.detail),
    refusal.suggestion === undefined
      ? ""
      : `Try <strong>${escapeHtml(refusal.suggestion)}</strong>.`
  ].filter(Boolean);
  return `<div class="note note-refused field-callout" id="${id}" role="alert"><strong class="note-title">${escapeHtml(refusal.title)}</strong>${detail.join(" ")}</div>`;
};

/** The attributes that mark a field as the one at fault, and land the cursor in it. */
const faulted = (id: string) => ` aria-describedby="${id}-error" aria-invalid="true" autofocus`;

const render = Effect.fn("Join.render")(function* (
  claims: Claims,
  door: Door,
  fields?: { readonly name: string; readonly handle: string },
  refusal?: Refusal
): Effect.fn.Return<JoinPage, SqlError, Companies.Companies> {
  const companies = yield* Companies.Companies;
  const invites = yield* companies.findInvitesByEmail(claims.email);
  const action = `/join${door.returnTo ? `?return=${encodeURIComponent(door.returnTo)}` : ""}`;
  const fieldRefusal = refusal !== undefined && "field" in refusal ? refusal : undefined;
  const notice = refusal
    ? `<div class="note note-warn" role="alert">${escapeHtml("message" in refusal ? refusal.message : refusal.title)}</div>`
    : "";
  if (invites.length > 0) {
    const rows = yield* Effect.forEach(
      invites,
      Effect.fn(function* (invite) {
        const company = yield* companies.findById(invite.companyId);
        if (!company) return yield* Effect.die(new Error("Invited company is missing"));
        return `<form class="list-row join-invite" method="post" action="${escapeAttribute(action)}"><p><strong>${escapeHtml(company.name)}</strong><br>${escapeHtml(invite.role)}</p><input type="hidden" name="action" value="join"><input type="hidden" name="inviteId" value="${escapeAttribute(invite.id)}"><button class="btn btn-primary" type="submit" aria-label="Join ${escapeAttribute(company.name)}">Join</button></form>`;
      })
    );
    return {
      title: "Join your company",
      body: `<p>Invitations for <span class="auth-email">${escapeHtml(claims.email)}</span>.</p>${notice}<div class="list">${rows.join("")}</div>`,
      status: refusal?.status
    };
  }
  const name = fields?.name ?? `${claims.name}'s company`;
  const handle = fields?.handle ?? suggestedHandle(name);
  const nameAt = fieldRefusal?.field === "name" ? fieldRefusal : undefined;
  const handleAt = fieldRefusal?.field === "handle" ? fieldRefusal : undefined;
  // The handle sits under the address it opens. The browser flags a broken rule while it is typed (field-rule);
  // Patchy names the rule on submit, so the form is novalidate and never blocked by the browser's bubble.
  const address = `${new URL(door.publicBaseUrl).host}/`;
  return {
    title: "Create your company",
    body: `<p>There is no invite for <span class="auth-email">${escapeHtml(claims.email)}</span>.</p>${fieldRefusal ? "" : notice}<form method="post" action="${escapeAttribute(action)}" novalidate><input type="hidden" name="action" value="create"><label class="field-label" for="company-name">Company name</label><input class="field" id="company-name" name="name" value="${escapeAttribute(name)}" required maxlength="200" autocomplete="organization"${nameAt ? faulted("company-name") : ""}>${nameAt ? callout("company-name-error", nameAt) : ""}<label class="field-label" for="company-handle">Company handle</label><div class="field field-group"><label class="field-prefix" for="company-handle">${escapeHtml(address)}</label><input id="company-handle" name="handle" value="${escapeAttribute(handle)}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocapitalize="none" autocomplete="off" spellcheck="false"${handleAt ? faulted("company-handle") : ' aria-describedby="company-handle-hint"'}></div>${handleAt ? callout("company-handle-error", handleAt) : `<p id="company-handle-hint" class="field-hint field-rule">Lowercase letters, digits and hyphens, 3–32 characters. Can't be changed later.</p>`}<div class="actions"><button class="btn btn-primary" type="submit">Create company</button></div></form>`,
    status: refusal?.status
  };
});

/** Auth supplies verified claims and membership; Companies owns the page and its transactions. */
export const handle = Effect.fn("Join.handle")(function* (
  claims: Claims,
  membership: { readonly company: { readonly name: string } } | null,
  door: Door
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (membership) {
    return {
      title: `You are in ${membership.company.name}`,
      body: `${request.method === "POST" ? '<div class="note note-warn" role="alert">Already in a company.</div>' : ""}<p>Signed in as <span class="auth-email">${escapeHtml(claims.email)}</span>.</p>`,
      status: request.method === "POST" ? 409 : 200,
      ...(request.method !== "POST" ? { redirect: door.returnTo ?? "/company" } : {})
    } satisfies JoinPage;
  }
  if (request.method !== "POST") return yield* render(claims, door);
  const fields = Object.fromEntries(yield* request.urlParamsBody);
  const entered = { name: (fields.name ?? "").trim(), handle: fields.handle ?? "" };
  const companies = yield* Companies.Companies;
  const analytics = yield* Analytics.Analytics;
  return yield* Effect.gen(function* () {
    const form = yield* decodeForm({ ...fields, name: entered.name });
    // Each change reports with its commit; a refusal or rollback reports nothing.
    if (form.action === "join") {
      yield* withReportedCommit(
        companies.consumeInvite({ ...claims, inviteId: form.inviteId }),
        (user) =>
          analytics.track({
            name: "user.joined",
            principalId: user.id,
            companyId: user.companyId,
            properties: { via: "invite", role: user.role, inviteId: form.inviteId }
          })
      );
    } else {
      if ((yield* companies.findInvitesByEmail(claims.email)).length > 0) {
        return yield* render(claims, door, entered, {
          message: "You have an invitation. Choose a company to join below.",
          status: 409
        });
      }
      const created = companies.create({
        clerkUserId: claims.clerkUserId,
        email: claims.email,
        userName: claims.name,
        name: form.name,
        handle: form.handle
      });
      yield* withReportedCommit(created, ({ company, user }) => {
        const joined = { principalId: user.id, companyId: company.id };
        return Effect.andThen(
          analytics.track({ name: "company.created", ...joined, properties: {} }),
          analytics.track({
            name: "user.joined",
            ...joined,
            properties: { via: "create", role: user.role }
          })
        );
      });
    }
    return {
      title: "Company joined",
      body: "",
      redirect: door.returnTo ?? "/company"
    } satisfies JoinPage;
  }).pipe(
    Effect.catchTags({
      SchemaError: () =>
        render(
          claims,
          door,
          entered,
          (fields.action === "create" ? nameRefusal(entered.name) : undefined) ?? {
            message: "Enter a company name and a valid handle, or choose an invitation.",
            status: 422
          }
        ),
      InvalidHandle: () => render(claims, door, entered, handleRefusal(entered.handle)),
      ReservedHandle: () =>
        render(claims, door, entered, {
          status: 422,
          field: "handle",
          title: `${entered.handle} is reserved`,
          detail: "Patchy uses this name. Choose another."
        }),
      HandleTaken: () =>
        render(claims, door, entered, {
          status: 409,
          field: "handle",
          title: `${entered.handle} is taken`,
          detail: "Another company already has it. Choose another."
        }),
      AlreadyInCompany: () =>
        render(claims, door, entered, { message: "Already in a company.", status: 409 }),
      InviteUnavailable: () =>
        render(claims, door, entered, {
          message: "This invitation is no longer available.",
          status: 409
        })
    })
  );
});
