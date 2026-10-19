// @effect-diagnostics globalDate:off -- a throwaway fake store's data is relative to the wall clock.
/**
 * PROTOTYPE (#815): an in-memory Shopify store, so the prototype runs before a real dev store
 * exists. `pnpm dev` turns it on with PATCHY_SHOPIFY_FAKE; it answers only its own shop's host.
 * It answers the token endpoint and the fixed GraphQL documents Patchy writes, by operation name,
 * with deterministic data: 90 days of orders, products and stock at two locations.
 *
 * Every order also carries a customer's name, email and street address, as a real store's do.
 * None of Patchy's documents select them, so none of them ever leaves this file.
 */
import type * as HttpClientRequest from "effect/http/HttpClientRequest";

export const SHOP = "northwind-demo.myshopify.com";
export const CLIENT_ID = "northwind-demo-app";
export const CLIENT_SECRET = "northwind-demo-secret";
const TOKEN = "shpat_fake_northwind_demo";
const SCOPES = "read_orders,read_products,read_inventory,read_locations,read_reports";

// --- deterministic data -------------------------------------------------------------------

const random = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const money = (value: number) => (Math.round(value * 100) / 100).toFixed(2);
const gid = (type: string, id: number) => `gid://shopify/${type}/${id}`;
const day = (time: number) => new Date(time).toISOString().slice(0, 10);

interface Variant {
  readonly id: number;
  readonly title: string;
  readonly sku: string;
  readonly price: number;
  readonly inventoryItemId: number;
  /** Relative popularity, and how it trends over the 90 days (+ rising, - falling). */
  readonly weight: number;
  readonly trend: number;
}
interface Product {
  readonly id: number;
  readonly title: string;
  readonly status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  readonly vendor: string;
  readonly productType: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly variants: ReadonlyArray<Variant>;
}
interface LineItem {
  readonly id: number;
  readonly product: Product;
  readonly variant: Variant;
  readonly quantity: number;
  readonly refundedQuantity: number;
  readonly discount: number;
}
interface Order {
  readonly id: number;
  readonly number: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly cancelledAt: string | null;
  readonly financial: string;
  readonly fulfillment: string;
  readonly sourceName: string;
  readonly channel: string;
  readonly country: string;
  readonly province: string;
  readonly region: string;
  readonly lineItems: ReadonlyArray<LineItem>;
  readonly subtotal: number;
  readonly discounts: number;
  readonly shipping: number;
  readonly tax: number;
  readonly total: number;
  readonly refunded: number;
  /** What every real order carries and Patchy never selects. */
  readonly customer: { readonly name: string; readonly email: string; readonly street: string };
}
interface Location {
  readonly id: number;
  readonly name: string;
  readonly isActive: boolean;
  readonly countryCode: string;
  readonly provinceCode: string;
}

const catalogue: ReadonlyArray<
  readonly [
    string,
    string,
    string,
    ReadonlyArray<readonly [string, string, number, number, number]>
  ]
> = [
  [
    "House Blend Coffee",
    "Northwind Roastery",
    "Coffee",
    [
      ["250g", "HB-250", 14, 9, 0],
      ["1kg", "HB-1000", 42, 3, 0.2]
    ]
  ],
  ["Ethiopia Yirgacheffe", "Northwind Roastery", "Coffee", [["250g", "ETH-250", 18, 4, 0.6]]],
  [
    "Colombia Huila",
    "Northwind Roastery",
    "Coffee",
    [
      ["250g", "COL-250", 16, 5, 0],
      ["1kg", "COL-1000", 48, 1.5, 0]
    ]
  ],
  ["Decaf Swiss Water", "Northwind Roastery", "Coffee", [["250g", "DEC-250", 15, 3, -0.7]]],
  [
    "Espresso Roast",
    "Northwind Roastery",
    "Coffee",
    [
      ["250g", "ESP-250", 15, 4, 1.4],
      ["1kg", "ESP-1000", 45, 1.5, 1.2]
    ]
  ],
  ["Earl Grey Tea", "Leaf & Co", "Tea", [["100g", "TEA-EG-100", 12, 2.5, 0]]],
  ["Sencha Green Tea", "Leaf & Co", "Tea", [["100g", "TEA-SEN-100", 13, 2, 0.3]]],
  ["Ceramic Pour-Over", "Kiln Works", "Brewing gear", [["Default Title", "GEAR-POUR", 32, 1.2, 0]]],
  ["Paper Filters (100)", "Kiln Works", "Brewing gear", [["Default Title", "GEAR-FILT", 6, 3, 0]]],
  ["Burr Grinder", "Grindhaus", "Brewing gear", [["Default Title", "GEAR-GRIND", 129, 0.5, 0.4]]],
  [
    "Travel Mug",
    "Kiln Works",
    "Merch",
    [
      ["Black", "GEAR-MUG-BLK", 24, 1, 0],
      ["Sand", "GEAR-MUG-SND", 24, 0.8, 0.5]
    ]
  ],
  ["Cold Brew Kit", "Grindhaus", "Brewing gear", [["Default Title", "GEAR-CB", 38, 0.7, 1.8]]],
  ["Holiday Blend", "Northwind Roastery", "Coffee", [["250g", "HOL-250", 17, 0, 0]]]
];
const places = [
  ["US", "OR", "Oregon", 18],
  ["US", "WA", "Washington", 14],
  ["US", "CA", "California", 20],
  ["US", "NY", "New York", 10],
  ["US", "TX", "Texas", 8],
  ["CA", "BC", "British Columbia", 6],
  ["CA", "ON", "Ontario", 4],
  ["GB", "ENG", "England", 3]
] as const;
const firstNames = ["Avery", "Jordan", "Riley", "Sam", "Morgan", "Casey", "Quinn", "Rowan"];
const lastNames = ["Nguyen", "Okafor", "Lindqvist", "Garcia", "Patel", "Murphy", "Kowalski"];

const generate = () => {
  const next = random(20261019);
  const pick = <A>(items: ReadonlyArray<A>) => items[Math.floor(next() * items.length)]!;
  const weighted = <A>(items: ReadonlyArray<readonly [A, number]>) => {
    let roll = next() * items.reduce((sum, [, weight]) => sum + weight, 0);
    for (const [item, weight] of items) if ((roll -= weight) <= 0) return item;
    return items.at(-1)![0];
  };
  const now = Date.now();
  const start = now - 90 * 86_400_000;
  let ids = 1_000;
  const products: Product[] = catalogue.map(([title, vendor, productType, variants], index) => ({
    id: 8_100 + index,
    title,
    status: title === "Holiday Blend" ? "DRAFT" : "ACTIVE",
    vendor,
    productType,
    createdAt: new Date(start - (400 - index * 20) * 86_400_000).toISOString(),
    updatedAt: new Date(now - index * 3 * 86_400_000).toISOString(),
    variants: variants.map(([variantTitle, sku, price, weight, trend]) => {
      const id = ++ids;
      return {
        id: 44_000 + id,
        title: variantTitle,
        sku,
        price,
        inventoryItemId: 47_000 + id,
        weight,
        trend
      };
    })
  }));
  const variants = products.flatMap((product) =>
    product.variants.map((variant) => ({ product, variant }))
  );
  const locations: Location[] = [
    {
      id: 61_001,
      name: "Portland Warehouse",
      isActive: true,
      countryCode: "US",
      provinceCode: "OR"
    },
    { id: 61_002, name: "Seattle Shop", isActive: true, countryCode: "US", provinceCode: "WA" }
  ];
  const stock = new Map<
    string,
    { available: number; onHand: number; committed: number; incoming: number }
  >();
  for (const { variant } of variants)
    for (const location of locations) {
      const base = Math.round(variant.weight * (location.id === 61_001 ? 60 : 12) * (0.4 + next()));
      // A few items run low, so a reorder tool has something to find.
      const available = ["ESP-250", "GEAR-CB", "ETH-250"].includes(variant.sku)
        ? Math.round(base / 9)
        : base;
      const committed = Math.round(next() * 6);
      stock.set(`${variant.inventoryItemId}:${location.id}`, {
        available,
        onHand: available + committed,
        committed,
        incoming: available < 15 && location.id === 61_001 ? 48 : 0
      });
    }

  const orders: Order[] = [];
  let number = 1_000;
  for (let time = start; time < now; time += 86_400_000) {
    const progress = (time - start) / (now - start);
    const weekday = new Date(time).getUTCDay();
    const count = Math.round(
      (22 + 10 * progress) * (weekday === 0 || weekday === 6 ? 1.3 : 1) * (0.8 + next() * 0.4)
    );
    for (let n = 0; n < count; n++) {
      const createdAt = Math.min(now - 60_000, time + Math.floor(next() * 86_400_000));
      const lines = new Map<number, LineItem>();
      for (let line = 0, size = 1 + Math.floor(next() * next() * 4); line < size; line++) {
        const chosen = weighted(
          variants
            .filter(({ product }) => product.status === "ACTIVE")
            .map(
              (entry) =>
                [
                  entry,
                  entry.variant.weight * Math.max(0.1, 1 + entry.variant.trend * (progress - 0.5))
                ] as const
            )
        );
        if (lines.has(chosen.variant.id)) continue;
        const quantity = 1 + Math.floor(next() * next() * 3);
        lines.set(chosen.variant.id, {
          id: ++ids * 10,
          product: chosen.product,
          variant: chosen.variant,
          quantity,
          refundedQuantity: 0,
          discount: next() < 0.12 ? chosen.variant.price * quantity * 0.1 : 0
        });
      }
      const age = (now - createdAt) / 86_400_000;
      const cancelled = next() < 0.015;
      const refunded = !cancelled && age > 3 && next() < 0.03;
      const items = [...lines.values()].map((item) =>
        refunded ? { ...item, refundedQuantity: item.quantity } : item
      );
      const gross = items.reduce((sum, item) => sum + item.variant.price * item.quantity, 0);
      const discounts = items.reduce((sum, item) => sum + item.discount, 0);
      const channel = weighted([
        ["web", 70],
        ["pos", 22],
        ["instagram", 8]
      ] as const);
      const subtotal = gross - discounts;
      const shipping = channel === "pos" || subtotal >= 50 ? 0 : 6.95;
      const tax = subtotal * 0.08;
      const total = subtotal + shipping + tax;
      const [country, province, region] =
        channel === "pos"
          ? (["US", "WA", "Washington"] as const)
          : weighted(places.map(([c, p, r, w]) => [[c, p, r] as const, w] as const));
      const fulfilled = cancelled
        ? "UNFULFILLED"
        : age > 2.5
          ? "FULFILLED"
          : age > 1 && next() < 0.5
            ? "PARTIALLY_FULFILLED"
            : "UNFULFILLED";
      const financial = cancelled
        ? "VOIDED"
        : refunded
          ? "REFUNDED"
          : age < 0.3 && next() < 0.2
            ? "PENDING"
            : "PAID";
      const first = pick(firstNames);
      const last = pick(lastNames);
      orders.push({
        id: 5_500_000 + ++number,
        number,
        createdAt: new Date(createdAt).toISOString(),
        updatedAt: new Date(
          Math.min(now, createdAt + Math.floor(next() * 3) * 86_400_000)
        ).toISOString(),
        closedAt:
          fulfilled === "FULFILLED" && !cancelled
            ? new Date(Math.min(now, createdAt + 2 * 86_400_000)).toISOString()
            : null,
        cancelledAt: cancelled ? new Date(createdAt + 3_600_000).toISOString() : null,
        financial,
        fulfillment: fulfilled,
        sourceName: channel,
        channel:
          channel === "web"
            ? "Online Store"
            : channel === "pos"
              ? "Point of Sale"
              : "Instagram Shop",
        country,
        province,
        region,
        lineItems: items,
        subtotal,
        discounts,
        shipping,
        tax,
        total,
        refunded: refunded ? total : 0,
        customer: {
          name: `${first} ${last}`,
          email: `${first}.${last}@example.com`.toLowerCase(),
          street: `${100 + Math.floor(next() * 900)} Alder St`
        }
      });
    }
  }
  return { products, variants, locations, stock, orders };
};

// --- search, sort and paging, the subset Patchy writes --------------------------------------

interface Term {
  readonly field: string;
  readonly op: "=" | ">=" | "<=" | ">" | "<";
  readonly value: string;
}
const parseSearch = (query: string | undefined): ReadonlyArray<Term> =>
  [...(query ?? "").matchAll(/([a-z_]+):(>=|<=|>|<)?("(?:[^"\\]|\\.)*"|\S+)/g)].map(
    ([, field, op, raw]) => ({
      field: field!,
      op: (op ?? "=") as Term["op"],
      value: raw!.startsWith('"') ? raw!.slice(1, -1).replace(/\\(.)/g, "$1") : raw!
    })
  );
const compare = (actual: string, term: Term) =>
  term.op === "="
    ? actual === term.value
    : term.op === ">="
      ? actual >= term.value
      : term.op === "<="
        ? actual <= term.value
        : term.op === ">"
          ? actual > term.value
          : actual < term.value;

const page = <A>(items: ReadonlyArray<A>, first: number, after: unknown) => {
  const offset =
    typeof after === "string" ? Number(Buffer.from(after, "base64url").toString()) + 1 : 0;
  const nodes = items.slice(offset, offset + first);
  const last = offset + nodes.length - 1;
  return {
    nodes,
    pageInfo: {
      hasNextPage: last < items.length - 1,
      endCursor: nodes.length === 0 ? null : Buffer.from(String(last)).toString("base64url")
    }
  };
};
const shaped = <A, B>(
  result: { nodes: ReadonlyArray<A>; pageInfo: unknown },
  map: (item: A) => B
) => ({
  nodes: result.nodes.map(map),
  pageInfo: result.pageInfo
});
const bag = (amount: number) => ({ shopMoney: { amount: money(amount) } });

// --- ShopifyQL, the grammar Patchy builds ---------------------------------------------------

const bucketOf = (iso: string, bucket: string) => {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (bucket === "week") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (bucket === "month") date.setUTCDate(1);
  if (bucket === "quarter") date.setUTCMonth(Math.floor(date.getUTCMonth() / 3) * 3, 1);
  if (bucket === "year") date.setUTCMonth(0, 1);
  return day(date.getTime());
};
const resolvePeriod = (value: string, now: number) => {
  if (value === "today") return day(now);
  if (value === "yesterday") return day(now - 86_400_000);
  const offset = /^-(\d+)([dwmy])$/.exec(value);
  if (offset === null) return value;
  const amount = Number(offset[1]);
  const days = { d: 1, w: 7, m: 30, y: 365 }[offset[2] as "d" | "w" | "m" | "y"];
  return day(now - amount * days * 86_400_000);
};

export const make = () => {
  const data = generate();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const graphql = (
    data: unknown,
    cost: number,
    search?: ReadonlyArray<Term>,
    known?: ReadonlyArray<string>
  ) => {
    const unknown = (search ?? []).filter(
      (term) => known !== undefined && !known.includes(term.field)
    );
    return json(200, {
      data,
      extensions: {
        cost: {
          requestedQueryCost: cost,
          actualQueryCost: cost,
          throttleStatus: {
            maximumAvailable: 2_000,
            currentlyAvailable: 2_000 - cost,
            restoreRate: 100
          }
        },
        ...(unknown.length === 0
          ? {}
          : {
              search: [
                {
                  warnings: unknown.map((term) => ({
                    field: term.field,
                    message: "Invalid search field for this query."
                  }))
                }
              ]
            })
      }
    });
  };

  const order = (item: Order) => ({
    id: gid("Order", item.id),
    number: item.number,
    createdAt: item.createdAt,
    processedAt: item.createdAt,
    updatedAt: item.updatedAt,
    cancelledAt: item.cancelledAt,
    closedAt: item.closedAt,
    displayFinancialStatus: item.financial,
    displayFulfillmentStatus: item.fulfillment,
    currencyCode: "USD",
    sourceName: item.sourceName,
    currentSubtotalPriceSet: bag(item.refunded > 0 ? 0 : item.subtotal),
    currentTotalDiscountsSet: bag(item.discounts),
    currentShippingPriceSet: bag(item.shipping),
    currentTotalTaxSet: bag(item.refunded > 0 ? 0 : item.tax),
    currentTotalPriceSet: bag(item.total - item.refunded),
    totalRefundedSet: bag(item.refunded),
    shippingAddress: { countryCodeV2: item.country, provinceCode: item.province }
  });
  const lineItem = (item: LineItem) => ({
    id: gid("LineItem", item.id),
    sku: item.variant.sku,
    title: item.product.title,
    variantTitle: item.variant.title === "Default Title" ? null : item.variant.title,
    quantity: item.quantity,
    currentQuantity: item.quantity - item.refundedQuantity,
    originalUnitPriceSet: bag(item.variant.price),
    totalDiscountSet: bag(item.discount),
    product: { id: gid("Product", item.product.id) },
    variant: { id: gid("ProductVariant", item.variant.id) }
  });
  const variantNode = (variant: Variant) => {
    const quantity = data.locations.reduce(
      (sum, location) =>
        sum + (data.stock.get(`${variant.inventoryItemId}:${location.id}`)?.available ?? 0),
      0
    );
    return {
      id: gid("ProductVariant", variant.id),
      title: variant.title,
      sku: variant.sku,
      price: money(variant.price),
      inventoryQuantity: quantity,
      inventoryItem: { id: gid("InventoryItem", variant.inventoryItemId) }
    };
  };
  const productNode = (product: Product) => ({
    id: gid("Product", product.id),
    title: product.title,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    totalInventory: product.variants.reduce(
      (sum, variant) => sum + variantNode(variant).inventoryQuantity,
      0
    )
  });

  const orderFields = [
    "created_at",
    "processed_at",
    "updated_at",
    "status",
    "financial_status",
    "fulfillment_status",
    "sku"
  ];
  const matchesOrder = (item: Order, term: Term) => {
    switch (term.field) {
      case "created_at":
      case "processed_at":
        return compare(item.createdAt.slice(0, 10), term);
      case "updated_at":
        return compare(item.updatedAt.slice(0, 10), term);
      case "status":
        return (
          term.value === "any" ||
          (term.value === "cancelled"
            ? item.cancelledAt !== null
            : term.value === "closed"
              ? item.closedAt !== null
              : item.closedAt === null && item.cancelledAt === null)
        );
      case "financial_status":
        return item.financial.toLowerCase() === term.value;
      case "fulfillment_status":
        return term.value === "shipped"
          ? item.fulfillment === "FULFILLED"
          : term.value === "unshipped"
            ? item.fulfillment === "UNFULFILLED"
            : term.value === "partial"
              ? item.fulfillment === "PARTIALLY_FULFILLED"
              : item.fulfillment.toLowerCase() === term.value;
      case "sku":
        return item.lineItems.some((line) => line.variant.sku === term.value);
      default:
        return true;
    }
  };
  const orderSorts: Record<string, (a: Order, b: Order) => number> = {
    CREATED_AT: (a, b) => a.createdAt.localeCompare(b.createdAt),
    PROCESSED_AT: (a, b) => a.createdAt.localeCompare(b.createdAt),
    UPDATED_AT: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    ORDER_NUMBER: (a, b) => a.number - b.number,
    TOTAL_PRICE: (a, b) => a.total - b.total
  };
  const productFields = ["status", "created_at", "updated_at", "sku"];
  const matchesProduct = (product: Product, term: Term) =>
    term.field === "status"
      ? product.status.toLowerCase() === term.value
      : term.field === "created_at"
        ? compare(product.createdAt.slice(0, 10), term)
        : term.field === "updated_at"
          ? compare(product.updatedAt.slice(0, 10), term)
          : term.field === "sku"
            ? product.variants.some((variant) => variant.sku === term.value)
            : true;
  const productSorts: Record<string, (a: Product, b: Product) => number> = {
    TITLE: (a, b) => a.title.localeCompare(b.title),
    CREATED_AT: (a, b) => a.createdAt.localeCompare(b.createdAt),
    UPDATED_AT: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    INVENTORY_TOTAL: (a, b) => productNode(a).totalInventory - productNode(b).totalInventory
  };
  const sorted = <A>(
    items: ReadonlyArray<A>,
    sorts: Record<string, (a: A, b: A) => number>,
    key: unknown,
    reverse: unknown
  ) => {
    const by = sorts[typeof key === "string" ? key : ""] ?? (() => 0);
    const result = [...items].sort(by);
    return reverse === true ? result.reverse() : result;
  };
  const numeric = (id: unknown) => Number(String(id).split("/").at(-1));

  const analytics = (query: string) => {
    const now = Date.now();
    const clause = (name: string, next: string) =>
      new RegExp(`\\b${name}\\s+(.+?)(?=\\s+(?:${next})\\b|$)`).exec(query)?.[1];
    const all = "WHERE|GROUP BY|TIMESERIES|SINCE|UNTIL|ORDER BY|LIMIT";
    const show = (clause("SHOW", all) ?? "").split(",").map((part) => part.trim());
    const groupBy = (
      clause("GROUP BY", "TIMESERIES|SINCE|UNTIL|ORDER BY|LIMIT")?.split(",") ?? []
    ).map((part) => part.trim());
    const bucket = clause("TIMESERIES", "SINCE|UNTIL|ORDER BY|LIMIT");
    const since = resolvePeriod(clause("SINCE", "UNTIL|ORDER BY|LIMIT") ?? "-30d", now);
    const until = resolvePeriod(clause("UNTIL", "ORDER BY|LIMIT") ?? "today", now);
    const order = clause("ORDER BY", "LIMIT");
    const limit = Number(clause("LIMIT", "$^") ?? 1_000);
    const where = [
      ...(clause("WHERE", "GROUP BY|TIMESERIES|SINCE|UNTIL|ORDER BY|LIMIT") ?? "").matchAll(
        /([a-z_]+) = '((?:[^'\\]|\\.)*)'/g
      )
    ].map(([, key, value]) => [key!, value!.replace(/\\(.)/g, "$1")] as const);
    const value = (item: Order, line: LineItem, dimension: string): string | null =>
      dimension === "product_id"
        ? String(line.product.id)
        : dimension === "product_variant_id"
          ? String(line.variant.id)
          : dimension === "product_title"
            ? line.product.title
            : dimension === "product_variant_title"
              ? line.variant.title
              : dimension === "product_variant_sku"
                ? line.variant.sku
                : dimension === "sales_channel"
                  ? item.channel
                  : dimension === "shipping_country_code"
                    ? item.country
                    : dimension === "shipping_region"
                      ? item.region
                      : null;
    const groups = new Map<
      string,
      {
        keys: ReadonlyArray<string | null>;
        orders: Set<number>;
        items: number;
        gross: number;
        discounts: number;
        net: number;
        total: number;
      }
    >();
    for (const item of data.orders) {
      const date = item.createdAt.slice(0, 10);
      if (date < since || date > until || item.cancelledAt !== null) continue;
      for (const line of item.lineItems) {
        if (where.some(([key, expected]) => value(item, line, key) !== expected)) continue;
        const keys = [
          ...(bucket === undefined ? [] : [bucketOf(item.createdAt, bucket)]),
          ...groupBy.map((dimension) => value(item, line, dimension))
        ];
        const key = JSON.stringify(keys);
        let group = groups.get(key);
        if (group === undefined)
          groups.set(
            key,
            (group = {
              keys,
              orders: new Set(),
              items: 0,
              gross: 0,
              discounts: 0,
              net: 0,
              total: 0
            })
          );
        const gross = line.variant.price * line.quantity;
        const net = gross - line.discount - line.variant.price * line.refundedQuantity;
        group.orders.add(item.id);
        group.items += line.quantity - line.refundedQuantity;
        group.gross += gross;
        group.discounts += line.discount;
        group.net += net;
        group.total +=
          net * 1.08 + (item.shipping * gross) / Math.max(1, item.subtotal + item.discounts);
      }
    }
    // TIMESERIES fills the buckets nothing sold in, when nothing else splits the rows.
    if (bucket !== undefined && groupBy.length === 0)
      for (
        let time = Date.parse(`${since}T00:00:00Z`);
        time <= Date.parse(`${until}T00:00:00Z`);
        time += 86_400_000
      ) {
        const keys = [bucketOf(day(time), bucket)];
        const key = JSON.stringify(keys);
        if (!groups.has(key))
          groups.set(key, {
            keys,
            orders: new Set(),
            items: 0,
            gross: 0,
            discounts: 0,
            net: 0,
            total: 0
          });
      }
    const metric = (group: NonNullable<ReturnType<typeof groups.get>>, name: string) =>
      name === "orders"
        ? group.orders.size
        : name === "net_items_sold"
          ? group.items
          : name === "gross_sales"
            ? money(group.gross)
            : name === "discounts"
              ? money(-group.discounts)
              : name === "net_sales"
                ? money(group.net)
                : money(group.total);
    const columns = [...(bucket === undefined ? [] : [bucket]), ...groupBy, ...show];
    let rows = [...groups.values()].map((group) =>
      Object.fromEntries([
        ...columns
          .slice(0, group.keys.length)
          .map((name, index) => [name, group.keys[index]] as const),
        ...show.map((name) => [name, metric(group, name)] as const)
      ])
    );
    const [orderColumn, direction] = (order ?? (bucket === undefined ? "" : `${bucket} ASC`)).split(
      /\s+/
    );
    if (orderColumn !== undefined && orderColumn !== "")
      rows = rows.sort((a, b) => {
        const left = a[orderColumn];
        const right = b[orderColumn];
        const result =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : Number.isFinite(Number(left)) && Number.isFinite(Number(right))
              ? Number(left) - Number(right)
              : String(left).localeCompare(String(right));
        return direction === "DESC" ? -result : result;
      });
    return {
      shopifyqlQuery: {
        tableData: {
          columns: columns.map((name) => ({
            name,
            dataType:
              name === bucket
                ? "DATE"
                : name in { orders: 1, net_items_sold: 1 }
                  ? "INTEGER"
                  : show.includes(name)
                    ? "MONEY"
                    : name.endsWith("_id")
                      ? "IDENTITY"
                      : "STRING",
            displayName: name
          })),
          rows: rows.slice(0, limit)
        },
        parseErrors: []
      }
    };
  };

  const respond = (request: HttpClientRequest.HttpClientRequest, url: URL): Response => {
    const body =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
    if (url.pathname === "/admin/oauth/access_token") {
      const form = new URLSearchParams(body);
      if (
        form.get("grant_type") !== "client_credentials" ||
        form.get("client_id") !== CLIENT_ID ||
        form.get("client_secret") !== CLIENT_SECRET
      )
        return json(400, { error: "invalid_client" });
      return json(200, { access_token: TOKEN, scope: SCOPES, expires_in: 86_399 });
    }
    if (url.pathname !== "/admin/api/2026-10/graphql.json")
      return json(404, { errors: "Not Found" });
    if (request.headers["x-shopify-access-token"] !== TOKEN)
      return json(401, { errors: "[API] Invalid API key or access token" });
    const { operationName, variables = {} } = JSON.parse(body) as {
      operationName: string;
      variables?: Record<string, unknown>;
    };
    const first = typeof variables.first === "number" ? variables.first : 10;
    switch (operationName) {
      case "PatchyShop":
        return graphql(
          {
            shop: {
              id: gid("Shop", 70_001),
              name: "Northwind Coffee Co.",
              myshopifyDomain: SHOP,
              currencyCode: "USD",
              ianaTimezone: "America/Los_Angeles",
              plan: { publicDisplayName: "Grow" }
            }
          },
          1
        );
      case "PatchyOrdersList": {
        const search = parseSearch(variables.query as string | undefined);
        const items = sorted(
          data.orders.filter((item) => search.every((term) => matchesOrder(item, term))),
          orderSorts,
          variables.sortKey ?? "CREATED_AT",
          variables.reverse
        );
        return graphql(
          {
            orders: shaped(page(items, first, variables.after), (item) => ({
              ...order(item),
              lineItems: shaped(page(item.lineItems, 10, undefined), lineItem)
            }))
          },
          2 + first * 14,
          search,
          orderFields
        );
      }
      case "PatchyOrder": {
        const item = data.orders.find((candidate) => candidate.id === numeric(variables.id));
        return graphql(
          {
            order:
              item === undefined
                ? null
                : {
                    ...order(item),
                    lineItems: shaped(page(item.lineItems, first, variables.after), lineItem)
                  }
          },
          3 + first * 3
        );
      }
      case "PatchyProductsList": {
        const search = parseSearch(variables.query as string | undefined);
        const items = sorted(
          data.products.filter((product) => search.every((term) => matchesProduct(product, term))),
          productSorts,
          variables.sortKey ?? "TITLE",
          variables.reverse
        );
        return graphql(
          {
            products: shaped(page(items, first, variables.after), (product) => ({
              ...productNode(product),
              variants: shaped(page(product.variants, 10, undefined), variantNode)
            }))
          },
          2 + first * 12,
          search,
          productFields
        );
      }
      case "PatchyProduct": {
        const product = data.products.find((candidate) => candidate.id === numeric(variables.id));
        return graphql(
          {
            product:
              product === undefined
                ? null
                : {
                    ...productNode(product),
                    variants: shaped(page(product.variants, first, variables.after), variantNode)
                  }
          },
          3 + first * 2
        );
      }
      case "PatchyInventoryLevels": {
        const location = data.locations.find(
          (candidate) => candidate.id === numeric(variables.locationId)
        );
        const levels = data.variants.map(({ variant }) => ({
          variant,
          quantities:
            location === undefined
              ? undefined
              : data.stock.get(`${variant.inventoryItemId}:${location.id}`)
        }));
        return graphql(
          {
            location:
              location === undefined
                ? null
                : {
                    inventoryLevels: shaped(
                      page(levels, first, variables.after),
                      ({ variant, quantities }) => ({
                        item: {
                          id: gid("InventoryItem", variant.inventoryItemId),
                          sku: variant.sku,
                          variant: { id: gid("ProductVariant", variant.id) }
                        },
                        quantities: [
                          { name: "available", quantity: quantities?.available ?? 0 },
                          { name: "on_hand", quantity: quantities?.onHand ?? 0 },
                          { name: "committed", quantity: quantities?.committed ?? 0 },
                          { name: "incoming", quantity: quantities?.incoming ?? 0 }
                        ]
                      })
                    )
                  }
          },
          2 + first * 4
        );
      }
      case "PatchyLocations":
        return graphql(
          {
            locations: shaped(page(data.locations, first, variables.after), (location) => ({
              id: gid("Location", location.id),
              name: location.name,
              isActive: location.isActive,
              address: { countryCode: location.countryCode, provinceCode: location.provinceCode }
            }))
          },
          2 + first
        );
      case "PatchyAnalytics":
        return graphql(analytics(String(variables.q ?? "")), 10);
      default:
        return json(200, {
          errors: [
            {
              message: `Field doesn't exist for ${operationName}`,
              extensions: { code: "undefinedField" }
            }
          ]
        });
    }
  };
  return { respond };
};
