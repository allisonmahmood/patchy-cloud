import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Analytics } from "@patchy/analytics";
import { Companies, InviteMail, Users } from "@patchy/companies";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AuthPages from "./AuthPages.js";
import * as DeviceLogins from "./DeviceLogins.js";
import * as DevPersonas from "./DevPersonas.js";
import * as MachineTokens from "./MachineTokens.js";
import * as RequireSession from "./RequireSession.js";
import { DEV_SEED } from "./seed.js";

const base = "http://brightline.localhost:20480";
const env = {
  PATCHY_PUBLIC_BASE_URL: base,
  PATCHY_DEV_PERSONAS_SECRET: "test-secret",
  NODE_ENV: "development"
};
const probe = HttpRouter.use((router) =>
  router.add(
    "GET",
    "/private",
    RequireSession.withViewer(
      Effect.map(RequireSession.Viewer, (viewer) => HttpServerResponse.jsonUnsafe(viewer))
    )
  )
);
const routes = Layer.mergeAll(AuthPages.layer, DevPersonas.routes, probe);
const settings = ConfigProvider.layer(ConfigProvider.fromUnknown(env));
const send = Effect.fn(function* (path: string, cookie?: string) {
  const app = yield* HttpRouter.toHttpEffect(routes).pipe(Effect.provide(settings));
  const response = yield* app.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request(new URL(path, base), cookie === undefined ? {} : { headers: { cookie } })
      )
    )
  );
  return HttpServerResponse.toWeb(response);
});
/** The persona cookie a sign-in sets, as a request `cookie` header. */
const signIn = Effect.fn(function* (email: string, target = "/private") {
  const response = yield* send(
    `/dev/sign-in?as=${encodeURIComponent(email)}&return=${encodeURIComponent(target)}`
  );
  assert.strictEqual(response.status, 303);
  assert.strictEqual(response.headers.get("location"), target);
  const set = response.headers.getSetCookie().find((c) => c.startsWith(`${DevPersonas.COOKIE}=`));
  assert.isDefined(set);
  assert.include(set!, "HttpOnly");
  return set!.split(";")[0]!;
});

const services = Layer.mergeAll(
  DevPersonas.layer,
  Companies.layer,
  Users.layer,
  InviteMail.layerRecording
).pipe(
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provide(Analytics.layerNoop),
  Layer.provide(Limits.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(settings)
);

it.layer(services)("dev personas", (it) => {
  it.effect("signs a seeded person in and back to a local path", () =>
    Effect.gen(function* () {
      const cookie = yield* signIn(DEV_SEED.email);
      const page = yield* send("/private", cookie);
      assert.strictEqual(page.status, 200);
      const viewer = (yield* Effect.promise(() => page.json())) as {
        user: { email: string };
        company: { handle: string };
      };
      assert.strictEqual(viewer.user.email, DEV_SEED.email);
      assert.strictEqual(viewer.company.handle, DEV_SEED.companyHandle);
    })
  );

  it.effect("refuses a forged cookie and sends the door to the persona picker", () =>
    Effect.gen(function* () {
      const cookie = yield* signIn(DEV_SEED.email);
      const [name, value] = cookie.split("=");
      const [payload] = value!.split(".");
      const door = yield* send("/private", `${name}=${payload}.${"A".repeat(43)}`);
      assert.strictEqual(door.status, 401);
      assert.strictEqual(
        door.headers.get("x-patchy-sign-in-url"),
        `${base}/dev/sign-in?return=${encodeURIComponent("/private")}`
      );
      assert.notInclude(yield* Effect.promise(() => door.text()), "clerk");
    })
  );

  it.effect("lets an email with no user enrol, so invitations can be accepted", () =>
    Effect.gen(function* () {
      const cookie = yield* signIn("someone.new@brightline.example", "/join");
      const join = yield* send("/join", cookie);
      assert.strictEqual(join.status, 200);
      assert.include(yield* Effect.promise(() => join.text()), "someone.new@brightline.example");
    })
  );

  it.effect("lists active people and keeps the return local", () =>
    Effect.gen(function* () {
      const picker = yield* send("/dev/sign-in?return=https%3A%2F%2Fforeign.invalid%2F");
      assert.strictEqual(picker.status, 200);
      const body = yield* Effect.promise(() => picker.text());
      assert.include(body, DEV_SEED.companyName);
      assert.include(body, `as=${encodeURIComponent(DEV_SEED.email)}&amp;return=%2F"`);
    })
  );
});

it.effect("refuses outside development, without NODE_ENV, and on a public origin", () =>
  Effect.gen(function* () {
    for (const [settings, tag] of [
      [{ ...env, NODE_ENV: "production" }, "DevPersonasOutsideDevelopment"],
      [{ PATCHY_PUBLIC_BASE_URL: base, PATCHY_DEV_PERSONAS_SECRET: "s" }, "ConfigError"],
      [{ ...env, PATCHY_PUBLIC_BASE_URL: "https://patchy.example/" }, "DevPersonasOnPublicOrigin"]
    ] as const) {
      const error = yield* DevPersonas.make.pipe(
        Effect.flip,
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(settings)))
      );
      assert.strictEqual(error._tag, tag);
    }
  })
);
