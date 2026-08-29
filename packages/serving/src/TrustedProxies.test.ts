import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as TrustedProxies from "./TrustedProxies.js";

const ranges = (value: string) => {
  const parsed = TrustedProxies.parse(value);
  assert.isNotNull(parsed, value);
  return parsed as ReadonlyArray<TrustedProxies.Range>;
};
const resolve = (trust: string | undefined, remote: string, forwardedFor?: string) =>
  Option.getOrNull(
    TrustedProxies.resolve(
      trust === undefined ? [] : ranges(trust),
      Option.some(remote),
      forwardedFor
    )
  );

describe("TrustedProxies", () => {
  it("attributes the socket address unless a trusted proxy forwarded the request", () => {
    assert.strictEqual(resolve(undefined, "192.0.2.10"), "192.0.2.10");
    // A forwarding header from a direct peer is anyone's to write, so it is ignored.
    assert.strictEqual(resolve(undefined, "192.0.2.10", "203.0.113.9, 198.51.100.7"), "192.0.2.10");
    assert.strictEqual(resolve("10.0.0.0/8", "192.0.2.10", "203.0.113.9, 10.0.0.5"), "192.0.2.10");
    // Through a trusted network the rightmost address it did not add is the client's.
    assert.strictEqual(
      resolve("10.0.0.0/8", "10.0.0.5", "203.0.113.9, 198.51.100.7"),
      "198.51.100.7"
    );
    assert.strictEqual(
      resolve("10.0.0.0/8, 198.51.100.0/24", "10.0.0.5", "203.0.113.9, 198.51.100.7"),
      "203.0.113.9"
    );
    // A chain trusted end to end names its leftmost entry; an empty one, the socket.
    assert.strictEqual(resolve("10.0.0.0/8", "10.0.0.5", "10.0.0.7"), "10.0.0.7");
    assert.strictEqual(resolve("10.0.0.0/8", "10.0.0.5"), "10.0.0.5");
    // A dual-stack socket reports IPv4 peers as mapped IPv6; they are the same address.
    assert.strictEqual(resolve("127.0.0.1", "::ffff:127.0.0.1", "203.0.113.9"), "203.0.113.9");
  });

  it("refuses hop counts and blanket trust before a peer can choose its own attribution", () => {
    for (const value of [
      "1",
      "32",
      "",
      "10.0.0.0/8, nonsense",
      "fe80::1%eth0",
      "::ffff:0:0/96",
      "::0.0.0.0/96",
      "::192.0.2.10",
      "::192.0.2.0/120",
      "::/1",
      "0.0.0.0/1,128.0.0.0/1",
      "::ffff:10.0.0.0/104",
      "0:0:0:0:0:ffff:a00:0/104",
      "::fffe:0:0/95",
      "::ffff:0:0/95"
    ]) {
      assert.isNull(TrustedProxies.parse(value), value);
    }
    assert.deepStrictEqual(
      ranges("10.0.0.0/8, 2001:db8::/32").map((range) => range.family),
      [4, 6]
    );
  });
});
