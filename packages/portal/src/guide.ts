import { confirmForm, type RequireSession } from "@patchy/auth";
import { copyLine, copyScriptPath, escapeAttribute, escapeHtml, isWelcomePage } from "@patchy/core";
import type { Patches } from "@patchy/patches";

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

const fallbackLines: Record<Fallback, string> = {
  contested: "Two computers used this line, so it can’t finish here.",
  denied: "That login was denied, so nothing was connected.",
  expired: "Your agent’s code ran out before it was confirmed.",
  other_account: "A different account confirmed that login, so it isn’t yours.",
  ran_out: "This line ran out."
};

/** Where the portal serves `guideScript`; "assets" is a reserved company handle. */
export const guideScriptPath = "/assets/guide.js";

/** The first publish's note stays up for a day after the patch was created. */
const firstPatchWindow = 24 * 60 * 60 * 1_000;

/** The Home it lives on, by the company's name: "Back to Acme Co". */
const companyHome = (viewer: RequireSession.Viewer["Service"]) => escapeHtml(viewer.company.name);

/** What a screen reader hears when the panel moves to each state, once. */
const announcements: Record<SetupState["kind"], string> = {
  waiting: "",
  picked_up: "Your agent opened the line.",
  login_pending: "Check your agent: it shows a link and a code to confirm.",
  confirming: "Confirmed. Your agent is collecting its key.",
  fallback: "This setup line can’t finish here.",
  connected: "You’re set. Your computer is connected.",
  live: "Your first publication is live."
};

const step = (
  state: "done" | "current" | "upcoming",
  marker: string,
  title: string,
  body: string
) =>
  `<li class="step${state === "upcoming" ? "" : ` step-${state}`}"${state === "current" ? ' aria-current="step"' : ""}><span class="step-marker" aria-hidden="true">${marker}</span><div><h2 class="step-title">${title}</h2>${body}</div></li>`;

/**
 * "Your welcome page is live", or "Your first patch is live" for anything else, with the ways to
 * open it and pass it on. Home's first-patch note and the panel's last state are this one note.
 */
export const renderLiveNote = (
  row: Patches.ReadPatch,
  viewer: RequireSession.Viewer["Service"],
  publicBaseUrl: string
): string => {
  const { patch } = row;
  const address = `/${encodeURIComponent(patch.companyHandle)}/${encodeURIComponent(patch.name)}`;
  const url = `${publicBaseUrl.replace(/\/+$/u, "")}${address}`;
  return `<section class="note note-ok" role="status"><span class="note-title">${isWelcomePage({ name: patch.name, tier: row.tier }) ? "Your welcome page is live" : "Your first patch is live"}</span><p>${
    patch.scope === "public"
      ? "Anyone with the link can open it."
      : `Signed-in people at ${escapeHtml(viewer.company.name)} can open it.`
  } To change it, tell your agent what to change.</p><div class="actions"><a class="btn btn-primary" href="${escapeAttribute(address)}">Open it</a><button type="button" class="btn" data-copy="${escapeAttribute(url)}" aria-live="polite" hidden>Copy link</button></div></section>`;
};

/**
 * The panel's two steps in the state Patchy's records give them. `/guide/steps` serves this region
 * alone, and the guide script swaps it in when its state changes.
 */
export const renderSetupSteps = (input: {
  readonly state: SetupState;
  readonly viewer: RequireSession.Viewer["Service"];
  readonly publicBaseUrl: string;
  /** The `?s=` of the person's setup line; without one the line is the plain one. */
  readonly setupLink?: string;
}): string => {
  const base = input.publicBaseUrl.replace(/\/+$/u, "");
  const setup = `Set up Patchy using ${base}/llms.txt${input.setupLink === undefined ? "" : `?s=${input.setupLink}`}`;
  const { state, viewer } = input;
  const opened = `<p class="supporting-text">Your agent opened the line.</p>`;
  const lineCard = (status: string) =>
    `<div class="step-card">${copyLine(setup, "Setup line, select to copy")}<p class="supporting-text">Paste it into Claude Code, Codex, Cursor or any agent that can run commands on your computer.</p>${status}<details><summary>Don’t have an agent yet?</summary><p>An agent is an AI assistant that works on your computer, like Claude Code or Codex. Install one, then come back: this step waits for you here.</p></details></div>`;
  const confirmLater = `<p class="supporting-text">Your agent sends a link and a code. Open it, check the code, confirm. This page moves on by itself.</p>`;
  const steps =
    state.kind === "waiting"
      ? `${step(
          "current",
          "1",
          "Give your agent this line",
          lineCard(
            `<p class="note note-info final-step-copied" role="status" hidden><strong>Now paste it into your agent.</strong> This page moves on by itself when your agent opens the line.</p>`
          )
        )}${step("upcoming", "2", "Confirm it’s you", confirmLater)}`
      : state.kind === "picked_up"
        ? `${step(
            "current",
            "1",
            "Give your agent this line",
            lineCard(
              `<p class="note note-info" role="status"><strong>Your agent opened the line.</strong></p>`
            )
          )}${step("upcoming", "2", "Confirm it’s you", confirmLater)}`
        : state.kind === "login_pending" || state.kind === "confirming" || state.kind === "fallback"
          ? `${step("done", "✓", "Give your agent this line", opened)}${step(
              "current",
              "2",
              "Confirm it’s you",
              state.kind === "login_pending"
                ? state.login === undefined || input.setupLink === undefined
                  ? `<p>Check your agent: it shows a link and a code to confirm.</p>`
                  : `<section class="note note-info"><span class="note-title">A computer wants to publish as you</span><p>Does your agent show <code>${escapeHtml(state.login.userCode)}</code>?</p>${confirmForm(
                      {
                        userCode: state.login.userCode,
                        userId: viewer.user.id,
                        machineName: state.login.machineNameHint,
                        oldMachineName: state.login.oldMachineName,
                        setupLink: input.setupLink
                      }
                    )}<p class="supporting-text">Or open the link your agent showed you. Both work.</p></section>`
                : state.kind === "confirming"
                  ? `<p>Confirmed. Your agent is collecting its key.</p>`
                  : `<section class="note note-warn" role="status"><span class="note-title">${fallbackLines[state.reason]}</span><p>Finish with the link your agent shows you, or get a new line.</p><form method="post" action="/guide/new-line"><input type="hidden" name="user" value="${escapeAttribute(viewer.user.id)}"><button class="btn" type="submit">Get a new line</button></form></section>`
            )}`
          : `${step("done", "✓", "Give your agent this line", "")}${step("done", "✓", "Confirm it’s you", `<p class="supporting-text">Your computer is connected.</p>`)}`;
  const go = `<a class="btn" href="/">Go to ${companyHome(viewer)}</a>`;
  const after =
    state.kind === "connected"
      ? `<section class="note note-ok" role="status"><span class="note-title">You’re set</span><p>Your agent finishes setup from here. What it publishes shows up on Home.</p><div class="actions">${go.replace('class="btn"', 'class="btn btn-primary"')}</div></section>`
      : state.kind === "live"
        ? `${renderLiveNote(state.row, viewer, input.publicBaseUrl)}<div class="actions">${go}</div>`
        : "";
  return `<div class="final-step-steps" data-guide-steps data-state="${stateKey(state)}" data-announce="${escapeAttribute(announcements[state.kind])}"><ol class="steps final-step-list">${steps}</ol>${after}</div>`;
};

/**
 * The Final step panel: connecting an agent is the last thing between a person and Patchy. As
 * `modal` it sits over Home with Later as its only way out before connecting; as `page` it is
 * `/guide`, which the nav leaves. On a phone it says the step happens on their computer.
 */
export const renderFinalStep = (input: {
  readonly state: SetupState;
  readonly viewer: RequireSession.Viewer["Service"];
  readonly publicBaseUrl: string;
  readonly setupLink?: string;
  readonly mode: "modal" | "page";
}): string => {
  const company = escapeHtml(input.viewer.company.name);
  const base = input.publicBaseUrl.replace(/\/+$/u, "");
  const later =
    input.mode === "modal"
      ? `<form class="final-step-later" method="post" action="/guide/later"><input type="hidden" name="user" value="${escapeAttribute(input.viewer.user.id)}"><button class="btn btn-quiet" type="submit"><span class="final-step-wide">Later</span><span class="final-step-narrow">Look around ${company} first</span></button></form>`
      : "";
  const body = `<h1 class="page-heading" id="final-step-heading" tabindex="-1">Final step</h1><p class="lede final-step-wide">Connect your AI agent. It builds what ${company} needs, and Patchy puts it online for everyone at ${company}.</p><p class="final-step-announce" aria-live="polite" data-guide-announce></p>${renderSetupSteps(input)}<div class="final-step-narrow"><p class="lede">Connect your AI agent. It runs on your computer, so this step happens there, and it’ll be waiting when you open Patchy on your computer.</p><div class="actions"><button type="button" class="btn btn-primary" data-share="${escapeAttribute(base)}" hidden>Send this to my computer</button></div></div><p class="supporting-text final-step-how">How Patchy works: you ask → your agent builds it → Patchy puts it online → ${company} uses it.</p>${later}<script defer src="${copyScriptPath}"></script><script defer src="${guideScriptPath}"></script>`;
  return input.mode === "modal"
    ? `<section class="modal-panel final-step" role="dialog" aria-modal="true" aria-labelledby="final-step-heading" data-guide-modal>${body}</section>`
    : `<article class="portal-card final-step" aria-labelledby="final-step-heading">${body}</article>`;
};

/** Layout only; every control is the shell's. */
export const finalStepStyles = `
  .final-step .lede { margin: 0; }
  .final-step .steps { margin-top: 18px; }
  .final-step-steps > .note { margin: 18px 0 0; }
  .final-step-how { margin: 22px 0 0; padding-top: 14px; border-top: 2px dashed var(--line-strong); }
  .final-step-later { margin: 12px 0 0; text-align: center; }
  .final-step .actions > [hidden], .note .actions > [hidden] { display: none; }
  .final-step-narrow { display: none; }
  .final-step-narrow[hidden], .final-step-later[hidden] { display: none; }
  .final-step-announce { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (max-width: 600px) {
    .final-step-wide, .final-step-list { display: none; }
    .final-step-steps > .note { margin-top: 0; }
    .final-step-narrow { display: block; }
    .final-step-later .final-step-narrow { display: inline; }
  }
`;

/**
 * Follows the agent: while the tab is visible it asks `/guide/steps` every 3 s and swaps the steps
 * in when their state changes, then stops at the last state, after 30 minutes (offering Check
 * again) or when the answer isn't the steps (a reload then lands on the sign-in door). On Home
 * without the panel it watches the same way and puts the live note at the top. It also reveals
 * Send this to my computer and the line after Copy, and puts focus in the panel.
 */
export const guideScript = `(() => {
  const limit = 30 * 60 * 1000;
  const started = Date.now();
  let region = document.querySelector("[data-guide-steps]");
  if (region === null) return;
  const watching = region.dataset.mode === "watch";
  const modal = document.querySelector("[data-guide-modal]");
  const panel = modal ?? document.querySelector(".final-step");
  const announcer = document.querySelector("[data-guide-announce]");
  const visible = (root) =>
    [...root.querySelectorAll("button, a[href], summary")].find((el) => !el.hidden && el.offsetParent !== null);
  // Copy buttons that arrive after the copy script ran, such as the live note's Copy link.
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
    if (copy) document.querySelector(".final-step-copied")?.removeAttribute("hidden");
  });
  for (const button of document.querySelectorAll("button[data-share]")) {
    button.hidden = false;
    button.addEventListener("click", () => {
      const url = button.dataset.share ?? "";
      if (navigator.share) navigator.share({ title: "Patchy", text: "Finish setting up Patchy on your computer", url }).catch(() => {});
      else navigator.clipboard.writeText(url).then(() => { button.textContent = "Link copied"; }, () => {});
    });
  }
  // Focus starts on the panel's first visible control: Copy on a computer, Send on a phone.
  if (modal !== null) (visible(modal) ?? modal.querySelector("h1"))?.focus();
  const settled = (state) => state === "connected" || state === "live";
  const done = (state) => state === "live";
  const show = (next) => {
    const hadFocus = region.contains(document.activeElement);
    region.replaceWith(next);
    region = next;
    wireCopy(region);
    if (settled(region.dataset.state))
      for (const gone of document.querySelectorAll(".final-step-later, .final-step-narrow")) gone.hidden = true;
    if (announcer !== null && region.dataset.announce) announcer.textContent = region.dataset.announce;
    const lost = document.activeElement === document.body || document.activeElement?.offsetParent === null;
    if (hadFocus || lost) (visible(region) ?? panel?.querySelector("h1"))?.focus();
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
      if (!response.ok || next === null) return location.reload();
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
            document.querySelector("main")?.prepend(...notes);
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
 * Home watches for the first publication without the panel, after a computer connects or after
 * Later: the region is empty until the live note arrives.
 */
export const renderWatch = (state: SetupState["kind"]): string =>
  `<div data-guide-steps data-mode="watch" data-state="${state}" hidden></div><script defer src="${guideScriptPath}"></script>`;

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
