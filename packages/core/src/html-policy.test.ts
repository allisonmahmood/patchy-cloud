import { describe, expect, it } from "vitest";
import type { HtmlFixture } from "../../../test/html-fixtures.mjs";
import { readFixtureCorpus } from "../../../test/html-fixtures.mjs";
import { BLOCKED_PROTOCOLS, BLOCKED_TAGS, validateHtml } from "./html-policy.js";

type BlockedTag = (typeof BLOCKED_TAGS)[number];
type BlockedProtocol = (typeof BLOCKED_PROTOCOLS)[number];

const fixtureByBlockedTag = {
  script: "blocked-tag-script.html",
  form: "blocked-tag-form.html",
  iframe: "blocked-tag-iframe.html",
  object: "blocked-tag-object.html",
  embed: "blocked-tag-embed.html",
  applet: "blocked-tag-applet.html",
  base: "blocked-tag-base.html",
  link: "blocked-tag-link.html"
} as const satisfies Record<BlockedTag, string>;

const fixtureByBlockedProtocol = {
  "javascript:": {
    filename: "blocked-protocol-javascript.html",
    sourceMarker: "java&#10;script:"
  },
  "vbscript:": {
    filename: "blocked-protocol-vbscript.html",
    sourceMarker: "vbscript:"
  },
  "file:": {
    filename: "blocked-protocol-file.html",
    sourceMarker: "file:"
  }
} as const satisfies Record<BlockedProtocol, { filename: string; sourceMarker: string }>;

const expectedErrorsByRejectFixture: Readonly<Record<string, readonly string[]>> = {
  "blocked-protocol-file.html": ['Blocked unsafe URL in "href" attribute.'],
  "blocked-protocol-javascript.html": ['Blocked unsafe URL in "href" attribute.'],
  "blocked-protocol-vbscript.html": ['Blocked unsafe URL in "href" attribute.'],
  "blocked-tag-applet.html": ["Blocked <applet> tag found."],
  "blocked-tag-base.html": ["Blocked <base> tag found."],
  "blocked-tag-embed.html": ["Blocked <embed> tag found."],
  "blocked-tag-form.html": ["Blocked <form> tag found."],
  "blocked-tag-iframe.html": ["Blocked <iframe> tag found."],
  "blocked-tag-link.html": ["Blocked <link> tag found."],
  "blocked-tag-object.html": ["Blocked <object> tag found."],
  "blocked-tag-script.html": ["Blocked <script> tag found."],
  "inline-event-handler.html": ['Blocked inline event handler attribute "onclick" found.'],
  "meta-refresh.html": ["Blocked meta refresh tag found."],
  "srcdoc-attribute.html": ['Blocked "srcdoc" attribute found.'],
  "unsafe-inline-css.html": ["Blocked unsafe inline CSS."]
};

const acceptFixtures = await readFixtureCorpus("accept");
const rejectFixtures = await readFixtureCorpus("reject");
const rejectFixtureByFilename = new Map(
  rejectFixtures.map((fixture) => [fixture.filename, fixture])
);

function rejectFixture(filename: string): HtmlFixture {
  const fixture = rejectFixtureByFilename.get(filename);
  if (!fixture) {
    throw new Error(`Missing reject fixture ${filename}.`);
  }
  return fixture;
}

describe("validateHtml", () => {
  it.each(BLOCKED_TAGS)("rejects the <%s> fixture", (tagName) => {
    const fixture = rejectFixture(fixtureByBlockedTag[tagName]);

    expect(fixture.html).toContain(`<${tagName}`);
    expect(validateHtml(fixture.html).errors).toEqual([`Blocked <${tagName}> tag found.`]);
  });

  it.each(BLOCKED_PROTOCOLS)("rejects the %s URL fixture", (protocol) => {
    const fixtureCase = fixtureByBlockedProtocol[protocol];
    const fixture = rejectFixture(fixtureCase.filename);

    expect(fixture.html.toLowerCase()).toContain(fixtureCase.sourceMarker);
    expect(validateHtml(fixture.html).errors).toEqual(['Blocked unsafe URL in "href" attribute.']);
  });

  it.each(acceptFixtures)("accepts $filename", ({ html }) => {
    expect(validateHtml(html).ok).toBe(true);
  });

  it("defines exact errors for every reject fixture", () => {
    expect(Object.keys(expectedErrorsByRejectFixture).sort()).toEqual(
      rejectFixtures.map(({ filename }) => filename)
    );
  });

  it.each(rejectFixtures)("rejects $filename for its specified reason", ({ filename, html }) => {
    const expectedErrors = expectedErrorsByRejectFixture[filename];
    if (!expectedErrors) {
      throw new Error(`Missing expected errors for ${filename}.`);
    }

    expect(validateHtml(html).errors).toEqual(expectedErrors);
  });

  it("warns when title is missing", () => {
    const result = validateHtml("<main>No title</main>");

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("No <title> found; Patchy Cloud will use a generic title.");
  });
});
