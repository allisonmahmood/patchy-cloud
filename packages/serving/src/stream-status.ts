/// <reference lib="dom" />
// @effect-diagnostics globalTimers:off
// The served shell owns browser timers and DOM elements, without an Effect runtime.

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
  const cover = document.createElement("dialog");
  cover.className = "shell-scrim";
  cover.dataset.streamStatus = "starting";
  cover.setAttribute("aria-labelledby", "patchy-starting-title");
  cover.setAttribute("aria-describedby", "patchy-starting-detail");
  cover.tabIndex = -1;
  const panel = document.createElement("div");
  panel.className = "note note-info note-float";
  const heading = text("Starting your tools", "note-title");
  heading.id = "patchy-starting-title";
  heading.prepend(glyph());
  const detail = document.createElement("p");
  detail.id = "patchy-starting-detail";
  detail.setAttribute("role", "status");
  const retryButton = button("Retry", "btn-primary", retry);
  retryButton.hidden = true;
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(retryButton);
  panel.append(heading, detail, actions);
  cover.append(panel);
  document.body.append(cover);
  cover.addEventListener("cancel", (event) => event.preventDefault());
  cover.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    if (retryButton.hidden) cover.focus();
    else retryButton.focus();
  });
  let starting = false;
  let hidden = document.hidden;
  let startingTimer: number | undefined;
  const showStarting = () => {
    if (hidden || cover.open) return;
    cover.showModal();
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
    clearTimeout(startingTimer);
    startingTimer = undefined;
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
    starting(retrying = false) {
      if (starting && !retrying) return;
      starting = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      reconnecting.hidden = true;
      detail.textContent =
        "You can use this page when your tools are ready. This may take up to 40 seconds.";
      retryButton.hidden = true;
      if (cover.open && !hidden) cover.focus();
      else scheduleStarting();
    },
    startFailed() {
      starting = true;
      detail.textContent =
        "Your tools could not start. Waiting requests were not run and will not be retried. Patchy will try to start your tools again, or you can retry now.";
      retryButton.hidden = false;
      if (startingTimer === undefined) showStarting();
    },
    visibility(nextHidden: boolean) {
      if (hidden === nextHidden) return;
      hidden = nextHidden;
      if (hidden) {
        clearTimeout(startingTimer);
        startingTimer = undefined;
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
