import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installCommand } from "./install.js";

/** An address that ends a naive quote, then substitutes a command. */
const hostile = "https://example.invalid/'$(touch${IFS}substituted)'";

describe("the install line", () => {
  it.skipIf(process.platform === "win32")("hands curl any address as one literal word", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "patchy install line "));
    try {
      // Stand-ins that record what they were given instead of downloading or running anything.
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "curl"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$RECORD"\n', {
        mode: 0o755
      });
      writeFileSync(path.join(bin, "node"), "#!/bin/sh\n", { mode: 0o755 });
      const result = spawnSync("sh", ["-c", installCommand(hostile, "posix")], {
        cwd: dir,
        env: {
          PATH: [bin, "/usr/bin", "/bin"].join(":"),
          TMPDIR: dir,
          RECORD: path.join(dir, "args")
        },
        encoding: "utf8"
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path.join(dir, "args"), "utf8").split("\n")[1]).toBe(
        `${hostile}/install.mjs`
      );
      expect(existsSync(path.join(dir, "substituted"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doubles every quote that ends a PowerShell single-quoted string", () => {
    expect(installCommand("https://example.invalid/'\u{2019}\u{2018}", "powershell")).toContain(
      "-UseBasicParsing 'https://example.invalid/''\u{2019}\u{2019}\u{2018}\u{2018}/install.mjs' -OutFile"
    );
  });
});
