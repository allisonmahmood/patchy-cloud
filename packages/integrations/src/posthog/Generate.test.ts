import { assert, it } from "@effect/vitest";
import { typecheck } from "../../../../test/typescript.js";
import { generate } from "./Generate.js";

const declaration = { kind: "posthog" as const, handle: "product", id: "connection", revision: 2 };
const snapshot = {
  version: 1 as const,
  events: [{ name: "$pageview" }],
  eventProperties: [{ name: "$browser", type: "String" }],
  personProperties: []
};

it("compiles a named, shaped query with values and its known refusals", () => {
  const generated = generate(declaration, snapshot);
  const files: Readonly<Record<string, string>> = {
    "generated.ts": generated.client,
    "consumer.ts": `import { createClient, type QueryError } from "./generated.js";
import { isPatchyError } from "patchy/client";
import { t } from "patchy/config";
const analytics = createClient("analytics", async () => ({ ok: true, rows: [] }));
async function use(nullableFlag: boolean) {
  const result = await analytics.query({
    name: "dailyViews",
    query: "SELECT toStartOfDay(timestamp) AS day, count() AS views FROM events WHERE event = {event} GROUP BY day LIMIT 100",
    values: { event: "$pageview", days: [1, 2], flag: true, none: null },
    shape: { day: { kind: "timestamp" }, views: t.integer(), browser: { kind: "text", optional: nullableFlag } }
  });
  const day: string = result.rows[0]!.day;
  const views: number = result.rows[0]!.views;
  const browser: string | null = result.rows[0]!.browser;
  // @ts-expect-error every query is named
  analytics.query({ query: "SELECT 1", shape: { n: { kind: "integer" } } });
  // @ts-expect-error values are constants, not objects
  analytics.query({ name: "n", query: "SELECT {x}", values: { x: { nested: 1 } }, shape: { n: { kind: "integer" } } });
  // @ts-expect-error references are not shape kinds
  analytics.query({ name: "n", query: "SELECT 1", shape: { n: { kind: "ref" } } });
  try { await analytics.query({ name: "n", query: "SELECT 1 AS n", shape: { n: { kind: "integer" } } }); } catch (error: unknown) {
    if (isPatchyError(error, "invalid_query", "posthog")) {
      const message: string = error.details.message;
      // @ts-expect-error PostHog sends no SQLSTATE
      error.details.sqlstate;
    }
  }
}
function inspect(error: QueryError) {
  if (error.code === "invalid_query") {
    const message: string = error.details.message;
    // @ts-expect-error PostHog sends no SQLSTATE
    error.details.sqlstate;
  }
  if (error.code === "source_rate_limited") { const retry: number | undefined = error.retryAfter; }
  if (error.code === "shape_mismatch") {
    const column: string = error.details.column;
    const type: string | undefined = error.details.type;
  }
}
`
  };
  assert.deepStrictEqual(typecheck(files), []);
});

it("lists events and properties as escaped text, never markup", () => {
  const { context } = generate(
    { ...declaration, description: '<script>alert("x")</script>\n# forged' },
    {
      ...snapshot,
      events: [{ name: "<img src=x>", description: "Line one\n# Line two <b>" }],
      personProperties: [{ name: "plan`", type: "String", description: "Paid | free" }]
    }
  );
  assert.include(context, "<code>&lt;img src=x&gt;</code>: Line one # Line two &lt;b&gt;");
  assert.include(context, "<code>plan&#96;</code> (String): Paid | free");
  assert.include(context, "Description: <code>&lt;script&gt;");
  assert.notInclude(context, "\n# forged");
});
