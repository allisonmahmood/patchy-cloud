/** Browser-confirmed device login, the bearer identity and self-revocation. */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  BadRequest,
  CurrentIdentity,
  decodeBody,
  DeviceLoginComplete,
  DeviceLoginGone,
  DeviceLoginStarted,
  DeviceLoginWaiting,
  LoggedOut,
  PatchyApi,
  PayloadTooLarge,
  PollDeviceLoginRequest,
  readBody,
  refuse,
  StartDeviceLoginRequest
} from "@patchy/api";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";

const decodeStart = decodeBody(StartDeviceLoginRequest);
const decodePoll = decodeBody(PollDeviceLoginRequest);

export const layer = HttpApiBuilder.group(PatchyApi, "auth", (handlers) =>
  Effect.gen(function* () {
    const tokens = yield* MachineTokens.MachineTokens;
    const logins = yield* DeviceLogins.DeviceLogins;
    const publicBaseUrl = yield* Config.string("PATCHY_PUBLIC_BASE_URL");
    const verificationUrlBare = `${publicBaseUrl.replace(/\/+$/, "")}/login/device`;
    return handlers
      .handleRaw("startDeviceLogin", () =>
        Effect.gen(function* () {
          const payload = yield* readBody(4096).pipe(Effect.flatMap(decodeStart));
          const started = yield* logins
            .start(payload)
            .pipe(Effect.catchTags({ SqlError: Effect.die }));
          return new DeviceLoginStarted({
            ok: true,
            ...started,
            verificationUrl: `${verificationUrlBare}?code=${started.userCode}`,
            verificationUrlBare
          });
        }).pipe(
          Effect.catchTags({
            MalformedBody: () =>
              Effect.succeed(refuse(BadRequest, { ok: false, error: "Malformed request body." })),
            BodyTooLarge: () =>
              Effect.succeed(
                refuse(PayloadTooLarge, { ok: false, error: "Request body is too large." })
              )
          })
        )
      )
      .handleRaw("pollDeviceLogin", () =>
        Effect.gen(function* () {
          const payload = yield* readBody(4096).pipe(Effect.flatMap(decodePoll));
          const result = yield* logins
            .poll(payload.deviceCode)
            .pipe(Effect.catchTags({ SqlError: Effect.die }));
          return result.status === "complete"
            ? new DeviceLoginComplete({ ok: true, ...result })
            : new DeviceLoginWaiting({ ok: true, status: result.status });
        }).pipe(
          Effect.catchTags({
            MalformedBody: () =>
              Effect.succeed(refuse(BadRequest, { ok: false, error: "Malformed request body." })),
            BodyTooLarge: () =>
              Effect.succeed(
                refuse(PayloadTooLarge, { ok: false, error: "Request body is too large." })
              ),
            DeviceLoginExpired: (error) =>
              Effect.succeed(
                refuse(DeviceLoginGone, { ok: false, code: "expired", error: error.message })
              ),
            DeviceLoginDenied: (error) =>
              Effect.succeed(
                refuse(DeviceLoginGone, { ok: false, code: "denied", error: error.message })
              ),
            DeviceLoginUnknown: (error) =>
              Effect.succeed(
                refuse(DeviceLoginGone, { ok: false, code: "unknown", error: error.message })
              )
          })
        )
      )
      .handle("me", () => CurrentIdentity)
      .handle("logout", () =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const result = yield* tokens
            .revoke(identity.machine.id)
            .pipe(Effect.catchTags({ SqlError: Effect.die, MachineTokenNotFound: Effect.die }));
          return new LoggedOut({ ok: true, alreadyRevoked: result.alreadyRevoked });
        })
      );
  })
);
