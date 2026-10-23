import { assert, it } from "@effect/vitest";
import { isPublicAddress } from "./addresses.js";

it("refuses non-global addresses, including cloud metadata, IPv6 aliases and transition ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "169.254.170.2",
    "100.100.100.200",
    "168.63.129.16",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::a9fe:a9fe",
    "2002:7f00:1::1",
    "2001::1",
    "2001:db8::1",
    "3fff::1",
    "not-an-ip"
  ])
    assert.isFalse(isPublicAddress(address), address);
  assert.isTrue(isPublicAddress("8.8.8.8"));
  assert.isTrue(isPublicAddress("2606:4700:4700::1111"));
});
