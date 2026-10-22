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

  it("treats a trailing dot on the configured host the same way", () => {
    const dotted = new URL("https://cloud.patchyhq.com.");
    for (const host of ["cloud.patchyhq.com", "cloud.patchyhq.com.", "cloud.patchyhq.com:443"])
      assert.isTrue(RequestTrust.isOwnHost(host, dotted), host);
  });

  it("reads an absolute-form target's authority, and refuses two Host fields", () => {
    const node = (rawHeaders: string[]) => ({ rawHeaders });
    assert.strictEqual(
      RequestTrust.requestAuthority({
        url: "/mcp",
        headers: { host: "cloud.patchyhq.com" },
        source: node(["Host", "cloud.patchyhq.com"])
      }),
      "cloud.patchyhq.com"
    );
    assert.strictEqual(
      RequestTrust.requestAuthority({
        url: "http://evil.example/mcp",
        headers: { host: "cloud.patchyhq.com" },
        source: node(["Host", "cloud.patchyhq.com"])
      }),
      "evil.example:80"
    );
    // A scheme's default port is the target's, never the public origin's by omission.
    for (const [url, authority] of [
      ["http://cloud.patchyhq.com/mcp", "cloud.patchyhq.com:80"],
      ["https://cloud.patchyhq.com/mcp", "cloud.patchyhq.com:443"],
      ["https://cloud.patchyhq.com:8443/mcp", "cloud.patchyhq.com:8443"],
      ["HTTPS://Cloud.PatchyHQ.com/mcp", "Cloud.PatchyHQ.com:443"]
    ] as const)
      assert.strictEqual(
        RequestTrust.requestAuthority({ url, headers: {}, source: node([]) }),
        authority,
        url
      );
    assert.isTrue(
      RequestTrust.isOwnHost(
        RequestTrust.requestAuthority({
          url: "HTTPS://Cloud.PatchyHQ.com/mcp",
          headers: {},
          source: node([])
        }),
        production
      )
    );
    assert.isFalse(
      RequestTrust.isOwnHost(
        RequestTrust.requestAuthority({
          url: "http://cloud.patchyhq.com/mcp",
          headers: {},
          source: node([])
        }),
        production
      )
    );
    for (const url of ["https://user@cloud.patchyhq.com/mcp", "ftp://cloud.patchyhq.com/mcp"])
      assert.isUndefined(
        RequestTrust.requestAuthority({ url, headers: { host: "cloud.patchyhq.com" }, source: {} }),
        url
      );
    assert.isUndefined(
      RequestTrust.requestAuthority({
        url: "/mcp",
        headers: { host: "cloud.patchyhq.com" },
        source: node(["Host", "cloud.patchyhq.com", "host", "evil.example"])
      })
    );
    // A request built from a web Request has no raw fields: one Host is all it can carry.
    assert.strictEqual(
      RequestTrust.requestAuthority({ url: "/mcp", headers: { host: "a.example" }, source: {} }),
      "a.example"
    );
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
      "https://evil.example",
      "https://%C3%A9.example",
      "http://[v1.fe]:8080"
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
      "https://cla ude.ai",
      "https://[:::]",
      "https://[1]",
      "https://%",
      "https://%zz.example",
      "https://[::1"
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
