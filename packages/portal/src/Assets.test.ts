import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { request, socket } from "./test/fixtures.js";

it.layer(socket)("the portal's scripts on a socket", (it) => {
  it.effect("serves the copy script that reveals copy buttons", () =>
    Effect.gen(function* () {
      const response = yield* request("/assets/copy.js", null);
      assert.strictEqual(response.status, 200);
      assert.include(response.headers["content-type"] ?? "", "text/javascript");
      assert.include(yield* response.text, "button[data-copy]");
    })
  );
});
