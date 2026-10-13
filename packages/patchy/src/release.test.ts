import { expect, it } from "vitest";
import { CURRENT_RELEASE } from "@patchy/api";
import { WhatsNew } from "@patchy/core";
import { RELEASE } from "./release.js";

// The version check compares release names, so a deploy that keeps the name lets CLIs and
// repos from the previous deploy pass it. Each What's new release moves the name.
it("names the release after the newest What's new release", () => {
  expect(RELEASE).toBe(`0.${WhatsNew.latestRelease}.0`);
  expect(CURRENT_RELEASE).toBe(RELEASE);
});
