import { expect, it } from "vitest";
import { releaseFromPin } from "./packagePin.js";

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
