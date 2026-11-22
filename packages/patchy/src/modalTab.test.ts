import { expect, it } from "vitest";
import { movesByOptionTab, type OptionTabBrowser } from "./modalTab.js";

const macSafari =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15";
const macChrome =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const linuxChrome =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const browsers: ReadonlyArray<readonly [string, OptionTabBrowser, boolean]> = [
  ["Safari on a Mac", { platform: "MacIntel", userAgent: macSafari, maxTouchPoints: 0 }, true],
  [
    "Chrome on a Mac",
    {
      platform: "MacIntel",
      userAgent: macChrome,
      maxTouchPoints: 0,
      userAgentData: { platform: "macOS" }
    },
    true
  ],
  [
    "Edge on a Mac",
    {
      platform: "MacIntel",
      userAgent: `${macChrome} Edg/142.0.0.0`,
      maxTouchPoints: 0,
      userAgentData: { platform: "macOS" }
    },
    true
  ],
  [
    "Firefox on a Mac",
    {
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0",
      maxTouchPoints: 0
    },
    false
  ],
  [
    "Safari on an iPad asking for desktop pages",
    { platform: "MacIntel", userAgent: macSafari, maxTouchPoints: 5 },
    false
  ],
  [
    "Safari on an iPhone",
    {
      platform: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1",
      maxTouchPoints: 5
    },
    false
  ],
  [
    "Chrome on Linux",
    {
      platform: "Linux x86_64",
      userAgent: linuxChrome,
      maxTouchPoints: 0,
      userAgentData: { platform: "Linux" }
    },
    false
  ],
  [
    "Chrome on Linux claiming a Mac's agent",
    {
      platform: "Linux x86_64",
      userAgent: macChrome,
      maxTouchPoints: 0,
      userAgentData: { platform: "Linux" }
    },
    false
  ],
  [
    "Chrome on Windows",
    {
      platform: "Win32",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      maxTouchPoints: 0,
      userAgentData: { platform: "Windows" }
    },
    false
  ]
];

it.each(browsers.map(([name, browser, moves]) => ({ name, browser, moves })))(
  "Option+Tab moves focus in $name: $moves",
  ({ browser, moves }) => {
    expect(movesByOptionTab(browser)).toBe(moves);
  }
);
