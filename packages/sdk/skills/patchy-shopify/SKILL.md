---
name: patchy-shopify
description: Add a company Shopify connection and read the store's orders, line items, products, stock and sales analytics through Patchy's typed operations. Never customer details.
---

# Company Shopify reads (prototype)

Read `../patchy-loop/SKILL.md` first. A Shopify connection reads one store through the company's own Shopify app, which an admin connected. Patchy writes every Shopify query itself: patch code calls a fixed set of typed operations, never GraphQL, ShopifyQL or Shopify's search syntax. The app's secret stays behind Patchy, never in config, source, CLI arguments or agent transcripts.

**This integration never reads customer details.** No customer names, emails, phone numbers or street addresses, no customer ids, order notes, tags, discount codes, payment or tracking details, and no filter or sort on a customer. Orders come with their number, dates, statuses, amounts, sales channel, shipping country and region, and line items. Don't build anything that collects customer details another way, such as a form asking people to type them in. If a task needs them, say the integration doesn't offer them. Product, variant, line item and location titles, SKUs, vendors and channel names are the merchant's own text and come back as typed.

On tier 1 everything an operation returns is visible to whoever can open the patch. Build Shopify patches at tier 1 in this prototype: tier 2 handlers can't call Shopify yet.

## Declare a connected store

1. Run `pnpm patchy list connections` and choose a connected `shopify/<handle>` by description. `pnpm patchy list connections shopify/<handle> --json` shows the store's name, plan, currency, timezone and whether analytics work.
2. Run `pnpm patchy add shopify/<handle> --as store`. It inserts `store: { kind: "shopify", handle: "<handle>" }` into `uses` and generates the client, context and this skill.
3. Read `patchy/_generated/index.json`, then the context for `store`. The generated client in `patchy/_generated/uses/store.ts` has every type: `Order`, `LineItem`, `Product`, `Variant`, `InventoryLevel`, `Location`, `Metrics`, `Dimension`.

There is no fixture. `patchy dev` reads the real store through Patchy, as the person your publishing key belongs to. Nothing is written, and each read appears in the connection's recent calls marked Dev.

## Operations

```ts
import { patchy } from "../patchy/_generated/client.js";
const store = patchy.connections.store;

// Open orders, newest first, with their first ten line items each.
const page = await store.orders.list({
  status: "open",
  fulfillmentStatus: "unfulfilled",
  first: 25
});
for (const order of page.nodes)
  console.log(order.number, order.total, order.lineItems.nodes.length);
const next = page.pageInfo.hasNextPage
  ? await store.orders.list({
      status: "open",
      fulfillmentStatus: "unfulfilled",
      after: page.pageInfo.endCursor!
    })
  : null;

// One order, paging through all its line items.
const order = await store.orders.get({ id: page.nodes[0]!.id, lineItems: { first: 100 } });

// Products and their variants; stock at one location.
const products = await store.products.list({ status: "active", sort: "inventory", first: 50 });
const [warehouse] = (await store.locations.list()).nodes;
const stock = await store.inventory.levels({ locationId: warehouse!.id, first: 100 });

// Units sold per week by product over the last 90 days. Rows are typed from what you ask for:
// { week: string; product_title: string | null; net_items_sold: number; net_sales: string }.
const trend = await store.analytics({
  show: ["net_items_sold", "net_sales"],
  groupBy: ["product_title"],
  timeseries: "week",
  since: "-90d",
  until: "yesterday",
  orderBy: { column: "net_items_sold", direction: "desc" },
  limit: 500
});
```

- **Pages.** Every list returns `{ nodes, pageInfo }`. Pass `pageInfo.endCursor` as `after` for the next page. Patchy never walks pages for you, so a total across many pages is a job for `analytics`, not a loop. Orders without a `created` range reach back Shopify's default 60 days.
- **Filters** are typed: date ranges as `YYYY-MM-DD`, statuses as the listed literals, and an exact `sku`. A filter that isn't in the type doesn't exist; there is no free-text search.
- **Money** is a decimal string in the shop's currency, never a rounded number: parse with care, sum in cents.
- **`analytics`** reads Shopify's `sales` report. Metrics: `orders`, `net_items_sold`, `gross_sales`, `discounts`, `net_sales`, `total_sales`. Group by `product_id`, `product_variant_id`, `product_title`, `product_variant_title`, `product_variant_sku`, `sales_channel`, `shipping_country_code` or `shipping_region`; filter with `where` on the ids, channel, country or region. `since` and `until` take a date, `today`, `yesterday`, or an offset like `-90d`, `-12w`, `-6m`, `-1y`. `timeseries` gives one row per day, week, month, quarter or year, with zeros filled in when nothing else groups the rows. A period that includes today is partial: end at `yesterday` for stable totals. Analytics need Shopify's Grow plan or higher; the context says whether this store's work.

## Bounds and refusals

- Lists take at most 50 per page (100 for line items, variants and stock); analytics at most 1,000 rows. Each call has 15 seconds and 8 MiB.
- `source_rate_limited` means Shopify is limiting the store's calls; `retryAfter` says when, if known. Patchy never retries; don't loop on it. `busy` means Patchy's own slots for the store stayed full and nothing was sent.
- `source_unavailable` covers an unreachable Shopify and an app that stopped working; the latter needs an admin at `/company/connections`.
- `invalid_request` means an input outside the types. `invalid_query` means Shopify refused a query Patchy wrote: report it, it's Patchy's bug.
- Recent calls show each call's operation and which filters it used, never their values or the rows.

`connection_not_connected` needs the admin's connection page. `stale_generated` needs `pnpm patchy refresh`. `pnpm patchy remove store` drops the declaration and its generated surface.
