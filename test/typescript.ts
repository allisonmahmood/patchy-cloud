import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const patchy = fileURLToPath(new URL("../packages/patchy/dist/", import.meta.url));
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

/**
 * TypeScript's verdict on `files` against the built `patchy` package, one line per diagnostic and
 * none when they pass: strict, bundler resolution, and `patchy/client` and `patchy/config` from
 * the published declarations, as a patch repo's `tsc --noEmit` reads them. Name each file
 * relative to a directory of their own, such as `consumer.ts`.
 */
export const typecheck = (files: Readonly<Record<string, string>>): readonly string[] => {
  const dir = mkdtempSync(path.join(tmpdir(), "patchy-typecheck-"));
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(path.join(dir, name), source);
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM"],
          types: [],
          resolveJsonModule: true,
          skipLibCheck: true,
          paths: {
            "patchy/client": [path.join(patchy, "client.d.ts")],
            "patchy/config": [path.join(patchy, "config.d.ts")]
          }
        },
        files: Object.keys(files)
      })
    );
    const result = spawnSync(process.execPath, [tsc, "-p", dir, "--pretty", "false"], {
      encoding: "utf8"
    });
    if (result.error) throw result.error;
    const lines = `${result.stdout}${result.stderr}`
      .split("\n")
      .filter((line) => line.trim() !== "");
    // Only a compiler that finished has a verdict: one killed, or failing without diagnostics,
    // checked nothing.
    if (
      result.signal !== null ||
      (result.status !== 0 && !lines.some((line) => /error TS\d+:/.test(line)))
    )
      throw new Error(
        `tsc did not finish (${result.signal ?? `exit ${result.status}`}):\n${lines.join("\n")}`
      );
    return lines;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
