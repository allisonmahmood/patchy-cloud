import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type { SqlError } from "effect/sql/SqlError";
import { Analytics } from "@patchy/analytics";
import { capBody } from "@patchy/api";
import {
  button,
  doorPage,
  escapeAttribute,
  escapeHtml,
  field,
  idFor,
  input,
  linkButton,
  notice,
  prefixInput,
  refusal as pageRefusal,
  row,
  rows
} from "@patchy/core";
import { withReportedCommit } from "@patchy/sql";
import * as Companies from "./Companies.js";
import * as Users from "./Users.js";
import { displayName, type Claims } from "./Users.js";

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

/**
 * The door's two forms: an invitation's id, or a company's name (200 characters, up to 12 bytes
 * each once percent-encoded) and its handle.
 */
const MAX_FORM_BYTES = 4_096;

/** The door, as `doorPage` draws it, or where to go instead. */
export interface JoinPage {
  readonly title: string;
  readonly heading?: string;
  readonly body: string;
  readonly status?: number;
  readonly redirect?: string;
}

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

/** Where the form posts back to, the instance whose address the handle opens, and the door's foot. */
export interface Door {
  readonly returnTo: string | null;
  readonly publicBaseUrl: string;
  /** Trusted HTML: who is signed in and the way out, which Auth draws. */
  readonly foot: string;
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

/** Names the first rule a refused handle breaks, in `Companies.Handle`'s order, and offers a fix only if it is free. */
const handleRefusal = Effect.fn("Join.handleRefusal")(function* (handle: string) {
  const companies = yield* Companies.Companies;
  const fix = suggestedHandle(handle);
  const offer =
    fix !== handle &&
    Companies.isHandle(fix) &&
    !Companies.RESERVED_HANDLES.includes(fix) &&
    !(yield* companies.isHandleTaken(fix))
      ? { suggestion: fix }
      : {};
  const title =
    handle.length === 0
      ? "Choose an address"
      : /[A-Z]/.test(handle) && !/[^A-Za-z0-9-]/.test(handle)
        ? "Addresses are lowercase"
        : /[^a-z0-9-]/.test(handle)
          ? "Use only lowercase letters, digits and hyphens"
          : handle.length < 3
            ? "Use at least 3 characters"
            : handle.length > 32
              ? "Use at most 32 characters"
              : "Start and end with a letter or digit";
  return { status: 422, field: "handle", title, ...offer } satisfies FieldRefusal;
});

const nameRefusal = (name: string): FieldRefusal | undefined =>
  name.length === 0
    ? { status: 422, field: "name", title: "Enter a company name" }
    : name.length > 200
      ? { status: 422, field: "name", title: "Use at most 200 characters" }
      : undefined;

/** A field's refusal in one line: what is wrong, why, and a free fix when there is one. */
const fieldError = (refusal: FieldRefusal) =>
  [
    `${refusal.title}.`,
    refusal.detail,
    refusal.suggestion === undefined ? undefined : `Try ${refusal.suggestion}.`
  ]
    .filter((part) => part !== undefined)
    .join(" ");

const render = Effect.fn("Join.render")(function* (
  claims: Claims,
  door: Door,
  fields?: { readonly name: string; readonly handle: string },
  refusal?: Refusal
): Effect.fn.Return<JoinPage, SqlError, Companies.Companies | Users.Users> {
  const companies = yield* Companies.Companies;
  const invites = yield* companies.findInvitesByEmail(claims.email);
  const action = `/join${door.returnTo ? `?return=${encodeURIComponent(door.returnTo)}` : ""}`;
  const fieldRefusal = refusal !== undefined && "field" in refusal ? refusal : undefined;
  // A refusal no field owns sits above the button it refused, and the page's focus starts on it.
  const refused =
    refusal === undefined || fieldRefusal !== undefined
      ? ""
      : pageRefusal(
          notice({ tone: "danger", title: "message" in refusal ? refusal.message : refusal.title })
        );
  const email = `<span class="strong">${escapeHtml(claims.email)}</span>`;
  if (invites.length > 0) {
    const inviters = yield* (yield* Users.Users).names(invites.map((invite) => invite.invitedBy));
    const offers = yield* Effect.forEach(
      invites,
      Effect.fn(function* (invite) {
        const company = yield* companies.findById(invite.companyId);
        if (!company) return yield* Effect.die(new Error("Invited company is missing"));
        return { invite, company, inviter: inviters.get(invite.invitedBy) };
      })
    );
    const joinForm = (inviteId: string, id: string) =>
      `<form id="${escapeAttribute(id)}" method="post" action="${escapeAttribute(action)}"><input type="hidden" name="action" value="join"><input type="hidden" name="inviteId" value="${escapeAttribute(inviteId)}"></form>`;
    const role = (invite: Companies.Invite) => (invite.role === "admin" ? "an admin" : "a member");
    const [only] = offers;
    if (offers.length === 1 && only !== undefined) {
      const by = only.inviter === undefined ? "" : `${escapeHtml(only.inviter)} invited `;
      return {
        title: `Join ${only.company.name}`,
        ...doorPage({
          kicker: "Invitation",
          title: `Join ${only.company.name}`,
          body: `<p>${by === "" ? `${email} is invited` : `${by}${email}`} as ${role(only.invite)}.</p>${joinForm(only.invite.id, "join-invite")}${refused}`,
          actions: button(`Join ${only.company.name}`, {
            kind: "primary",
            block: true,
            form: "join-invite"
          }),
          foot: door.foot
        }),
        status: refusal?.status
      };
    }
    const items = offers.map(({ invite, company, inviter }) =>
      row({
        name: company.name,
        description: `As ${role(invite)}${inviter === undefined ? "" : `, from ${inviter}`}`,
        end: `${joinForm(invite.id, idFor("join", invite.id))}${button("Join", { size: "sm", form: idFor("join", invite.id), ariaLabel: `Join ${company.name}` })}`
      })
    );
    return {
      title: "Join your company",
      ...doorPage({
        kicker: "Invitation",
        title: "Join your company",
        body: `<p>Invitations for ${email}.</p>${refused}${rows(items, true)}`,
        foot: door.foot
      }),
      status: refusal?.status
    };
  }
  const name = fields?.name ?? `${displayName(claims)}'s company`;
  const handle = fields?.handle ?? suggestedHandle(name);
  const nameAt = fieldRefusal?.field === "name" ? fieldRefusal : undefined;
  const handleAt = fieldRefusal?.field === "handle" ? fieldRefusal : undefined;
  // The handle sits under the address it opens. Patchy names a broken rule on submit, so the form
  // is novalidate and never blocked by the browser's bubble.
  const address = `${new URL(door.publicBaseUrl).host}/`;
  const nameField = field({
    id: "company-name",
    label: "Company name",
    ...(nameAt === undefined ? {} : { error: fieldError(nameAt) }),
    control: (aria) =>
      input(aria, {
        name: "name",
        value: name,
        required: true,
        maxlength: 200,
        autocomplete: "organization",
        autofocus: nameAt !== undefined
      })
  });
  const handleField = field({
    id: "company-handle",
    label: "Address",
    hint: "Lowercase letters, digits and hyphens, 3–32 characters. It can’t change later.",
    ...(handleAt === undefined ? {} : { error: fieldError(handleAt) }),
    control: (aria) =>
      prefixInput(aria, {
        name: "handle",
        prefix: address,
        value: handle,
        required: true,
        maxlength: 32,
        pattern: "[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]",
        autocomplete: "off",
        exact: true,
        autofocus: handleAt !== undefined
      })
  });
  return {
    title: "Create your company",
    ...doorPage({
      title: "Create your company",
      body: `<p>No invitation is waiting for ${email}.</p><form id="create-company" method="post" action="${escapeAttribute(action)}" novalidate><input type="hidden" name="action" value="create"><div class="fields">${nameField}${handleField}</div></form>${refused}`,
      actions: button("Create company", { kind: "primary", block: true, form: "create-company" }),
      foot: door.foot
    }),
    status: refusal?.status
  };
});

/**
 * Auth supplies verified claims and membership; Companies owns the page and its transactions.
 * `suggestedName` replaces the "<name>'s company" the create form otherwise starts with, such as
 * the name a beta link was made for; the person can still change it.
 */
export const handle = Effect.fn("Join.handle")(function* (
  claims: Claims,
  membership: { readonly company: { readonly name: string } } | null,
  door: Door,
  suggestedName?: string
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (membership) {
    const title = `You are in ${membership.company.name}`;
    return {
      title,
      ...doorPage({
        title,
        body: `${request.method === "POST" ? pageRefusal(notice({ tone: "danger", title: "Already in a company." })) : ""}<p>You can be in one company at a time.</p>`,
        actions: linkButton(`Go to ${membership.company.name}`, "/", {
          kind: "primary",
          block: true
        }),
        foot: door.foot
      }),
      status: request.method === "POST" ? 409 : 200,
      ...(request.method !== "POST" ? { redirect: door.returnTo ?? "/settings/people" } : {})
    } satisfies JoinPage;
  }
  if (request.method !== "POST")
    return yield* render(
      claims,
      door,
      suggestedName === undefined
        ? undefined
        : { name: suggestedName, handle: suggestedHandle(suggestedName) }
    );
  const fields = Object.fromEntries(
    new URLSearchParams(yield* request.text.pipe(capBody(MAX_FORM_BYTES)))
  );
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
      redirect: door.returnTo ?? "/settings/people"
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
      InvalidHandle: () =>
        Effect.flatMap(handleRefusal(entered.handle), (refusal) =>
          render(claims, door, entered, refusal)
        ),
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
