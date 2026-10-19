// @effect-diagnostics globalTimers:off globalDate:off preferSchemaOverJson:off -- this runs inside the recorded page, not in Effect.
/**
 * The film overlay, injected into every frame of a recorded page. It is
 * plain browser code: `film.ts` sends it as source, so nothing here may rely
 * on module scope.
 */
declare global {
  interface Window {
    __film?: { caption: (text: string, failed?: boolean) => void };
  }
}

/**
 * Runs in every frame before the page's own scripts. The top frame gets the
 * side's label and the caption bar; every frame gets a cursor and click
 * rings, since a patch's sandboxed frame keeps its pointer events to itself.
 * The portal navigates on most clicks, so the pointer and the last click are
 * kept in sessionStorage and replayed on the next page; a sandboxed frame
 * has no storage and just starts fresh. Styles go through CSSOM so page CSPs
 * that block inline styles allow them.
 */
export const overlay = ({ label }: { readonly label: string }) => {
  const top = window === window.top;
  const CAPTION = "__filmCaption";
  const POINTER = "__filmPointer";
  const load = (key: string) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const save = (key: string, value: string) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // A sandboxed frame has no storage.
    }
  };
  const mount = () => {
    const root = document.createElement("div");
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
      font: "500 18px/1.35 system-ui, -apple-system, sans-serif"
    });
    const cursor = document.createElement("div");
    Object.assign(cursor.style, {
      position: "absolute",
      left: "-12px",
      top: "-12px",
      width: "24px",
      height: "24px",
      borderRadius: "50%",
      background: "rgba(255, 196, 0, 0.45)",
      border: "2px solid rgba(20, 20, 20, 0.85)",
      boxShadow: "0 0 0 2px rgba(255, 255, 255, 0.8)",
      transition: "transform 220ms ease-out",
      display: "none"
    });
    root.append(cursor);
    const move = (x: number, y: number) => {
      cursor.style.display = "block";
      cursor.style.transform = `translate(${x}px, ${y}px)`;
    };
    const ring = (x: number, y: number) => {
      const shape = document.createElement("div");
      Object.assign(shape.style, {
        position: "absolute",
        left: `${x - 20}px`,
        top: `${y - 20}px`,
        width: "40px",
        height: "40px",
        borderRadius: "50%",
        border: "3px solid rgba(255, 140, 0, 0.95)",
        transform: "scale(0.4)",
        opacity: "1",
        transition: "transform 600ms ease-out, opacity 600ms ease-out"
      });
      root.append(shape);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          shape.style.transform = "scale(1.8)";
          shape.style.opacity = "0";
        })
      );
      setTimeout(() => shape.remove(), 800);
    };
    document.addEventListener(
      "mousemove",
      (event) => {
        move(event.clientX, event.clientY);
        save(POINTER, JSON.stringify({ x: event.clientX, y: event.clientY, at: 0 }));
      },
      true
    );
    document.addEventListener(
      "mouseout",
      (event) => {
        if (event.relatedTarget === null || (event.relatedTarget as Element).tagName === "IFRAME")
          cursor.style.display = "none";
      },
      true
    );
    document.addEventListener(
      "mousedown",
      (event) => {
        move(event.clientX, event.clientY);
        ring(event.clientX, event.clientY);
        save(POINTER, JSON.stringify({ x: event.clientX, y: event.clientY, at: Date.now() }));
      },
      true
    );
    const last = load(POINTER);
    if (last !== null) {
      const pointer = JSON.parse(last) as { x: number; y: number; at: number };
      move(pointer.x, pointer.y);
      if (Date.now() - pointer.at < 1_500) ring(pointer.x, pointer.y);
    }
    if (top) {
      const chip = document.createElement("div");
      chip.textContent = label;
      Object.assign(chip.style, {
        position: "absolute",
        left: "12px",
        bottom: "12px",
        padding: "4px 10px",
        borderRadius: "999px",
        background: "rgba(20, 20, 20, 0.8)",
        color: "#fff",
        fontSize: "13px"
      });
      const bar = document.createElement("div");
      Object.assign(bar.style, {
        position: "absolute",
        left: "50%",
        bottom: "44px",
        transform: "translateX(-50%)",
        maxWidth: "80%",
        padding: "10px 18px",
        borderRadius: "12px",
        background: "rgba(20, 20, 20, 0.88)",
        color: "#fff",
        textAlign: "center",
        display: "none"
      });
      const caption = (text: string, failed = false) => {
        save(CAPTION, text);
        bar.textContent = text;
        bar.style.display = text === "" ? "none" : "block";
        bar.style.background = failed ? "rgba(160, 20, 20, 0.92)" : "rgba(20, 20, 20, 0.88)";
      };
      root.append(chip, bar);
      window.__film = { caption };
      caption(load(CAPTION) ?? "");
    }
    document.documentElement.append(root);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
};
