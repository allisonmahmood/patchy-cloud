/**
 * PROTOTYPE (#815): the operations patch code may call. Each sends a fixed GraphQL selection
 * Patchy wrote, with a search Patchy builds from typed filters, and returns only the fields
 * named below. None of them selects, filters or sorts on a customer.
 */
import {
  type ShopifyDevRead,
  ShopifyDevRead as ShopifyDevReadSchema,
  ShopifyRead,
  shopifyDimensions,
  shopifyMetrics
} from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ConnectionStore from "../ConnectionStore.js";
import { operation } from "../definition.js";
import * as Source from "./Source.js";

export class ConnectionNotDeclared extends Schema.TaggedError<ConnectionNotDeclared>()(
  "ShopifyConnectionNotDeclared",
  {}
) {
  readonly code = "connection_not_declared" as const;
  readonly status = 400;
  override get message() {
    return "This Shopify connection is not declared by this version.";
  }
}
/** The app stopped working after connect: only an admin can fix it. */
export class ConnectionRefused extends Schema.TaggedError<ConnectionRefused>()(
  "ShopifyConnectionRefused",
  { cause: Schema.Union([Source.CredentialsRejected, Source.WrongScopes]) }
) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return `${this.cause.message} Ask a company administrator to fix it at /company/connections.`;
  }
}
export class ShapeMismatch extends Schema.TaggedError<ShapeMismatch>()("ShopifyShapeMismatch", {
  column: Schema.String
}) {
  readonly code = "shape_mismatch" as const;
  readonly status = 400;
  override get message() {
    return `Shopify's report didn't have the expected column ${this.column}.`;
  }
}

export const Errors = Schema.Union([
  ConnectionNotDeclared,
  ConnectionRefused,
  ShapeMismatch,
  Source.AccessDenied,
  Source.RateLimited,
  Source.Unavailable,
  Source.Timeout,
  Source.InvalidQuery,
  Source.TooLarge,
  Source.Busy,
  Runtime.InvalidRequest,
  Runtime.AccessDenied,
  Runtime.SourceUnavailable
]);

const DEADLINE_MS = registry["integration.deadline"].default;

// --- the fixed documents --------------------------------------------------------------------

const ORDER = `id number createdAt processedAt updatedAt cancelledAt closedAt
  displayFinancialStatus displayFulfillmentStatus currencyCode sourceName
  currentSubtotalPriceSet { shopMoney { amount } }
  currentTotalDiscountsSet { shopMoney { amount } }
  currentShippingPriceSet { shopMoney { amount } }
  currentTotalTaxSet { shopMoney { amount } }
  currentTotalPriceSet { shopMoney { amount } }
  totalRefundedSet { shopMoney { amount } }
  shippingAddress { countryCodeV2 provinceCode }`;
const LINE_ITEM = `id sku title variantTitle quantity currentQuantity
  originalUnitPriceSet { shopMoney { amount } }
  totalDiscountSet { shopMoney { amount } }
  product { id } variant { id }`;
const PAGE = `pageInfo { hasNextPage endCursor }`;
const PRODUCT = `id title status vendor productType createdAt updatedAt totalInventory`;
const VARIANT = `id title sku price inventoryQuantity inventoryItem { id }`;
/** How many children each list item carries inline; the rest come from the detail call. */
const INLINE_CHILDREN = 10;

const documents = {
  ordersList: `query PatchyOrdersList($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
  orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    nodes { ${ORDER} lineItems(first: ${INLINE_CHILDREN}) { nodes { ${LINE_ITEM} } ${PAGE} } }
    ${PAGE}
  }
}`,
  ordersGet: `query PatchyOrder($id: ID!, $first: Int!, $after: String) {
  order(id: $id) { ${ORDER} lineItems(first: $first, after: $after) { nodes { ${LINE_ITEM} } ${PAGE} } }
}`,
  productsList: `query PatchyProductsList($first: Int!, $after: String, $query: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
  products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    nodes { ${PRODUCT} variants(first: ${INLINE_CHILDREN}) { nodes { ${VARIANT} } ${PAGE} } }
    ${PAGE}
  }
}`,
  productsGet: `query PatchyProduct($id: ID!, $first: Int!, $after: String) {
  product(id: $id) { ${PRODUCT} variants(first: $first, after: $after) { nodes { ${VARIANT} } ${PAGE} } }
}`,
  inventoryLevels: `query PatchyInventoryLevels($locationId: ID!, $first: Int!, $after: String) {
  location(id: $locationId) {
    inventoryLevels(first: $first, after: $after) {
      nodes { item { id sku variant { id } } quantities(names: ["available", "on_hand", "committed", "incoming"]) { name quantity } }
      ${PAGE}
    }
  }
}`,
  locationsList: `query PatchyLocations($first: Int!, $after: String) {
  locations(first: $first, after: $after) { nodes { id name isActive address { countryCode provinceCode } } ${PAGE} }
}`,
  analytics: `query PatchyAnalytics($q: String!) {
  shopifyqlQuery(query: $q) { tableData { columns { name dataType } rows } parseErrors }
}`
};

// --- searches Patchy builds -----------------------------------------------------------------

/** A value as a literal under Shopify's search grammar: quoted, quotes and backslashes escaped. */
const literal = (value: string) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
const range = (
  field: string,
  value: { readonly from?: string; readonly to?: string } | undefined
) => [
  ...(value?.from === undefined ? [] : [`${field}:>=${value.from}`]),
  ...(value?.to === undefined ? [] : [`${field}:<=${value.to}`])
];
const search = (terms: ReadonlyArray<string>) => (terms.length === 0 ? undefined : terms.join(" "));

const orderSorts = {
  createdAt: "CREATED_AT",
  processedAt: "PROCESSED_AT",
  updatedAt: "UPDATED_AT",
  orderNumber: "ORDER_NUMBER",
  total: "TOTAL_PRICE"
} as const;
const productSorts = {
  title: "TITLE",
  createdAt: "CREATED_AT",
  updatedAt: "UPDATED_AT",
  inventory: "INVENTORY_TOTAL"
} as const;

// --- mapping Shopify's nodes to what patches see --------------------------------------------

type Json = typeof Schema.Json.Type;
type Node = Readonly<Record<string, unknown>>;
const record = (value: unknown): Node => (Predicate.isObject(value) ? (value as Node) : {});
const amount = (value: unknown): string | null => {
  const found = record(record(value).shopMoney).amount;
  return typeof found === "string" ? found : null;
};
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const id = (value: unknown): string | null => text(record(value).id);
const page = <A>(value: unknown, map: (node: Node) => A) => {
  const connection = record(value);
  const info = record(connection.pageInfo);
  return {
    nodes: (Array.isArray(connection.nodes) ? connection.nodes : []).map((node) =>
      map(record(node))
    ),
    pageInfo: {
      hasNextPage: info.hasNextPage === true,
      endCursor: text(info.endCursor)
    }
  };
};
const lineItem = (node: Node) => ({
  id: text(node.id),
  productId: id(node.product),
  variantId: id(node.variant),
  sku: text(node.sku),
  title: text(node.title),
  variantTitle: text(node.variantTitle),
  quantity: typeof node.quantity === "number" ? node.quantity : 0,
  currentQuantity: typeof node.currentQuantity === "number" ? node.currentQuantity : 0,
  unitPrice: amount(node.originalUnitPriceSet),
  discount: amount(node.totalDiscountSet)
});
const order = (node: Node) => {
  const address = record(node.shippingAddress);
  return {
    id: text(node.id),
    number: typeof node.number === "number" ? node.number : null,
    createdAt: text(node.createdAt),
    processedAt: text(node.processedAt),
    updatedAt: text(node.updatedAt),
    cancelledAt: text(node.cancelledAt),
    closedAt: text(node.closedAt),
    financialStatus: text(node.displayFinancialStatus),
    fulfillmentStatus: text(node.displayFulfillmentStatus),
    currency: text(node.currencyCode),
    salesChannel: text(node.sourceName),
    subtotal: amount(node.currentSubtotalPriceSet),
    discounts: amount(node.currentTotalDiscountsSet),
    shipping: amount(node.currentShippingPriceSet),
    tax: amount(node.currentTotalTaxSet),
    total: amount(node.currentTotalPriceSet),
    refunded: amount(node.totalRefundedSet),
    shippingCountry: text(address.countryCodeV2),
    shippingRegion: text(address.provinceCode),
    lineItems: page(node.lineItems, lineItem)
  };
};
const variant = (node: Node) => ({
  id: text(node.id),
  title: text(node.title),
  sku: text(node.sku),
  price: text(node.price),
  inventoryQuantity: typeof node.inventoryQuantity === "number" ? node.inventoryQuantity : null,
  inventoryItemId: id(node.inventoryItem)
});
const product = (node: Node) => ({
  id: text(node.id),
  title: text(node.title),
  status: text(node.status),
  vendor: text(node.vendor),
  productType: text(node.productType),
  createdAt: text(node.createdAt),
  updatedAt: text(node.updatedAt),
  totalInventory: typeof node.totalInventory === "number" ? node.totalInventory : null,
  variants: page(node.variants, variant)
});
const level = (locationId: string) => (node: Node) => {
  const item = record(node.item);
  const quantities = new Map(
    (Array.isArray(node.quantities) ? node.quantities : []).map((entry) => {
      const found = record(entry);
      return [found.name, typeof found.quantity === "number" ? found.quantity : null] as const;
    })
  );
  return {
    inventoryItemId: text(item.id),
    sku: text(item.sku),
    variantId: id(item.variant),
    locationId,
    available: quantities.get("available") ?? null,
    onHand: quantities.get("on_hand") ?? null,
    committed: quantities.get("committed") ?? null,
    incoming: quantities.get("incoming") ?? null
  };
};
const location = (node: Node) => {
  const address = record(node.address);
  return {
    id: text(node.id),
    name: text(node.name),
    isActive: node.isActive === true,
    countryCode: text(address.countryCode),
    regionCode: text(address.provinceCode)
  };
};

// --- analytics: Patchy writes the ShopifyQL --------------------------------------------------

type AnalyticsInput = Extract<ShopifyDevRead, { readonly operation: "analytics" }>["input"];
/** ShopifyQL single-quoted: backslashes and quotes escaped, so a value can't end the literal. */
const quoted = (value: string) => `'${value.replace(/[\\']/g, (char) => `\\${char}`)}'`;
export const shopifyql = (input: AnalyticsInput) => {
  const groupBy = input.groupBy ?? [];
  const where = Object.entries(input.where ?? {});
  const columns = [
    ...(input.timeseries === undefined ? [] : [input.timeseries]),
    ...groupBy,
    ...input.show
  ];
  const order =
    input.orderBy !== undefined && (columns as ReadonlyArray<string>).includes(input.orderBy.column)
      ? `ORDER BY ${input.orderBy.column} ${input.orderBy.direction === "asc" ? "ASC" : "DESC"}`
      : undefined;
  return [
    "FROM sales",
    `SHOW ${input.show.join(", ")}`,
    ...(where.length === 0
      ? []
      : [`WHERE ${where.map(([key, value]) => `${key} = ${quoted(value)}`).join(" AND ")}`]),
    ...(groupBy.length === 0 ? [] : [`GROUP BY ${groupBy.join(", ")}`]),
    ...(input.timeseries === undefined ? [] : [`TIMESERIES ${input.timeseries}`]),
    `SINCE ${input.since}`,
    ...(input.until === undefined ? [] : [`UNTIL ${input.until}`]),
    ...(order === undefined ? [] : [order]),
    `LIMIT ${input.limit ?? 1_000}`
  ].join(" ");
};
const analyticsRows = (input: AnalyticsInput, data: unknown) =>
  Effect.gen(function* () {
    const result = record(record(data).shopifyqlQuery);
    const errors = Array.isArray(result.parseErrors) ? result.parseErrors : [];
    if (errors.length > 0)
      return yield* new Source.InvalidQuery({
        details: { message: String(errors[0]).slice(0, 500) }
      });
    const table = record(result.tableData);
    const columns = (Array.isArray(table.columns) ? table.columns : []).map(
      (column) => text(record(column).name) ?? ""
    );
    const expected = [
      ...(input.timeseries === undefined ? [] : [input.timeseries]),
      ...(input.groupBy ?? []),
      ...input.show
    ];
    for (const name of expected)
      if (!columns.includes(name)) return yield* new ShapeMismatch({ column: name });
    const rows = Array.isArray(table.rows) ? table.rows : [];
    return {
      rows: rows.map((row) => {
        const cells = Array.isArray(row)
          ? Object.fromEntries(columns.map((name, index) => [name, row[index]]))
          : record(row);
        return Object.fromEntries(
          expected.map((name) => {
            const cell = cells[name];
            if (name in shopifyMetrics)
              return [
                name,
                shopifyMetrics[name as keyof typeof shopifyMetrics] === "integer"
                  ? Number(cell ?? 0)
                  : cell === null || cell === undefined
                    ? "0.00"
                    : String(cell)
              ];
            if (name in shopifyDimensions || cell !== undefined)
              return [name, cell === null || cell === undefined ? null : String(cell)];
            return [name, null];
          })
        ) as Readonly<Record<string, Json>>;
      })
    };
  });

/** The GraphQL each operation sends, and how its answer becomes what the patch sees. */
const plan = (read: ShopifyDevRead) => {
  switch (read.operation) {
    case "orders.list": {
      const input = read.input;
      return {
        request: {
          name: "PatchyOrdersList",
          query: documents.ordersList,
          variables: {
            first: input.first ?? 25,
            after: input.after ?? null,
            sortKey: orderSorts[input.sort ?? "createdAt"],
            reverse: input.reverse ?? input.sort === undefined,
            query:
              search([
                ...range("created_at", input.created),
                ...range("processed_at", input.processed),
                ...range("updated_at", input.updated),
                ...(input.status === undefined ? [] : [`status:${input.status}`]),
                ...(input.financialStatus === undefined
                  ? []
                  : [`financial_status:${input.financialStatus}`]),
                ...(input.fulfillmentStatus === undefined
                  ? []
                  : [`fulfillment_status:${input.fulfillmentStatus}`]),
                ...(input.sku === undefined ? [] : [`sku:${literal(input.sku)}`])
              ]) ?? null
          }
        },
        map: (data: unknown) => Effect.succeed(page(record(data).orders, order))
      };
    }
    case "orders.get":
      return {
        request: {
          name: "PatchyOrder",
          query: documents.ordersGet,
          variables: {
            id: read.input.id,
            first: read.input.lineItems?.first ?? 50,
            after: read.input.lineItems?.after ?? null
          }
        },
        map: (data: unknown) => {
          const found = record(data).order;
          return Effect.succeed(Predicate.isObject(found) ? order(record(found)) : null);
        }
      };
    case "products.list": {
      const input = read.input;
      return {
        request: {
          name: "PatchyProductsList",
          query: documents.productsList,
          variables: {
            first: input.first ?? 25,
            after: input.after ?? null,
            sortKey: productSorts[input.sort ?? "title"],
            reverse: input.reverse ?? false,
            query:
              search([
                ...(input.status === undefined ? [] : [`status:${input.status}`]),
                ...range("created_at", input.created),
                ...range("updated_at", input.updated),
                ...(input.sku === undefined ? [] : [`sku:${literal(input.sku)}`])
              ]) ?? null
          }
        },
        map: (data: unknown) => Effect.succeed(page(record(data).products, product))
      };
    }
    case "products.get":
      return {
        request: {
          name: "PatchyProduct",
          query: documents.productsGet,
          variables: {
            id: read.input.id,
            first: read.input.variants?.first ?? 50,
            after: read.input.variants?.after ?? null
          }
        },
        map: (data: unknown) => {
          const found = record(data).product;
          return Effect.succeed(Predicate.isObject(found) ? product(record(found)) : null);
        }
      };
    case "inventory.levels": {
      const input = read.input;
      return {
        request: {
          name: "PatchyInventoryLevels",
          query: documents.inventoryLevels,
          variables: {
            locationId: input.locationId,
            first: input.first ?? 50,
            after: input.after ?? null
          }
        },
        map: (data: unknown) =>
          Effect.succeed(
            page(record(record(data).location).inventoryLevels, level(input.locationId))
          )
      };
    }
    case "locations.list":
      return {
        request: {
          name: "PatchyLocations",
          query: documents.locationsList,
          variables: { first: read.input.first ?? 25, after: read.input.after ?? null }
        },
        map: (data: unknown) => Effect.succeed(page(record(data).locations, location))
      };
    case "analytics":
      return {
        request: {
          name: "PatchyAnalytics",
          query: documents.analytics,
          variables: { q: shopifyql(read.input) }
        },
        map: (data: unknown) => analyticsRows(read.input, data)
      };
  }
};

// --- running one read -----------------------------------------------------------------------

const connect = Effect.fn("ShopifyOperations.connect")(function* (
  companyId: string,
  declared: Target["connection"]
) {
  const connections = yield* ConnectionStore.ConnectionStore;
  const connection = yield* connections
    .get(companyId, declared.id)
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ConnectionNotFound" ? cause : new Runtime.SourceUnavailable({ cause })
      )
    );
  if (
    connection.companyId !== companyId ||
    connection.id !== declared.id ||
    connection.integration !== "shopify" ||
    connection.handle !== declared.handle
  )
    return yield* new ConnectionStore.ConnectionNotFound({
      companyId,
      lookup: { id: declared.id }
    });
  if (connection.status !== "connected")
    return yield* new ConnectionStore.ConnectionNotConnected({});
  const secret = yield* connections
    .poolCredentials(
      companyId,
      {
        kind: "shopify",
        id: connection.id,
        handle: connection.handle,
        revision: connection.metadataRevision
      },
      connection.credentialRevision
    )
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ConnectionNotConnected" || cause._tag === "ConnectionNotFound"
          ? cause
          : new Runtime.SourceUnavailable({ cause })
      )
    );
  return yield* Source.parseCredentials(secret).pipe(
    Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
  );
});

export interface Target<E = never> {
  readonly companyId: string;
  readonly connection: { readonly id: string; readonly handle: string };
  readonly deadline: number;
  readonly recheck: Effect.Effect<void, E>;
}

const perform = Effect.fn("ShopifyOperations.perform")(function* <E>(
  target: Target<E>,
  read: ShopifyDevRead
) {
  const credentials = yield* connect(target.companyId, target.connection);
  const source = yield* Source.Source;
  const { request, map } = plan(read);
  const data = yield* source.withSlot(
    credentials,
    target.deadline
  )(
    Effect.gen(function* () {
      yield* target.recheck;
      const current = yield* connect(target.companyId, target.connection);
      if (current.shop !== credentials.shop)
        return yield* new Runtime.SourceUnavailable({
          cause: new ConnectionStore.ConnectionChanged({})
        });
      return yield* source.graphql(current, request).pipe(
        Effect.catchTags({
          ShopifyCredentialsRejected: (cause) => Effect.fail(new ConnectionRefused({ cause })),
          ShopifyWrongScopes: (cause) => Effect.fail(new ConnectionRefused({ cause }))
        })
      );
    })
  );
  return (yield* map(data.data)) as Json;
});

const read = operation({
  input: ShopifyRead,
  output: Schema.Json,
  errors: Errors,
  run: Effect.fn("ShopifyOperations.read")(function* (args: typeof ShopifyRead.Type) {
    const binding = yield* Binding.Binding;
    const declaration = binding.manifest.uses[args.connection];
    if (!Object.hasOwn(binding.manifest.uses, args.connection) || declaration?.kind !== "shopify")
      return yield* new ConnectionNotDeclared({});
    if (
      binding.scope !== "company" ||
      binding.identity === null ||
      binding.principal === null ||
      binding.identity.company.id !== binding.companyId ||
      binding.identity.user.id !== binding.principal.userId
    )
      return yield* new Runtime.AccessDenied({});
    const deadline = binding.deadline ?? (yield* Clock.currentTimeMillis) + DEADLINE_MS;
    return yield* perform(
      { companyId: binding.companyId, connection: declaration, deadline, recheck: Effect.void },
      { operation: args.operation, input: args.input } as ShopifyDevRead
    ).pipe(
      Effect.catchTags({
        ConnectionNotFound: (cause) => Effect.fail(new Runtime.AccessDenied({ cause })),
        ConnectionNotConnected: (cause) => Effect.fail(new Runtime.AccessDenied({ cause }))
      })
    );
  })
});

export const operations = { read };

const connectionId = (args: unknown, binding: Binding.Binding["Service"]): string | null => {
  if (
    !Predicate.isObject(args) ||
    typeof args.connection !== "string" ||
    !Object.hasOwn(binding.manifest.uses, args.connection)
  )
    return null;
  const declaration = binding.manifest.uses[args.connection];
  return declaration?.kind === "shopify" ? declaration.id : null;
};

/** Recent calls name the operation and which filters it used, never their values or the rows. */
const recorded = {
  resource: (args: unknown) =>
    Predicate.isObject(args) && typeof args.operation === "string"
      ? args.operation.slice(0, 40)
      : null,
  rowCount: (value: unknown) =>
    Predicate.isObject(value) && Array.isArray(value.nodes)
      ? value.nodes.length
      : Predicate.isObject(value) && Array.isArray(value.rows)
        ? value.rows.length
        : null,
  sql: (args: unknown) =>
    Predicate.isObject(args) && Predicate.isObject(args.input)
      ? `${String(args.operation)} ${Object.keys(args.input).sort().join(", ")}`.slice(0, 200)
      : undefined
};

export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const connections = yield* ConnectionStore.ConnectionStore;
  return {
    "shopify.read": Runtime.handler(
      { kind: "integration", ...read, ...recorded, connectionId },
      (args) =>
        read
          .run(args)
          .pipe(
            Effect.provideService(Source.Source, source),
            Effect.provideService(ConnectionStore.ConnectionStore, connections)
          )
    )
  };
});

const decodeDevRead = Schema.decodeUnknownEffect(ShopifyDevReadSchema, {
  onExcessProperty: "error"
});

/** `shopify.read` as the dev door runs it, for `patchy dev` (ADR-0013). */
export const devReads = {
  "shopify.read": {
    ...recorded,
    run: <E extends Runtime.RuntimeError>(target: Target<E>, args: unknown) =>
      decodeDevRead(args).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })),
        Effect.flatMap((decoded) => perform(target, decoded))
      )
  }
};
