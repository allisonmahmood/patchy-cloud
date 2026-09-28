/** Runs inside the pinned engine, not Node's implementation of these globals. */
export const runtimePromiseBundle = `

const handlers = {
  intl() {
    return {
      decimal: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format("9007199254740993.01"),
      date: new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date("2024-02-29T23:00:00Z")),
      plural: new Intl.PluralRules("en", { type: "ordinal" }).select(22),
      relative: new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-1, "day"),
      list: new Intl.ListFormat("en-US", { style: "long", type: "conjunction" }).format(["Ada", "Grace", "Linus"]),
      collator: Math.sign(new Intl.Collator("en", { numeric: true }).compare("2", "10")),
      display: new Intl.DisplayNames("fr", { type: "region" }).of("US"),
      segments: [...new Intl.Segmenter("en", { granularity: "word" }).segment("hello world!")].map(part => part.segment)
    };
  },
  async crypto() {
    const bytes = new Uint8Array(16);
    const sameArray = crypto.getRandomValues(bytes) === bytes;
    let floatRefused = false;
    try { crypto.getRandomValues(new Float32Array(1)); } catch { floatRefused = true; }
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
    const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const signature = await crypto.subtle.sign("HMAC", key, bytes);
    return {
      uuid: crypto.randomUUID(), sameArray, floatRefused,
      hash: [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, "0")).join(""),
      verified: await crypto.subtle.verify("HMAC", key, signature, bytes),
      forged: await crypto.subtle.verify("HMAC", key, new Uint8Array(signature.byteLength), bytes)
    };
  },
  values() {
    const original = { date: new Date("2024-02-29T00:00:00Z"), map: new Map([["answer", 42]]), bytes: new Uint8Array([1, 2, 3]) };
    original.self = original;
    const copy = structuredClone(original);
    copy.bytes[0] = 9;
    const url = new URL("../items?q=a+b&q=c#row", "https://example.test/tools/page");
    const params = new URLSearchParams([["name", "Ada & Grace"], ["tag", "a"], ["tag", "b"]]);
    return {
      text: new TextDecoder().decode(new TextEncoder().encode("Grüße 🌍")),
      clone: { cycle: copy.self === copy, date: copy.date.toISOString(), answer: copy.map.get("answer"), originalByte: original.bytes[0], copyByte: copy.bytes[0] },
      url: { href: url.href, query: url.searchParams.getAll("q"), params: params.toString() },
      base64: btoa("\\x00\\xffPatchy"), decoded: [...atob("AP9QYXRjaHk=")].map(c => c.charCodeAt(0)),
      bigint: (9007199254740993n * 100n + 1n).toString()
    };
  },
  async refusals() {
    const targets = ["https://example.com/", "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:1/", "file:///etc/passwd"];
    const fetches = [];
    for (const target of targets) {
      try { const response = await fetch(target); fetches.push(response.status === 403); }
      catch { fetches.push(true); }
    }
    let evalRefused = false;
    let functionRefused = false;
    try { eval("1 + 1"); } catch { evalRefused = true; }
    try { new Function("return 2")(); } catch { functionRefused = true; }
    return { fetches, evalRefused, functionRefused, process: typeof process, Buffer: typeof Buffer };
  }
};

export default {
  async fetch(request) {
    const input = await request.json();
    if (input.type === "describe") return Response.json({ ok: true, handlers: Object.fromEntries(Object.keys(handlers).map(name => ["runtime." + name, { kind: "query", args: {}, result: { kind: "json" } }])) });
    return Response.json({ ok: true, value: await handlers[input.handler.split(".")[1]]() });
  }
};
`;
