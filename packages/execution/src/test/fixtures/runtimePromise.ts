// Every Node built-in across the Node versions CI runs, which covers every node: name in
// workerd's registry. With the nodejs_compat flags the guest turns off, workerd offers all but
// node:ffi, node:sea and node:test/reporters.
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

const named = (prefix: string, names: string) =>
  names
    .trim()
    .split(/\s+/)
    .map((name) => `${prefix}:${name}`);

// workerd's other built-in modules: every name the 1.20260924.1 and 1.20261112.1 binaries embed
// under the prefixes a JavaScript Worker's registry holds, leaving out the internal: names of
// workerd's Python runtime. Most never load for a guest; they are here because their arrival
// matters. A finite list notices only the names it holds, so an engine move checks the new
// release's registry against it.
const workerdBuiltins = [
  ...named(
    "cloudflare",
    "ai br durable-objects email node pipelines sockets vectorize workers workflows"
  ),
  ...named(
    "workerd",
    "cloneable MessagePort rtti serializeMode unsafe unsafe-eval URL URLSearchParams"
  ),
  ...named(
    "cloudflare-internal",
    `
    ai-api aig-api autorag-api base64 br-api d1-api email env filesystem http hyperdrive
    hyperdrive-mysql-api hyperdrive-postgres-api images-api messagechannel pipeline-transform
    sockets streaming-base64 streaming-forms test-tracing-wrapper to-markdown-api tracing
    tracing-helpers vectorize-api workers workflows-api wrapped-binding`
  ),
  ...named(
    "node-internal",
    `
    async_hooks buffer constants crypto crypto_cipher crypto_dh crypto_hash crypto_hkdf crypto_keys
    crypto_pbkdf2 crypto_random crypto_scrypt crypto_sign crypto_spkac crypto_util crypto_x509
    debuglog diagnostics_channel dns events inspector internal_assert internal_assertionerror
    internal_buffer internal_comparisons internal_diffs internal_dns internal_dns_client
    internal_dns_constants internal_dns_promises internal_errors internal_fs internal_fs_callback
    internal_fs_constants internal_fs_glob internal_fs_promises internal_fs_stdio
    internal_fs_streams internal_fs_sync internal_fs_utils internal_http internal_http2_constants
    internal_http_agent internal_http_client internal_http_constants internal_http_incoming
    internal_http_outgoing internal_https_agent internal_http_server internal_https_server
    internal_http_util internal_inspect internal_inspector internal_mime internal_module
    internal_net internal_os_constants internal_path internal_process internal_querystring
    internal_readline internal_readline_promises internal_stringdecoder internal_timers
    internal_timers_global_override internal_timers_promises internal_tls internal_tls_common
    internal_tls_constants internal_tls_jsstream internal_tls_wrap internal_types internal_url
    internal_utils internal_uv internal_zlib internal_zlib_base internal_zlib_constants
    legacy_process legacy_url mock module process public_process sqlite streams_add_abort_signal
    streams_compose streams_destroy streams_duplex streams_end_of_stream streams_legacy
    streams_pipeline streams_promises streams_readable streams_state streams_transform
    streams_util streams_writable timers url util validators zlib`
  )
];

/** Runs inside the pinned engine, not Node's implementation of these globals. */
export const runtimePromiseBundle = `
const nodeBuiltins = ${JSON.stringify(nodeBuiltins)};
const workerdBuiltins = ${JSON.stringify(workerdBuiltins)};
const nodeGlobals = ["process", "Buffer", "global", "setImmediate", "clearImmediate"];
// The loader's import scan misses an import behind an ambiguous division, as test/network.ts
// shows, so what loads here is the engine's own answer rather than the scan's.
const hiddenImport = (name) => {
  const module = Promise.withResolvers();
  const hidden = function(){} / import(name).then(module.resolve, module.reject) / 1;
  return module.promise;
};
// The names that load through a hidden import.
const loadable = async (names) => {
  const loaded = [];
  for (const name of names) {
    try { await hiddenImport(name); loaded.push(name); } catch {}
  }
  return loaded;
};
// The names the process stub's getBuiltinModule resolves, and the ones it throws for, kept
// apart so a throw never passes for undefined.
const reachable = async (names) => {
  const process = (await hiddenImport("node:process")).default;
  const resolved = [];
  const threw = [];
  for (const name of names) {
    try { if (process.getBuiltinModule(name) !== undefined) resolved.push(name); }
    catch { threw.push(name); }
  }
  return { resolved, threw };
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
    const stub = await hiddenImport("node:process");
    const members = [];
    for (let target = stub.default; target !== null && target !== Object.prototype; target = Object.getPrototypeOf(target))
      members.push(...Reflect.ownKeys(target).map(String));
    return {
      modules: await loadable(nodeBuiltins),
      builtins: await reachable(nodeBuiltins),
      process: {
        exports: Object.keys(stub).sort(),
        members: members.sort(),
        env: Reflect.ownKeys(stub.default.env).map(String),
        // Every host sets PATH, so an environment that read the host's would answer it.
        PATH: typeof stub.default.env.PATH
      },
      globals: nodeGlobals.filter((name) => typeof globalThis[name] !== "undefined")
    };
  },
  async workerd() {
    const workers = await hiddenImport("cloudflare:workers");
    return {
      modules: await loadable(workerdBuiltins),
      builtins: await reachable(workerdBuiltins),
      // Where the loader's own bindings and entrypoints would show if they reached the guest.
      workers: { env: Reflect.ownKeys(workers.env).map(String), exports: Object.keys(workers.exports) }
    };
  },
  async exit() {
    // An ordinary throw also fails the call; returning here tells it apart from exit.
    try { (await hiddenImport("node:process")).default.exit(1); }
    catch { return "exit threw"; }
    return "exit returned";
  }
};

// Inspection answers only with descriptors, so these probes' answers ride in their descriptions.
const described = ["node", "workerd"];

export default {
  async fetch(request) {
    const input = await request.json();
    if (input.type === "describe") {
      const descriptions = {};
      for (const name of described) descriptions[name] = JSON.stringify(await handlers[name]());
      return Response.json({ ok: true, handlers: Object.fromEntries(Object.keys(handlers).map(name => ["runtime." + name, { kind: "query", args: {}, result: { kind: "json" }, ...(name in descriptions ? { description: descriptions[name] } : {}) }])) });
    }
    return Response.json({ ok: true, value: await handlers[input.handler.split(".")[1]]() });
  }
};
`;
