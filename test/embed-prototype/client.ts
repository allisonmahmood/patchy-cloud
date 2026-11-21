/** Throwaway #1232 shell adapter. This executes on Patchy's origin, never the host's. */
declare global {
  interface Window {
    prototypeContent?: (frame: HTMLIFrameElement, url: string) => void;
    prototypeStop?: (code: string) => void;
  }
}

const parameters = new URL(location.href).searchParams;
const patch = parameters.get("patch")!;
const host = parameters.get("host")!;
const originalFetch = window.fetch.bind(window);
let credential: string | undefined;
let stopped = false;
const requests = new Set<AbortController>();
const signIn = document.querySelector<HTMLButtonElement>("#sign-in")!;
const status = document.querySelector<HTMLElement>("#status")!;

function stop(reason: string) {
  if (stopped) return;
  stopped = true;
  credential = undefined;
  for (const controller of requests) controller.abort();
  document.querySelector("#patch")?.remove();
  document.querySelector("#end")?.remove();
  status.textContent = reason;
  signIn.hidden = false;
  signIn.disabled = false;
}
window.prototypeStop = (code) => {
  status.dataset.reason = code;
  stop("Embedded access ended. Sign in again.");
};

async function call(path: string, body?: unknown) {
  const response = await originalFetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "omit",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      ...(credential === undefined ? {} : { "x-prototype-session": credential })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) throw new Error("Embedded access ended. Sign in again.");
  return response;
}

signIn.addEventListener("click", async () => {
  // Open synchronously in the click; asynchronous window.open is popup-blocked.
  const popup = window.open("about:blank", "_blank");
  if (!popup) {
    status.textContent = "Allow the sign-in tab, then try again.";
    return;
  }
  popup.opener = null;
  signIn.disabled = true;
  stopped = false;
  try {
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const challenge = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("");
    const { id } = (await (await call("/~prototype/begin", { patch, host, challenge })).json()) as {
      id: string;
    };
    popup.location.href = `/~prototype/authorize?id=${encodeURIComponent(id)}`;
    status.textContent = "Complete sign-in in the Patchy tab.";
    for (let attempt = 0; attempt < 180; attempt++) {
      const response = await call("/~prototype/claim", { id, verifier });
      if (response.status === 200) {
        const result = (await response.json()) as { token: string };
        credential = result.token;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!credential) throw new Error("Sign-in timed out. Try again.");
    const shell = await (await call("/~prototype/shell")).text();
    // Parse only Patchy's trusted shell. The published document is still fetched separately.
    const parsed = new DOMParser().parseFromString(shell, "text/html");
    const frame = parsed.querySelector<HTMLIFrameElement>("#patch")!;
    const mounted = document.importNode(frame, true);
    // A target name assigned after the blank frame loads can open another tab in Chromium.
    mounted.name = `content-${crypto.randomUUID()}`;
    const blankLoaded = new Promise<void>((resolve) =>
      mounted.addEventListener("load", () => resolve(), { once: true })
    );
    document.body.append(mounted);
    // The real broker's one-shot load handoff must observe the content load, not about:blank.
    await blankLoaded;
    signIn.hidden = true;
    status.textContent = "Embedded session active";
    const end = Object.assign(document.createElement("button"), {
      id: "end",
      textContent: "End embedded session"
    });
    end.onclick = async () => {
      await call("/~prototype/end", {});
      stop("Embedded session ended.");
    };
    document.querySelector("header")!.append(end);

    // Broker calls and its fetch-based stream stay inside this Patchy frame. Never use cookies.
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      // Test the browser's real third-party cookie policy independently of this adapter.
      if (url.origin === location.origin && url.pathname === "/~prototype/cookie-probe")
        return originalFetch(input, init);
      if (url.origin !== location.origin || !url.pathname.startsWith("/api/runtime/"))
        throw new Error("Prototype transport only accepts this patch's runtime.");
      const controller = new AbortController();
      if (url.pathname.endsWith("/stream")) requests.add(controller);
      init?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      const headers = new Headers(init?.headers);
      headers.set("x-prototype-session", credential!);
      // Session termination cancels streams, not already-admitted mutations.
      return originalFetch(input, {
        ...init,
        headers,
        credentials: "omit",
        signal: controller.signal
      });
    };
    window.prototypeContent = (child, url) => {
      // A form navigation carries the credential in the POST body, never in the content URL.
      // The original HTML, URL nonce, HTTP sandbox/CSP and broker handshake remain intact.
      const form = Object.assign(document.createElement("form"), {
        method: "POST",
        action: url,
        target: child.name
      });
      form.hidden = true;
      form.append(
        Object.assign(document.createElement("input"), {
          type: "hidden",
          name: "token",
          value: credential!
        })
      );
      document.body.append(form);
      form.submit();
      form.remove();
    };
    const broker = document.createElement("script");
    broker.src = "/~prototype/broker.js";
    document.head.append(broker);
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await call("/~prototype/status");
    }
  } catch (error) {
    stop(error instanceof Error ? error.message : "Embedded access ended.");
  }
});
