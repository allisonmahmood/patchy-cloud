/**
 * PROTOTYPE (#815): mirrors PostHog's dev binding. Shopify's dev binding is the real connection (ADR-0013): `patchy dev` sends each query to the
 * instance's dev door as the machine token's person, whichever local viewer asked. The token
 * stays in this process's memory, out of workerd, generated files and logs. The instance decides
 * everything; its refusals reach the patch as it sent them.
 */
import {
  DEV_READ_PATH,
  type DevRead,
  ShopifyRead,
  RateLimited,
  RuntimeFailure,
  RuntimeSuccess
} from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ConnectionNotDeclared } from "./Operations.js";

/** The instance refused this machine's key, before or while the read waited. */
export class KeyRefused extends Schema.TaggedError<KeyRefused>()("ShopifyDevKeyRefused", {
  correlationId: Schema.optionalKey(Schema.String)
}) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return "The instance refused this machine's key: it expired or was revoked, or your account was deactivated. Run `patchy login`, then `patchy dev stop` and `patchy dev`.";
  }
}

/** The instance couldn't be reached, or answered with something other than its wire. */
export class InstanceUnavailable extends Schema.TaggedError<InstanceUnavailable>()(
  "ShopifyDevInstanceUnavailable",
  { instance: Schema.String, cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())) }
) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return `patchy dev couldn't read Shopify through ${this.instance}: it can't be reached or answered unexpectedly. Other dev work keeps going.`;
  }
}

/** The instance refused the read; the patch sees the refusal the instance sent. */
export class Refused extends Schema.TaggedError<Refused>()("ShopifyDevRefused", {
  status: Schema.Int,
  failure: RuntimeFailure
}) {
  get code() {
    return this.failure.code;
  }
  override get message() {
    return this.failure.error;
  }
  get retryAfterSeconds() {
    return this.failure.retryAfter;
  }
  get limitId() {
    return this.failure.limitId;
  }
  get scope() {
    return this.failure.scope;
  }
  get value() {
    return this.failure.value;
  }
  get details() {
    return this.failure.details;
  }
  get correlationId() {
    return this.failure.correlationId;
  }
  get integrationOperation() {
    return this.failure.operation;
  }
}

const decodeSuccess = Schema.decodeUnknownOption(RuntimeSuccess);
const decodeFailure = Schema.decodeUnknownOption(RuntimeFailure);
const decodeGuard = Schema.decodeUnknownOption(RateLimited);
const decodeValue = Schema.decodeUnknownOption(Schema.Json);

/** Where the instance is and the key dev reads with; absent when no live integration is declared. */
export interface Instance {
  readonly apiUrl: string;
  readonly token: Option.Option<Redacted.Redacted>;
}

/** `shopify.read` for `patchy dev`: the local manifest routes, the instance reads. */
export const handlers = Effect.fn("ShopifyDev.handlers")(function* (instance: Instance) {
  const http = yield* HttpClient.HttpClient;
  const failed = (cause?: unknown) =>
    new InstanceUnavailable({
      instance: instance.apiUrl,
      ...(cause === undefined ? {} : { cause: Redacted.make(cause) })
    });
  return {
    "shopify.read": Runtime.handler(
      { kind: "integration", input: ShopifyRead, output: Schema.Json },
      Effect.fn("ShopifyDev.query")(function* ({ connection: alias, ...args }) {
        const binding = yield* Binding.Binding;
        const declaration = binding.manifest.uses[alias];
        if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "shopify")
          return yield* new ConnectionNotDeclared({});
        if (Option.isNone(instance.token)) return yield* new KeyRefused({});
        const payload: DevRead = {
          op: "shopify.read",
          connection: { id: declaration.id, handle: declaration.handle },
          args
        };
        // The local runtime's deadline interrupts this request; the instance keeps its own.
        const response = yield* http
          .execute(
            HttpClientRequest.post(`${instance.apiUrl}/api${DEV_READ_PATH}`).pipe(
              HttpClientRequest.bearerToken(instance.token.value),
              HttpClientRequest.bodyJsonUnsafe(payload)
            )
          )
          .pipe(Effect.mapError(failed));
        // A refused key is a refused key whatever its body says; only the rest must be the wire.
        const read = yield* Effect.result(response.json);
        const failure =
          read._tag === "Success" ? decodeFailure(read.success) : Option.none<RuntimeFailure>();
        if (response.status === 401)
          return yield* new KeyRefused(
            Option.isSome(failure) && failure.value.correlationId !== undefined
              ? { correlationId: failure.value.correlationId }
              : {}
          );
        if (read._tag === "Failure") return yield* failed(read.failure);
        const body = read.success;
        if (response.status === 200) {
          const value = Option.flatMap(decodeSuccess(body), (success) =>
            decodeValue(success.value)
          );
          return Option.isSome(value) ? value.value : yield* failed();
        }
        if (Option.isSome(failure))
          return yield* new Refused({ status: response.status, failure: failure.value });
        // The protected-API limit per address answers before the door does.
        const guard = response.status === 429 ? decodeGuard(body) : Option.none();
        if (Option.isSome(guard))
          return yield* new Refused({
            status: 429,
            failure: {
              ok: false,
              source: "patchy",
              code: "rate_limited",
              error: `The instance is limiting requests from this address. Try again in ${guard.value.retryAfterSeconds} seconds.`,
              limitId: "rate.protectedApi.perMinute",
              scope: registry["rate.protectedApi.perMinute"].scope,
              retryAfter: guard.value.retryAfterSeconds
            }
          });
        return yield* failed();
      })
    )
  };
});
