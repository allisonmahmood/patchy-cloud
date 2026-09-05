import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Companies, Users } from "@patchy/companies";
import { BodyTooLarge } from "@patchy/api";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { pageResponse, signOutForm, type Page } from "./page.js";

const styles = `
    .auth-card { overflow-wrap: anywhere; }
    .device-kicker { margin: 0 0 16px; color: var(--muted); font-size: .8rem; font-weight: 750; text-transform: uppercase; letter-spacing: .12em; }
    .device-lede { margin-bottom: 12px; }
    .auth-card .device-code { font-family: var(--font-mono); font-size: clamp(1.65rem, 7vw, 3rem); letter-spacing: .04em; white-space: nowrap; }
    .device-actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 24px 0; }
    .device-foot { margin-top: 24px; color: var(--muted); font-size: .85rem; }
    .machines-list { list-style: none; padding: 0; }
    .machine-row { padding: 20px 0; border-bottom: 1px solid var(--line-strong); }
    .machine-row h2 { margin: 0 0 12px; font-size: 1.2rem; }
    .machine-row dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; font-size: .85rem; }
    .machine-row dt { color: var(--muted); }
    .machine-row dd { margin: 0; }
    .machines-all { margin-top: 24px; }
`;

const MAX_FORM_BYTES = 4_096;

const refreshNotice =
  "Your sign-in was refreshed before that went through. Check the code and press Confirm again.";
const decodeForm = Schema.decodeUnknownEffect(
  Schema.Struct({
    code: Schema.String,
    action: Schema.Literals(["confirm", "deny"]),
    machineName: Schema.optional(Schema.String)
  })
);

const message = (title: string, body: string, status = 200): Page => ({
  title,
  body,
  status,
  styles
});

const renderConfirm = Effect.fn("DevicePages.renderConfirm")(function* (
  login: DeviceLogins.PendingLogin,
  fields?: { readonly machineName: string; readonly invalid: boolean }
) {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const now = yield* Clock.currentTimeMillis;
  const minutes = Math.max(
    1,
    Math.ceil((DateTime.toEpochMillis(DateTime.makeUnsafe(login.expiresAt)) - now) / 60_000)
  );
  const machineName = fields?.machineName ?? login.oldMachineName ?? login.machineNameHint;
  const refreshed =
    new URL(request.url, session.publicBaseUrl).searchParams.get("refreshed") === "1";
  return pageResponse(
    {
      title: "Device login",
      heading: `<p class="device-kicker">Device login</p><p class="device-lede">Is this the code on your terminal?</p><h1 class="device-code">${escapeHtml(login.userCode)}</h1>`,
      styles,
      status: fields?.invalid ? 422 : 200,
      body: `${refreshed ? `<div class="note" role="status">${refreshNotice}</div>` : ""}<p>A terminal just ran <code>patchy login</code> and wants to publish at <strong>${escapeHtml(viewer.company.name)}</strong> as ${escapeHtml(viewer.user.name)} (<code>${escapeHtml(viewer.user.email)}</code>). If the code matches, name the machine and confirm. If you didn't run it, deny: nothing happens.</p>${fields?.invalid ? '<div class="note note-warn" role="alert" id="machine-name-error">Give the machine a name, up to 64 characters.</div>' : ""}<form method="post" action="/login/device"><input type="hidden" name="code" value="${escapeAttribute(login.userCode)}"><label for="machine-name">Machine name</label><input id="machine-name" name="machineName" value="${escapeAttribute(machineName)}" aria-required="true" autocomplete="off"${fields?.invalid ? ' aria-invalid="true" aria-describedby="machine-name-error"' : ""}>${login.oldMachineName === null ? "" : `<p class="auth-hint">Replaces the key named <code>${escapeHtml(login.oldMachineName)}</code>, which stops working once your terminal finishes logging in</p>`}<div class="device-actions"><button class="auth-action" type="submit" name="action" value="confirm">Confirm</button><button class="auth-action" type="submit" name="action" value="deny">Deny</button></div></form><p class="device-foot">The code expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}. The key it makes works for 90 days, or 30 days unused, and can be revoked any time on <a href="/machines">Your machines</a>.</p>`
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
    return pageResponse(
      message(
        "Device login",
        "<p>Open the link your terminal printed. <code>patchy login</code> prints a link that carries its own code, so there is nothing to type here. If someone sent you here to type a code, don't: that is the trick the link is designed to avoid.</p>"
      ),
      session
    );
  }
  const login = yield* (yield* DeviceLogins.DeviceLogins).lookup(code, viewer.user.id);
  return yield* renderConfirm(login);
});

const postDevice = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"]) > MAX_FORM_BYTES) {
    return yield* new BodyTooLarge({ maxBytes: MAX_FORM_BYTES });
  }
  const params = yield* request.urlParamsBody.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(MAX_FORM_BYTES))
  );
  const form = yield* decodeForm(Object.fromEntries(params));
  // Only the code survives authentication/enrollment. Neither the action nor
  // the entered machine name is replayed after a session refresh.
  const returnTo = `/login/device?${new URLSearchParams({ code: form.code, refreshed: "1" })}`;
  return yield* RequireSession.withViewer(
    Effect.gen(function* () {
      const viewer = yield* RequireSession.Viewer;
      const session = yield* Session.Session;
      const logins = yield* DeviceLogins.DeviceLogins;
      const machineName = form.machineName ?? "";
      if (form.action === "confirm") {
        const valid = yield* MachineTokens.validateMachineName(machineName).pipe(
          Effect.as(true),
          Effect.catchTags({ InvalidMachineName: () => Effect.succeed(false) })
        );
        if (!valid) {
          const login = yield* logins.lookup(form.code, viewer.user.id);
          return yield* renderConfirm(login, { machineName, invalid: true });
        }
      }
      if (form.action === "deny") yield* logins.deny(form.code, viewer.user.id);
      else yield* logins.confirm({ userCode: form.code, userId: viewer.user.id, machineName });
      return pageResponse(
        form.action === "confirm"
          ? message(
              "Confirmed.",
              "<p>Your terminal finishes logging in on its own within a few seconds. You can close this tab.</p>"
            )
          : message(
              "Nothing was logged in.",
              `<p>The code ${escapeHtml(form.code)} is dead and no key was made. If you didn't run <code>patchy login</code>, there is nothing else to do.</p>`
            ),
        session
      );
    }),
    returnTo
  );
});

const machines = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const tokens = yield* (yield* MachineTokens.MachineTokens).list(viewer.user.id);
  const time = (iso: string) =>
    `<time datetime="${escapeAttribute(iso)}">${escapeHtml(iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC"))}</time>`;
  const rows = tokens.map(
    (token) =>
      `<li class="machine-row"><h2>${escapeHtml(token.name)}</h2><dl><dt>Created</dt><dd>${time(token.createdAt)}</dd><dt>Last used</dt><dd>${time(token.lastUsedAt)}</dd><dt>Expires</dt><dd>${time(token.expiresAt)}</dd></dl><form method="post" action="/machines/${encodeURIComponent(token.id)}/revoke"><button class="auth-action" type="submit" aria-label="Revoke ${escapeAttribute(token.name)}">Revoke</button></form></li>`
  );
  return pageResponse(
    message(
      "Your machines",
      `<p>Machines publishing at <strong>${escapeHtml(viewer.company.name)}</strong> as <span class="auth-email">${escapeHtml(viewer.user.email)}</span>.</p>${tokens.length === 0 ? "<p>No machines are logged in.</p>" : `<ul class="machines-list">${rows.join("")}</ul><form class="machines-all" method="post" action="/machines/revoke-all"><button class="auth-action" type="submit">Revoke all machines</button></form>`}${signOutForm()}`
    ),
    session
  );
});

const revoke = Effect.fn("DevicePages.revoke")(function* (all: boolean) {
  const viewer = yield* RequireSession.Viewer;
  const tokens = yield* MachineTokens.MachineTokens;
  if (all) yield* tokens.revokeAll(viewer.user.id);
  else {
    const params = yield* HttpRouter.params;
    yield* tokens.revokeOwned({ id: params.id ?? "", userId: viewer.user.id });
  }
  return HttpServerResponse.redirect("/machines", {
    status: 303,
    headers: { "cache-control": "private, no-store" }
  });
});

type PageError =
  | Effect.Error<typeof getDevice | typeof postDevice | typeof machines>
  | MachineTokens.MachineTokenNotFound;

const errors = <R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, PageError, R>) =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    const reply = (page: Page) => Effect.succeed(pageResponse(page, session));
    return yield* app.pipe(
      Effect.catchTags({
        DeviceLoginExpired: () =>
          reply(
            message(
              "This code has expired.",
              "<p>A login code lasts ten minutes. Run <code>patchy login</code> again on the machine and open the new link it prints.</p>",
              410
            )
          ),
        DeviceLoginAnswered: () => reply(message("This code was already used.", "", 410)),
        DeviceLoginUnknown: () =>
          reply(
            message(
              "Nothing is waiting for this code.",
              "<p>Check the link you opened, or run <code>patchy login</code> again…</p>",
              404
            )
          ),
        DeviceLoginLookupLimited: (error: DeviceLogins.DeviceLoginLookupLimited) =>
          reply(
            message(
              "Too many code lookups.",
              "<p>Wait a minute, then open the link your terminal printed again.</p>",
              429
            )
          ).pipe(
            Effect.map(HttpServerResponse.setHeader("retry-after", String(error.retryAfterSeconds)))
          ),
        MachineTokenNotFound: () =>
          reply(
            message(
              "Machine not found",
              '<p>This machine is not on <a href="/machines">Your machines</a>.</p>',
              404
            )
          ),
        BodyTooLarge: () =>
          reply(message("Invalid form", "<p>The submitted form is too large.</p>", 413)),
        InvalidMachineName: () =>
          reply(
            message("Invalid form", "<p>Give the machine a name, up to 64 characters.</p>", 422)
          ),
        SchemaError: () =>
          reply(
            message(
              "Invalid form",
              "<p>Open the link your terminal printed and submit the form again.</p>",
              400
            )
          ),
        HttpServerError: () =>
          reply(
            message("Invalid form", "<p>Open the page again and submit the form again.</p>", 400)
          ),
        SqlError: () =>
          reply(message("Machine service unavailable", "<p>Please try again.</p>", 503)),
        SessionError: () =>
          reply(message("Sign-in service unavailable", "<p>Please try again.</p>", 502))
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
      | MachineTokens.MachineTokens
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/login/device", errors(RequireSession.withViewer(getDevice)));
    yield* router.add("POST", "/login/device", errors(RequireSession.sameOrigin(postDevice)));
    yield* router.add("GET", "/machines", errors(RequireSession.withViewer(machines)));
    yield* router.add(
      "POST",
      "/machines/:id/revoke",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(revoke(false))))
    );
    yield* router.add(
      "POST",
      "/machines/revoke-all",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(revoke(true))))
    );
  })
);
