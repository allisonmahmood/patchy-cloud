import { describe, expect, it } from "vitest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cookies from "effect/http/Cookies";
import * as Receipt from "./Receipt.js";

const https = "https://cloud.example";
const local = "http://acme.localhost:3000";

/** The cookies a browser would send back after `response`. */
const jar = (response: HttpServerResponse.HttpServerResponse) =>
  Object.fromEntries(
    Object.values(response.cookies.cookies).map((cookie) => [cookie.name, cookie.value])
  );

describe("Receipt", () => {
  it("shows a receipt once to the person it was left for", () => {
    const response = Receipt.set(HttpServerResponse.redirect("/machines"), {
      userId: "usr_a",
      text: "Revoked Studio Mac mini",
      publicBaseUrl: https
    });
    const [line] = Cookies.toSetCookieHeaders(response.cookies);
    expect(line).toMatch(/^__Host-patchy_receipt=[\w-]+;/);
    for (const attribute of ["Path=/", "Max-Age=60", "HttpOnly", "Secure"])
      expect(line).toContain(attribute);
    expect(line?.toLowerCase()).toContain("samesite=lax");
    const taken = Receipt.take(jar(response), { userId: "usr_a", publicBaseUrl: https });
    expect(taken.text).toBe("Revoked Studio Mac mini");
    expect(taken.clear).toEqual([
      "__Host-patchy_receipt=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure"
    ]);
  });

  it("clears without showing a receipt left for someone else or one it can't read", () => {
    const response = Receipt.set(HttpServerResponse.redirect("/"), {
      userId: "usr_a",
      text: "Invited 2 people",
      publicBaseUrl: local
    });
    const other = Receipt.take(jar(response), { userId: "usr_b", publicBaseUrl: local });
    expect(other.text).toBeUndefined();
    expect(other.clear).toHaveLength(1);
    const forged = Receipt.take(
      { patchy_receipt: "not-a-receipt" },
      { userId: "usr_a", publicBaseUrl: local }
    );
    expect(forged.text).toBeUndefined();
    expect(Receipt.take({}, { userId: "usr_a", publicBaseUrl: local })).toEqual({
      text: undefined,
      clear: []
    });
  });

  it("keeps a long receipt to one sentence's worth", () => {
    const response = Receipt.set(HttpServerResponse.redirect("/"), {
      userId: "usr_a",
      text: "x".repeat(1_000),
      publicBaseUrl: local
    });
    expect(
      Receipt.take(jar(response), { userId: "usr_a", publicBaseUrl: local }).text
    ).toHaveLength(300);
  });
});
