/// <reference lib="dom" />
// @effect-diagnostics globalFetch:off globalDate:off
// This browser entry owns fetch and the clock; it never creates an Effect runtime.
/**
 * `/~shell/switcher.js`: Patchy's switcher on a signed-in page: an app page, a company shell or a
 * notice. Its tag names the viewer and company the page was rendered for (`switcherTag`). A company
 * shell's frame names the patch on screen, and a notice about one patch names it in the tag.
 * `scripts/build-core-scripts.mjs` bundles it, plain DOM code with no dependencies.
 *
 * The relay holds a press made before this loads, so the menu opens as soon as it starts,
 * whatever Clerk is doing; from then on the chord opens it at once, through the `Switcher` this
 * installs as `window.patchySwitcher`.
 */
import { tabStorage } from "./cache.js";
import { forgetOnSignOut, pageSession, switcherClient } from "./client.js";
import { switcherMenu } from "./menu.js";
import { type Switcher, switcherMessage, switcherMessageKind } from "./messages.js";

const tag = document.currentScript;
const viewer = tag?.dataset.viewer;
const company = tag?.dataset.company;
if (viewer !== undefined && company !== undefined) {
  const element = document.getElementById("patch");
  const frame =
    element instanceof HTMLIFrameElement && element.dataset.scope === "company"
      ? element
      : undefined;
  const patch = frame?.dataset.patchId ?? tag?.dataset.patch;
  const client = switcherClient({
    who: { viewer, company },
    here: patch,
    storage: tabStorage(),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    session: pageSession
  });
  forgetOnSignOut(client, document);
  const { open, toggle } = switcherMenu(client, { frame, patch });
  const asked = window.patchySwitcher === true;
  window.patchySwitcher = { open, toggle } satisfies Switcher;
  // The patch's relay holds its keys after the chord only where a switcher will take them, so the
  // switcher answers each of its frame's documents' hello, whatever the broker's release. It runs
  // before the broker gives the frame its address, so it hears every one.
  if (frame !== undefined)
    addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.origin !== "null") return;
      if (switcherMessageKind(event.data, ["hello"]) === undefined) return;
      frame.contentWindow?.postMessage(switcherMessage("available"), "*");
    });
  if (asked) open();
}
