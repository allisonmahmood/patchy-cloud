import { describe, expect, it } from "vitest";
import { readFixtureCorpus } from "../fixtures/corpus.mjs";
import { BLOCKED_PROTOCOLS, BLOCKED_TAGS, validateHtml } from "./html-policy.js";

const acceptFixtures = await readFixtureCorpus("accept");
const rejectFixtures = await readFixtureCorpus("reject");

describe("validateHtml", () => {
  it.each(BLOCKED_TAGS)("rejects the <%s> fixture", async (tagName) => {
    const fixture = rejectFixtures.find(
      ({ filename }) => filename === `blocked-tag-${tagName}.html`
    );

    expect(fixture, `missing reject fixture for <${tagName}>`).toBeDefined();
    expect(validateHtml(fixture!.html).errors).toContain(`Blocked <${tagName}> tag found.`);
  });

  it.each(BLOCKED_PROTOCOLS)("rejects the %s URL fixture", async (protocol) => {
    const fixture = rejectFixtures.find(
      ({ filename }) => filename === `blocked-protocol-${protocol.slice(0, -1)}.html`
    );

    expect(fixture, `missing reject fixture for ${protocol}`).toBeDefined();
    expect(validateHtml(fixture!.html).errors).toContain('Blocked unsafe URL in "href" attribute.');
  });

  it.each(acceptFixtures)("accepts $filename", ({ html }) => {
    expect(validateHtml(html).ok).toBe(true);
  });

  it.each(rejectFixtures)("rejects $filename", ({ html }) => {
    expect(validateHtml(html).ok).toBe(false);
  });

  it("warns when title is missing", () => {
    const result = validateHtml("<main>No title</main>");

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("No <title> found; Patchy Cloud will use a generic title.");
  });
});
