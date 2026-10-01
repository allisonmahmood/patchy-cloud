import { afterEach, expect, it, vi } from "vitest";
import {
  createQueryRegistry,
  type QueryDriver,
  type QueryFrame,
  type QueryRequest,
  type QuerySnapshot
} from "./queryRegistry.js";

function transport() {
  const subscriptions: Array<{
    request: QueryRequest;
    send: (frame: QueryFrame) => void;
    closed: boolean;
  }> = [];
  const driver: QueryDriver = {
    subscribe(request, send) {
      const subscription = { request, send, closed: false };
      subscriptions.push(subscription);
      return () => {
        subscription.closed = true;
      };
    }
  };
  return { driver, subscriptions };
}

afterEach(() => vi.useRealTimers());

it("shares one transport subscription for canonical arguments and releases only the last consumer", () => {
  vi.useFakeTimers();
  const { driver, subscriptions } = transport();
  const registry = createQueryRegistry(driver);
  const first: QuerySnapshot<string>[] = [];
  const second: QuerySnapshot<string>[] = [];
  const releaseFirst = registry.subscribe<string>(
    "leads.list",
    { filter: { stage: "new", owner: "me" }, page: 1 },
    (snapshot) => first.push(snapshot)
  );
  const releaseSecond = registry.subscribe<string>(
    "leads.list",
    { page: 1, filter: { owner: "me", stage: "new", search: undefined } },
    (snapshot) => second.push(snapshot)
  );
  expect(subscriptions).toHaveLength(1);
  subscriptions[0]!.send({ status: "ready", revision: 1, data: "first page" });
  expect(first.at(-1)).toEqual({
    status: "ready",
    data: "first page",
    error: undefined,
    loading: false
  });
  expect(second.at(-1)).toBe(first.at(-1));

  releaseFirst();
  vi.advanceTimersByTime(2_000);
  expect(subscriptions[0]!.closed).toBe(false);
  subscriptions[0]!.send({ status: "ready", revision: 2, data: "updated page" });
  expect(first.at(-1)?.data).toBe("first page");
  expect(second.at(-1)?.data).toBe("updated page");
  releaseSecond();
  vi.advanceTimersByTime(999);
  expect(subscriptions[0]!.closed).toBe(false);
  vi.advanceTimersByTime(1);
  expect(subscriptions[0]!.closed).toBe(true);
  registry.close();
});

it("drops stale and duplicate revisions before reading their data, separately for each query", () => {
  const { driver, subscriptions } = transport();
  const registry = createQueryRegistry(driver);
  const seen: QuerySnapshot<string>[] = [];
  const other: QuerySnapshot<string>[] = [];
  registry.subscribe<string>("leads.list", { page: 1 }, (snapshot) => seen.push(snapshot));
  registry.subscribe<string>("leads.list", { page: 2 }, (snapshot) => other.push(snapshot));
  subscriptions[0]!.send({ status: "ready", revision: 10, data: "current" });
  const current = seen.at(-1);
  for (const revision of [9, 10]) {
    subscriptions[0]!.send({
      status: "ready",
      revision,
      get data() {
        throw new Error("A stale frame must not inspect its result.");
      }
    });
  }
  subscriptions[0]!.send({ status: "error", revision: 9, error: new Error("obsolete") });
  expect(seen).toEqual([
    { status: "loading", data: undefined, error: undefined, loading: true },
    current
  ]);
  subscriptions[1]!.send({ status: "ready", revision: 1, data: "other query" });
  expect(other.at(-1)?.data).toBe("other query");
  registry.close();
});

it("retains the last successful data through errors and clears the error on a newer result", () => {
  const { driver, subscriptions } = transport();
  const registry = createQueryRegistry(driver);
  const seen: QuerySnapshot<readonly string[]>[] = [];
  registry.subscribe<readonly string[]>("leads.list", {}, (snapshot) => seen.push(snapshot));
  const data = ["lead-1"];
  subscriptions[0]!.send({ status: "ready", revision: 1, data });
  const error = new Error("Stream disconnected");
  subscriptions[0]!.send({ status: "error", revision: 2, error });
  expect(seen.at(-1)).toEqual({ status: "error", data, error, loading: false });
  expect(seen.at(-1)?.data).toBe(data);
  subscriptions[0]!.send({ status: "ready", revision: 1, data: ["outdated"] });
  expect(seen.at(-1)?.error).toBe(error);
  subscriptions[0]!.send({ status: "ready", revision: 3, data: ["lead-2"] });
  expect(seen.at(-1)).toEqual({
    status: "ready",
    data: ["lead-2"],
    error: undefined,
    loading: false
  });
  registry.close();
});

it("keeps results across a remount within the grace period and fences frames after disposal", () => {
  vi.useFakeTimers();
  const { driver, subscriptions } = transport();
  const registry = createQueryRegistry(driver);
  const first = registry.getQuery<string>("leads.list", "{}");
  const release = first.subscribe(() => {});
  subscriptions[0]!.send({ status: "ready", revision: 8, data: "cached" });
  release();
  vi.advanceTimersByTime(500);
  const remounted = registry.getQuery<string>("leads.list", "{}");
  expect(remounted).toBe(first);
  const seen: QuerySnapshot<string>[] = [];
  const releaseRemount = remounted.subscribe((snapshot) => seen.push(snapshot));
  expect(seen[0]?.data).toBe("cached");
  vi.advanceTimersByTime(1_000);
  expect(subscriptions).toHaveLength(1);
  expect(subscriptions[0]!.closed).toBe(false);
  releaseRemount();
  vi.advanceTimersByTime(1_000);
  expect(subscriptions[0]!.closed).toBe(true);

  const fresh: QuerySnapshot<string>[] = [];
  registry.subscribe<string>("leads.list", {}, (snapshot) => fresh.push(snapshot));
  expect(fresh[0]?.status).toBe("loading");
  subscriptions[0]!.send({ status: "ready", revision: 99, data: "late old stream" });
  subscriptions[1]!.send({ status: "ready", revision: 0, data: "fresh stream" });
  expect(fresh.at(-1)?.data).toBe("fresh stream");
  expect(seen.at(-1)?.data).toBe("cached");
  registry.close();
});

it("separates handlers, changed arguments, and client identities without retaining caller mutations", () => {
  vi.useFakeTimers();
  const { driver, subscriptions } = transport();
  const registry = createQueryRegistry(driver);
  const colleague = createQueryRegistry(driver);
  const args = { filter: { stage: "new" } };
  const release = registry.subscribe("leads.list", args, () => {});
  args.filter.stage = "won";
  release();
  const next: QuerySnapshot<string>[] = [];
  registry.subscribe<string>("leads.list", args, (snapshot) => next.push(snapshot));
  registry.subscribe("leads.count", args, () => {});
  const colleagueSeen: QuerySnapshot<string>[] = [];
  colleague.subscribe<string>("leads.list", args, (snapshot) => colleagueSeen.push(snapshot));
  expect(subscriptions).toHaveLength(4);
  expect(subscriptions[0]!.request.args).toEqual({ filter: { stage: "new" } });
  subscriptions[0]!.send({ status: "ready", revision: 1, data: "old arguments" });
  expect(next.at(-1)?.status).toBe("loading");
  subscriptions[1]!.send({ status: "ready", revision: 1, data: "my result" });
  subscriptions[3]!.send({ status: "ready", revision: 1, data: "colleague result" });
  expect(next.at(-1)?.data).toBe("my result");
  expect(colleagueSeen.at(-1)?.data).toBe("colleague result");
  vi.advanceTimersByTime(1_000);
  expect(subscriptions[0]!.closed).toBe(true);
  expect(subscriptions[1]!.closed).toBe(false);
  registry.close();
  expect(subscriptions[3]!.closed).toBe(false);
  colleague.close();
});

it("counts repeated callback subscriptions separately and makes each cleanup idempotent", () => {
  vi.useFakeTimers();
  const { driver, subscriptions } = transport();
  const registry = createQueryRegistry(driver);
  const seen: QuerySnapshot<string>[] = [];
  const listener = (snapshot: QuerySnapshot<string>) => {
    seen.push(snapshot);
  };
  const first = registry.subscribe<string>("leads.list", {}, listener);
  const second = registry.subscribe<string>("leads.list", {}, listener);
  first();
  first();
  vi.advanceTimersByTime(1_000);
  subscriptions[0]!.send({ status: "ready", revision: 1, data: "still subscribed" });
  expect(seen.at(-1)?.data).toBe("still subscribed");
  expect(subscriptions[0]!.closed).toBe(false);
  second();
  vi.advanceTimersByTime(1_000);
  expect(subscriptions[0]!.closed).toBe(true);
  registry.close();
});

it("closes active and grace-period subscriptions immediately, retaining data and rejecting late frames", () => {
  vi.useFakeTimers();
  const { driver, subscriptions } = transport();
  const registry = createQueryRegistry(driver);
  const seen: QuerySnapshot<string>[] = [];
  registry.subscribe<string>("leads.list", {}, (snapshot) => seen.push(snapshot));
  const release = registry.subscribe("leads.count", {}, () => {});
  subscriptions[0]!.send({ status: "ready", revision: 1, data: "last value" });
  release();
  registry.close();
  registry.close();
  expect(subscriptions.map((subscription) => subscription.closed)).toEqual([true, true]);
  const closedSnapshot = seen.at(-1);
  expect(closedSnapshot).toMatchObject({ status: "error", data: "last value", loading: false });
  expect(closedSnapshot?.error?.message).toBe("The query client is closed.");
  subscriptions[0]!.send({ status: "ready", revision: 2, data: "late value" });
  expect(seen.at(-1)).toBe(closedSnapshot);
  const afterClose: QuerySnapshot<string>[] = [];
  registry.subscribe<string>("leads.list", {}, (snapshot) => afterClose.push(snapshot));
  expect(afterClose[0]?.status).toBe("error");
  expect(subscriptions).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up a synchronous subscription when its first result closes the client", () => {
  let stops = 0;
  const registry = createQueryRegistry({
    subscribe(_request, send) {
      send({ status: "ready", revision: 0, data: "first" });
      return () => {
        stops++;
      };
    }
  });
  registry.subscribe("leads.list", {}, (snapshot) => {
    if (snapshot.status === "ready") registry.close();
  });
  expect(stops).toBe(1);
});

it("releases an abandoned render's store and lets a delayed subscriber join the replacement", () => {
  vi.useFakeTimers();
  const { driver, subscriptions } = transport();
  const registry = createQueryRegistry(driver);
  const abandoned = registry.getQuery<string>("leads.list", "{}");
  vi.advanceTimersByTime(1_000);
  const mounted = registry.getQuery<string>("leads.list", "{}");
  expect(mounted).not.toBe(abandoned);
  const first: QuerySnapshot<string>[] = [];
  const second: QuerySnapshot<string>[] = [];
  mounted.subscribe((snapshot) => first.push(snapshot));
  abandoned.subscribe((snapshot) => second.push(snapshot));
  expect(subscriptions).toHaveLength(1);
  subscriptions[0]!.send({ status: "ready", revision: 0, data: "shared value" });
  expect(first.at(-1)?.data).toBe("shared value");
  expect(second.at(-1)).toBe(first.at(-1));
  expect(abandoned.getSnapshot()).toBe(mounted.getSnapshot());
  registry.close();
});
