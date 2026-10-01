import * as GuestProtocol from "@patchy/api/guest";
import { Executor } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const strict = { onExcessProperty: "error" } as const;
const decodeBundle = Schema.decodeUnknownEffect(GuestProtocol.Bundle, strict);
const decodeInvoke = Schema.decodeUnknownEffect(GuestProtocol.Invoke, strict);
const decodeBindReply = Schema.decodeUnknownEffect(GuestProtocol.BindReply, strict);
const decodeInvokeReply = Schema.decodeUnknownEffect(GuestProtocol.InvokeReply, strict);

/** Adapts a running loader. Its caller owns the process and any invocation cancellation. */
export const make = Effect.fn("ExecutionEngine.make")(function* (options: {
  readonly url: string;
}) {
  const http = yield* HttpClient.HttpClient;
  const base = options.url.replace(/\/$/, "");
  const post = Effect.fn("ExecutionEngine.post")(function* (
    operation: "bind" | "invoke",
    body: GuestProtocol.BindRequest | GuestProtocol.Invoke
  ) {
    const response = yield* http
      .execute(
        HttpClientRequest.post(`${base}/${operation}`).pipe(HttpClientRequest.bodyJsonUnsafe(body))
      )
      .pipe(
        Effect.mapError(
          (cause) => new Executor.ExecutionError({ operation, reason: "transport", cause })
        )
      );
    const value = yield* response.json.pipe(
      Effect.mapError(
        (cause) => new Executor.ExecutionError({ operation, reason: "protocol", cause })
      )
    );
    if (response.status !== 200) {
      const refusal = yield* decodeBindReply(value).pipe(
        Effect.mapError(
          (cause) => new Executor.ExecutionError({ operation, reason: "protocol", cause })
        )
      );
      return yield* new Executor.ExecutionError({
        operation,
        reason: refusal.ok || refusal.code === "invalid_request" ? "protocol" : refusal.code
      });
    }
    return value;
  });
  return Executor.Executor.of({
    bind: Effect.fn("ExecutionEngine.bind")(function* (input) {
      const bundle = yield* decodeBundle(input).pipe(
        Effect.mapError(
          (cause) => new Executor.ExecutionError({ operation: "bind", reason: "protocol", cause })
        )
      );
      const reply = yield* decodeBindReply(
        yield* post("bind", { wire: GuestProtocol.wireVersion, ...bundle })
      ).pipe(
        Effect.mapError(
          (cause) => new Executor.ExecutionError({ operation: "bind", reason: "protocol", cause })
        )
      );
      if (!reply.ok)
        return yield* new Executor.ExecutionError({
          operation: "bind",
          reason: reply.code === "invalid_request" ? "protocol" : reply.code
        });
      return {
        companyId: bundle.companyId,
        patchId: bundle.patchId,
        versionId: bundle.versionId,
        sha256: bundle.sha256
      };
    }),
    invoke: Effect.fn("ExecutionEngine.invoke")(function* (input) {
      const request = yield* decodeInvoke(input).pipe(
        Effect.mapError(
          (cause) => new Executor.ExecutionError({ operation: "invoke", reason: "protocol", cause })
        )
      );
      return yield* decodeInvokeReply(yield* post("invoke", request)).pipe(
        Effect.mapError(
          (cause) => new Executor.ExecutionError({ operation: "invoke", reason: "protocol", cause })
        )
      );
    })
  });
});

export const layer = (options: { readonly url: string }) =>
  Layer.effect(Executor.Executor, make(options));
