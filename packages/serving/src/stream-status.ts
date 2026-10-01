/// <reference lib="dom" />
// @effect-diagnostics globalTimers:off globalDate:off
// The served shell owns browser timers, the starting cover's elapsed clock and DOM elements, without an Effect runtime.
import { registry } from "@patchy/limits/registry";

export function createStreamStatus(
  frame: HTMLIFrameElement,
  versionId: string,
  tier: number,
  base: string,
  retry: () => void
) {
  const name = frame.title;
  const root = document.createElement("div");
  root.className = "shell-bottom";
  root.setAttribute("aria-label", "Patchy page status");
  const glyph = () => {
    const element = document.createElement("span");
    element.className = "glyph glyph-sm";
    element.setAttribute("aria-hidden", "true");
    return element;
  };
  const text = (value: string, className = "") => {
    const element = document.createElement("span");
    element.className = className;
    element.textContent = value;
    return element;
  };
  const button = (label: string, className: string, action: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `btn ${className}`;
    element.textContent = label;
    element.addEventListener("click", action);
    return element;
  };
  const reconnecting = document.createElement("div");
  reconnecting.className = "status-chip";
  reconnecting.dataset.streamStatus = "reconnecting";
  reconnecting.setAttribute("role", "status");
  reconnecting.hidden = true;
  reconnecting.append(
    glyph(),
    text("Reconnecting"),
    text("What you see may be out of date.", "status-chip-detail")
  );
  const version = document.createElement("div");
  version.hidden = true;
  version.setAttribute("role", "status");
  root.append(reconnecting, version);
  document.body.append(root);
  // T-1 from #385: a static dim over the frame with one centred note. It holds focus until ready.
  // The dialog's name stays fixed while the note inside switches between starting and failed.
  const cover = document.createElement("dialog");
  cover.className = "shell-scrim";
  cover.dataset.streamStatus = "starting";
  cover.setAttribute("aria-label", "Starting your tools");
  cover.setAttribute("aria-describedby", "patchy-starting-message");
  cover.tabIndex = -1;
  const panel = document.createElement("section");
  // Title and body are the live region; the elapsed line sits outside it so its ticks stay silent.
  const message = document.createElement("div");
  message.id = "patchy-starting-message";
  message.setAttribute("role", "status");
  const heading = text("", "note-title");
  const body = document.createElement("p");
  message.append(heading, body);
  const elapsed = document.createElement("p");
  elapsed.className = "supporting-text";
  const retryButton = button("Try again", "btn-primary", () => {
    failed = false;
    startedAt = Date.now();
    renderStarting();
    retry();
  });
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(retryButton);
  panel.append(message, elapsed, actions);
  cover.append(panel);
  document.body.append(cover);
  cover.addEventListener("cancel", (event) => event.preventDefault());
  cover.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    if (retryButton.hidden) cover.focus();
    else retryButton.focus();
  });
  const waitSeconds = registry["execution.pool.wait"].default / 1_000;
  let starting = false;
  // Failed holds through automatic bind retries; only ready, Try again or a resume clears it.
  let failed = false;
  let startedAt = 0;
  let hidden = document.hidden;
  let startingTimer: number | undefined;
  // The only thing that changes while starting is this text, rewritten once a second. No animation.
  let elapsedTimer: number | undefined;
  const tick = () => {
    elapsed.textContent = `${Math.max(0, Math.floor((Date.now() - startedAt) / 1_000))} s so far`;
  };
  const stopTicking = () => {
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
  };
  const renderStarting = () => {
    const copy = failed
      ? {
          title: "Your tools are taking longer than usual to start.",
          body: "Anything you just did didn't go through. Patchy keeps trying; try again once they're ready."
        }
      : {
          title: "Starting your tools",
          body: `Your company's tools are waking up. This can take up to ${waitSeconds} seconds; the page works as soon as they're ready.`
        };
    const refocus = retryButton === document.activeElement && !failed;
    panel.className = `note note-float ${failed ? "note-warn" : "note-info"}`;
    heading.replaceChildren(glyph(), copy.title);
    body.textContent = copy.body;
    elapsed.hidden = failed;
    retryButton.hidden = !failed;
    if (refocus) cover.focus();
    stopTicking();
    if (failed || !cover.open) return;
    tick();
    elapsedTimer = window.setInterval(tick, 1_000);
  };
  const showStarting = () => {
    if (hidden || cover.open) return;
    cover.showModal();
    renderStarting();
    cover.focus();
  };
  const scheduleStarting = () => {
    if (hidden || !starting || cover.open || startingTimer !== undefined) return;
    startingTimer = window.setTimeout(() => {
      startingTimer = undefined;
      showStarting();
    }, 2_000);
  };
  const clearStarting = () => {
    starting = false;
    failed = false;
    clearTimeout(startingTimer);
    startingTimer = undefined;
    stopTicking();
    if (cover.open) {
      cover.close();
      if (!hidden) frame.focus();
    }
  };

  let reconnectTimer: number | undefined;
  let served: { readonly versionId: string; readonly tier: number } | undefined;
  let dismissed = false;
  let collapsed = false;
  // Pages.addressRouteOf reserves ~ segments and shell data-base includes only the address
  // plus its optional /~v/<number> selector, never the patch's client route.
  const currentBase = base.split("/~v/", 1)[0]!;
  const reload = () => {
    if (currentBase === base) return location.reload();
    const url = new URL(location.href);
    url.pathname = currentBase + url.pathname.slice(base.length);
    location.assign(url.href);
  };
  const focusFrame = () => frame.focus();
  // S-C from #385: the bar folds into a chip that keeps Reload; only the new-version bar can be dismissed.
  const renderVersion = () => {
    const visible = served !== undefined && served.versionId !== versionId && !dismissed;
    const focused = version.contains(document.activeElement);
    version.hidden = !visible;
    version.replaceChildren();
    if (!visible) {
      if (focused) focusFrame();
      return;
    }
    const required = served!.tier === 2 && tier < 2;
    const copy = required
      ? {
          chip: "Reload to keep saving",
          title: `${name} was updated. Reload to keep saving.`,
          detail: "This page can no longer save. Copy anything unsaved before you reload."
        }
      : {
          chip: "New version available",
          title: `A new version of ${name} is available.`,
          detail: "Reload when you're ready. Saved changes stay; unsaved edits may be lost."
        };
    version.dataset.streamStatus = required ? "reload-required" : "new-version";
    if (collapsed) {
      version.className = `status-chip status-chip-${required ? "warn" : "info"}`;
      version.append(glyph(), text(copy.chip), button("Reload", "btn-primary", reload));
    } else {
      version.className = `note note-${required ? "warn" : "info"} note-float note-inline`;
      const content = document.createElement("div");
      content.className = "note-inline-text";
      const heading = text(copy.title, "note-title");
      heading.prepend(glyph());
      const detail = document.createElement("p");
      detail.textContent = copy.detail;
      content.append(heading, detail);
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(button("Reload", "btn-primary", reload));
      if (!required)
        actions.append(
          button("Not now", "btn-quiet", () => {
            dismissed = true;
            renderVersion();
            focusFrame();
          })
        );
      const hide = button("Hide", "btn-quiet note-collapse", () => {
        collapsed = true;
        renderVersion();
        focusFrame();
      });
      version.append(content, actions, hide);
    }
    if (focused) focusFrame();
  };

  return {
    // No reason: the first start. "retry": another bind after start_failed, automatic or Try again.
    // "resume": a fresh start after a suspended document returns.
    starting(reason?: "retry" | "resume") {
      if (starting && reason === undefined) return;
      if (!starting || reason === "resume") {
        failed = false;
        startedAt = Date.now();
      }
      starting = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      reconnecting.hidden = true;
      if (cover.open) renderStarting();
      else scheduleStarting();
    },
    startFailed() {
      starting = true;
      failed = true;
      if (cover.open) renderStarting();
      else if (startingTimer === undefined) showStarting();
    },
    visibility(nextHidden: boolean) {
      if (hidden === nextHidden) return;
      hidden = nextHidden;
      if (hidden) {
        clearTimeout(startingTimer);
        startingTimer = undefined;
        stopTicking();
        if (cover.open) cover.close();
      } else scheduleStarting();
    },
    ready() {
      clearStarting();
    },
    connecting() {
      if (starting) return;
      if (reconnecting.hidden && reconnectTimer === undefined) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = undefined;
          reconnecting.hidden = false;
        }, 2_000);
      }
    },
    connected() {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      reconnecting.hidden = true;
    },
    served(next: { readonly versionId: string; readonly tier: number }) {
      // Reconnects and delayed callbacks can repeat the current version; keep Not now.
      if (served?.versionId === next.versionId && served.tier === next.tier) return;
      served = next;
      dismissed = false;
      collapsed = false;
      renderVersion();
    },
    close() {
      clearTimeout(reconnectTimer);
      clearStarting();
      cover.remove();
      root.remove();
    }
  };
}
