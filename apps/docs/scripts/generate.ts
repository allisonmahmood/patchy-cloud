// Writes the Limits page from the limits registry. `dev` and `build` run it first, so every
// build renders the registry it was built from and no checked-in copy can go stale; the page
// is gitignored.
import { writeFile } from "node:fs/promises";
import { renderBuilderLimits } from "@patchy/limits/render";

const page = [
  "---",
  "title: Limits",
  "description: The limits a patch, its handlers and people's agents meet, and what happens at each.",
  "---",
  "",
  renderBuilderLimits()
].join("\n");

await writeFile(new URL("../content/docs/limits.md", import.meta.url), page);
