/**
 * PROTOTYPE (#815): Shopify's wire. Patch code calls a fixed set of Patchy-written operations,
 * never raw GraphQL, ShopifyQL or Shopify search strings, so no request can reach a customer.
 * Every operation travels as one runtime op, `shopify.read`, naming the operation it runs.
 */
import * as Schema from "effect/Schema";
import { DefinitionName } from "./schemas.js";

const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
const Cursor = Schema.String.check(Schema.isBetweenLength(1, 512));
const ShopifyId = Schema.String.check(Schema.isPattern(/^gid:\/\/shopify\/[A-Za-z]+\/\d{1,20}$/));
/** A literal value Patchy quotes into a search itself; never syntax. */
const SearchText = Schema.String.check(Schema.isBetweenLength(1, 100));
const pageSize = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));
const DateRange = Schema.Struct({
  from: Schema.optionalKey(IsoDate),
  to: Schema.optionalKey(IsoDate)
});
const ChildPage = (maximum: number) =>
  Schema.Struct({
    first: Schema.optionalKey(pageSize(maximum)),
    after: Schema.optionalKey(Cursor)
  });

export const ShopifyOrdersList = Schema.Struct({
  created: Schema.optionalKey(DateRange),
  processed: Schema.optionalKey(DateRange),
  updated: Schema.optionalKey(DateRange),
  status: Schema.optionalKey(Schema.Literals(["open", "closed", "cancelled", "any"])),
  financialStatus: Schema.optionalKey(
    Schema.Literals([
      "pending",
      "authorized",
      "paid",
      "partially_paid",
      "partially_refunded",
      "refunded",
      "voided"
    ])
  ),
  fulfillmentStatus: Schema.optionalKey(
    Schema.Literals(["unfulfilled", "partial", "fulfilled", "unshipped", "shipped"])
  ),
  sku: Schema.optionalKey(SearchText),
  sort: Schema.optionalKey(
    Schema.Literals(["createdAt", "processedAt", "updatedAt", "orderNumber", "total"])
  ),
  reverse: Schema.optionalKey(Schema.Boolean),
  first: Schema.optionalKey(pageSize(50)),
  after: Schema.optionalKey(Cursor)
});
export const ShopifyOrdersGet = Schema.Struct({
  id: ShopifyId,
  lineItems: Schema.optionalKey(ChildPage(100))
});
export const ShopifyProductsList = Schema.Struct({
  status: Schema.optionalKey(Schema.Literals(["active", "draft", "archived"])),
  created: Schema.optionalKey(DateRange),
  updated: Schema.optionalKey(DateRange),
  sku: Schema.optionalKey(SearchText),
  sort: Schema.optionalKey(Schema.Literals(["title", "createdAt", "updatedAt", "inventory"])),
  reverse: Schema.optionalKey(Schema.Boolean),
  first: Schema.optionalKey(pageSize(50)),
  after: Schema.optionalKey(Cursor)
});
export const ShopifyProductsGet = Schema.Struct({
  id: ShopifyId,
  variants: Schema.optionalKey(ChildPage(100))
});
export const ShopifyInventoryLevels = Schema.Struct({
  locationId: ShopifyId,
  first: Schema.optionalKey(pageSize(100)),
  after: Schema.optionalKey(Cursor)
});
export const ShopifyLocationsList = Schema.Struct({
  first: Schema.optionalKey(pageSize(50)),
  after: Schema.optionalKey(Cursor)
});

/**
 * What `analytics` may name, over Shopify's `sales` dataset only. Nothing here is per customer,
 * and nothing locates a buyer more finely than country and region.
 */
export const shopifyMetrics = {
  orders: "integer",
  net_items_sold: "integer",
  gross_sales: "money",
  discounts: "money",
  net_sales: "money",
  total_sales: "money"
} as const;
export const shopifyDimensions = {
  product_id: { filter: true },
  product_variant_id: { filter: true },
  product_title: { filter: false },
  product_variant_title: { filter: false },
  product_variant_sku: { filter: false },
  sales_channel: { filter: true },
  shipping_country_code: { filter: true },
  shipping_region: { filter: true }
} as const;
export type ShopifyMetric = keyof typeof shopifyMetrics;
export type ShopifyDimension = keyof typeof shopifyDimensions;
export type ShopifyFilterDimension = {
  [K in ShopifyDimension]: (typeof shopifyDimensions)[K]["filter"] extends true ? K : never;
}[ShopifyDimension];
const metricNames = Object.keys(shopifyMetrics) as [ShopifyMetric, ...ShopifyMetric[]];
const dimensionNames = Object.keys(shopifyDimensions) as [ShopifyDimension, ...ShopifyDimension[]];
const filterNames = dimensionNames.filter(
  (name): name is ShopifyFilterDimension => shopifyDimensions[name].filter
) as [ShopifyFilterDimension, ...ShopifyFilterDimension[]];
/** A calendar date, or an offset back from today: `-90d`, `-12w`, `-6m`, `-2y`. */
export const ShopifyPeriod = Schema.String.check(
  Schema.isPattern(/^(?:\d{4}-\d{2}-\d{2}|today|yesterday|-[1-9]\d{0,3}[dwmy])$/)
);
export const shopifyBuckets = ["day", "week", "month", "quarter", "year"] as const;
export const ShopifyAnalytics = Schema.Struct({
  show: Schema.Array(Schema.Literals(metricNames)).check(Schema.isBetweenLength(1, 6)),
  groupBy: Schema.optionalKey(
    Schema.Array(Schema.Literals(dimensionNames)).check(Schema.isMaxLength(3))
  ),
  where: Schema.optionalKey(
    Schema.Record(Schema.Literals(filterNames), Schema.String.check(Schema.isBetweenLength(1, 200)))
  ),
  since: ShopifyPeriod,
  until: Schema.optionalKey(ShopifyPeriod),
  timeseries: Schema.optionalKey(Schema.Literals(shopifyBuckets)),
  orderBy: Schema.optionalKey(
    Schema.Struct({
      column: Schema.String.check(Schema.isPattern(/^[a-z_]{1,40}$/)),
      direction: Schema.optionalKey(Schema.Literals(["asc", "desc"]))
    })
  ),
  limit: Schema.optionalKey(pageSize(1_000))
});

const reads = [
  Schema.Struct({ operation: Schema.Literal("orders.list"), input: ShopifyOrdersList }),
  Schema.Struct({ operation: Schema.Literal("orders.get"), input: ShopifyOrdersGet }),
  Schema.Struct({ operation: Schema.Literal("products.list"), input: ShopifyProductsList }),
  Schema.Struct({ operation: Schema.Literal("products.get"), input: ShopifyProductsGet }),
  Schema.Struct({ operation: Schema.Literal("inventory.levels"), input: ShopifyInventoryLevels }),
  Schema.Struct({ operation: Schema.Literal("locations.list"), input: ShopifyLocationsList }),
  Schema.Struct({ operation: Schema.Literal("analytics"), input: ShopifyAnalytics })
] as const;
/** One Patchy-written operation and its typed input, without the connection. */
export const ShopifyDevRead = Schema.Union(reads);
export type ShopifyDevRead = typeof ShopifyDevRead.Type;
export type ShopifyOperation = ShopifyDevRead["operation"];
export const ShopifyRead = Schema.Union(
  reads.map((read) => Schema.Struct({ connection: DefinitionName, ...read.fields }))
);
export type ShopifyRead = typeof ShopifyRead.Type;

export const shopifyOperations = {
  "shopify.read": {
    request: Schema.Struct({ op: Schema.Literal("shopify.read"), args: ShopifyRead }),
    response: Schema.Json,
    kind: "integration"
  }
} as const;
