import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import {
  actor,
  company,
  post,
  publish,
  publishTier2,
  receiptAfter,
  request,
  socket
} from "./test/fixtures.js";
import { Patches } from "@patchy/patches";

const sidebar = (html: string) => html.match(/<nav class="app-pins"[\s\S]*?<\/nav>/)?.[0] ?? "";

it.layer(socket)("Personal pins", (it) => {
  it.effect(
    "persists more than five pages and tools, isolates people and hides unavailable patches",
    () =>
      Effect.gen(function* () {
        const { owner, member } = yield* company();
        const page = yield* publish(owner, "handbook");
        const tool = yield* publishTier2(owner, "tracker");
        const ids = [page.patchId, tool.patchId];
        for (let i = 0; i < 5; i++) ids.push((yield* publish(owner, `pin-page-${i}`)).patchId);
        for (const id of ids) {
          assert.strictEqual(
            (yield* post(`/patches/${id}/pin`, member, { user: member.id })).status,
            303
          );
          yield* TestClock.adjust(1);
        }
        // Pinning again changes nothing, and says what is pinned, by its title.
        const again = yield* post(`/patches/${tool.patchId}/pin`, member, {
          user: member.id,
          return: "/patches"
        });
        assert.strictEqual(again.headers.location, "/patches");
        assert.strictEqual(yield* receiptAfter(again, member), "Pinned tracker");
        for (const path of ["/", "/patches", "/patches/handbook"]) {
          const pins = sidebar(yield* (yield* request(path, member)).text);
          assert.strictEqual((pins.match(/class="app-pin"/g) ?? []).length, 7);
          assert.isBelow(pins.indexOf("handbook"), pins.indexOf("tracker"));
          assert.include(pins, `action="/patches/${page.patchId}/unpin"`);
        }
        assert.strictEqual(sidebar(yield* (yield* request("/", owner)).text), "");
        const outsider = (yield* company()).member;
        const pin = `/patches/${page.patchId}/pin`;
        assert.strictEqual((yield* post(pin, outsider, { user: outsider.id })).status, 404);
        assert.strictEqual((yield* post(pin, member, { user: owner.id })).status, 409);
        assert.strictEqual(
          (yield* request(pin, member, { user: member.id }, { origin: "https://other.example" }))
            .status,
          403
        );
        const patches = yield* Patches.Patches;
        yield* patches.retire(page.patchId, actor(owner));
        assert.notInclude(sidebar(yield* (yield* request("/", member)).text), "handbook");
        yield* patches.restore(page.patchId, actor(owner));
        assert.include(sidebar(yield* (yield* request("/", member)).text), "handbook");
        assert.strictEqual(
          yield* receiptAfter(
            yield* post(`/patches/${tool.patchId}/unpin`, member, { user: member.id }),
            member
          ),
          "Unpinned tracker"
        );
        for (const id of ids) yield* post(`/patches/${id}/unpin`, member, { user: member.id });
        assert.strictEqual(sidebar(yield* (yield* request("/", member)).text), "");
      })
  );
});
