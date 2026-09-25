// PROTOTYPE for #311: shared helpers for the bench scripts. Talks to the host
// through the ALB (self-signed cert) unless HOST is set.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import { writeFileSync, mkdirSync } from "node:fs";

export const H = process.env.HOST ?? `https://${process.env.SPIKE_ALB_DNS}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function invoke(body, headers = {}) {
  const t0 = performance.now();
  const r = await fetch(`${H}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-viewer": "allison", ...headers },
    body: JSON.stringify(body)
  });
  const out = await r.json();
  out.wallMs = Math.round(performance.now() - t0);
  return out;
}
export const admin = async (path, method = "GET") =>
  (await fetch(`${H}${path}`, { method })).json();

export function pct(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { n: s.length, min: s[0], p50: q(50), p95: q(95), p99: q(99), max: s[s.length - 1] };
}
export const row = (label, p) =>
  `| ${label} | ${p.n} | ${p.p50} | ${p.p95} | ${p.p99} | ${p.max} |`;
export const header = (metric) =>
  `| ${metric} | n | p50 | p95 | p99 | max |\n| --- | --- | --- | --- | --- | --- |`;

export function save(name, data) {
  mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
  writeFileSync(new URL(`./out/${name}.json`, import.meta.url), JSON.stringify(data, null, 2));
}

// Wait until the pool has at least n ready (unbound) tasks.
export async function waitReady(n, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const p = await admin("/admin/pool");
    if (p.tasks.filter((t) => t.state === "ready").length >= n) return p;
    if (Date.now() - t0 > timeoutMs) throw new Error("pool never filled");
    await sleep(1000);
  }
}
