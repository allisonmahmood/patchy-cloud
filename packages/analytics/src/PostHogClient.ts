/**
 * The upstream client the reporting analytics layer writes to, narrowed to
 * the two calls this capability makes so the PostHog SDK stays behind one
 * adapter. A test that needs a broken backend provides another layer of it.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { PostHog } from "posthog-node";

export class PostHogError extends Schema.TaggedError<PostHogError>()("PostHogError", {
  operation: Schema.Literals(["capture", "shutdown"]),
  cause: Schema.Defect()
}) {
  override get message() {
    return `PostHog ${this.operation} failed.`;
  }
}

export interface CaptureMessage {
  readonly distinctId: string;
  readonly event: string;
  readonly properties: Record<string, unknown>;
}

/** The key that switches reporting on. Unset (the default) means an instance reports nothing. */
export const apiKey = Config.redacted("PATCHY_POSTHOG_API_KEY");

/**
 * Where capture goes: PostHog's US cloud unless pointed elsewhere. Must be an
 * http(s) URL, so a typo fails startup rather than discarding every event.
 */
export const host = Config.schema(
  Schema.String.check(
    Schema.makeFilter(
      (value: string) => /^https?:\/\/\S+$/.test(value) || "Must be an http or https URL.",
      { title: "HttpUrl" }
    )
  ),
  "PATCHY_POSTHOG_HOST"
).pipe(Config.withDefault("https://us.i.posthog.com"));

/**
 * How long a capture request may take before it is abandoned. Short by design:
 * the client batches in the background, so this only bounds how long a flush
 * can sit on a socket, and nothing waits on the answer either way.
 */
const CAPTURE_REQUEST_TIMEOUT_MS = 3_000;

/** How many events collect before a batch goes out, and how long that wait may run. */
const CAPTURE_FLUSH_AT = 20;
const CAPTURE_FLUSH_INTERVAL_MS = 10_000;

export class PostHogClient extends Context.Service<
  PostHogClient,
  {
    /** Queues one message; the SDK batches and sends in the background. */
    readonly capture: (message: CaptureMessage) => Effect.Effect<void, PostHogError>;
    /** Sends whatever is queued and closes the client. */
    readonly shutdown: Effect.Effect<void, PostHogError>;
  }
>()("@patchy/analytics/PostHogClient") {}

export const make = Effect.gen(function* () {
  const key = yield* apiKey;
  const client = new PostHog(Redacted.value(key), {
    host: yield* host,
    flushAt: CAPTURE_FLUSH_AT,
    flushInterval: CAPTURE_FLUSH_INTERVAL_MS,
    requestTimeout: CAPTURE_REQUEST_TIMEOUT_MS,
    // The server is the only caller, so the address on the wire is the
    // instance's own. Resolving it to a location would describe the
    // datacenter and nothing else.
    disableGeoip: true
  });

  return PostHogClient.of({
    capture: (message) =>
      Effect.try({
        try: () => client.capture(message),
        catch: (cause) => new PostHogError({ operation: "capture", cause })
      }),
    shutdown: Effect.tryPromise({
      try: () => client.shutdown(),
      catch: (cause) => new PostHogError({ operation: "shutdown", cause })
    })
  });
});

export const layer = Layer.effect(PostHogClient, make);
