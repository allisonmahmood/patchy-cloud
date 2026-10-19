import { assert, describe, it } from "@effect/vitest";
import { type Capture, compareMarkdown, type Pair } from "./compare.js";
import { localReferences } from "./publish.js";

const shot = (side: Capture["side"], width: number, extra: Partial<Capture> = {}): Capture => ({
  side,
  target: "/",
  width,
  url: "http://after.localhost/",
  status: 200,
  file: `.local/shots/run/${side}-home-${width}.png`,
  errors: [],
  clipped: null,
  ...extra
});

const pair = (width: number, identical = false): Pair => ({
  target: "/",
  width,
  before: shot("before", width),
  after: shot("after", width),
  identical
});

const markdown = (pairs: ReadonlyArray<Pair>) =>
  compareMarkdown({
    provenance: {
      command: "compare",
      scenario: "team",
      before: {
        status: "served",
        side: {
          name: "before",
          commit: { sha: "1111111aaaa", label: "where this branch left main" },
          clone: "/evidence/before",
          served: { apiUrl: "http://before.localhost", scenario: "team", people: [] }
        }
      },
      after: { sha: "2222222bbbb", label: "dev/feature" }
    },
    person: { key: "ada", name: "Ada", email: "ada@acme.example", role: "admin" },
    pairs
  });

describe("compareMarkdown", () => {
  it("puts a desktop width's after full width and its before in a details", () => {
    const text = markdown([pair(1280)]);

    assert.include(
      text,
      "**1280px, after**\n\n![After: / at 1280px](.local/shots/run/after-home-1280.png)\n\n<details><summary>1280px, before</summary>\n\n![Before: / at 1280px](.local/shots/run/before-home-1280.png)\n\n</details>"
    );
    assert.notInclude(text, "| Width |");
  });

  it("sits phone widths side by side in a table", () => {
    const text = markdown([pair(390)]);

    assert.include(
      text,
      "| Width | Before | After |\n| --- | --- | --- |\n| 390px | ![Before: / at 390px](.local/shots/run/before-home-390.png) | ![After: / at 390px](.local/shots/run/after-home-390.png) |"
    );
    assert.notInclude(text, "<details>");
  });

  it("says no visible change and leaves the identical before out of the uploads", () => {
    const text = markdown([pair(1280, true), pair(390, true)]);

    assert.include(text, "No visible change at 1280px.");
    assert.include(text, "| 390px | No visible change | ![After: / at 390px]");
    assert.deepStrictEqual(localReferences(text), [
      ".local/shots/run/after-home-1280.png",
      ".local/shots/run/after-home-390.png"
    ]);
  });

  it("names both commits and the scenario, and a page's problems", () => {
    const text = markdown([
      { ...pair(1280), after: shot("after", 1280, { status: 500, errors: ["boom\nstack"] }) }
    ]);

    assert.include(
      text,
      "Before is `1111111` (where this branch left main) and after is `2222222` (dev/feature), both on the `team` scenario"
    );
    assert.include(text, "- After at 1280px answered 500; 1 browser error(s): `boom`.");
    assert.notInclude(text, "Every page answered 200");
  });
});
