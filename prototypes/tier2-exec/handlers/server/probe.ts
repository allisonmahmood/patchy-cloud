// PROTOTYPE for #311: what can handler code reach?
import { t } from "../patchy.ts";

async function tryFetch(url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { url, status: res.status, body: (await res.text()).slice(0, 80) };
  } catch (e: any) {
    return { url, error: `${e?.name}: ${e?.message}` };
  }
}

export const metadata = t.query({
  handler: async () => [
    await tryFetch("http://169.254.170.2/v2/metadata"),
    await tryFetch("http://169.254.169.254/latest/meta-data/")
  ]
});

export const fs = t.query({
  handler: async () => {
    const results: unknown[] = [await tryFetch("file:///etc/passwd")];
    try {
      const mod: any = await import(/* @vite-ignore */ "node:fs");
      results.push({ import: "node:fs", ok: true, keys: Object.keys(mod).slice(0, 5) });
    } catch (e: any) {
      results.push({ import: "node:fs", error: `${e?.name}: ${e?.message}` });
    }
    return results;
  }
});

export const internet = t.query({
  handler: async () => {
    const results: unknown[] = [await tryFetch("https://example.com")];
    try {
      const sockets: any = await import(/* @vite-ignore */ "cloudflare:sockets");
      const s = sockets.connect("example.com:443");
      await s.opened;
      results.push({ connect: "example.com:443", ok: true });
      await s.close();
    } catch (e: any) {
      results.push({ connect: "example.com:443", error: `${e?.name}: ${e?.message}` });
    }
    return results;
  }
});

// Can guest code reach the supervisor's management endpoints on the task's
// own loopback? (Only the loader's Outbound loopback should exist.)
export const supervisor = t.query({
  handler: async () => [
    await tryFetch("http://127.0.0.1:8080/stats"),
    await tryFetch("http://localhost:8080/healthz"),
    await tryFetch("http://127.0.0.1:8787/healthz")
  ]
});
