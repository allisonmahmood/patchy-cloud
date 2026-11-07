import { describe, expect, it } from "vitest";
import { SWITCHER_RELAY_SOURCE } from "@patchy/core/html";
import {
  CONTENT_SECURITY_POLICY,
  PATCH_CONTENT_SECURITY_POLICY,
  shellContentSecurityPolicy
} from "./shell-headers.js";

const scriptSources = (policy: string) =>
  policy
    .split("; ")
    .find((directive) => directive.startsWith("script-src "))
    ?.split(" ")
    .slice(1);

describe("the switcher relay's hash", () => {
  it("admits the relay in every shell and notice, beside their external scripts", () => {
    expect(scriptSources(shellContentSecurityPolicy())).toEqual(["'self'", SWITCHER_RELAY_SOURCE]);
    expect(scriptSources(shellContentSecurityPolicy("clerk.example.test"))).toEqual([
      "'self'",
      "https://clerk.example.test",
      SWITCHER_RELAY_SOURCE
    ]);
    expect(scriptSources(PATCH_CONTENT_SECURITY_POLICY)).toEqual([SWITCHER_RELAY_SOURCE]);
  });

  it("stays out of a patch's own document, whose inline script a hash would switch off", () => {
    expect(scriptSources(CONTENT_SECURITY_POLICY)).toEqual(["'unsafe-inline'"]);
  });
});
