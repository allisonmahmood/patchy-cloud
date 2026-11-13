import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Companies, Users } from "@patchy/companies";
import { BodyTooLarge, capBody, closeAfterAnswer } from "@patchy/api";
import {
  button,
  escapeAttribute,
  escapeHtml,
  field,
  input,
  linkButton,
  notice,
  refusal,
  verificationCode
} from "@patchy/core";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { accountFoot, doorResponse, unavailableDoor, type DoorSpec } from "./page.js";

const MAX_FORM_BYTES = 4_096;

// Each refuses what was just pressed, so the page's focus starts on it.
const refreshNotice = refusal(
  notice({
    tone: "info",
    title: "Your sign-in was refreshed before that went through.",
    body: "<p>Check the code and press Confirm again.</p>"
  })
);
const accountChangedNotice = refusal(
  notice({
    tone: "warning",
    title: "The signed-in account changed since this page loaded.",
    body: "<p>Check the account and the code, then press again.</p>"
  })
);
// userId is the account the page was rendered for; an answer only counts as that account.
const decodeForm = Schema.decodeUnknownEffect(
  Schema.Struct({
    code: Schema.String,
    userId: Schema.String,
    action: Schema.Literals(["confirm", "deny"]),
    machineName: Schema.optional(Schema.String),
    /** The Final step panel's setup link, when the form was answered there. */
    setup: Schema.optional(Schema.String.check(Schema.isMaxLength(64)))
  })
);

/** The confirmation's hidden fields: the code, the account the page was rendered for and, from the panel, its setup link. */
const answerFields = (input: {
  readonly userCode: string;
  readonly userId: string;
  readonly setupLink?: string;
}) =>
  `<input type="hidden" name="code" value="${escapeAttribute(input.userCode)}"><input type="hidden" name="userId" value="${escapeAttribute(input.userId)}">${input.setupLink === undefined ? "" : `<input type="hidden" name="setup" value="${escapeAttribute(input.setupLink)}">`}`;

/**
 * The computer's name, as Your agents will list it. Replacing a computer of the same name says
 * so: its key stops working once the terminal finishes logging in. A refused name says why under
 * the field, which takes the focus.
 */
const nameField = (input_: {
  readonly id: string;
  readonly machineName: string;
  readonly oldMachineName: string | null;
  readonly invalid?: boolean;
}) =>
  field({
    id: input_.id,
    label: "Name this computer",
    hint:
      input_.oldMachineName === null
        ? "You’ll see it on Your agents."
        : `Replaces ${input_.oldMachineName}, which stops working once your terminal finishes logging in.`,
    ...(input_.invalid === true ? { error: "Give the computer a name, up to 64 characters." } : {}),
    control: (aria) =>
      input(aria, {
        name: "machineName",
        value: input_.machineName,
        required: true,
        maxlength: 64,
        autocomplete: "off",
        autofocus: input_.invalid === true
      })
  });

/**
 * The confirmation form inside the Final step panel. It posts to the device page's own address
 * and carries the account the panel was rendered for and the panel's setup link, so the server
 * rechecks the line before answering and sends the person back Home. Deny is Not me there.
 */
export const confirmForm = (input_: {
  readonly userCode: string;
  readonly userId: string;
  readonly machineName: string;
  readonly oldMachineName: string | null;
  readonly invalid?: boolean;
  readonly setupLink: string;
}): string =>
  `<form method="post" action="/login/device" novalidate data-inline-confirm>${answerFields(input_)}${nameField({ ...input_, id: "inline-machine-name" })}<div class="actions">${button("Confirm", { kind: "primary", name: "action", value: "confirm" })}${button("Not me", { name: "action", value: "deny" })}</div></form>`;

/** Why a POST came back to the confirmation page instead of answering. */
type Refusal =
  | { readonly reason: "invalid-name"; readonly machineName: string }
  | { readonly reason: "account-changed" };

const kicker = "Device login";
const patchyLogin = "<code>patchy login</code>";

/** The device door's outcome: its title, one paragraph or two, and where to go next. */
const outcome = (title: string, body: string, status = 200, actions?: string): DoorSpec => ({
  kicker,
  title,
  body,
  status,
  ...(actions === undefined ? {} : { actions })
});

const yourAgents = linkButton("Open Your agents", "/agents", { block: true });

/**
 * The confirmation for the current viewer, the only account it can answer as: the code to compare
 * in the title's place, who is asking to publish as whom, the computer's name, Confirm and Deny,
 * and when the code expires beside who is signed in, with the way to switch.
 */
const renderConfirm = Effect.fn("DevicePages.renderConfirm")(function* (
  login: DeviceLogins.PendingLogin,
  refusal?: Refusal
) {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const now = yield* Clock.currentTimeMillis;
  const minutes = Math.max(
    1,
    Math.ceil((DateTime.toEpochMillis(DateTime.makeUnsafe(login.expiresAt)) - now) / 60_000)
  );
  const invalid = refusal?.reason === "invalid-name";
  const machineName = invalid
    ? refusal.machineName
    : (login.oldMachineName ?? login.machineNameHint);
  const shownNotice =
    refusal?.reason === "account-changed"
      ? accountChangedNotice
      : new URL(request.url, session.publicBaseUrl).searchParams.get("refreshed") === "1"
        ? refreshNotice
        : "";
  const here = `/login/device?${new URLSearchParams({ code: login.userCode })}`;
  return doorResponse(
    {
      kicker,
      title: "Is this the code in your terminal?",
      body: `${shownNotice}${verificationCode(login.userCode)}<p>A terminal ran ${patchyLogin} and wants to publish at <span class="strong">${escapeHtml(viewer.company.name)}</span> as <span class="strong">${escapeHtml(viewer.user.name)}</span>. If you didn’t run it, deny: nothing happens.</p><form id="device-confirm" method="post" action="/login/device" novalidate>${answerFields({ userCode: login.userCode, userId: viewer.user.id })}${nameField({ id: "machine-name", machineName, oldMachineName: login.oldMachineName, invalid })}</form>`,
      actions: `${button("Confirm", { kind: "primary", block: true, name: "action", value: "confirm", form: "device-confirm" })}${button("Deny", { kind: "quiet", block: true, name: "action", value: "deny", form: "device-confirm" })}`,
      foot: accountFoot(viewer.user.email, {
        label: "Not you?",
        returnTo: here,
        before: `Expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"} · `
      }),
      status: refusal === undefined ? 200 : invalid ? 422 : 409
    },
    session
  );
});

const getDevice = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* Session.Session;
  const viewer = yield* RequireSession.Viewer;
  const query = new URL(request.url, session.publicBaseUrl).searchParams;
  const code = query.get("code");
  if (code === null) {
    return doorResponse(
      outcome(
        "Open the link your terminal printed",
        `<p>${patchyLogin} prints a link that carries its own code, so there is nothing to type here. If someone sent you here to type a code, don’t: that is the trick the link is designed to avoid.</p>`
      ),
      session
    );
  }
  const login = yield* (yield* DeviceLogins.DeviceLogins).lookup(code, viewer.user.id);
  return yield* renderConfirm(login);
});

const home = HttpServerResponse.redirect("/", {
  status: 303,
  headers: { "cache-control": "private, no-store" }
});

/**
 * An answer from the Final step panel. The server, not the page, decides: the line must still be
 * the person's, live, uncontested and bound to this login. Whatever happens, the person goes back
 * Home, where the panel shows where things stand; a refreshed sign-in replays nothing.
 */
const postInline = Effect.fn("DevicePages.postInline")(function* (form: {
  readonly code: string;
  readonly userId: string;
  readonly action: "confirm" | "deny";
  readonly machineName?: string;
  readonly setup: string;
}) {
  return yield* RequireSession.withoutPins(
    Effect.gen(function* () {
      const viewer = yield* RequireSession.Viewer;
      const session = yield* Session.Session;
      const logins = yield* DeviceLogins.DeviceLogins;
      if (form.userId !== viewer.user.id) return home;
      if (form.action === "confirm") {
        yield* logins.confirmInline({
          userCode: form.code,
          userId: viewer.user.id,
          machineName: form.machineName ?? "",
          setupLink: form.setup
        });
        return home;
      }
      const ended = yield* logins.denyInline({
        userCode: form.code,
        userId: viewer.user.id,
        setupLink: form.setup
      });
      return ended === "connected"
        ? doorResponse(
            outcome(
              "That computer is already connected",
              "<p>It finished logging in before you pressed Not me. Disconnect it on Your agents.</p>",
              409,
              yourAgents
            ),
            session
          )
        : home;
    }).pipe(
      Effect.catchTags({
        DeviceLoginExpired: () => Effect.succeed(home),
        DeviceLoginAnswered: () => Effect.succeed(home),
        DeviceLoginUnknown: () => Effect.succeed(home),
        SetupLineChanged: () => Effect.succeed(home),
        InvalidMachineName: () => Effect.succeed(home)
      })
    ),
    "/"
  );
});

const postDevice = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"]) > MAX_FORM_BYTES) {
    yield* closeAfterAnswer;
    return yield* new BodyTooLarge({ maxBytes: MAX_FORM_BYTES });
  }
  const params = yield* request.urlParamsBody.pipe(capBody(MAX_FORM_BYTES));
  const form = yield* decodeForm(Object.fromEntries(params));
  if (form.setup !== undefined) return yield* postInline({ ...form, setup: form.setup });
  // Only the code survives authentication/enrollment. Neither the action nor
  // the entered machine name is replayed after a session refresh.
  const returnTo = `/login/device?${new URLSearchParams({ code: form.code, refreshed: "1" })}`;
  return yield* RequireSession.withoutPins(
    Effect.gen(function* () {
      const viewer = yield* RequireSession.Viewer;
      const session = yield* Session.Session;
      const logins = yield* DeviceLogins.DeviceLogins;
      // A page left open across an account switch must not answer as the new account.
      if (form.userId !== viewer.user.id) {
        const login = yield* logins.lookup(form.code, viewer.user.id);
        return yield* renderConfirm(login, { reason: "account-changed" });
      }
      const machineName = form.machineName ?? "";
      if (form.action === "confirm") {
        const valid = yield* MachineTokens.validateMachineName(machineName).pipe(
          Effect.as(true),
          Effect.catchTags({ InvalidMachineName: () => Effect.succeed(false) })
        );
        if (!valid) {
          const login = yield* logins.lookup(form.code, viewer.user.id);
          return yield* renderConfirm(login, { reason: "invalid-name", machineName });
        }
      }
      if (form.action === "deny") yield* logins.deny(form.code, viewer.user.id);
      else yield* logins.confirm({ userCode: form.code, userId: viewer.user.id, machineName });
      // Confirmed is not connected: the computer is connected once its terminal collects the key.
      return doorResponse(
        form.action === "confirm"
          ? {
              ...outcome(
                "Go back to your terminal",
                `<p>Your agent finishes connecting <span class="strong">${escapeHtml(machineName.trim())}</span>. It shows up on Your agents as soon as it does.</p>`,
                200,
                yourAgents
              ),
              foot: "You can close this tab."
            }
          : outcome(
              "Nothing was logged in",
              `<p>The code ${escapeHtml(form.code)} no longer works and no key was made. If you didn’t run ${patchyLogin}, there’s nothing else to do.</p>`
            ),
        session
      );
    }),
    returnTo
  );
});

type PageError = Effect.Error<typeof getDevice | typeof postDevice>;

const errors = <R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, PageError, R>) =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    const reply = (door: DoorSpec) => Effect.succeed(doorResponse(door, session));
    const invalidForm = (body: string, status: number) =>
      reply({ title: "Invalid form", body: `<p>${body}</p>`, status });
    return yield* app.pipe(
      Effect.catchTags({
        DeviceLoginExpired: () =>
          reply(
            outcome(
              "This code has expired",
              `<p>A login code lasts ten minutes. Run ${patchyLogin} again on the computer and open the new link it prints.</p>`,
              410
            )
          ),
        DeviceLoginAnswered: () =>
          reply(
            outcome(
              "This code was already used",
              `<p>Each code is answered once. If your terminal is still waiting, run ${patchyLogin} again.</p>`,
              410
            )
          ),
        DeviceLoginUnknown: () =>
          reply(
            outcome(
              "Nothing is waiting for this code",
              `<p>Check the link you opened, or run ${patchyLogin} again.</p>`,
              404
            )
          ),
        DeviceLoginLookupLimited: (error: DeviceLogins.DeviceLoginLookupLimited) =>
          reply(
            outcome(
              "Too many code lookups",
              "<p>Wait a minute, then open the link your terminal printed again.</p>",
              429
            )
          ).pipe(
            Effect.map(HttpServerResponse.setHeader("retry-after", String(error.retryAfterSeconds)))
          ),
        BodyTooLarge: () => invalidForm("The submitted form is too large.", 413),
        InvalidMachineName: () =>
          invalidForm("Give the computer a name, up to 64 characters.", 422),
        SchemaError: () =>
          invalidForm("Open the link your terminal printed and submit the form again.", 400),
        HttpServerError: () => invalidForm("Open the page again and submit the form again.", 400),
        SqlError: () => Effect.succeed(unavailableDoor("patchy", {}, session)),
        SessionError: () => Effect.succeed(unavailableDoor("sign-in", {}, session))
      })
    );
  });

export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      | Session.Session
      | Companies.Companies
      | Users.Users
      | SqlClient.SqlClient
      | DeviceLogins.DeviceLogins
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/login/device", errors(RequireSession.withoutPins(getDevice)));
    yield* router.add("POST", "/login/device", errors(RequireSession.sameOrigin(postDevice)));
  })
);
