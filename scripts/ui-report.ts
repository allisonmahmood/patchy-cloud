/**
 * What in the app's stylesheet is off the token block, by chunk, and the role each value plays:
 * core's rule (`packages/core/src/styles/rules.ts`) read over every chunk. `styles.test.ts` fails
 * `pnpm check` on the same list, so this is where to see it whole while fixing it. Page markup is
 * `pnpm lint`'s, through the repo's own `patchy/no-page-styles` and
 * `patchy/no-hand-drawn-components` rules.
 *
 *   pnpm ui:report
 */
import { chunks } from "../packages/core/src/styles/index.js";
import { offTokens } from "../packages/core/src/styles/rules.js";

const found = Object.entries(chunks)
  .filter(([chunk]) => chunk !== "fonts" && chunk !== "tokens")
  .flatMap(([chunk, css]) => offTokens(css).map((finding) => ({ chunk, ...finding })));

console.log(`Values off the token block in the app's stylesheet: ${found.length}`);
for (const { chunk, selector, property, value, role } of found)
  console.log(`  ${chunk}: ${selector} { ${property}: ${value} } is a ${role}`);
console.log(
  "\nPage markup: pnpm lint runs patchy/no-page-styles and patchy/no-hand-drawn-components."
);
process.exitCode = found.length === 0 ? 0 : 1;
