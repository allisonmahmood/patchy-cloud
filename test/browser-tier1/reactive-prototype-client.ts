// PROTOTYPE for #313, not for merge.
// The fixture patch: a subscribed list of `rows` rendered in the frame, an insert button, and a
// harness the Playwright spec drives. This is what a builder's screen looks like with the model.
import {
  createClient,
  createPostMessageTransport,
  subscriptionStats,
  type SubscriptionStatus
} from "patchy/client";

interface Row {
  readonly id: string;
  readonly label: string;
  readonly owner?: string | null;
}
export interface Recorded {
  readonly at: number;
  readonly kind: "snapshot" | "status" | "error";
  readonly name: string;
  readonly rows?: number;
  readonly labels?: string[];
}
export interface PrototypeWindow extends Window {
  harness: {
    ready: boolean;
    readonly client: typeof client;
    readonly events: Recorded[];
    readonly stats: typeof subscriptionStats;
    status: SubscriptionStatus | "idle";
    /** Subscribe the visible list; returns the unsubscribe. `own` filters by the viewer. */
    subscribe(name: string, args?: Record<string, unknown>): void;
    unsubscribe(name: string): void;
    labels(): string[];
    /** Timed insert: wall-clock before the call and when the runtime acknowledged the commit. */
    insert(label: string, owner?: string): Promise<{ id: string; started: number; acked: number }>;
    /** The refusal case: a subscription over a company Postgres connection. */
    subscribePostgres(): Promise<string>;
  };
}

const host = window as unknown as PrototypeWindow;
const transport = createPostMessageTransport();
const client = createClient<{
  tables: {
    rows: {
      columns: { label: { kind: "text" }; owner: { kind: "text"; optional: true } };
      indexes: { byOwner: { columns: ["owner"] } };
    };
  };
  files: Record<never, never>;
  uses: Record<never, never>;
}>(
  {
    tables: { rows: {} },
    files: {},
    uses: {}
  },
  { transport, shared: {}, connections: {} }
);
const rows = client.tables.rows!;
const list = document.querySelector<HTMLUListElement>("#list")!;
const statusLine = document.querySelector<HTMLParagraphElement>("#status")!;
const active = new Map<string, () => void>();
let current: string[] = [];
// Wall clock, so a snapshot in one browser can be timed against a write in another.
const record = (event: Omit<Recorded, "at">) => harness.events.push({ at: Date.now(), ...event });
const render = (name: string, page: { rows: readonly Row[] }) => {
  current = page.rows.map((row) => row.label);
  record({ kind: "snapshot", name, rows: page.rows.length, labels: current });
  list.replaceChildren(
    ...page.rows.map((row) =>
      Object.assign(document.createElement("li"), { textContent: row.label })
    )
  );
};
const harness: PrototypeWindow["harness"] = {
  ready: false,
  get client() {
    return client;
  },
  events: [],
  stats: subscriptionStats,
  status: "idle",
  subscribe(name, args) {
    active.get(name)?.();
    active.set(
      name,
      rows.list.subscribe(
        args as Parameters<typeof rows.list.subscribe>[0],
        (page) => render(name, page),
        {
          onStatus: (status) => {
            harness.status = status;
            statusLine.textContent = status;
            record({ kind: "status", name: `${name}:${status}` });
          },
          onError: (error) => record({ kind: "error", name: `${name}:${error.code}` })
        }
      )
    );
  },
  unsubscribe(name) {
    active.get(name)?.();
    active.delete(name);
  },
  labels: () => current,
  insert: async (label, owner) => {
    const started = Date.now();
    const row = await rows.insert(owner === undefined ? { label } : { label, owner });
    return { id: row.id, started, acked: Date.now() };
  },
  subscribePostgres: () =>
    new Promise((resolve) => {
      transport.subscribe(
        "postgres.list",
        { connection: "warehouse", relation: { schema: "public", name: "orders" } },
        (event) =>
          resolve(
            event.type === "error" ? `${event.error.code}: ${event.error.message}` : event.type
          )
      );
    })
};
host.harness = harness;
document.querySelector("#insert")!.addEventListener("click", () => {
  void rows.insert({ label: `clicked ${new Date().toISOString()}` });
});
void client.me().then(
  (me) => {
    harness.ready = true;
    document.querySelector("#identity")!.textContent = me?.user.id ?? "anonymous";
    // The default page is 100 rows; the burst case writes 250, so ask for the maximum page.
    harness.subscribe("all", { limit: 1000 });
  },
  (error: unknown) => {
    document.querySelector("#identity")!.textContent = String(error);
  }
);
