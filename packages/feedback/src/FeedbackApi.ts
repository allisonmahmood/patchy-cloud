/**
 * The `feedback` group of the Patchy API: the CLI's door to `Feedback`. The machine token names
 * the person and company; the `Patchy-Cli` header names the coding agent (`unknown` without one)
 * and the CLI release; the body names only what was sent and the patch whose repo the CLI ran
 * in. Bodies are bounded before they are parsed, and refusals keep the wire's stable codes.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  BadRequest,
  ContainsSecret,
  CurrentIdentity,
  decodeBody,
  FeedbackSent,
  FileRequest,
  InvalidLink,
  InvalidText,
  LinkRequest,
  type MalformedBody,
  PATCHY_CLI_HEADER,
  parsePatchyCli,
  PatchyApi,
  PayloadTooLarge,
  RateLimited,
  readBody,
  refuse,
  RequestFiled,
  RequestLinked,
  RequestUnlinked,
  SendFeedback,
  SubmissionNotFound,
  Submissions,
  Withdrawn
} from "@patchy/api";
import * as Feedback from "./Feedback.js";

/** Three times the largest field's worst-case JSON escaping, with room for the rest. */
export const MAX_BODY_BYTES = 64 * 1024;

const decodeFile = decodeBody(FileRequest);
const decodeFeedback = decodeBody(SendFeedback);
const decodeLink = decodeBody(LinkRequest);
const encodeSubmissions = Schema.encodeSync(Submissions);
const noStore = { headers: { "cache-control": "private, no-store" } };

const bodyFailures = {
  MalformedBody: (error: { readonly message: string }) =>
    Effect.succeed(refuse(BadRequest, { ok: false, error: error.message })),
  BodyTooLarge: () =>
    Effect.succeed(refuse(PayloadTooLarge, { ok: false, error: "Request body is too large." }))
};

/** The wire's answer to each refusal the service gives. */
const refusals = {
  InvalidText: (error: Feedback.InvalidText) =>
    Effect.succeed(
      refuse(InvalidText, {
        ok: false,
        code: "invalid_text",
        error: error.message,
        field: error.field
      })
    ),
  ContainsSecret: (error: Feedback.ContainsSecret) =>
    Effect.succeed(
      refuse(ContainsSecret, {
        ok: false,
        code: "contains_secret",
        error: error.message,
        secrets: error.secrets.map(({ field, kind }) => ({ field, kind }))
      })
    ),
  SendLimited: (error: Feedback.SendLimited) =>
    Effect.succeed(
      refuse(
        RateLimited,
        {
          ok: false,
          code: "rate_limited",
          error: error.message,
          retryAfterSeconds: error.retryAfterSeconds
        },
        { "retry-after": String(error.retryAfterSeconds) }
      )
    ),
  SubmissionNotFound: (error: Feedback.SubmissionNotFound) =>
    Effect.succeed(
      refuse(SubmissionNotFound, { ok: false, code: "not_found", error: error.message })
    ),
  InvalidLink: (error: Feedback.InvalidLink) =>
    Effect.succeed(refuse(InvalidLink, { ok: false, code: "invalid_link", error: error.message }))
};

/** What sending refuses with, whichever kind is sent. */
const sendRefusals = {
  InvalidText: refusals.InvalidText,
  ContainsSecret: refusals.ContainsSecret,
  SendLimited: refusals.SendLimited
};

/** The token's person, sending through the CLI with the agent and release its header names. */
const cliSender = (patch: string | undefined) =>
  Effect.gen(function* () {
    const identity = yield* CurrentIdentity;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const cli = parsePatchyCli(request.headers[PATCHY_CLI_HEADER]);
    return {
      userId: identity.user.id,
      companyId: identity.company.id,
      surface: "cli",
      agent: cli.agent ?? "unknown",
      cliVersion: cli.cliVersion ?? null,
      patchId: patch ?? null
    } satisfies Feedback.Sender;
  });

const person = Effect.map(CurrentIdentity, (identity) => ({
  userId: identity.user.id,
  companyId: identity.company.id
}));

export const layer = HttpApiBuilder.group(PatchyApi, "feedback", (handlers) =>
  Effect.gen(function* () {
    const feedback = yield* Feedback.Feedback;
    /** The request's body through `decode`, or the refusal it gets instead. */
    const body = <A>(decode: (body: unknown) => Effect.Effect<A, MalformedBody>) =>
      readBody(MAX_BODY_BYTES).pipe(Effect.flatMap(decode), Effect.catchTags(bodyFailures));

    return handlers
      .handleRaw("fileRequest", () =>
        Effect.gen(function* () {
          const payload = yield* body(decodeFile);
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          const filed = yield* feedback
            .sendRequest({
              sender: yield* cliSender(payload.patch),
              text: payload.text,
              why: payload.why
            })
            .pipe(Effect.catchTags(sendRefusals));
          if (HttpServerResponse.isHttpServerResponse(filed)) return filed;
          return new RequestFiled({ ok: true, ...filed });
        }).pipe(Effect.orDie)
      )
      .handleRaw("linkRequest", ({ params }) =>
        Effect.gen(function* () {
          const payload = yield* body(decodeLink);
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          const linked = yield* feedback
            .link({
              sender: yield* cliSender(undefined),
              id: params.id,
              to: payload.to,
              why: payload.why
            })
            .pipe(
              Effect.catchTags({
                SubmissionNotFound: refusals.SubmissionNotFound,
                InvalidLink: refusals.InvalidLink,
                InvalidText: refusals.InvalidText,
                ContainsSecret: refusals.ContainsSecret
              })
            );
          if (HttpServerResponse.isHttpServerResponse(linked)) return linked;
          return new RequestLinked({ ok: true, ...linked });
        }).pipe(Effect.orDie)
      )
      .handle("unlinkRequest", ({ params }) =>
        Effect.gen(function* () {
          const unlinked = yield* feedback
            .unlink({ person: yield* person, id: params.id })
            .pipe(Effect.catchTags({ SubmissionNotFound: refusals.SubmissionNotFound }));
          if (HttpServerResponse.isHttpServerResponse(unlinked)) return unlinked;
          return new RequestUnlinked({ ok: true, ...unlinked });
        }).pipe(Effect.orDie)
      )
      .handleRaw("sendFeedback", () =>
        Effect.gen(function* () {
          const payload = yield* body(decodeFeedback);
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          const sent = yield* feedback
            .sendFeedback({ sender: yield* cliSender(payload.patch), text: payload.text })
            .pipe(Effect.catchTags(sendRefusals));
          if (HttpServerResponse.isHttpServerResponse(sent)) return sent;
          return new FeedbackSent({ ok: true, ...sent });
        }).pipe(Effect.orDie)
      )
      .handle("listSubmissions", ({ query }) =>
        Effect.gen(function* () {
          const page = yield* feedback.list({ person: yield* person, ...query }).pipe(
            Effect.catchTags({
              InvalidCursor: (error) =>
                Effect.succeed(refuse(BadRequest, { ok: false, error: error.message }))
            })
          );
          if (HttpServerResponse.isHttpServerResponse(page)) return page;
          return HttpServerResponse.jsonUnsafe(
            encodeSubmissions(
              new Submissions({
                submissions: page.submissions.map((sent) => ({
                  ...sent,
                  createdAt: sent.createdAt.toISOString()
                })),
                nextCursor: page.nextCursor
              })
            ),
            noStore
          );
        }).pipe(Effect.orDie)
      )
      .handle("withdraw", ({ params }) =>
        Effect.gen(function* () {
          const withdrawn = yield* feedback
            .withdraw({ person: yield* person, id: params.id })
            .pipe(Effect.catchTags({ SubmissionNotFound: refusals.SubmissionNotFound }));
          if (HttpServerResponse.isHttpServerResponse(withdrawn)) return withdrawn;
          return new Withdrawn({ ok: true, ...withdrawn });
        }).pipe(Effect.orDie)
      );
  })
);
