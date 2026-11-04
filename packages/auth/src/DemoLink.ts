/**
 * The demo link: one address that signs whoever opens it in as one account, for people who
 * can't be invited by email because nobody knows who they will be, such as an application's
 * reviewers. `PATCHY_DEMO_LINK` is `<sha-256 hex of the link's secret>:<Clerk user id>:<day>`;
 * the link is `/signin/<secret>`, and it works until the start of that `YYYY-MM-DD` day in UTC.
 * Unset or empty, there is no link. The secret itself is never configured, only its digest.
 *
 * Each visit mints its own minute-long Clerk sign-in token, because Clerk accepts a token once,
 * and sends the browser to Clerk's sign-in page with it, which signs the account in and returns
 * to Patchy. Any other secret, and the right one after its day, gets the given not-found page.
 */
import { createClerkClient } from "@clerk/backend";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Analytics } from "@patchy/analytics";
import { Users } from "@patchy/companies";
import { Cryptography } from "@patchy/core";
import * as Session from "./Session.js";
import { pageResponse } from "./page.js";

export class DemoLinkTokenFailed extends Schema.TaggedError<DemoLinkTokenFailed>()(
  "DemoLinkTokenFailed",
  { cause: Schema.Defect() }
) {
  override get message() {
    return "Clerk did not create the demo link's sign-in token.";
  }
}

/** Long enough to follow the redirect; Clerk accepts the token once either way. */
const TOKEN_SECONDS = 60;

const SETTING = /^([0-9a-f]{64}):(user_[A-Za-z0-9]+):(\d{4}-\d{2}-\d{2})$/;

/** When a `YYYY-MM-DD` day starts in UTC, or None for a day the calendar lacks, such as 02-30. */
const dayStart = (day: string) =>
  DateTime.make(day).pipe(
    Option.filter((start) => DateTime.formatIsoDateUtc(start) === day),
    Option.map(DateTime.toEpochMillis)
  );

const Setting = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const day = SETTING.exec(value)?.[3];
      return value === "" || (day !== undefined && Option.isSome(dayStart(day)));
    },
    { expected: "<sha-256 hex of the secret>:<Clerk user id>:<YYYY-MM-DD>, or empty for none" }
  )
);

/** The link, or None when there is none. The entrypoint checks it before acquiring Postgres. */
export const config = Config.schema(Setting, "PATCHY_DEMO_LINK").pipe(
  Config.withDefault(""),
  Config.map((value) =>
    Option.fromNullishOr(SETTING.exec(value)).pipe(
      Option.flatMap(([, digest, clerkUserId, day]) =>
        Option.map(dayStart(day!), (endsAt) => ({
          digest: Buffer.from(digest!, "hex"),
          clerkUserId: clerkUserId!,
          endsAt
        }))
      )
    )
  )
);

/** `/signin/:secret`, only while a link is configured; `notFound` answers every other secret. */
export const routes = (notFound: HttpServerResponse.HttpServerResponse) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const configured = yield* config;
      if (Option.isNone(configured)) return;
      const link = configured.value;
      const { publicUrl, secretKey } = yield* Config.all({
        publicUrl: Session.publicUrlConfig,
        secretKey: Config.Redacted("CLERK_SECRET_KEY")
      });
      const cryptography = yield* Cryptography.Cryptography;
      const client = createClerkClient({
        apiUrl: yield* Session.backendApiUrl,
        secretKey: Redacted.value(secretKey),
        telemetry: { disabled: true }
      });
      const open = Effect.gen(function* () {
        const { secret = "" } = yield* HttpRouter.params;
        const presented = yield* cryptography.digest("SHA-256", secret);
        if (
          !(yield* cryptography.equal(presented, link.digest)) ||
          (yield* Clock.currentTimeMillis) >= link.endsAt
        )
          return notFound;
        const token = yield* Effect.tryPromise({
          try: () =>
            client.signInTokens.createSignInToken({
              userId: link.clerkUserId,
              expiresInSeconds: TOKEN_SECONDS
            }),
          catch: (cause) => new DemoLinkTokenFailed({ cause })
        });
        // A business event needs a company, which the account has once it has joined one.
        const user = yield* (yield* Users.Users).findByClerkId(link.clerkUserId);
        if (user !== null)
          yield* (yield* Analytics.Analytics).track({
            name: "demo_link.opened",
            principalId: user.id,
            companyId: user.companyId,
            properties: {}
          });
        const target = new URL(token.url);
        target.searchParams.set("redirect_url", publicUrl.href);
        return HttpServerResponse.redirect(target.href, {
          status: 303,
          headers: { "cache-control": "no-store" }
        });
      });
      yield* router.add(
        "GET",
        "/signin/:secret",
        open.pipe(
          Effect.catchTags({
            DemoLinkTokenFailed: () =>
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
                  title: "Company service unavailable",
                  body: "<p>Please try again.</p>",
                  status: 503
                })
              )
          }),
          // Every answer carries the secret in its URL, so none may pass it on as a referrer.
          Effect.map(HttpServerResponse.setHeader("referrer-policy", "no-referrer"))
        )
      );
    })
  );
