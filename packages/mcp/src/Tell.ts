/**
 * `tell_patchy`: a worker agent sends Patchy's team a request or feedback about Patchy itself,
 * as its person (docs/product.md › Requests and feedback). It calls Feedback's service directly,
 * as the connection's person and company, with surface `mcp` and the client name they approved
 * as the agent. It reads no patch, never passes Runtime's admission and mints no token: the
 * door's own gates and the service's send limit are all it passes.
 *
 * Every answer links the person's page of what they and their agents sent, the only place to
 * see or withdraw it. Linking a request to a match happens there too, never over MCP. Every
 * refusal is a tool result with the service's code, saying what to rewrite; none stores anything.
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type RequestBrief, toolAnswer, toolRefusal } from "@patchy/api";
import type { AgentConnections } from "@patchy/auth";
import { Feedback } from "@patchy/feedback";
import * as Catalogue from "./Catalogue.js";

const Args = Schema.Struct({
  kind: Schema.Literals(["request", "feedback"]),
  text: Schema.String,
  why: Schema.optionalKey(Schema.String)
});
type Kind = (typeof Args.Type)["kind"];
const decodeArgs = Schema.decodeUnknownResult(Args, { onExcessProperty: "error" });

const argsFix =
  "Nothing was stored. Send kind and text, and why only with a request, as tools/list describes them.";

/** Where a field the service refused for its length goes instead. */
const rewrite = (kind: Kind, field: string) =>
  field === "why"
    ? "Keep why to what the person is trying to do and why it matters, and send it again."
    : kind === "request"
      ? "A request's text is its title, one line saying what Patchy should do; put the rest in why and send it again."
      : "Say what happened and what you expected within that, and send it again.";

/** The service's refusals as tool results, with its codes. */
const refusals = (kind: Kind) => ({
  InvalidText: (error: Feedback.InvalidText) =>
    Effect.succeed(
      toolRefusal({
        code: "invalid_text",
        from: "patchy",
        message: `${error.message} ${rewrite(kind, error.field)}`,
        details: { field: error.field }
      })
    ),
  ContainsSecret: (error: Feedback.ContainsSecret) =>
    Effect.succeed(
      toolRefusal({
        code: "contains_secret",
        from: "patchy",
        message: error.message,
        details: { secrets: error.secrets.map(({ field, kind }) => ({ field, kind })) }
      })
    ),
  SendLimited: (error: Feedback.SendLimited) =>
    Effect.succeed(
      toolRefusal({
        code: "rate_limited",
        from: "patchy",
        message: error.message,
        retryAfterSeconds: error.retryAfterSeconds
      })
    ),
  // As the door's other reads of the platform database do.
  SqlError: Effect.die
});

/** What the agent does with a request's answer: tell of a shipped match, and where it is. */
const requestNext = (similar: ReadonlyArray<RequestBrief>, url: string) =>
  `Patchy's team has this request, sent as the person you act for.${
    similar.some((match) => match.status === "shipped")
      ? " A similar request has shipped: tell the person, using its note."
      : ""
  } They can see or withdraw it at ${url}.`;

const feedbackNext = (url: string) =>
  `Patchy's team has this feedback, sent as the person you act for. They can see or withdraw it at ${url}.`;

/**
 * `tell_patchy { kind, text, why? }`: a request answers `{ id, similar, next, url }`, with up to
 * three similar requests, and feedback `{ id, next, url }`. `url` is the person's page at
 * `<public origin>/feedback`. A why on feedback is refused rather than dropped, since the
 * service stores exactly what was sent.
 */
export const tell = Effect.fn("Tell.tell")(function* (
  identity: AgentConnections.AgentIdentity,
  args: unknown,
  publicUrl: URL
) {
  const decoded = decodeArgs(args ?? {});
  if (Result.isFailure(decoded))
    return Catalogue.invalidArgs("tell_patchy", Catalogue.problemOf(decoded.failure), argsFix);
  const { kind, text, why } = decoded.success;
  const feedback = yield* Feedback.Feedback;
  const sender: Feedback.Sender = {
    userId: identity.user.id,
    companyId: identity.company.id,
    surface: "mcp",
    agent: identity.agentConnection.clientName
  };
  const url = `${publicUrl.origin}/feedback`;
  if (kind === "request")
    return yield* feedback.sendRequest({ sender, text, why: why ?? null }).pipe(
      Effect.map(({ id, similar }) =>
        toolAnswer({ id, similar, next: requestNext(similar, url), url })
      ),
      Effect.catchTags(refusals(kind))
    );
  if (why !== undefined && why.trim() !== "")
    return Catalogue.invalidArgs(
      "tell_patchy",
      "why is for requests only",
      "Nothing was stored. Put the reason in text and send it again."
    );
  return yield* feedback.sendFeedback({ sender, text }).pipe(
    Effect.map(({ id }) => toolAnswer({ id, next: feedbackNext(url), url })),
    Effect.catchTags(refusals(kind))
  );
});
