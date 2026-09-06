// PROTOTYPE — the SDK as patch code sees it inside the sandboxed frame. It
// never holds a credential and never talks to the API: every call is a message
// to the shell's broker, correlated by id. Wayfinder #175.
//
// Compiled to an IIFE by the prototype server and inlined into the content
// response. The real SDK would be generated per patch with the table types
// filled in from the manifest; here `Tables` stands in for that.

type Tables = {
  items: { id: number; name: string; qty: number };
  slides: { id: number; title: string };
};

type Request = { v: 1; id: string; op: string; args: unknown };
type Reply =
  | { v: 1; id: string; kind: "result"; value: unknown }
  | { v: 1; id: string; kind: "error"; error: { code: string | number; message: string } }
  | { v: 1; kind: "event"; event: "route"; data: { path: string } };

const { shellOrigin } = (window as unknown as { __patchyContent: { shellOrigin: string } }).__patchyContent;

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const routeListeners = new Set<(path: string) => void>();

window.addEventListener("message", (event: MessageEvent<Reply>) => {
  // Only the shell may answer, and only from the origin the content was served for.
  if (event.source !== window.parent || event.origin !== shellOrigin) return;
  const m = event.data;
  if (!m || m.v !== 1) return;
  if (m.kind === "event") {
    if (m.event === "route") routeListeners.forEach((l) => l(m.data.path));
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.kind === "result") p.resolve(m.value);
  else p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
});

function call<T>(op: string, args: unknown = {}): Promise<T> {
  const id = crypto.randomUUID();
  const request: Request = { v: 1, id, op, args };
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.parent.postMessage(request, shellOrigin);
  });
}

export const tables = {
  read: <K extends keyof Tables>(table: K) => call<Array<Tables[K]>>("rows.read", { table }),
  insert: <K extends keyof Tables>(table: K, row: Omit<Tables[K], "id">) =>
    call<Tables[K]>("rows.insert", { table, row })
};

export const files = {
  /** The file's bytes, fetched by the shell, as a frame-local blob URL. */
  url: async (name: string) => {
    const { bytes, type } = await call<{ bytes: ArrayBuffer; type: string }>("files.get", { name });
    return URL.createObjectURL(new Blob([bytes], { type }));
  },
  /** A shell-owned download of one stored file. */
  download: (name: string) => call<null>("download", { name })
};

export const route = {
  /** Tell the shell the patch moved; the address bar follows. */
  set: (path: string) => call<null>("route.set", { path }),
  /** The shell tells the patch where it is: on load, and on back/forward. */
  onChange: (listener: (path: string) => void) => {
    routeListeners.add(listener);
    return () => routeListeners.delete(listener);
  }
};

/** Shell-owned printing; the frame reports its height so the shell can unclip it. */
export const print = () => call<null>("print", { height: document.documentElement.scrollHeight });

/** Anything the broker does not expose; used by the click-through to prove the refusal. */
export const raw = (op: string, args: unknown = {}) => call<unknown>(op, args);

window.parent.postMessage({ v: 1, kind: "ready" }, shellOrigin);
