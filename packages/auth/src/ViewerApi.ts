/**
 * The viewer group: what a signed-in person's browser changes about their own use of Patchy,
 * admitted by their session and the same-origin check, as Patchy's own forms are.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  BadRequest,
  PatchyApi,
  PayloadTooLarge,
  refuse,
  ShortcutsRequest,
  ShortcutsSetting,
  capBody,
  closeAfterAnswer
} from "@patchy/api";
import { Users } from "@patchy/companies";
import * as Receipt from "./Receipt.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { pageResponse, returnPath } from "./page.js";

/** The value and a page path to land back on. */
const MAX_FORM_BYTES = 4_096;
const readForm = HttpServerRequest.schemaBodyUrlParams(ShortcutsRequest).pipe(
  capBody(MAX_FORM_BYTES)
);
const encodeSetting = Schema.encodeSync(ShortcutsSetting);
const noStore = { "cache-control": "private, no-store" };

/**
 * Stores the explicit value, then answers `{ value }` to a request asking for JSON, such as the
 * shell's, or sends a form post back to `back` with a receipt.
 */
const setShortcuts = (form: ShortcutsRequest, back: string) =>
  Effect.gen(function* () {
    const viewer = yield* RequireSession.Viewer;
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* (yield* Users.Users).setSingleKeyShortcuts({
      userId: viewer.user.id,
      on: form.value === "on"
    });
    if (request.headers.accept?.includes("application/json") === true)
      return HttpServerResponse.jsonUnsafe(
        encodeSetting(new ShortcutsSetting({ value: form.value })),
        { headers: noStore }
      );
    const session = yield* Session.Session;
    return Receipt.set(HttpServerResponse.redirect(back, { status: 303, headers: noStore }), {
      userId: viewer.user.id,
      text: `Turned ${form.value} single-key shortcuts`,
      publicBaseUrl: session.publicBaseUrl
    });
  });

/**
 * The form is read before the session, so a form post signed out goes back to its `return` page,
 * whose own door signs in there, rather than to this route, which has no page to come back to.
 * The shell's request names no page, so signed out it gets the door's 401.
 */
const readSetting = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // A declared overflow answers 413 and one that streams past the bound 400; either closes the
  // connection after the answer.
  if (Number(request.headers["content-length"]) > MAX_FORM_BYTES) {
    yield* closeAfterAnswer;
    return refuse(PayloadTooLarge, { ok: false, error: "Request body is too large." }, noStore);
  }
  const form = yield* readForm;
  const session = yield* Session.Session;
  const back = returnPath(form.return ?? null, session.publicBaseUrl) ?? "/";
  return yield* RequireSession.withoutPins(
    setShortcuts(form, back),
    form.return === undefined ? undefined : back
  );
}).pipe(
  Effect.catchTags({
    SchemaError: () =>
      Effect.succeed(
        refuse(BadRequest, { ok: false, error: "Send value=on or value=off." }, noStore)
      ),
    HttpServerError: () =>
      Effect.succeed(refuse(BadRequest, { ok: false, error: "Malformed request body." }, noStore))
  })
);

/** A sign-in or database failure is a retryable page; nothing claims the change was made. */
const route = RequireSession.sameOrigin(readSetting).pipe(
  Effect.catchTags({
    SessionError: () =>
      Effect.succeed(
        pageResponse({
          title: "Sign-in service unavailable",
          body: "<p>Please try again.</p>",
          status: 502
        })
      ),
    SqlError: () =>
      Effect.succeed(
        pageResponse({
          title: "Settings unavailable",
          body: "<p>Please try again. Nothing was changed.</p>",
          status: 503
        })
      )
  })
);

export const layer = HttpApiBuilder.group(PatchyApi, "viewer", (handlers) =>
  Effect.succeed(handlers.handleRaw("setShortcuts", () => route))
);
