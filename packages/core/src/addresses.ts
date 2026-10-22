// @effect-diagnostics nodeBuiltinImport:off -- IP classification needs Node's BlockList.
import { BlockList, isIP } from "node:net";

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const)
  privateAddresses.addSubnet(address, prefix, "ipv4");
// Azure's platform virtual address is neither RFC1918 nor link-local.
privateAddresses.addAddress("168.63.129.16", "ipv4");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20]
] as const) {
  privateAddresses.addSubnet(address, prefix, "ipv6");
}

/**
 * Whether Patchy may connect to `address` when a stranger names the host: global unicast only.
 * Private, loopback, link-local, cloud metadata, special-use and documentation ranges are
 * refused, and so is every IPv6 form that carries an IPv4 address (mapped, compatible, NAT64,
 * 6to4, Teredo), since only `2000::/3` is allowed. A string that isn't an address is refused.
 */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !privateAddresses.check(address, "ipv4");
  return (
    family === 6 && globalIpv6.check(address, "ipv6") && !privateAddresses.check(address, "ipv6")
  );
};
