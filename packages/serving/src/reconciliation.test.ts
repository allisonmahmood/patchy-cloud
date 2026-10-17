import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createReconciliation } from "./reconciliation.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// A replace makes the stream's set unadmitted again, as stream.ts reports it.
const reconciliation = () => {
  const replaces: number[] = [];
  const timer = createReconciliation(() => {
    replaces.push(Date.now());
    timer.update("unadmitted");
  });
  return { timer, replaces };
};

it("waits the full interval for answers to an admitted set, however they progress", () => {
  const { timer, replaces } = reconciliation();
  const start = Date.now();
  timer.update("unanswered");
  vi.advanceTimersByTime(20_000);
  timer.update("unanswered");
  vi.advanceTimersByTime(9_999);
  expect(replaces).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(replaces).toEqual([start + 30_000]);
});

it("replaces an unadmitted set after 1 s, then backs off until the server catches up", () => {
  const { timer, replaces } = reconciliation();
  const start = Date.now();
  timer.update("unadmitted");
  vi.advanceTimersByTime(7_000);
  expect(replaces).toEqual([start + 1_000, start + 3_000, start + 7_000]);
  // Admission cancels the armed 8 s fast timer and restarts the backoff.
  timer.update("unanswered");
  timer.update("unadmitted");
  vi.advanceTimersByTime(1_000);
  expect(replaces).toHaveLength(4);
});

it("an admitted delta cancels its fast timer and a new one shortens the slow timer", () => {
  const { timer, replaces } = reconciliation();
  timer.update("unadmitted");
  vi.advanceTimersByTime(500);
  timer.update("unanswered");
  vi.advanceTimersByTime(10_000);
  expect(replaces).toEqual([]);
  const delta = Date.now();
  timer.update("unadmitted");
  vi.advanceTimersByTime(1_000);
  expect(replaces).toEqual([delta + 1_000]);
});

it("stops once reconciled or stopped", () => {
  const { timer, replaces } = reconciliation();
  timer.update("unadmitted");
  timer.update("reconciled");
  timer.update("unanswered");
  timer.stop();
  vi.advanceTimersByTime(60_000);
  expect(replaces).toEqual([]);
});
