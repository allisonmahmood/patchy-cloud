import { expect, it } from "vitest";
import { builderLimitGroups, renderBuilderLimits } from "./builderLimits.js";
import { registry, type LimitId } from "./registry.js";

const page = renderBuilderLimits();
const allowlist = builderLimitGroups.flatMap((group) => group.rows.map((row) => row.id));
// Each table row's first cell ends with its limit's id: `| <what> \`<id>\` | …`.
const rows = new Map(
  [...page.matchAll(/^\| [^|]* `([^`]+)` \|.*$/gm)].map((match) => [match[1] as LimitId, match[0]])
);

it("shows exactly the allowlisted limits, each once", () => {
  expect(new Set(allowlist).size).toBe(allowlist.length);
  expect([...rows.keys()].sort()).toEqual([...allowlist].sort());
  // Prose never names a limit the allowlist leaves out either.
  const named = Object.keys(registry).filter((id) => page.includes(`\`${id}\``));
  expect(named.sort()).toEqual([...allowlist].sort());
});

it("labels a deployment's operating values as defaults and nothing else", () => {
  for (const [id, line] of rows)
    expect(line.includes("(default)"), id).toBe(registry[id].kind === "operating");
});
