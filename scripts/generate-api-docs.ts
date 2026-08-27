import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { renderApiReference } from "../packages/core/src/wire.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const formatted = await format(renderApiReference(), { parser: "markdown" });
writeFileSync(path.join(repoRoot, "docs/API.md"), formatted);
