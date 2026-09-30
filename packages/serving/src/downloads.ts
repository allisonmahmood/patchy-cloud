/// <reference lib="dom" />
// @effect-diagnostics globalTimers:off
// Download approval belongs to the signed-in shell, never to an event reported by the frame.
// D-1 from #385: each file is a bottom-right card, "<patch> made a file", with its name, size, Download and Not now.
export function createDownloads(
  frame: HTMLIFrameElement,
  reserve: (size: number) => void,
  release: (size: number) => void
) {
  const glyph = () => {
    const element = document.createElement("span");
    element.className = "glyph glyph-sm";
    element.setAttribute("aria-hidden", "true");
    return element;
  };
  const root = document.createElement("section");
  root.className = "shell-corner";
  root.setAttribute("aria-label", "Files ready to download");
  const visible = document.createElement("div");
  visible.className = "shell-downloads";
  const older = document.createElement("details");
  const summary = document.createElement("summary");
  summary.className = "status-chip";
  const summaryText = document.createElement("span");
  summary.append(glyph(), summaryText);
  const folded = document.createElement("div");
  folded.className = "shell-downloads";
  older.append(summary, folded);
  root.append(visible, older);
  document.body.append(root);
  const files: Array<{ card: HTMLElement; url: string; size: number }> = [];
  const retiring = new Map<string, { size: number; timer: number }>();
  let closed = false;
  const layout = () => {
    const active = document.activeElement;
    files.forEach((file, index) => {
      const parent = index < 3 ? visible : folded;
      if (index >= 3 && file.card.contains(active)) older.open = true;
      const position = index < 3 ? index : index - 3;
      if (parent.children[position] !== file.card)
        parent.insertBefore(file.card, parent.children[position] ?? null);
    });
    older.hidden = files.length <= 3;
    const remaining = Math.max(0, files.length - 3);
    summaryText.textContent = `${remaining} more ${remaining === 1 ? "file" : "files"}`;
    root.hidden = files.length === 0;
    if (active instanceof HTMLElement && root.contains(active)) active.focus();
  };
  const discard = (file: (typeof files)[number], downloaded: boolean) => {
    files.splice(files.indexOf(file), 1);
    file.card.remove();
    if (downloaded) {
      // Chromium needs the URL to survive the click's download handoff.
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(file.url);
        release(file.size);
        retiring.delete(file.url);
      }, 10_000);
      retiring.set(file.url, { size: file.size, timer });
    } else {
      URL.revokeObjectURL(file.url);
      release(file.size);
    }
    layout();
    frame.focus();
  };
  layout();
  return {
    add(name: string, bytes: ArrayBuffer, contentType: string) {
      if (closed) return;
      reserve(bytes.byteLength);
      let url: string;
      try {
        url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
      } catch (error) {
        release(bytes.byteLength);
        throw error;
      }
      const card = document.createElement("section");
      card.className = "note note-info note-float";
      card.setAttribute("aria-label", name);
      // Title and file line are the live region; the actions stay outside it.
      const message = document.createElement("div");
      message.setAttribute("role", "status");
      const title = document.createElement("div");
      title.className = "note-title";
      title.append(glyph(), `${frame.title} made a file`);
      const line = document.createElement("p");
      const fileName = document.createElement("code");
      fileName.textContent = name;
      const size = document.createElement("span");
      const kb = bytes.byteLength / 1024;
      size.textContent =
        bytes.byteLength < 1024
          ? `${bytes.byteLength} bytes`
          : kb < 1024
            ? `${Number(kb.toFixed(1))} KB`
            : `${Number((kb / 1024).toFixed(1))} MB`;
      line.append(fileName, " · ", size);
      message.append(title, line);
      const actions = document.createElement("div");
      actions.className = "actions";
      const download = document.createElement("button");
      download.type = "button";
      download.className = "btn btn-primary";
      download.textContent = "Download";
      const notNow = document.createElement("button");
      notNow.type = "button";
      notNow.className = "btn btn-quiet";
      notNow.textContent = "Not now";
      const file = { card, url, size: bytes.byteLength };
      download.addEventListener("click", (event) => {
        if (!event.isTrusted || closed) return;
        const anchor = Object.assign(document.createElement("a"), { href: url, download: name });
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        discard(file, true);
      });
      notNow.addEventListener("click", () => discard(file, false));
      actions.append(download, notNow);
      card.append(message, actions);
      files.unshift(file);
      visible.prepend(card);
      layout();
    },
    close() {
      if (closed) return;
      closed = true;
      for (const file of files) {
        URL.revokeObjectURL(file.url);
        release(file.size);
      }
      files.length = 0;
      for (const [url, file] of retiring) {
        clearTimeout(file.timer);
        URL.revokeObjectURL(url);
        release(file.size);
      }
      retiring.clear();
      root.remove();
    }
  };
}
