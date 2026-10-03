import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import { installCommand } from "@patchy/api";
import * as FrontDoor from "./FrontDoor.js";

const layer = HttpRouter.serve(FrontDoor.layer, {
  disableLogger: true,
  disableListenLog: true
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(NodeServices.layer),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ PATCHY_PUBLIC_BASE_URL: "https://patchy.example/" })
    )
  )
);

it.layer(layer)("the front door", (it) => {
  it.effect("introduces Patchy to an agent without a session, with this instance's commands", () =>
    Effect.gen(function* () {
      const response = yield* (yield* HttpClient.HttpClient).get("/llms.txt");
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers["content-type"], "text/plain; charset=utf-8");
      assert.strictEqual(response.headers["cache-control"], "no-store");
      const text = yield* response.text;
      assert.include(
        text,
        `${installCommand("https://patchy.example", "posix")} && patchy login --api-url 'https://patchy.example' --json`
      );
      assert.include(text, "patchy.cmd login --api-url 'https://patchy.example' --json");
      assert.include(text, "Node.js 22.22.0");
      assert.include(text, "~/.agents/skills/patchy/SKILL.md");
    })
  );

  it.effect("serves the installer with the instance's base URL in place of its placeholder", () =>
    Effect.gen(function* () {
      const response = yield* (yield* HttpClient.HttpClient).get("/install.mjs");
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers["content-type"], "text/javascript; charset=utf-8");
      assert.strictEqual(response.headers["cache-control"], "no-store");
      const script = yield* response.text;
      assert.include(script, 'const base = "https://patchy.example";');
      assert.notInclude(script, "__PATCHY_PUBLIC_BASE_URL__");
    })
  );
});
