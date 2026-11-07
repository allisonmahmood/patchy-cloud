import { describe, expect, it } from "vitest";
import { SWITCHER_RELAY_SOURCE, switcherRelay } from "@patchy/core";
import { pageResponse } from "./page.js";

const app = {
  viewer: {
    user: { name: "Sam", email: "sam@northwind.example" },
    company: { name: "Northwind" },
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
    ["a door with no script of its own", pageResponse({ title: "Sign in", body: "" }), []]
  ] as const)(
    "admits the switcher relay it renders, and no other inline script, on %s",
    (_, page, sources) => {
      const scriptSources = page.headers["content-security-policy"]
        ?.split("; ")
        .find((directive) => directive.startsWith("script-src "))
        ?.split(" ")
        .slice(1);
      expect(scriptSources).toEqual([...sources, SWITCHER_RELAY_SOURCE]);
      expect(page.body._tag === "Uint8Array" && new TextDecoder().decode(page.body.body)).toContain(
        switcherRelay
      );
    }
  );
});
