// THROWAWAY: simulate the final, successful part of the Deploy GitHub Action.
// These are invented PR release-note fields, not claims about production.
// The action prepares notes before publishing; the browser never writes them.
const examples = [
  {
    title: "A clearer home for your company’s tools",
    summary: "Find your patches and your company’s patches together, in one place.",
    changes: [
      {
        kind: "New",
        title: "Your tools, together",
        detail:
          "The portal groups the patches you own and the tools shared by your company. Open a card to see its description and who maintains it."
      },
      {
        kind: "Improved",
        title: "More context before you open",
        detail: "Each patch shows a short description, so it’s easier to pick the right tool."
      }
    ]
  },
  {
    title: "More control over your patches",
    summary: "Manage sharing and revisit earlier versions from a patch’s card.",
    changes: [
      {
        kind: "New",
        title: "Version history in one place",
        detail:
          "See earlier published versions and choose which version people open at the patch’s address."
      },
      {
        kind: "Improved",
        title: "Clearer sharing controls",
        detail: "See who can open a patch and change its sharing directly from the portal."
      },
      {
        kind: "Fixed",
        title: "Clearer messages when a patch changes",
        detail:
          "If another person changes a patch while you’re managing it, the page explains what changed before you try again."
      }
    ]
  },
  {
    title: "Download files from your tools",
    summary: "Save generated reports and exports straight from a patch.",
    changes: [
      {
        kind: "New",
        title: "Reports you can take with you",
        detail:
          "Tools can offer a generated file to download. You’ll see the file’s name and size before choosing to save it."
      },
      {
        kind: "Improved",
        title: "A clear choice for every download",
        detail:
          "Choose Download when you’re ready, or Not now to dismiss the offer and keep working."
      },
      {
        kind: "Fixed",
        title: "A better fit on small screens",
        detail: "Download offers stay within the screen and leave the tool’s content in place."
      }
    ]
  },
  {
    title: "See what’s new in Patchy",
    summary: "Catch up on the latest improvements whenever you return.",
    changes: [
      {
        kind: "New",
        title: "A little bell, a useful heads-up",
        detail:
          "The bell highlights the newest deployment. Open it for a quick summary, then choose View all updates for the full history."
      },
      {
        kind: "New",
        title: "Every update, easy to explore",
        detail:
          "Updates are listed newest first. Expand any entry to read what’s new, improved, or fixed."
      },
      {
        kind: "Improved",
        title: "Pick up where you left off",
        detail:
          "Once you open the updates page, the bell clears. The history is always there when you want to revisit it."
      }
    ]
  },
  {
    title: "Small improvements for everyday work",
    summary: "Clearer descriptions and easier navigation around your company’s tools.",
    changes: [
      {
        kind: "Improved",
        title: "Find the right tool faster",
        detail:
          "Long descriptions are easier to scan in the patch index, while the full description remains on the card."
      },
      {
        kind: "Fixed",
        title: "More room on mobile",
        detail: "Controls wrap neatly on narrow screens, with comfortable space to tap."
      }
    ]
  }
];

export function prepareActionPayload(sequence, now = Date.now()) {
  const notes = examples[Math.min(sequence - 1, examples.length - 1)];
  return {
    environment: "local-prototype",
    conclusion: "success",
    runId: `simulation-${sequence}`,
    runAttempt: 1,
    revision: `sample-${String(sequence).padStart(3, "0")}`,
    completedAt: new Date(now).toISOString(),
    // In the real Action these inputs come from the deployed PR/commit range.
    notes: structuredClone(notes)
  };
}

export function initialState() {
  return {
    generation: Date.now(),
    readThrough: 1,
    entries: [1, 2, 3].map((sequence) => ({
      sequence,
      ...prepareActionPayload(sequence, Date.now() - (4 - sequence) * 86_400_000)
    })),
    lastResult: "Three sample deployments. Two arrived since your last visit.",
    lastPayload: null
  };
}

export function recordConfirmedDeployment(state, payload) {
  if (payload.environment !== "local-prototype" || payload.conclusion !== "success") {
    return {
      ...state,
      lastResult: "No update published: deployment was not confirmed successful."
    };
  }
  const latest = state.entries.at(-1);
  if (
    state.entries.some(
      (entry) => entry.runId === payload.runId && entry.runAttempt === payload.runAttempt
    ) ||
    latest?.revision === payload.revision
  ) {
    return {
      ...state,
      lastPayload: payload,
      lastResult: "Retry completed. The same deployment still has just one entry."
    };
  }
  return {
    ...state,
    entries: [...state.entries, { sequence: (latest?.sequence ?? 0) + 1, ...payload }],
    lastPayload: payload,
    lastResult: "Deployment confirmed live. Its prepared notes are now in the update history."
  };
}
