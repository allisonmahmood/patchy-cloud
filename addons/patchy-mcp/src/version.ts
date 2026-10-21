import { readFileSync } from "node:fs";

export const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const buildId: string = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL("./build-info.json", import.meta.url), "utf8"),
    ).buildId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return "development";
    throw new Error("Invalid build identity; reinstall this connector build.");
  }
})();
