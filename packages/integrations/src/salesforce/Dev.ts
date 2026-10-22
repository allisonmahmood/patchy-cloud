import {
  DEV_READ_PATH,
  RuntimeFailure,
  RuntimeSuccess,
  SalesforceQuery,
  SalesforceRows,
  SalesforceDescribe,
  SalesforceDescription
} from "@patchy/api";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Failed } from "../Nango.js";
import { KeyRefused, Refused, type Instance } from "../posthog/Dev.js";

const decodeSuccess = Schema.decodeUnknownOption(RuntimeSuccess);
const decodeFailure = Schema.decodeUnknownOption(RuntimeFailure);
/** Prototype bindings use the existing dev-read door; the machine key stays in this daemon. */
export const handlers = Effect.fn("SalesforceDev.handlers")(function* (instance: Instance) {
  const http = yield* HttpClient.HttpClient;
  const handler = <
    I extends Schema.Top & Schema.Codec<{ readonly connection: string }, unknown>,
    O extends Schema.Top & Schema.Codec<unknown, unknown>
  >(
    op: string,
    input: I,
    output: O
  ) => {
    const decodeOutput = Schema.decodeUnknownOption(output);
    return Runtime.handler(
      { kind: "integration", input, output },
      Effect.fn("SalesforceDev.read")(function* (input: I["Type"]) {
        const { connection: alias, ...args } = input;
        const binding = yield* Binding.Binding;
        const declaration = binding.manifest.uses[alias];
        if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "salesforce")
          return yield* new Runtime.InvalidRequest({});
        if (Option.isNone(instance.token)) return yield* new KeyRefused({});
        const response = yield* http
          .execute(
            HttpClientRequest.post(`${instance.apiUrl}/api${DEV_READ_PATH}`).pipe(
              HttpClientRequest.bearerToken(instance.token.value),
              HttpClientRequest.bodyJsonUnsafe({
                op,
                connection: { id: declaration.id, handle: declaration.handle },
                args
              })
            )
          )
          .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
        if (response.status === 401) return yield* new KeyRefused({});
        const body = yield* response.json.pipe(
          Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
        );
        if (response.status !== 200) {
          const failure = decodeFailure(body);
          return yield* Option.isSome(failure)
            ? new Refused({ status: response.status, failure: failure.value })
            : new Failed({ stage: "response" });
        }
        const result = Option.flatMap(decodeSuccess(body), (success) =>
          decodeOutput(success.value)
        );
        return Option.isSome(result) ? result.value : yield* new Failed({ stage: "response" });
      })
    );
  };
  return {
    "salesforce.query": handler("salesforce.query", SalesforceQuery, SalesforceRows),
    "salesforce.describe": handler("salesforce.describe", SalesforceDescribe, SalesforceDescription)
  };
});
