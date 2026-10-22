import { assert, describe, it } from "@effect/vitest";
import * as RequestTrust from "./RequestTrust.js";

const production = new URL("https://cloud.patchyhq.com");
const dev = new URL("http://patchy-abc.localhost:29276");

describe("the Host gate", () => {
  it("takes the configured host whatever its case, a trailing dot or the default port", () => {
    for (const host of [
      "cloud.patchyhq.com",
      "Cloud.PatchyHQ.com",
      "cloud.patchyhq.com.",
      "cloud.patchyhq.com:443",
      "CLOUD.PATCHYHQ.COM.:443"
    ])
      assert.isTrue(RequestTrust.isOwnHost(host, production), host);
    for (const host of ["patchy-abc.localhost:29276", "PATCHY-ABC.localhost.:29276"])
      assert.isTrue(RequestTrust.isOwnHost(host, dev), host);
    assert.isTrue(RequestTrust.isOwnHost("127.0.0.1:3000", new URL("http://127.0.0.1:3000")));
    assert.isTrue(RequestTrust.isOwnHost("localhost", new URL("http://localhost")));
    assert.isTrue(RequestTrust.isOwnHost("localhost:80", new URL("http://localhost")));
  });

  it("refuses any other host, port or spelling, and a missing one", () => {
    for (const host of [
      undefined,
      "",
      "evil.example",
      "cloud.patchyhq.com.evil.example",
      "evil.cloud.patchyhq.com",
      "cloud.patchyhq.com:8443",
      "cloud.patchyhq.com:80",
      "cloud.patchyhq.com..",
      "user@cloud.patchyhq.com",
      "cloud.patchyhq.com/mcp",
      "cloud.patchyhq.com:",
      "cloud.patchyhq.com:443:443",
      " cloud.patchyhq.com",
      "cloud.patchyhq.com, evil.example"
    ])
      assert.isFalse(RequestTrust.isOwnHost(host, production), String(host));
    // DNS rebinding: a stranger's name pointed at the dev instance's address.
    for (const host of ["evil.example:29276", "127.0.0.1:29276", "localhost:29276"])
      assert.isFalse(RequestTrust.isOwnHost(host, dev), host);
    assert.isFalse(RequestTrust.isOwnHost("127.0.0.1:3001", new URL("http://127.0.0.1:3000")));
  });
});

describe("the Origin rules", () => {
  it("in production pass no Origin and any well-formed one, null and odd schemes included", () => {
    for (const origin of [
      undefined,
      "null",
      "https://claude.ai",
      "https://chatgpt.com:8443",
      "http://localhost:6274",
      "http://[::1]:5173",
      "vscode-webview://1a2b3c",
      "chrome-extension://abcdefghijklmnop",
      "tauri://localhost",
      "https://evil.example"
    ])
      assert.strictEqual(RequestTrust.checkOrigin(origin, production), "allowed", String(origin));
  });

  it("refuses a malformed or duplicated Origin", () => {
    for (const origin of [
      "",
      "claude.ai",
      "https://",
      "https://claude.ai/",
      "https://claude.ai/path",
      "https://claude.ai?x",
      "https://user@claude.ai",
      "https://claude.ai:port",
      "1https://claude.ai",
      "Null",
      "null, null",
      // How Node hands over two Origin headers.
      "https://claude.ai, https://evil.example",
      "https://claude.ai,https://evil.example",
      "https://cla ude.ai"
    ])
      assert.strictEqual(RequestTrust.checkOrigin(origin, production), "malformed", origin);
  });

  it("on a dev instance, passes no Origin or its own and refuses every other", () => {
    assert.strictEqual(RequestTrust.checkOrigin(undefined, dev), "allowed");
    assert.strictEqual(
      RequestTrust.checkOrigin("http://patchy-abc.localhost:29276", dev),
      "allowed"
    );
    for (const origin of [
      "null",
      "https://claude.ai",
      "http://evil.example:29276",
      "http://127.0.0.1:29276",
      "https://patchy-abc.localhost:29276"
    ])
      assert.strictEqual(RequestTrust.checkOrigin(origin, dev), "foreign", origin);
    assert.strictEqual(RequestTrust.checkOrigin("https://claude.ai, null", dev), "malformed");
  });
});
