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

it("relays pnpm 12's code and causes, one per line under NO_GRAPHICS", () => {
  const notFound = [
    "Error: installing dependencies",
    "    Diagnostic severity: error",
    "    Caused by: Failed to resolve dependency tree: GET http://127.0.0.1:4100/zz-missing-pkg: Not Found - 404",
    "diagnostic help: zz-missing-pkg is not in the npm registry. ERR_PNPM_NOT_THIS_ONE",
    "",
    "No authorization header was set for the request.",
    "diagnostic code: ERR_PNPM_FETCH_404"
  ].join("\n");
  expect(installFailureReason(notFound)).toBe(
    "ERR_PNPM_FETCH_404: Failed to resolve dependency tree: GET http://127.0.0.1:4100/zz-missing-pkg: Not Found - 404"
  );
  const refused = [
    "Error: installing dependencies",
    "    Diagnostic severity: error",
    "    Caused by: Failed to resolve dependency: error sending request for url (https://registry.example/patchy-0.0.1.tgz?token=secret#frag)",
    "    Caused by: client error (Connect)",
    "    Caused by: Connection refused (os error 111)"
  ].join("\n");
  expect(installFailureReason(refused)).toBe(
    "Failed to resolve dependency: error sending request for url (https://registry.example/patchy-0.0.1.tgz: client error (Connect): Connection refused (os error 111)"
  );
});

it("redacts URLs whatever their scheme's case or path characters", () => {
  const relay = (url: string) => installFailureReason(`ERR_PNPM_X GET ${url} failed`);
  expect(relay("HTTPS://user:pass@registry.example/pkg?token=s")).toBe(
    "ERR_PNPM_X GET HTTPS://registry.example/pkg failed"
  );
  expect(relay("https://user:p@ss@registry.example/pkg")).toBe(
    "ERR_PNPM_X GET https://registry.example/pkg failed"
  );
  for (const inner of ["'", '"', "\u00a0"])
    expect(relay(`https://registry.example/a${inner}b.tgz?token=s#f`)).toBe(
      `ERR_PNPM_X GET https://registry.example/a${inner}b.tgz failed`
    );
});

it("reads causes only from pnpm 12's narrated report", () => {
  const legacy = 'ERR_PNPM_BAD Tarball "https://registry.example/p.tgz" is bad\nCaused by: detail';
  expect(installFailureReason(legacy)).toBe(
    'ERR_PNPM_BAD Tarball "https://registry.example/p.tgz" is bad'
  );
});
