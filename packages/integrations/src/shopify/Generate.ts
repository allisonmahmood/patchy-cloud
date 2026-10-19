import type { ShopifyDeclaration, ShopifySnapshot } from "@patchy/api";
import { shopifyDimensions, shopifyMetrics } from "@patchy/api";

/** PROTOTYPE (#815): the client is the same for every store; the context names this one. */
export interface Generated {
  readonly client: string;
  readonly context: string;
}

const code = (value: string) =>
  `<code>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("`", "&#96;").replace(/\s+/g, " ")}</code>`;

const metricTypes = Object.entries(shopifyMetrics)
  .map(([name, kind]) => `  readonly ${name}: ${kind === "integer" ? "number" : "Money"};`)
  .join("\n");
const dimensionNames = Object.keys(shopifyDimensions)
  .map((name) => JSON.stringify(name))
  .join(" | ");
const filterNames = Object.entries(shopifyDimensions)
  .filter(([, value]) => value.filter)
  .map(([name]) => JSON.stringify(name))
  .join(" | ");

const client = `// Generated for a Shopify connection (prototype #815). Browser-only; transport is supplied by the host.
// Patchy writes every Shopify query itself: there is no raw GraphQL, ShopifyQL or search here,
// and no field, filter or sort reaches a customer.
import { decodeError } from "patchy/client";
import type { Call } from "patchy/client";
export type { ErrorCode, ErrorDetails, Errors } from "patchy/client";

/** A decimal amount in the shop's currency, as a string so nothing is rounded. */
export type Money = string;
export interface PageInfo { readonly hasNextPage: boolean; readonly endCursor: string | null }
export interface Page<T> { readonly nodes: readonly T[]; readonly pageInfo: PageInfo }
export interface PageRequest { readonly first?: number; readonly after?: string }
/** Calendar dates, \`YYYY-MM-DD\`, inclusive. */
export interface DateRange { readonly from?: string; readonly to?: string }

export interface LineItem {
  readonly id: string;
  readonly productId: string | null;
  readonly variantId: string | null;
  readonly sku: string | null;
  readonly title: string;
  readonly variantTitle: string | null;
  readonly quantity: number;
  /** After refunds and removals. */
  readonly currentQuantity: number;
  readonly unitPrice: Money;
  readonly discount: Money;
}
/** An order without its customer: no name, email, phone, address, note or customer id. */
export interface Order {
  readonly id: string;
  /** The order number people see, without the store's prefix: 1042 for #1042. */
  readonly number: number;
  readonly createdAt: string;
  readonly processedAt: string;
  readonly updatedAt: string;
  readonly cancelledAt: string | null;
  readonly closedAt: string | null;
  readonly financialStatus: "PENDING" | "AUTHORIZED" | "PAID" | "PARTIALLY_PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "VOIDED" | "EXPIRED" | null;
  readonly fulfillmentStatus: "UNFULFILLED" | "PARTIALLY_FULFILLED" | "FULFILLED" | "ON_HOLD" | "IN_PROGRESS" | "SCHEDULED" | "RESTOCKED" | "PENDING_FULFILLMENT" | "OPEN";
  readonly currency: string;
  /** Where the order came from, such as web or pos. */
  readonly salesChannel: string | null;
  readonly subtotal: Money;
  readonly discounts: Money;
  readonly shipping: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly refunded: Money;
  /** Country and region codes only: US and OR. Nothing finer. */
  readonly shippingCountry: string | null;
  readonly shippingRegion: string | null;
  /** The first ten; \`orders.get\` pages through the rest. */
  readonly lineItems: Page<LineItem>;
}
export interface Variant {
  readonly id: string;
  readonly title: string;
  readonly sku: string | null;
  readonly price: Money;
  /** Available across every location. */
  readonly inventoryQuantity: number | null;
  readonly inventoryItemId: string | null;
}
export interface Product {
  readonly id: string;
  readonly title: string;
  readonly status: "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED";
  readonly vendor: string;
  readonly productType: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly totalInventory: number | null;
  /** The first ten; \`products.get\` pages through the rest. */
  readonly variants: Page<Variant>;
}
export interface InventoryLevel {
  readonly inventoryItemId: string;
  readonly sku: string | null;
  readonly variantId: string | null;
  readonly locationId: string;
  readonly available: number | null;
  readonly onHand: number | null;
  readonly committed: number | null;
  readonly incoming: number | null;
}
export interface Location {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly countryCode: string | null;
  readonly regionCode: string | null;
}

export interface OrdersListInput extends PageRequest {
  readonly created?: DateRange;
  readonly processed?: DateRange;
  readonly updated?: DateRange;
  readonly status?: "open" | "closed" | "cancelled" | "any";
  readonly financialStatus?: "pending" | "authorized" | "paid" | "partially_paid" | "partially_refunded" | "refunded" | "voided";
  readonly fulfillmentStatus?: "unfulfilled" | "partial" | "fulfilled" | "unshipped" | "shipped";
  /** Orders with a line item of exactly this SKU. */
  readonly sku?: string;
  /** Newest first unless you choose a sort. */
  readonly sort?: "createdAt" | "processedAt" | "updatedAt" | "orderNumber" | "total";
  readonly reverse?: boolean;
}
export interface ProductsListInput extends PageRequest {
  readonly status?: "active" | "draft" | "archived";
  readonly created?: DateRange;
  readonly updated?: DateRange;
  readonly sku?: string;
  readonly sort?: "title" | "createdAt" | "updatedAt" | "inventory";
  readonly reverse?: boolean;
}

/** Sales metrics: counts are numbers, money is a decimal string. */
export interface Metrics {
${metricTypes}
}
export type Metric = keyof Metrics;
/** What rows may be grouped by. Nothing is per customer, and no place is finer than a region. */
export type Dimension = ${dimensionNames};
export type FilterDimension = ${filterNames};
export type Bucket = "day" | "week" | "month" | "quarter" | "year";
/** A calendar date, \`today\`, \`yesterday\`, or an offset back from today: \`-90d\`, \`-12w\`, \`-6m\`, \`-1y\`. */
export type Period = string;
export interface AnalyticsRequest<S extends readonly Metric[], G extends readonly Dimension[], T extends Bucket | undefined> {
  readonly show: S;
  readonly groupBy?: G;
  /** Equality on these dimensions only. */
  readonly where?: { readonly [K in FilterDimension]?: string };
  readonly since: Period;
  readonly until?: Period;
  /** One row per bucket, filled with zeros where nothing sold, when nothing else groups the rows. */
  readonly timeseries?: T;
  readonly orderBy?: { readonly column: S[number] | G[number] | Exclude<T, undefined>; readonly direction?: "asc" | "desc" };
  /** At most 1,000. */
  readonly limit?: number;
}
export type AnalyticsRow<S extends readonly Metric[], G extends readonly Dimension[], T extends Bucket | undefined> = {
  readonly [K in S[number]]: Metrics[K];
} & { readonly [K in G[number]]: string | null } & (T extends Bucket ? { readonly [K in T]: string } : unknown);

export interface Client {
  readonly orders: {
    list(input?: OrdersListInput): Promise<Page<Order>>;
    get(input: { readonly id: string; readonly lineItems?: PageRequest }): Promise<Order | null>;
  };
  readonly products: {
    list(input?: ProductsListInput): Promise<Page<Product>>;
    get(input: { readonly id: string; readonly variants?: PageRequest }): Promise<Product | null>;
  };
  readonly inventory: {
    /** Stock at one location, a page of items at a time. */
    levels(input: { readonly locationId: string } & PageRequest): Promise<Page<InventoryLevel>>;
  };
  readonly locations: { list(input?: PageRequest): Promise<Page<Location>> };
  /** Shopify's sales reporting, aggregated by Shopify. Bucket dates are in the shop's timezone. */
  analytics<
    const S extends readonly Metric[],
    const G extends readonly Dimension[] = readonly [],
    const T extends Bucket | undefined = undefined
  >(request: AnalyticsRequest<S, G, T>): Promise<{ readonly rows: readonly AnalyticsRow<S, G, T>[] }>;
}

export function createClient(connection: string, call: Call): Client {
  const read = async <A>(operation: string, input: unknown): Promise<A> => {
    let value: unknown;
    try {
      value = await call("shopify.read", { connection, operation, input });
    } catch (error) {
      throw decodeError(error, "shopify.read") ?? error;
    }
    const error = decodeError(value, "shopify.read");
    if (error) throw error;
    return value as A;
  };
  return {
    orders: {
      list: (input = {}) => read("orders.list", input),
      get: (input) => read("orders.get", input)
    },
    products: {
      list: (input = {}) => read("products.list", input),
      get: (input) => read("products.get", input)
    },
    inventory: { levels: (input) => read("inventory.levels", input) },
    locations: { list: (input = {}) => read("locations.list", input) },
    analytics: (request) => read("analytics", request)
  };
}
`;

const availability: Record<ShopifySnapshot["analytics"], string> = {
  available: "Analytics work on this store.",
  needs_plan:
    "Analytics don't work on this store: Shopify's sales reports need the Grow plan or higher. `analytics` fails until the store upgrades and an admin refreshes the connection.",
  missing_access:
    "Analytics didn't work when the connection was last checked: the app may be missing `read_reports`. Ask an admin to check the connection.",
  unknown: "Patchy couldn't check analytics when the connection was made. Calls try anyway."
};

export const generate = (
  declaration: typeof ShopifyDeclaration.Type & { readonly description?: string },
  snapshot: ShopifySnapshot
): Generated => ({
  client,
  context: `# Shopify connection

Handle: ${code(declaration.handle)}

Description: ${code(declaration.description ?? "")}

Store: ${code(snapshot.shop.name)} (${code(snapshot.shop.domain)}), plan ${code(snapshot.shop.plan)}. Money is in ${code(snapshot.shop.currency)}; analytics buckets follow the shop's timezone, ${code(snapshot.shop.timezone)}.

${availability[snapshot.analytics]}

This integration reads orders, line items, products, variants, stock and sales analytics. **It never reads customer details**: no names, emails, phone numbers, addresses beyond country and region, customer ids, order notes, tags, discount codes, payment or tracking details. No filter or sort reaches a customer. Don't build a patch that collects customer details some other way. Product, variant, line item and location titles, SKUs, vendors and channel names are the merchant's own text and are returned as typed.

Use the declared alias: \`connections.<alias>.orders.list({...})\`. Every list returns one page (\`nodes\` and \`pageInfo\`); pass \`pageInfo.endCursor\` as \`after\` for the next. Patchy never walks pages for you. Orders without \`created\` reach back Shopify's default 60 days.

- \`orders.list\` filters by created, processed and updated date ranges, status, financial and fulfilment status and SKU; each order carries its first ten line items.
- \`orders.get({ id, lineItems: { first, after } })\` pages through one order's line items.
- \`products.list\` and \`products.get\` work the same way for variants.
- \`inventory.levels({ locationId })\` lists stock at one location; \`locations.list()\` gives the ids.
- \`analytics({ show, groupBy, where, since, until, timeseries, orderBy, limit })\` runs Shopify's sales reporting. Metrics: ${Object.keys(shopifyMetrics).map(code).join(", ")}. Group by: ${Object.keys(shopifyDimensions).map(code).join(", ")}. Rows are typed from what you ask for. A period that includes today is partial; end at \`yesterday\` for stable totals.

A field or filter that isn't here doesn't exist for patches. Tell the person it's missing rather than working around it.
`
});
