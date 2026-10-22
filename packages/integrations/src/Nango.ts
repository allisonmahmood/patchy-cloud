import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { registry } from "@patchy/limits/registry";

export class Failed extends Schema.TaggedError<Failed>()("NangoFailed", {
  stage: Schema.Literals(["configuration", "request", "response", "status", "authorization"]),
  upstreamStatus: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(Schema.Redacted(Schema.Defect()))
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "The connector could not complete this request. Ask a company administrator to check or reconnect it.";
  }
}
/** Private mapping only. OAuth tokens and refresh stay in Nango. */
export const Mapping = Schema.Struct({
  providerConfigKey: Schema.String,
  connectionId: Schema.String
});
export type Mapping = typeof Mapping.Type;
export const providers = {
  salesforce: { provider: "salesforce", configKey: "salesforce" }
} as const;
export const credentials = (mapping: Mapping) => Redacted.make(JSON.stringify(mapping));
const decodeMapping = Schema.decodeUnknownEffect(Schema.fromJsonString(Mapping));
export const parseCredentials = (secret: Redacted.Redacted<string>) =>
  decodeMapping(Redacted.value(secret)).pipe(
    Effect.mapError((cause) => new Failed({ stage: "configuration", cause: Redacted.make(cause) }))
  );
export class Nango extends Context.Service<
  Nango,
  {
    readonly request: (
      method: "GET" | "POST" | "DELETE",
      path: string,
      body?: unknown,
      mapping?: Mapping,
      headers?: Readonly<Record<string, string>>
    ) => Effect.Effect<unknown, Failed>;
  }
>()("@patchy/integrations/Nango") {}

/** Optional while this is a local proof; existing integrations work without Nango configured. */
export const request = Effect.fn("Nango.request")(function* (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  mapping?: Mapping,
  headers?: Readonly<Record<string, string>>
) {
  const adapter = yield* Effect.serviceOption(Nango);
  if (Option.isNone(adapter)) return yield* new Failed({ stage: "configuration" });
  return yield* adapter.value.request(method, path, body, mapping, headers);
});
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decoder = new TextDecoder();
export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const url = yield* Config.String("PATCHY_NANGO_URL").pipe(
    Config.withDefault("http://127.0.0.1:3003")
  );
  const key = yield* Config.option(Config.Redacted("PATCHY_NANGO_SECRET_KEY"));
  return Nango.of({
    request: Effect.fn("Nango.send")(
      function* (method, path, body, mapping, headers) {
        if (
          Option.isNone(key) ||
          Redacted.value(key.value) === "" ||
          !path.startsWith("/") ||
          path.startsWith("//")
        )
          return yield* new Failed({ stage: "configuration" });
        let req = HttpClientRequest.make(method)(
          `${url}${mapping === undefined ? "" : "/proxy"}${path}`
        ).pipe(HttpClientRequest.bearerToken(key.value), HttpClientRequest.acceptJson);
        if (body !== undefined) req = HttpClientRequest.bodyJsonUnsafe(req, body);
        if (mapping !== undefined)
          req = req.pipe(
            HttpClientRequest.setHeaders({
              "Provider-Config-Key": mapping.providerConfigKey,
              "Connection-Id": mapping.connectionId,
              ...Object.fromEntries(
                Object.entries(headers ?? {}).map(([name, value]) => [`Nango-Proxy-${name}`, value])
              )
            })
          );
        const response = yield* http
          .execute(req)
          .pipe(
            Effect.mapError(
              (cause) => new Failed({ stage: "request", cause: Redacted.make(cause) })
            )
          );
        if (response.status < 200 || response.status >= 300)
          return yield* new Failed({ stage: "status", upstreamStatus: response.status });
        if (response.status === 204) return null;
        // Bound before parsing, including responses from a misbehaving provider.
        const state = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => ({ bytes: 0, chunks: [] as Uint8Array[] }),
            (state, chunk) => {
              state.bytes += chunk.byteLength;
              if (state.bytes > registry["runtime.result.bytes"].default)
                return Effect.fail(new Failed({ stage: "response" }));
              state.chunks.push(chunk);
              return Effect.succeed(state);
            }
          ),
          Effect.mapError((cause) => new Failed({ stage: "response", cause: Redacted.make(cause) }))
        );
        const bytes = new Uint8Array(state.bytes);
        let offset = 0;
        for (const chunk of state.chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return yield* decodeJson(decoder.decode(bytes)).pipe(
          Effect.mapError((cause) => new Failed({ stage: "response", cause: Redacted.make(cause) }))
        );
      },
      Effect.timeoutOrElse({
        duration: registry["integration.deadline"].default,
        orElse: () => Effect.fail(new Failed({ stage: "request" }))
      }),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(Tracer.DisablePropagation, true)
    )
  });
});
export const layer = Layer.effect(Nango, make).pipe(Layer.provide(FetchHttpClient.layer));

export const remove = (mapping: Mapping) =>
  request(
    "DELETE",
    `/connections/${encodeURIComponent(mapping.connectionId)}?provider_config_key=${encodeURIComponent(mapping.providerConfigKey)}`
  ).pipe(
    Effect.catchTags({
      NangoFailed: (error) =>
        error.upstreamStatus === 404 ? Effect.succeed(null) : Effect.fail(error)
    })
  );
