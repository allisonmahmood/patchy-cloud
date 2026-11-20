import { expect, it } from "vitest";
import { builderLimitGroups, formatValue, renderBuilderLimits } from "./builderLimits.js";
import { registry, type LimitId } from "./registry.js";

const page = renderBuilderLimits();
const allowlist = builderLimitGroups.flatMap((group) => group.rows.map((row) => row.id));
// Every table body row on the page, header and divider rows left out, split into its cells.
const rows = page
  .split("\n")
  .filter((line) => line.startsWith("|") && !/^\| (Limit|---) \|/.test(line))
  .map((line) => ({ line, cells: line.slice(2, -2).split(" | ") }));
// A row's first cell ends with its limit's id: `<what> \`<id>\``.
const idOf = (cell: string | undefined) => /`([^`]+)`$/.exec(cell ?? "")?.[1];
const isLimitId = (id: string | undefined): id is LimitId => id !== undefined && id in registry;

it("shows exactly the allowlisted limits, each once", () => {
  expect(new Set(allowlist).size).toBe(allowlist.length);
  for (const { line, cells } of rows) expect(isLimitId(idOf(cells[0])), line).toBe(true);
  // The full list in page order, so an extra, missing or repeated row fails here.
  expect(rows.map(({ cells }) => idOf(cells[0]))).toEqual(allowlist);
  // Prose never names a limit the allowlist leaves out either.
  const named = Object.keys(registry).filter((id) => page.includes(`\`${id}\``));
  expect(named.sort()).toEqual([...allowlist].sort());
});

it("labels a deployment's operating values as defaults and nothing else", () => {
  for (const { line, cells } of rows) {
    const id = idOf(cells[0]);
    if (!isLimitId(id)) throw new Error(`No limit id in ${line}`);
    expect(cells[1]?.endsWith(" (default)"), id).toBe(registry[id].kind === "operating");
  }
});

it("says a value as a reader would, whatever its size", () => {
  expect(formatValue(registry["mcp.body.bytes"])).toBe("1 MiB and 64 KiB");
  expect(formatValue(registry["runtime.call.bytes"])).toBe("64 KiB");
  expect(formatValue(registry["tier2.mutation.keyLifetime"])).toBe("24 hours");
  expect(formatValue({ ...registry["company.admission.rate"], default: 0.0001 })).toBe(
    "0.0001 calls a second"
  );
});
