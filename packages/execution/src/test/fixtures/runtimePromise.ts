// Every Node built-in across the Node versions CI runs. With the nodejs_compat flags the guest
// turns off, workerd offers all but node:ffi, node:sea and node:test/reporters.
const nodeBuiltins = [
  ...[
    "_http_agent",
    "_http_client",
    "_http_common",
    "_http_incoming",
    "_http_outgoing",
    "_http_server",
    "_stream_duplex",
    "_stream_passthrough",
    "_stream_readable",
    "_stream_transform",
    "_stream_wrap",
    "_stream_writable",
    "_tls_common",
    "_tls_wrap",
    "assert",
    "assert/strict",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "dns/promises",
    "domain",
    "events",
    "fs",
    "fs/promises",
    "http",
    "http2",
    "https",
    "inspector",
    "inspector/promises",
    "module",
    "net",
    "os",
    "path",
    "path/posix",
    "path/win32",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "readline/promises",
    "repl",
    "stream",
    "stream/consumers",
    "stream/promises",
    "stream/web",
    "string_decoder",
    "sys",
    "timers",
    "timers/promises",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "util/types",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib"
  ].flatMap((name) => [name, `node:${name}`]),
  // Prefix-only built-ins.
  "node:ffi",
  "node:sea",
  "node:sqlite",
  "node:test",
  "node:test/reporters"
];

/** Runs inside the pinned engine, not Node's implementation of these globals. */
export const runtimePromiseBundle = `
const nodeBuiltins = ${JSON.stringify(nodeBuiltins)};
const nodeGlobals = ["process", "Buffer", "global", "setImmediate", "clearImmediate"];
// The loader's import scan misses an import behind an ambiguous division, as test/network.ts
// shows, so what loads here is the engine's own answer rather than the scan's.
const hiddenImport = (name) => {
  const module = Promise.withResolvers();
  const hidden = function(){} / import(name).then(module.resolve, module.reject) / 1;
  return module.promise;
};

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
    return { fetches, evalRefused, functionRefused };
  },
  async node() {
    const modules = [];
    for (const name of nodeBuiltins) {
      try { await hiddenImport(name); modules.push(name); } catch {}
    }
    const stub = await hiddenImport("node:process");
    const members = [];
    for (let target = stub.default; target !== null && target !== Object.prototype; target = Object.getPrototypeOf(target))
      members.push(...Reflect.ownKeys(target).map(String));
    const reaches = (name) => { try { return stub.default.getBuiltinModule(name) !== undefined; } catch { return false; } };
    return {
      modules,
      process: {
        exports: Object.keys(stub).sort(),
        members: members.sort(),
        env: Reflect.ownKeys(stub.default.env).map(String),
        // Every host sets PATH, so an environment that read the host's would answer it.
        PATH: typeof stub.default.env.PATH,
        builtins: nodeBuiltins.filter(reaches)
      },
      globals: nodeGlobals.filter((name) => typeof globalThis[name] !== "undefined")
    };
  },
  async exit() {
    (await hiddenImport("node:process")).default.exit(1);
    return "exit returned";
  }
};

export default {
  async fetch(request) {
    const input = await request.json();
    // Inspection answers only with descriptors, so runtime.node's answer rides in its description.
    if (input.type === "describe") {
      const node = JSON.stringify(await handlers.node());
      return Response.json({ ok: true, handlers: Object.fromEntries(Object.keys(handlers).map(name => ["runtime." + name, { kind: "query", args: {}, result: { kind: "json" }, ...(name === "node" ? { description: node } : {}) }])) });
    }
    return Response.json({ ok: true, value: await handlers[input.handler.split(".")[1]]() });
  }
};
`;
