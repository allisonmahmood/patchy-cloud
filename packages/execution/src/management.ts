// @effect-diagnostics nodeBuiltinImport:off -- Node supplies the listener and constant-time secret comparison.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { limitRefusal, readBody, type BodyTooLarge, type MalformedBody } from "@patchy/api";
import * as Protocol from "@patchy/api/management";
import { registry } from "@patchy/limits/registry";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Supervisor from "./supervisor.js";

export class ManagementError extends Schema.TaggedError<ManagementError>()("ManagementError", {
  reason: Schema.Literals([
    "public_interface",
    "invalid_secret",
    "invalid_port",
    "invalid_body_limit"
  ])
}) {
  override get message() {
    return `Execution management listener refused: ${this.reason}.`;
  }
}

export class ListenerUnavailable extends Schema.TaggedError<ListenerUnavailable>()(
  "ListenerUnavailable",
  {
    host: Schema.String,
    port: Schema.Int,
    cause: Schema.Defect()
  }
) {
  override get message() {
    return `Execution management could not listen on ${this.host}:${this.port}.`;
  }
}

export interface Options {
  readonly secret: Redacted.Redacted<string>;
  readonly previousSecret?: Redacted.Redacted<string>;
  readonly host?: string;
  readonly port?: number;
  readonly maxRequestBytes?: number;
  /** Deployment must also restrict this private interface to the host security group. */
  readonly privateInterface?: boolean;
}

export const config = Config.all({
  secret: Config.Redacted("EXECUTION_MANAGEMENT_SECRET"),
  previousSecret: Config.option(Config.Redacted("EXECUTION_MANAGEMENT_PREVIOUS_SECRET")),
  host: Config.String("EXECUTION_MANAGEMENT_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Int("EXECUTION_MANAGEMENT_PORT").pipe(Config.withDefault(8788)),
  privateInterface: Config.Boolean("EXECUTION_MANAGEMENT_PRIVATE_INTERFACE").pipe(
    Config.withDefault(false)
  )
}).pipe(
  Config.map(({ previousSecret, ...options }): Options => ({
    ...options,
    ...(Option.isSome(previousSecret) ? { previousSecret: previousSecret.value } : {})
  }))
);

export const maxRequestBytes = registry["execution.management.bodyBytes"].default;
const strict = { onExcessProperty: "error" } as const;
const decodeBind = Schema.decodeUnknownEffect(Protocol.BindRequest, strict);
const decodeInvoke = Schema.decodeUnknownEffect(Protocol.InvokeRequest, strict);
const decodeStop = Schema.decodeUnknownEffect(Protocol.StopRequest, strict);
const decodeStats = Schema.decodeUnknownEffect(Protocol.StatsRequest, strict);
const portSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }));
const validPort = Schema.is(portSchema);
const validBodyLimit = Schema.is(Schema.Int.check(Schema.isGreaterThan(0)));
const digest = (value: string) => createHash("sha256").update(value).digest();
const privateHost = (host: string, explicit: boolean) => {
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    if (octets[0] === 127) return true;
    return (
      explicit &&
      (octets[0] === 10 ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168))
    );
  }
  if (family !== 6) return false;
  const normalized = new URL(`http://[${host}]/`).hostname;
  return normalized === "[::1]" || (explicit && /^\[f[cd][0-9a-f]{2}:/i.test(normalized));
};
const refusal = (
  code: Protocol.Refusal["code"],
  status: number,
  limits: Supervisor.SupervisorError["limit"] = {},
  peaks?: Supervisor.SupervisorError["limits"]
) =>
  HttpServerResponse.jsonUnsafe(
    {
      ok: false,
      code,
      ...limits,
      ...(peaks === undefined ? {} : { limits: peaks })
    } satisfies Protocol.Refusal,
    {
      status
    }
  );
const failureStatus = (reason: Supervisor.SupervisorError["reason"]) => {
  switch (reason) {
    case "unauthorized":
      return 401;
    case "busy":
      return 503;
    case "stale_epoch":
    case "stale_generation":
    case "stopped":
    case "binding_conflict":
    case "bundle_required":
      return 409;
    case "invalid_bundle":
    case "load_failed":
    case "protocol":
      return 400;
    default:
      return 502;
  }
};

const respond = <R>(
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Supervisor.SupervisorError | Schema.SchemaError | BodyTooLarge | MalformedBody,
    R
  >
) =>
  effect.pipe(
    Effect.catchTags({
      SchemaError: () => Effect.succeed(refusal("invalid_request", 400)),
      SupervisorError: (error) =>
        Effect.succeed(
          refusal(error.reason, failureStatus(error.reason), error.limit, error.limits)
        ),
      BodyTooLarge: (error) =>
        Effect.succeed(
          refusal("too_large", 413, limitRefusal("execution.management.bodyBytes", error.maxBytes))
        ),
      MalformedBody: () => Effect.succeed(refusal("invalid_request", 400))
    })
  );

/** Owns only a private listener; the enclosing scope owns this listener and its supervisor. */
export const serve = Effect.fn("ExecutionManagement.serve")(function* (options: Options) {
  const supervisor = yield* Supervisor.Supervisor;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8788;
  const bodyLimit = options.maxRequestBytes ?? maxRequestBytes;
  if (!validBodyLimit(bodyLimit))
    return yield* new ManagementError({ reason: "invalid_body_limit" });
  if (!privateHost(host, options.privateInterface === true))
    return yield* new ManagementError({ reason: "public_interface" });
  if (!validPort(port)) return yield* new ManagementError({ reason: "invalid_port" });
  const current = Redacted.value(options.secret);
  const previous =
    options.previousSecret === undefined ? current : Redacted.value(options.previousSecret);
  if (current.length === 0 || previous.length === 0)
    return yield* new ManagementError({ reason: "invalid_secret" });
  const currentDigest = digest(current);
  const previousDigest = digest(previous);
  const handler = yield* HttpRouter.toHttpEffect(
    HttpRouter.addAll([
      HttpRouter.route(
        "POST",
        "/bind",
        respond(
          Effect.gen(function* () {
            return HttpServerResponse.jsonUnsafe(
              yield* supervisor.bind(yield* decodeBind(yield* readBody(bodyLimit)))
            );
          })
        )
      ),
      HttpRouter.route(
        "POST",
        "/invoke",
        respond(
          Effect.gen(function* () {
            return HttpServerResponse.jsonUnsafe(
              yield* supervisor.invoke(yield* decodeInvoke(yield* readBody(bodyLimit)))
            );
          })
        )
      ),
      HttpRouter.route(
        "POST",
        "/stop",
        respond(
          Effect.gen(function* () {
            yield* supervisor.stop(yield* decodeStop(yield* readBody(bodyLimit)));
            return HttpServerResponse.empty({ status: 204 });
          })
        )
      ),
      HttpRouter.route(
        "POST",
        "/stats",
        respond(
          Effect.gen(function* () {
            return HttpServerResponse.jsonUnsafe(
              yield* supervisor.stats(yield* decodeStats(yield* readBody(bodyLimit)))
            );
          })
        )
      )
    ])
  );
  const server = yield* NodeHttpServer.make(createServer, { host, port }).pipe(
    Effect.mapError((cause) => new ListenerUnavailable({ host, port, cause }))
  );
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization ?? "";
      const supplied = digest(authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
      const accepted =
        Number(timingSafeEqual(supplied, currentDigest)) |
        Number(timingSafeEqual(supplied, previousDigest));
      if (accepted === 0) return refusal("unauthorized", 401);
      return yield* handler;
    })
  );
  if (server.address._tag === "UnixPathAddress")
    return yield* new ManagementError({ reason: "public_interface" });
  return { url: `http://${host.includes(":") ? `[${host}]` : host}:${server.address.port}` };
});
