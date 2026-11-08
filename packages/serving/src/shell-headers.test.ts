import { describe, expect, it } from "vitest";
import { SWITCHER_RELAY_SOURCE } from "@patchy/core/html";
import {
  CONTENT_SECURITY_POLICY,
  NOTICE_SECURITY_POLICY,
  noticeContentSecurityPolicy,
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
    expect(scriptSources(NOTICE_SECURITY_POLICY)).toEqual([SWITCHER_RELAY_SOURCE]);
  });

  it("admits a signed-in viewer's notice scripts from Patchy and Clerk, and nothing else new", () => {
    expect(scriptSources(noticeContentSecurityPolicy())).toEqual(["'self'", SWITCHER_RELAY_SOURCE]);
    const clerk = noticeContentSecurityPolicy("clerk.example.test").split("; ");
    expect(scriptSources(clerk.join("; "))).toEqual([
      "'self'",
      "https://clerk.example.test",
      SWITCHER_RELAY_SOURCE
    ]);
    expect(clerk).toContain("connect-src 'self' https://clerk.example.test");
    expect(clerk).toContain("worker-src blob:");
    // Otherwise it is the notice's own policy: no frames, no forms, no other origin.
    const rest = (policy: ReadonlyArray<string>) =>
      policy.filter((directive) => !/^(script|connect|worker)-src /.test(directive));
    expect(rest(clerk)).toEqual(rest(NOTICE_SECURITY_POLICY.split("; ")));
  });

  it("stays out of a patch's own document, whose inline script a hash would switch off", () => {
    expect(scriptSources(CONTENT_SECURITY_POLICY)).toEqual(["'unsafe-inline'"]);
  });
});
