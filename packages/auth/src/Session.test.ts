/**
 * Tests for Clerk session authentication (`Session`).
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { buildClerkRequest, signOutCookies } from "./Session.js";

describe("buildClerkRequest", () => {
  it("builds a Clerk request from method, path, and publicBaseUrl", () => {
    const request = buildClerkRequest({
      method: "GET",
      path: "/api/foo",
      publicBaseUrl: "https://patchy.example.com",
    });
    assert.strictEqual(request.method, "GET");
    assert.strictEqual(request.url, "https://patchy.example.com/api/foo");
  });

  it("forwards cookies when provided", () => {
    const request = buildClerkRequest({
      method: "GET",
      path: "/",
      publicBaseUrl: "https://patchy.example.com",
      cookies: "__session=abc123",
    });
    assert.strictEqual(request.headers.get("cookie"), "__session=abc123");
  });

  it("does not forward cookies when absent", () => {
    const request = buildClerkRequest({
      method: "GET",
      path: "/",
      publicBaseUrl: "https://patchy.example.com",
    });
    assert.strictEqual(request.headers.get("cookie"), null);
  });
});

describe("signOutCookies", () => {
  it("returns a clear cookie for every known Clerk cookie name", () => {
    const cookies = signOutCookies("https://patchy.example.com");
    assert.isArray(cookies);
    assert.isNotEmpty(cookies);
    for (const cookie of cookies) {
      assert.strictEqual(cookie.value, "");
      assert.strictEqual(cookie.options["max-age"], 0);
      assert.isTrue(cookie.options.httpOnly);
    }
  });

  it("uses secure: true for https origins", () => {
    const cookies = signOutCookies("https://patchy.example.com");
    for (const cookie of cookies) {
      assert.isTrue(cookie.options.secure);
    }
  });

  it("uses secure: false for http origins", () => {
    const cookies = signOutCookies("http://localhost:3000");
    for (const cookie of cookies) {
      assert.isFalse(cookie.options.secure);
    }
  });
});
