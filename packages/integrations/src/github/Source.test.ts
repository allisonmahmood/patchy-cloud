import { assert, describe, it } from "@effect/vitest";
import { NodeCryptography } from "@patchy/core";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as GithubDouble from "../test/github.js";
import * as Source from "./Source.js";

/** The App's configuration from the host's settings, and what counts as a limit answer. */

const configured = (settings: Record<string, string>) =>
  Source.appConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(settings))),
    Effect.provide(NodeCryptography.layer)
  );
const key = Redacted.value(GithubDouble.app.privateKey);
const full = {
  PATCHY_GITHUB_APP_ID: "1001",
  PATCHY_GITHUB_APP_SLUG: "patchy-cloud-test",
  PATCHY_GITHUB_APP_CLIENT_ID: "Iv23test",
  PATCHY_GITHUB_APP_CLIENT_SECRET: "secret",
  PATCHY_GITHUB_APP_PRIVATE_KEY: key
};

describe("the App's settings", () => {
  it.effect("offers nothing when every setting is empty, and refuses to start when some are", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* configured({})));
      assert.isTrue(
        Option.isNone(
          yield* configured(Object.fromEntries(Object.keys(full).map((name) => [name, ""])))
        )
      );
      const partial = yield* Effect.flip(
        configured({ ...full, PATCHY_GITHUB_APP_SLUG: "", PATCHY_GITHUB_APP_CLIENT_SECRET: " " })
      );
      assert.instanceOf(partial, Source.AppIncomplete);
      assert.include(partial.message, "PATCHY_GITHUB_APP_SLUG, PATCHY_GITHUB_APP_CLIENT_SECRET");
      assert.instanceOf(
        yield* Effect.flip(configured({ ...full, PATCHY_GITHUB_APP_PRIVATE_KEY: "not a key" })),
        Source.AppKeyInvalid
      );
    })
  );

  it.effect("reads a private key written on one line with \\n escapes", () =>
    Effect.gen(function* () {
      const app = Option.getOrThrow(
        yield* configured({ ...full, PATCHY_GITHUB_APP_PRIVATE_KEY: key.replaceAll("\n", "\\n") })
      );
      assert.strictEqual(Redacted.value(app.privateKey).trim(), key.trim());
      assert.strictEqual(app.slug, "patchy-cloud-test");
    })
  );
});

describe("a limit answer", () => {
  const now = 1_000_000;
  const answer = (status: number, headers: Record<string, string> = {}, body: unknown = {}) => ({
    status,
    headers,
    text: JSON.stringify(body)
  });
  const at = (status: number, headers?: Record<string, string>, body?: unknown) =>
    Option.getOrUndefined(Source.limitAnswer(answer(status, headers, body), now, 60_000));

  it("is a 429, or a 403 with Retry-After or no requests remaining, at GitHub's own time", () => {
    assert.strictEqual(at(429), now + 60_000);
    assert.strictEqual(at(403, { "retry-after": "30" }), now + 30_000);
    assert.strictEqual(
      at(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1200" }),
      1_200_000
    );
  });

  it("is a 403 with GitHub's secondary-limit message and neither header, for a minute", () => {
    assert.strictEqual(
      at(
        403,
        {},
        {
          message:
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."
        }
      ),
      now + 60_000
    );
  });

  it("isn't any other 403, which goes down the failure path", () => {
    assert.isUndefined(at(403, {}, { message: "This installation has been suspended" }));
    assert.isUndefined(at(403, { "x-ratelimit-remaining": "12" }, { message: "Forbidden" }));
    assert.isUndefined(at(422));
  });
});

describe("an installation's permissions", () => {
  it("must hold every one Patchy reads with, and none above read", () => {
    assert.deepStrictEqual(Source.permissionGaps({ ...Source.permissions }), {
      missing: [],
      above: []
    });
    const rest = Object.fromEntries(
      Object.entries(Source.permissions).filter(([name]) => name !== "checks")
    );
    assert.deepStrictEqual(Source.permissionGaps({ ...rest, contents: "write", members: "read" }), {
      missing: ["checks"],
      above: ["contents"]
    });
  });
});
