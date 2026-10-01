import { expect, it } from "vitest";
import { installFailureReason, releaseFromPin, withTarballIntegrity } from "./packagePin.js";

const digest = "a".repeat(64);

it.each([
  [`https://patchy-cloud.example/sdk/patchy-0.0.1-${digest}.tgz`, "0.0.1"],
  [`https://patchy.example/sdk/patchy-1.2.3-rc.1-${digest}.tgz?download=1#archive`, "1.2.3-rc.1"],
  ["https://patchy-cloud.example/sdk/patchy-0.0.1.tgz", "0.0.1"],
  ["patchy-1.2.3-rc.1.tgz", "1.2.3-rc.1"],
  ["file:../local-package", "file:../local-package"],
  ["https://patchy-cloud.example/other.tgz", "https://patchy-cloud.example/other.tgz"]
])("reports the release without the host or digest for %s", (pin, expected) => {
  expect(releaseFromPin(pin)).toBe(expected);
});

const pinned = `http://127.0.0.1:4100/sdk/patchy-0.0.1-${digest}.tgz`;
const other = `http://127.0.0.1:4100/sdk/patchy-0.0.0-${"b".repeat(64)}.tgz`;
const integrity = `sha512-${"A".repeat(86)}==`;
const lockfile = (resolution: string) => `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      patchy:
        specifier: ${pinned}
        version: ${pinned}

packages:

  patchy@${pinned}:
    resolution: ${resolution}
    version: 0.0.1
    hasBin: true

  vendored@${other}:
    resolution: {tarball: ${other}}
    version: 0.0.0

  workerd@1.20260924.1:
    resolution: {integrity: sha512-${"C".repeat(86)}==}

snapshots:

  patchy@${pinned}: {}
`;

it("adds the reported integrity to the pinned tarball's entry only", () => {
  expect(withTarballIntegrity(lockfile(`{tarball: ${pinned}}`), pinned, integrity)).toBe(
    lockfile(`{integrity: ${integrity}, tarball: ${pinned}}`)
  );
});

it("leaves an entry that already carries an integrity unchanged", () => {
  const recorded = lockfile(`{integrity: sha512-${"D".repeat(86)}==, tarball: ${pinned}}`);
  expect(withTarballIntegrity(recorded, pinned, integrity)).toBe(recorded);
});

it("repairs the entry when pnpm quotes the URL, as it does for an IPv6 host", () => {
  const ipv6 = `http://[::1]:4100/sdk/patchy-0.0.1-${digest}.tgz`;
  const entry = (resolution: string) => `  patchy@${ipv6}:\n    resolution: ${resolution}\n`;
  expect(withTarballIntegrity(entry(`{tarball: '${ipv6}'}`), ipv6, integrity)).toBe(
    entry(`{integrity: ${integrity}, tarball: '${ipv6}'}`)
  );
});

it("relays pnpm's error line without URL credentials, queries or fragments", () => {
  const output = [
    "Progress: resolved 1",
    " ERR_PNPM_FETCH_401  GET https://user:secret@registry.example/pkg.tgz?token=abc#x: Unauthorized",
    "later line"
  ].join("\n");
  expect(installFailureReason(output)).toBe(
    "ERR_PNPM_FETCH_401  GET https://registry.example/pkg.tgz Unauthorized"
  );
  expect(installFailureReason("only line\u0007")).toBe("only line");
  expect(installFailureReason("")).toBeUndefined();
  expect(installFailureReason(`ERR_PNPM_X ${"y".repeat(400)}`)).toHaveLength(300);
});
