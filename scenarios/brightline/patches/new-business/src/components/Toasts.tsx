import { useCallback, useRef, useState } from "patchy/preact";
import type { Notify } from "../types.js";

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: "error" | "success";
}

/** Bottom-right message stack for refusals and confirmations. */
export function Toasts({
  toasts,
  onDismiss
}: {
  toasts: readonly Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} class={`toast toast-${toast.tone}`}>
          <span class="toast-icon" aria-hidden="true">
            {toast.tone === "error" ? "!" : "✓"}
          </span>
          <p>{toast.message}</p>
          <button
            type="button"
            class="toast-close"
            aria-label="Dismiss"
            onClick={() => onDismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** Toast state: `notify` adds a message that dismisses itself after a few seconds. */
export function useToasts() {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback(
    (id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)),
    []
  );
  const notify = useCallback<Notify>(
    (message, options = {}) => {
      const id = nextId.current++;
      const tone = options.tone ?? "error";
      setToasts((list) => [...list.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), tone === "success" ? 4000 : 7000);
    },
    [dismiss]
  );
  return { toasts, notify, dismiss };
}
