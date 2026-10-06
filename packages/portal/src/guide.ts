import type { RequireSession } from "@patchy/auth";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import type { Patches } from "@patchy/patches";
import { ago } from "./render.js";

/**
 * Where a person stands on the way to their first patch, from what Patchy already records. The portal shows the
 * guide while they own no patch; `machine` is the newest machine logged in as them, once one is.
 */
export interface Guide {
  readonly machine: { readonly name: string; readonly createdAt: string } | null;
}

/** The example in the flow and step 3, and the patch the agent's reply names. */
const example = {
  ask: "Build us a lead tracker",
  prompt: "Build us a lead tracker with Patchy",
  name: "lead-tracker"
};

/** Where the portal serves `copyScript`; "assets" is a reserved company handle. */
export const copyScriptPath = "/assets/copy.js";

/** The first publish's note stays up for a day after the patch was created. */
const firstPatchWindow = 24 * 60 * 60 * 1_000;

const icons = {
  you: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" stroke-linecap="round"/></svg>`,
  agent: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 10 3 2.5L7 15M12.5 15H17" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  team: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" stroke-linecap="round"/><circle cx="17" cy="9" r="2.8"/><path d="M16.5 14.2c2.9.3 5 2.3 5 5.3" stroke-linecap="round"/></svg>`
};

const copyLine = (line: string, label: string) =>
  `<div class="copy-line"><code aria-label="${escapeAttribute(label)}">${escapeHtml(line)}</code><button type="button" class="btn btn-primary" data-copy="${escapeAttribute(line)}" aria-live="polite" hidden>Copy</button></div>`;

const preview = (lines: ReadonlyArray<string>) =>
  `<p class="supporting-text">Your agent will say something like</p><div class="agent-preview">${lines.map((line) => `<p>${line}</p>`).join("")}</div>`;

const said = (text: string) =>
  `<span class="agent-preview-said" aria-hidden="true">●</span> ${text}`;
const you = (text: string) =>
  `<span class="agent-preview-you" aria-hidden="true">›</span> ${escapeHtml(text)}`;

const step = (
  state: "done" | "current" | "upcoming",
  marker: string,
  title: string,
  body: string
) =>
  `<li class="step${state === "upcoming" ? "" : ` step-${state}`}"${state === "current" ? ' aria-current="step"' : ""}><span class="step-marker" aria-hidden="true">${marker}</span><div><h2 class="step-title">${title}</h2>${body}</div></li>`;

/** The guide's card: what Patchy is, then the steps to a first patch with the open one's work and a preview. */
export const renderGuide = (input: {
  readonly guide: Guide;
  readonly viewer: RequireSession.Viewer["Service"];
  readonly publicBaseUrl: string;
  readonly now: number;
}): string => {
  const company = escapeHtml(input.viewer.company.name);
  const base = input.publicBaseUrl.replace(/\/+$/u, "");
  const host = escapeHtml(base.replace(/^https?:\/\//u, ""));
  const setup = `Set up Patchy using ${base}/llms.txt`;
  const { machine } = input.guide;
  const flow = `<ol class="flow" aria-label="How Patchy works"><li class="flow-node"><span class="flow-icon flow-icon-you">${icons.you}</span><strong>You ask</strong><span>“${example.ask}”</span></li><li class="flow-node"><span class="flow-icon flow-icon-agent">${icons.agent}</span><strong>Your agent builds it</strong><span>Claude Code, Codex, Cursor…</span></li><li class="flow-node"><span class="flow-icon flow-icon-patchy"><span class="glyph" aria-hidden="true"></span></span><strong>Patchy puts it online</strong><span>${escapeHtml(input.viewer.company.handle)}/${example.name}</span></li><li class="flow-node"><span class="flow-icon flow-icon-team">${icons.team}</span><strong>${company} uses it</strong><span>Signed in, private to ${company}</span></li></ol>`;
  const ask = step(
    machine === null ? "upcoming" : "current",
    "3",
    "Ask for your first patch",
    machine === null
      ? `<p class="supporting-text">Anything works, like “Publish this plan with Patchy”. It shows up here, under Yours.</p>`
      : `<div class="step-card"><p>Tell your agent what you want, and mention Patchy.</p>${copyLine(example.prompt, "Example request, select to copy")}<p class="supporting-text">Anything works: a lunch poll, an on-call rota, a page from today’s notes.</p>${preview(
          [
            you(example.prompt),
            said(`Building ${example.name}… done.`),
            said(
              `Published. Here it is: <u>${host}/${escapeHtml(input.viewer.company.handle)}/${example.name}</u>. Everyone at ${company} can open it.`
            )
          ]
        )}</div>`
  );
  const steps =
    machine === null
      ? [
          step(
            "current",
            "1",
            "Give your agent this line",
            `<div class="step-card">${copyLine(setup, "Setup line, select to copy")}<p class="supporting-text">Paste it into Claude Code, Codex, Cursor or any AI agent that can run commands on your computer. It installs Patchy and gets this computer ready to publish.</p><details><summary>Don’t have an agent yet?</summary><p>An agent is an AI assistant that works on your computer, like Claude Code or Codex. Install one, then come back. This guide stays here until your first patch is live.</p></details>${preview(
              [
                you(setup),
                said("Installing Patchy… done."),
                said(
                  `To publish as you, this machine needs to be logged in. Open <u>${host}/login/device?code=BCDF-GHJK</u> and check that it shows <strong>BCDF-GHJK</strong>.`
                )
              ]
            )}</div>`
          ),
          step(
            "upcoming",
            "2",
            "Confirm it’s you",
            `<p class="supporting-text">Your agent replies with a link and a code. Open the link, check the code matches, name this computer and confirm.</p>`
          ),
          ask
        ]
      : [
          step(
            "done",
            "✓",
            "Agent connected",
            `<p class="supporting-text">“${escapeHtml(machine.name)}” can publish as you · ${escapeHtml(ago(machine.createdAt, input.now))}</p>`
          ),
          ask
        ];
  return `<article class="portal-card portal-guide" aria-labelledby="guide-heading"><p class="supporting-text">Get started · ${machine === null ? "a few minutes" : "2 of 3 done"}</p><h1 class="page-heading" id="guide-heading">Ship your first patch</h1><p class="lede">Patchy is where ${company}’s tools live. You say what you need, your AI agent builds it, and Patchy puts it online for everyone at ${company}.</p>${machine === null ? flow : ""}<ol class="steps">${steps.join("")}</ol><script defer src="${copyScriptPath}"></script></article>`;
};

/** "Your first patch" under Yours: the guide's row in the index, selected while the guide is the card. */
export const renderGuideRow = (input: {
  readonly guide: Guide;
  readonly selected: boolean;
  readonly all: boolean;
}): string =>
  `<li class="list-row"><a class="list-link list-link-placeholder" href="${input.all ? "/?all=1" : "/"}"${input.selected ? ' aria-current="page"' : ""}><span class="portal-index-line">Your first patch</span><span class="supporting-text portal-index-line">${input.guide.machine === null ? "Start here" : "1 step left"}</span></a></li>`;

/** The day after a person's first patch: their only patch, live, made less than a day ago. */
export const firstPatch = (
  rows: ReadonlyArray<Patches.ReadPatch>,
  userId: string,
  now: number
): Patches.ReadPatch | undefined => {
  const owned = rows.filter((row) => row.owner.id === userId);
  const [only] = owned;
  return owned.length === 1 &&
    only !== undefined &&
    only.patch.state === "live" &&
    now - Date.parse(only.patch.createdAt) < firstPatchWindow
    ? only
    : undefined;
};

/** Shown above the first patch's card while `firstPatch` holds. */
export const renderFirstPatchNote = (
  row: Patches.ReadPatch,
  viewer: RequireSession.Viewer["Service"]
): string =>
  `<section class="note note-ok" role="status"><span class="note-title">Your first patch is live</span><p>${
    row.patch.scope === "public"
      ? "Anyone with the link can open it."
      : `Everyone at ${escapeHtml(viewer.company.name)} can open it.`
  } To change it, tell your agent what to change.</p></section>`;

/** Reveals each copy button and copies its line; a refused clipboard asks the person to select the line instead. */
export const copyScript = `(() => {
  for (const button of document.querySelectorAll("button[data-copy]")) {
    const label = button.textContent;
    let reset;
    button.hidden = false;
    button.addEventListener("click", () => {
      clearTimeout(reset);
      navigator.clipboard.writeText(button.dataset.copy ?? "").then(
        () => { button.textContent = "Copied"; },
        () => { button.textContent = "Select the line to copy"; }
      ).finally(() => { reset = setTimeout(() => { button.textContent = label; }, 2000); });
    });
  }
})();
`;
