/** PROTOTYPE (#815): what Shopify discovery keeps; apart from schemas.ts, which imports it. */
import * as Schema from "effect/Schema";

/** Why analytics can or can't run on a store, as connect last found it. */
export const ShopifyAnalyticsAvailability = Schema.Literals([
  "available",
  "needs_plan",
  "missing_access",
  "unknown"
]);
/** What Patchy keeps about a store: shop facts and the granted scopes, never business rows. */
export const ShopifySnapshot = Schema.Struct({
  version: Schema.Literal(1),
  shop: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    domain: Schema.String,
    plan: Schema.String,
    currency: Schema.String,
    timezone: Schema.String
  }),
  scopes: Schema.Array(Schema.String),
  analytics: ShopifyAnalyticsAvailability
});
export type ShopifySnapshot = typeof ShopifySnapshot.Type;
