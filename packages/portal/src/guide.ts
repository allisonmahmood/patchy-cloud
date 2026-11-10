import { confirmForm, type RequireSession } from "@patchy/auth";
import {
  button,
  copyButton,
  copyLine,
  copyScriptPath,
  dialog,
  escapeAttribute,
  escapeHtml,
  flowPage,
  isWelcomePage,
  linkButton,
  notice,
  steps,
  type Step,
  type Template
} from "@patchy/core";
import type { Patches } from "@patchy/patches";
import { hidden } from "./shared/presentation.js";

/** Why a setup line can't finish on the panel; each says what happened, and all offer a new line. */
export type Fallback = "contested" | "denied" | "expired" | "other_account" | "ran_out";

/**
 * Where a person stands on connecting their agent, from what Patchy records: their setup line's
 * link (picked up, a login bound to it and how it ended), their live machine tokens, and what they
 * published since. Nothing else about setup is stored.
 */
export type SetupState =
  | { readonly kind: "waiting" }
  | { readonly kind: "picked_up" }
  | {
      readonly kind: "login_pending";
      /** The login the line bound, to confirm right here; absent once it can't be. */
      readonly login?: {
        readonly userCode: string;
        readonly machineNameHint: string;
        readonly oldMachineName: string | null;
      };
    }
  | { readonly kind: "confirming" }
  | { readonly kind: "fallback"; readonly reason: Fallback }
  | { readonly kind: "connected" }
  | { readonly kind: "live"; readonly row: Patches.ReadPatch };

/** One key per state the script compares, so a fallback's reason counts as a change. */
export const stateKey = (state: SetupState): string =>
  state.kind === "fallback" ? `fallback-${state.reason}` : state.kind;

/** What to do next: after a denial there's nothing to finish, only a fresh start if wanted. */
const fallbackNext = (reason: Fallback) =>
  reason === "denied"
    ? "If you didn’t just paste the line, you’re fine: no computer can publish as you."
    : "Finish with the link your agent shows you, or get a new line.";

const fallbackLines: Record<Fallback, string> = {
  contested: "Two computers used this line, so it can’t finish here.",
  denied: "Nothing was connected.",
  expired: "Your agent’s code ran out before it was confirmed.",
  other_account: "A different account confirmed that login, so it isn’t yours.",
  ran_out: "This line ran out."
};

/** Where the portal serves `guideScript`; "assets" is a reserved company handle. */
export const guideScriptPath = "/assets/guide.js";

/** The first publish's note stays up for a day after the patch was created. */
const firstPatchWindow = 24 * 60 * 60 * 1_000;

/** Patchy's glyph beside the Final step's title. */
const glyph = '<span class="glyph glyph-lg" aria-hidden="true"></span>';

type Viewer = RequireSession.Viewer["Service"];

/** What a screen reader hears when the steps move to each state, once. */
const announcements: Record<SetupState["kind"], string> = {
  waiting: "",
  picked_up: "Your agent opened the line.",
  login_pending: "Check your agent: it shows a link and a code to confirm.",
  confirming: "Confirmed. Your agent is collecting its key.",
  fallback: "This setup line can’t finish here.",
  connected: "You’re set. Your computer is connected.",
  live: "Your first publication is live."
};

/**
 * "Your welcome page is live", or "Your first patch is live" for anything else, with the ways to
 * open it and pass it on: the steps' last state.
 */
export const renderLiveNote = (row: Patches.ReadPatch, viewer: Viewer, publicBaseUrl: string) => {
  const { patch } = row;
  const address = `/${encodeURIComponent(patch.companyHandle)}/${encodeURIComponent(patch.name)}`;
  const url = `${publicBaseUrl.replace(/\/+$/u, "")}${address}`;
  return notice({
    tone: "info",
    title: isWelcomePage({ name: patch.name, tier: row.tier })
      ? "Your welcome page is live"
      : "Your first patch is live",
    body: `<p>${
      patch.scope === "public"
        ? "Anyone with the link can open it."
        : `Signed-in people at ${escapeHtml(viewer.company.name)} can open it.`
    } To change it, tell your agent what to change.</p>`,
    action: `<div class="btn-group">${linkButton("Open it", address, { kind: "primary", size: "sm" })}${copyButton(url, { label: "Copy link", size: "sm" })}</div>`
  });
};

/**
 * The two steps in the state Patchy's records give them, and what comes after the last. On a
 * phone the steps fold away, since they happen on a computer. `/guide/steps` serves this region
 * alone, and the guide script swaps it in when its state changes.
 */
export const renderSetupSteps = (input: {
  readonly state: SetupState;
  readonly viewer: Viewer;
  readonly publicBaseUrl: string;
  /** The `?s=` of the person's setup line; without one the line is the plain one. */
  readonly setupLink?: string;
}): string => {
  const base = input.publicBaseUrl.replace(/\/+$/u, "");
  const setup = `Set up Patchy using ${base}/llms.txt${input.setupLink === undefined ? "" : `?s=${input.setupLink}`}`;
  const { state, viewer } = input;
  const line = (status: string) =>
    `${copyLine(setup, "Setup line, select to copy", "the setup line")}<p class="meta">Works in Claude Code, Codex, Cursor or any agent that runs commands on your computer.</p>${status}<details><summary>No agent yet?</summary><p class="meta">An agent is an AI assistant that works on your computer, like Claude Code, Codex or Cursor. Install one, then come back: this step waits for you here.</p></details>`;
  const give = (stage: Step["state"], body: string): Step => ({
    title: "Give your agent this line",
    state: stage,
    body
  });
  const confirm = (stage: Step["state"], body: string): Step => ({
    title: "Confirm it’s you",
    state: stage,
    body
  });
  const confirmLater = `<p class="meta">Your agent shows a link and a code. Open it, check the code matches, and confirm. This moves on by itself.</p>`;
  const opened = `<p class="meta">Your agent opened the line.</p>`;
  const items: ReadonlyArray<Step> =
    state.kind === "waiting"
      ? [
          give(
            "current",
            line(
              `<div data-guide-copied hidden>${notice({ tone: "info", title: "Now paste it into your agent", body: "<p>This moves on by itself when your agent opens the line.</p>" })}</div>`
            )
          ),
          confirm("later", confirmLater)
        ]
      : state.kind === "picked_up"
        ? [
            give("current", line(notice({ tone: "info", title: "Your agent opened the line" }))),
            confirm("later", confirmLater)
          ]
        : state.kind === "login_pending" || state.kind === "confirming" || state.kind === "fallback"
          ? [
              give("done", opened),
              confirm(
                "current",
                state.kind === "login_pending"
                  ? state.login === undefined || input.setupLink === undefined
                    ? `<p>Check your agent: it shows a link and a code to confirm.</p>`
                    : `<p><span class="strong">A computer wants to publish as you.</span> Does your agent show <code>${escapeHtml(state.login.userCode)}</code>?</p>${confirmForm(
                        {
                          userCode: state.login.userCode,
                          userId: viewer.user.id,
                          machineName: state.login.machineNameHint,
                          oldMachineName: state.login.oldMachineName,
                          setupLink: input.setupLink
                        }
                      )}<p class="meta">Or open the link your agent showed you. Both work.</p>`
                  : state.kind === "confirming"
                    ? `<p>Confirmed. Your agent is collecting its key.</p>`
                    : notice({
                        tone: "warning",
                        title: fallbackLines[state.reason],
                        body: `<p>${fallbackNext(state.reason)}</p>`,
                        action: `<form method="post" action="/guide/new-line">${hidden("user", viewer.user.id)}${button("Get a new line", { size: "sm" })}</form>`
                      })
              )
            ]
          : [give("done", ""), confirm("done", `<p class="meta">Your computer is connected.</p>`)];
  const home = `Go to ${viewer.company.name}`;
  const after =
    state.kind === "connected"
      ? notice({
          tone: "info",
          title: "You’re set",
          body: "<p>Your agent finishes setup from here. What it publishes shows up on Home.</p>",
          action: linkButton(home, "/", { kind: "primary", size: "sm" })
        })
      : state.kind === "live"
        ? `${renderLiveNote(state.row, viewer, input.publicBaseUrl)}<div class="btn-group">${linkButton(home, "/")}</div>`
        : "";
  return `<div class="stack" data-guide-steps data-viewer="${escapeAttribute(viewer.user.id)}" data-state="${stateKey(state)}" data-announce="${escapeAttribute(announcements[state.kind])}"><div class="hide-sm">${steps(items)}</div>${after}</div>`;
};

/**
 * What the Final step and New patch share while the viewer isn't connected: the steps, and on a
 * phone, in their place, that this happens on a computer, with Send this to my computer. The
 * guide script follows the agent and reveals what needs script; the page they are on loads the
 * copy script.
 */
const setupBody = (input: Parameters<typeof renderSetupSteps>[0]) =>
  `<p class="sr-only" aria-live="polite" data-guide-announce></p>${renderSetupSteps(input)}<div class="show-sm" data-guide-unsettled><p class="prose">Connect your AI agent. It runs on your computer, so this step happens there, and it’ll be waiting when you open Patchy on your computer.</p><div data-guide-send hidden><div class="btn-group">${button("Send this to my computer", { type: "button", kind: "primary", data: { share: input.publicBaseUrl.replace(/\/+$/u, "") } })}</div></div></div><script defer src="${guideScriptPath}"></script>`;

const lede = (viewer: Viewer) =>
  `Connect your agent. It builds on your computer, and Patchy puts it online for ${escapeHtml(viewer.company.name)}.`;

/**
 * The Final step: connecting an agent is the last thing between a person and Patchy. Over Home it
 * is a dialog whose only way out before connecting is Later, which a phone words "Look around
 * <company> first"; it has no Close and Escape doesn't close it.
 */
export const renderFinalStep = (input: {
  readonly state: SetupState;
  readonly viewer: Viewer;
  readonly publicBaseUrl: string;
  readonly setupLink?: string;
}): string =>
  dialog({
    id: "final-step",
    title: "Final step",
    mark: glyph,
    size: "lg",
    body: `<p class="meta hide-sm">${lede(input.viewer)}</p>${setupBody(input)}`,
    foot: `<span class="meta dialog-foot-start hide-sm" data-guide-unsettled>This updates by itself</span><form method="post" action="/guide/later" data-guide-unsettled>${hidden("user", input.viewer.user.id)}<span class="hide-sm">${button("Later", { kind: "quiet" })}</span><span class="show-sm">${button(`Look around ${input.viewer.company.name} first`, { kind: "quiet" })}</span></form>`
  });

/** `/guide`: the Final step as a page, which Connect on Home leads to; the sidebar leaves it. */
export const renderGuide = (input: Parameters<typeof renderSetupSteps>[0]): Template =>
  flowPage({
    parent: { label: "Home", href: "/" },
    mark: glyph,
    title: "Final step",
    meta: [`<span class="hide-sm">${lede(input.viewer)}</span>`],
    sections: [],
    outcome: `${setupBody(input)}<script defer src="${copyScriptPath}"></script>`,
    submit: ""
  });

/**
 * New patch, over Home at `/?new`: the line someone gives their agent. Connected, a starter line
 * and the computer it builds on; not yet, the same steps as the Final step, from the same state.
 * Like the Final step, it relies on Home's copy script.
 */
export const renderNewPatch = (
  input:
    | { readonly connected: true; readonly viewer: Viewer; readonly computer: string }
    | ({ readonly connected: false } & Parameters<typeof renderSetupSteps>[0])
): string =>
  input.connected
    ? dialog({
        id: "new-patch",
        title: "New patch",
        closeHref: "/",
        size: "lg",
        body: `<p class="prose">Tell your agent what to build. It builds the patch on your computer and publishes it to ${escapeHtml(input.viewer.company.name)}.</p>${copyLine(`Use Patchy to build ${input.viewer.company.name} a tool that …`, "Starter line, select to copy", "the starter line")}<p class="meta">Your agent is set up on <span class="strong">${escapeHtml(input.computer)}</span>. Building somewhere else? <a href="/agents/computer">Add a computer</a></p>`,
        foot: linkButton("Done", "/", { kind: "primary", autofocus: true })
      })
    : dialog({
        id: "new-patch",
        title: "New patch",
        closeHref: "/",
        size: "lg",
        body: setupBody(input),
        foot: `<span class="meta dialog-foot-start hide-sm" data-guide-unsettled>This updates by itself</span>${linkButton("Done", "/")}`
      });

/**
 * Follows the agent: while the tab is visible it asks `/guide/steps` every 3 s and swaps the steps
 * in when their state changes, then stops at the last state, after 30 minutes (offering Check
 * again) or when the answer isn't the steps (a reload then lands on the sign-in door). On Home
 * without the steps it watches the same way and puts the live notice in Home's notices. It also
 * reveals Send this to my computer and the paste reminder after Copy, and puts focus in the dialog
 * the steps are in when nothing there has it yet.
 */
export const guideScript = `(() => {
  const limit = 30 * 60 * 1000;
  const started = Date.now();
  let region = document.querySelector("[data-guide-steps]");
  // Without the account it was rendered for, a reply can't be checked against it.
  if (region === null || !region.dataset.viewer) return;
  const watching = region.dataset.mode === "watch";
  const dialog = region.closest("[data-dialog]");
  const panel = dialog ?? document.querySelector("main");
  const announcer = document.querySelector("[data-guide-announce]");
  const visible = (root) =>
    [...root.querySelectorAll("button, a[href], summary")].find((el) => !el.hidden && el.offsetParent !== null);
  // Copy buttons that arrive after the copy script ran, such as the live notice's Copy link.
  const wireCopy = (root) => {
    for (const button of root.querySelectorAll("button[data-copy]")) {
      const label = button.textContent;
      button.hidden = false;
      button.addEventListener("click", () => {
        navigator.clipboard.writeText(button.dataset.copy ?? "").then(
          () => { button.textContent = "Copied"; },
          () => { button.textContent = "Select the line to copy"; }
        ).finally(() => setTimeout(() => { button.textContent = label; }, 2000));
      });
    }
  };
  document.addEventListener("click", (event) => {
    const copy = event.target.closest?.("[data-guide-steps] button[data-copy]");
    if (copy) document.querySelector("[data-guide-copied]")?.removeAttribute("hidden");
  });
  for (const send of document.querySelectorAll("[data-guide-send]")) {
    const button = send.querySelector("button[data-share]");
    if (button === null) continue;
    send.hidden = false;
    button.addEventListener("click", () => {
      const url = button.dataset.share ?? "";
      if (navigator.share) navigator.share({ title: "Patchy", text: "Finish setting up Patchy on your computer", url }).catch(() => {});
      else navigator.clipboard.writeText(url).then(() => { button.textContent = "Link copied"; }, () => {});
    });
  }
  const heading = () => panel?.querySelector("h1, h2");
  // Focus starts on the dialog's first visible control, Copy on a computer and Send on a phone,
  // unless the page's enhancer already put it there.
  if (dialog !== null && !dialog.contains(document.activeElement))
    (visible(dialog.querySelector(".dialog-body") ?? dialog) ?? heading())?.focus();
  const settled = (state) => state === "connected" || state === "live";
  const done = (state) => state === "live";
  const show = (next) => {
    const hadFocus = region.contains(document.activeElement);
    region.replaceWith(next);
    region = next;
    wireCopy(region);
    if (settled(region.dataset.state))
      for (const gone of document.querySelectorAll("[data-guide-unsettled]")) gone.hidden = true;
    if (announcer !== null && region.dataset.announce) announcer.textContent = region.dataset.announce;
    const lost = document.activeElement === document.body || document.activeElement?.offsetParent === null;
    if (hadFocus || lost) (visible(region) ?? heading())?.focus();
  };
  let timer;
  let inFlight = false;
  const checkAgain = () => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.textContent = "Check again";
    button.addEventListener("click", () => location.reload());
    region.append(button);
  };
  // One loop: a tick never overlaps another, so replies arrive in order and none goes stale.
  const tick = async () => {
    clearTimeout(timer);
    if (inFlight || document.hidden || done(region.dataset.state)) return;
    if (Date.now() - started > limit) return checkAgain();
    inFlight = true;
    try {
      const response = await fetch("/guide/steps" + (watching ? "?mode=watch" : ""), { credentials: "same-origin", headers: { accept: "text/html" } });
      const next = new DOMParser().parseFromString(await response.text(), "text/html").querySelector("[data-guide-steps]");
      // Another account signed in since the page loaded: its answers belong on its own page.
      if (!response.ok || next === null || next.dataset.viewer !== region.dataset.viewer) return location.reload();
      // A confirmation someone is filling in stays put until they answer it.
      const form = region.querySelector("form[data-inline-confirm]");
      const busy =
        form !== null &&
        (form.contains(document.activeElement) ||
          [...form.querySelectorAll("input")].some((input) => input.value !== input.defaultValue));
      if (next.dataset.state !== region.dataset.state && !busy) {
        if (!watching) show(next);
        else {
          if (next.dataset.state === "live") {
            const notes = [...next.children];
            (document.querySelector("[data-home-notes]") ?? document.querySelector("main"))?.prepend(...notes);
            for (const note of notes) wireCopy(note);
          }
          region.dataset.state = next.dataset.state;
        }
      }
    } catch {
    } finally {
      inFlight = false;
    }
    if (!done(region.dataset.state)) timer = setTimeout(tick, 3000);
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  timer = setTimeout(tick, 3000);
})();
`;

/**
 * Home watches for the first publication without the steps, after a computer connects or after
 * Later: the region is empty until the live notice arrives.
 */
export const renderWatch = (state: SetupState["kind"], viewerId: string): string =>
  `<div data-guide-steps data-mode="watch" data-viewer="${escapeAttribute(viewerId)}" data-state="${state}" hidden></div><script defer src="${guideScriptPath}"></script>`;

/** A person's earliest patch, for the day after it was made and while it is live. */
export const firstPatch = (
  rows: ReadonlyArray<Patches.ReadPatch>,
  userId: string,
  now: number
): Patches.ReadPatch | undefined => {
  const first = rows
    .filter((row) => row.owner.id === userId)
    .reduce<Patches.ReadPatch | undefined>(
      (earliest, row) =>
        earliest === undefined ||
        Date.parse(row.patch.createdAt) < Date.parse(earliest.patch.createdAt)
          ? row
          : earliest,
      undefined
    );
  return first !== undefined &&
    first.patch.state === "live" &&
    now - Date.parse(first.patch.createdAt) < firstPatchWindow
    ? first
    : undefined;
};
