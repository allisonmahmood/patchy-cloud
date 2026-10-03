import { describe, expect, it } from "vitest";
import { readFixtureCorpus } from "../../../test/html-fixtures.mjs";
import { BLOCKED_PROTOCOLS, BLOCKED_TAGS, validateHtml } from "./html-policy.js";

type BlockedTag = (typeof BLOCKED_TAGS)[number];
type Scheme<Protocol> = Protocol extends `${infer Name}:` ? Name : never;
type BlockedScheme = Scheme<(typeof BLOCKED_PROTOCOLS)[number]>;

/** Adding a blocked tag or protocol fails typecheck until it has a reject fixture. */
type RequiredRejectFixtures = Record<
  `blocked-tag-${BlockedTag}.html` | `blocked-protocol-${BlockedScheme}.html`,
  readonly string[]
> &
  Readonly<Record<string, readonly string[]>>;

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
} satisfies RequiredRejectFixtures;

const acceptFixtures = await readFixtureCorpus("accept");
const rejectFixtures = await readFixtureCorpus("reject");

describe("validateHtml", () => {
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
