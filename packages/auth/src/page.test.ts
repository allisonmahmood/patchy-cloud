import { describe, expect, it } from "vitest";
import { SWITCHER_RELAY_SOURCE, switcherRelay, uiScriptTag } from "@patchy/core";
import { pageResponse } from "./page.js";

const app = {
  viewer: {
    user: { id: "usr_sam", name: "Sam", email: "sam@northwind.example" },
    company: { id: "cmp_northwind", name: "Northwind" },
    whatsNewSeen: 0
  },
  section: "people"
} as const;
const clerk = { frontendApiHost: "clerk.example.test", publishableKey: "pk_test_example" };

describe("pageResponse", () => {
  it.each([
    [
      "an app page signed in through Clerk",
      pageResponse({ title: "People", body: "", app }, { clerk }),
      ["'self'", "https://clerk.example.test"]
    ],
    [
      "an app page with dev personas",
      pageResponse({ title: "People", body: "", app }, { clerk: undefined }),
      ["'self'"]
    ],
    [
      "a door that loads Clerk",
      pageResponse({ title: "Sign in", body: "" }, { clerk }),
      ["'self'", "https://clerk.example.test"]
    ],
    ["a door with no session script", pageResponse({ title: "Sign in", body: "" }), ["'self'"]]
  ] as const)(
    "admits the switcher relay it renders, no other inline script, and the enhancer, on %s",
    (_, page, sources) => {
      const scriptSources = page.headers["content-security-policy"]
        ?.split("; ")
        .find((directive) => directive.startsWith("script-src "))
        ?.split(" ")
        .slice(1);
      expect(scriptSources).toEqual([...sources, SWITCHER_RELAY_SOURCE]);
      const html = page.body._tag === "Uint8Array" && new TextDecoder().decode(page.body.body);
      expect(html).toContain(switcherRelay);
      // Every page loads the enhancer from this origin, which is why even a bare door admits 'self'.
      expect(html).toContain(uiScriptTag);
    }
  );
});
