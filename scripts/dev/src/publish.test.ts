import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { localReferences, placeSection } from "./publish.js";

const open = "<!-- patchy-dev:compare:ada -->";
const close = "<!-- /patchy-dev:compare:ada -->";
const section = (text: string) => `${open}\n\n${text}\n\n${close}`;

describe("placeSection", () => {
  it.effect("goes before a final paragraph starting Made by", () =>
    Effect.gen(function* () {
      const body = "## What changed\n\nA fix.\n\nMade by Claude Opus 5.5 in Claude Code.\n";

      const placed = yield* placeSection(body, "compare", "ada", "shots");

      assert.strictEqual(
        placed,
        `## What changed\n\nA fix.\n\n${section("shots")}\n\nMade by Claude Opus 5.5 in Claude Code.\n`
      );
    })
  );

  it.effect("goes at the end when the body has no attribution line", () =>
    Effect.gen(function* () {
      const placed = yield* placeSection(
        "## What changed\n\nA fix.\n\n\n",
        "compare",
        "ada",
        "shots"
      );

      assert.strictEqual(placed, `## What changed\n\nA fix.\n\n${section("shots")}\n`);
    })
  );

  it.effect("replaces its own section wherever it is, leaving the rest alone", () =>
    Effect.gen(function* () {
      const body = [
        "## Look at",
        "",
        section("old shots"),
        "",
        "<!-- patchy-dev:compare:ben -->",
        "Ben's",
        "<!-- /patchy-dev:compare:ben -->",
        "",
        "Made by Claude."
      ].join("\r\n");

      const placed = yield* placeSection(body, "compare", "ada", "new shots");

      assert.strictEqual(
        placed,
        [
          "## Look at",
          "",
          section("new shots"),
          "",
          "<!-- patchy-dev:compare:ben -->",
          "Ben's",
          "<!-- /patchy-dev:compare:ben -->",
          "",
          "Made by Claude."
        ].join("\n")
      );
    })
  );

  it.effect("ignores markers and a Made by line inside code fences", () =>
    Effect.gen(function* () {
      const body = ["Example:", "", "````md", open, "```", close, "Made by", "````", ""].join("\n");

      const placed = yield* placeSection(body, "compare", "ada", "shots");

      assert.strictEqual(placed, `${body.trimEnd()}\n\n${section("shots")}\n`);
    })
  );

  it.effect("fails on two sections for the same key rather than guessing", () =>
    Effect.gen(function* () {
      const body = `${section("one")}\n\n${section("two")}\n`;

      const error = yield* Effect.flip(placeSection(body, "compare", "ada", "shots"));

      assert.strictEqual(error._tag, "DuplicateSection");
      assert.include(error.message, "2 `<!-- patchy-dev:compare:ada -->` markers");
    })
  );

  it.effect("fails on a section missing its closing marker", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        placeSection(`${open}\n\nshots\n\nMade by Claude.\n`, "compare", "ada", "shots")
      );

      assert.strictEqual(error._tag, "UnclosedSection");
    })
  );
});

describe("localReferences", () => {
  it("lists each local file once, leaving uploads out", () => {
    const markdown = [
      "![After: /](.local/shots/run/after-home-1280.png)",
      "| 390px | ![Before](.local/shots/run/before-home-390.png) | ![After](.local/shots/run/after-home-390.png) |",
      "![After: /](.local/shots/run/after-home-1280.png)",
      "![Old](https://github.com/user-attachments/assets/1234)"
    ].join("\n");

    assert.deepStrictEqual(localReferences(markdown), [
      ".local/shots/run/after-home-1280.png",
      ".local/shots/run/before-home-390.png",
      ".local/shots/run/after-home-390.png"
    ]);
  });
});
