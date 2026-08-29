import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workspaceLibraries = [
  {
    packageName: "@patchy/config",
    sourceUrl: pathToFileURL(
      path.resolve(import.meta.dirname, "../../../packages/config/src/index.ts")
    ).href,
    resolve: () => import.meta.resolve("@patchy/config")
  },
  {
    packageName: "@patchy/core",
    sourceUrl: pathToFileURL(
      path.resolve(import.meta.dirname, "../../../packages/core/src/index.ts")
    ).href,
    resolve: () => import.meta.resolve("@patchy/core")
  },
  {
    packageName: "@patchy/db",
    sourceUrl: pathToFileURL(path.resolve(import.meta.dirname, "../../../packages/db/src/index.ts"))
      .href,
    resolve: () => import.meta.resolve("@patchy/db")
  },
  {
    packageName: "@patchy/content-store",
    sourceUrl: pathToFileURL(
      path.resolve(import.meta.dirname, "../../../packages/content-store/src/index.ts")
    ).href,
    resolve: () => import.meta.resolve("@patchy/content-store")
  }
];

describe("workspace development exports", () => {
  it.each(workspaceLibraries)(
    "resolves $packageName from source under Vitest",
    ({ resolve, sourceUrl }) => {
      expect(resolve()).toBe(sourceUrl);
    }
  );

  it("resolves every workspace library from source under tsx", async () => {
    const packageNames = workspaceLibraries.map(({ packageName }) => packageName);
    const probe = `console.log(JSON.stringify(${JSON.stringify(packageNames)}.map((name) => import.meta.resolve(name))))`;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--conditions=development", "--input-type=module", "--eval", probe],
      { cwd: path.resolve(import.meta.dirname, "..") }
    );

    expect(JSON.parse(stdout)).toEqual(workspaceLibraries.map(({ sourceUrl }) => sourceUrl));
  });
});
