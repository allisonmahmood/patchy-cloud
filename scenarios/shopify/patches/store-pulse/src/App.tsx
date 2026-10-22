import { useEffect, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import type { InventoryLevel, Location, Order, Page } from "../patchy/_generated/uses/store.js";

const store = patchy.connections.store;

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const whole = new Intl.NumberFormat("en-US");
const dayLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC"
});

/** Loads once; `undefined` while loading, an Error when it failed. */
function useLoad<A>(load: () => Promise<A>, deps: ReadonlyArray<unknown> = []) {
  const [value, setValue] = useState<A | Error | undefined>(undefined);
  useEffect(() => {
    let current = true;
    setValue(undefined);
    load().then(
      (result) => current && setValue(result),
      (error: unknown) =>
        current && setValue(error instanceof Error ? error : new Error(String(error)))
    );
    return () => {
      current = false;
    };
  }, deps);
  return value;
}

function Status({ value }: { value: unknown }) {
  if (value === undefined) return <p className="muted">Loading…</p>;
  if (value instanceof Error) return <p className="error">{value.message}</p>;
  return null;
}

const change = (now: number, before: number) =>
  before === 0 ? null : Math.round(((now - before) / before) * 100);

function Delta({ now, before }: { now: number; before: number }) {
  const pct = change(now, before);
  if (pct === null) return null;
  return (
    <span className={pct >= 0 ? "delta up" : "delta down"}>
      {pct >= 0 ? "▲" : "▼"} {Math.abs(pct)}% vs previous 30 days
    </span>
  );
}

function Totals() {
  const totals = useLoad(() =>
    Promise.all([
      store.analytics({
        show: ["orders", "net_items_sold", "net_sales"],
        since: "-30d",
        until: "yesterday"
      }),
      store.analytics({
        show: ["orders", "net_items_sold", "net_sales"],
        since: "-60d",
        until: "-31d"
      })
    ])
  );
  if (totals === undefined || totals instanceof Error) return <Status value={totals} />;
  const [now, before] = totals.map((result) => result.rows[0]);
  const tile = (label: string, value: string, a: number, b: number) => (
    <div className="tile">
      <p className="tile-label">{label}</p>
      <p className="tile-value">{value}</p>
      <Delta now={a} before={b} />
    </div>
  );
  return (
    <div className="tiles">
      {tile(
        "Orders, last 30 days",
        whole.format(now?.orders ?? 0),
        now?.orders ?? 0,
        before?.orders ?? 0
      )}
      {tile(
        "Items sold",
        whole.format(now?.net_items_sold ?? 0),
        now?.net_items_sold ?? 0,
        before?.net_items_sold ?? 0
      )}
      {tile(
        "Net sales",
        currency.format(Number(now?.net_sales ?? 0)),
        Number(now?.net_sales ?? 0),
        Number(before?.net_sales ?? 0)
      )}
    </div>
  );
}

function OrdersChart() {
  const daily = useLoad(() =>
    store.analytics({ show: ["orders"], timeseries: "day", since: "-90d", until: "yesterday" })
  );
  if (daily === undefined || daily instanceof Error) return <Status value={daily} />;
  const rows = daily.rows;
  const max = Math.max(1, ...rows.map((row) => row.orders));
  const width = 720;
  const height = 160;
  const bar = width / Math.max(1, rows.length);
  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${width} ${height + 18}`}
        role="img"
        aria-label="Orders per day, last 90 days"
      >
        {rows.map((row, index) => {
          const h = (row.orders / max) * height;
          return (
            <rect
              key={row.day}
              x={index * bar + 1}
              y={height - h}
              width={Math.max(1, bar - 2)}
              height={h}
              rx="1.5"
            >
              <title>{`${dayLabel.format(new Date(row.day))}: ${row.orders} orders`}</title>
            </rect>
          );
        })}
        {rows
          .filter((_, index) => index % 14 === 0)
          .map((row) => (
            <text key={row.day} x={rows.indexOf(row) * bar} y={height + 14}>
              {dayLabel.format(new Date(row.day))}
            </text>
          ))}
      </svg>
      <figcaption className="muted">
        Orders per day, last 90 days. Hover a bar for its count.
      </figcaption>
    </figure>
  );
}

function ItemTrends() {
  const trends = useLoad(() =>
    Promise.all([
      store.analytics({
        show: ["net_items_sold", "net_sales"],
        groupBy: ["product_title"],
        since: "-28d",
        until: "yesterday",
        limit: 100
      }),
      store.analytics({
        show: ["net_items_sold"],
        groupBy: ["product_title"],
        since: "-56d",
        until: "-29d",
        limit: 100
      })
    ])
  );
  if (trends === undefined || trends instanceof Error) return <Status value={trends} />;
  const [recent, earlier] = trends;
  const before = new Map(earlier.rows.map((row) => [row.product_title, row.net_items_sold]));
  const items = recent.rows
    .map((row) => ({ ...row, before: before.get(row.product_title) ?? 0 }))
    .sort((a, b) => b.net_items_sold - a.net_items_sold);
  return (
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th className="num">Sold, last 4 weeks</th>
          <th className="num">4 weeks before</th>
          <th className="num">Change</th>
          <th className="num">Net sales</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const pct = change(item.net_items_sold, item.before);
          return (
            <tr key={item.product_title}>
              <td>{item.product_title}</td>
              <td className="num">{whole.format(item.net_items_sold)}</td>
              <td className="num muted">{whole.format(item.before)}</td>
              <td
                className={`num ${pct === null ? "" : pct >= 10 ? "up" : pct <= -10 ? "down" : "muted"}`}
              >
                {pct === null ? "new" : `${pct > 0 ? "+" : ""}${pct}%`}
              </td>
              <td className="num">{currency.format(Number(item.net_sales))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const age = (iso: string) => {
  const hours = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

function ToShip() {
  const [pages, setPages] = useState<Page<Order>[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const load = (after?: string) =>
    store.orders
      .list({
        status: "open",
        fulfillmentStatus: "unfulfilled",
        sort: "createdAt",
        reverse: false,
        first: 15,
        ...(after ? { after } : {})
      })
      .then(
        (page) => setPages((loaded) => [...loaded, page]),
        (failure: unknown) =>
          setError(failure instanceof Error ? failure : new Error(String(failure)))
      );
  useEffect(() => {
    void load();
  }, []);
  if (error) return <p className="error">{error.message}</p>;
  if (pages.length === 0) return <p className="muted">Loading…</p>;
  const orders = pages.flatMap((page) => page.nodes);
  const last = pages.at(-1)!;
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Waiting</th>
            <th>Items</th>
            <th>Channel</th>
            <th>Ships to</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td>#{order.number}</td>
              <td
                className={Date.now() - Date.parse(order.createdAt) > 2 * 86_400_000 ? "down" : ""}
              >
                {age(order.createdAt)}
              </td>
              <td>
                {order.lineItems.nodes
                  .map(
                    (line) =>
                      `${line.quantity}× ${line.title}${line.variantTitle ? ` (${line.variantTitle})` : ""}`
                  )
                  .join(", ")}
              </td>
              <td className="muted">{order.salesChannel}</td>
              <td className="muted">
                {[order.shippingRegion, order.shippingCountry].filter(Boolean).join(", ")}
              </td>
              <td className="num">{currency.format(Number(order.total))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {last.pageInfo.hasNextPage && (
        <button className="more" onClick={() => void load(last.pageInfo.endCursor ?? undefined)}>
          Load more
        </button>
      )}
    </>
  );
}

const LOW = 20;

function LowStock() {
  const stock = useLoad(async () => {
    const locations: readonly Location[] = (await store.locations.list()).nodes;
    const products = (await store.products.list({ status: "active", first: 50 })).nodes;
    const names = new Map(
      products.flatMap((product) =>
        product.variants.nodes.map((variant) => [
          variant.id,
          `${product.title}${variant.title === "Default Title" ? "" : ` (${variant.title})`}`
        ])
      )
    );
    const levels = await Promise.all(
      locations.map(async (location) => ({
        location,
        levels: (await store.inventory.levels({ locationId: location.id, first: 100 })).nodes
      }))
    );
    return levels.flatMap(({ location, levels: found }) =>
      found
        .filter(
          (level: InventoryLevel) =>
            level.variantId !== null && names.has(level.variantId) && (level.available ?? 0) < LOW
        )
        .map((level) => ({ location: location.name, name: names.get(level.variantId!)!, level }))
    );
  });
  if (stock === undefined || stock instanceof Error) return <Status value={stock} />;
  if (stock.length === 0) return <p className="muted">Nothing is below {LOW} anywhere.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th>Location</th>
          <th className="num">Available</th>
          <th className="num">Committed</th>
          <th className="num">Incoming</th>
        </tr>
      </thead>
      <tbody>
        {stock
          .sort((a, b) => (a.level.available ?? 0) - (b.level.available ?? 0))
          .map(({ location, name, level }) => (
            <tr key={`${level.inventoryItemId}:${location}`}>
              <td>{name}</td>
              <td className="muted">{location}</td>
              <td className={`num ${(level.available ?? 0) < 5 ? "down" : ""}`}>
                {level.available}
              </td>
              <td className="num muted">{level.committed}</td>
              <td className="num">{level.incoming ? `+${level.incoming}` : "—"}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

export function App() {
  return (
    <div className="app">
      <header>
        <p className="eyebrow">Northwind Coffee Co. · Shopify</p>
        <h1>Store pulse</h1>
        <p className="muted">
          Totals end yesterday, so they don't move while you read. No customer details, by design.
        </p>
      </header>
      <Totals />
      <section>
        <h2>Orders</h2>
        <OrdersChart />
      </section>
      <section>
        <h2>Which items are moving</h2>
        <ItemTrends />
      </section>
      <div className="split">
        <section>
          <h2>Waiting to ship</h2>
          <ToShip />
        </section>
        <section>
          <h2>Running low</h2>
          <LowStock />
        </section>
      </div>
    </div>
  );
}
