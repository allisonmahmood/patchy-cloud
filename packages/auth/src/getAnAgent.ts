import { linkButton, productMark, row, rows } from "@patchy/core";

/** The common agents that build patches, each linking to its maker's own page for it. */
const common = [
  {
    name: "Claude Code",
    mark: { logo: "claude" },
    description: "Anthropic’s agent, in your terminal or desktop app",
    href: "https://claude.com/product/claude-code"
  },
  {
    name: "Codex",
    mark: { logo: "openai" },
    description: "OpenAI’s agent, in your terminal or its app",
    href: "https://openai.com/codex/"
  },
  {
    name: "Cursor",
    mark: { logo: "cursor" },
    description: "A code editor with an agent built in",
    href: "https://cursor.com/"
  }
] as const;

/**
 * For someone with no agent yet: the common ones and where to get each, then what to do once one
 * is installed. One set of words wherever it's offered: Add a computer opens it as its Get an
 * agent dialog's body, and the Final step, already a dialog, as a `disclosure` under "No agent
 * yet?".
 */
export const getAnAgent = `<p class="prose">Patchy works with any agent that can run commands on your computer. If you don’t have one, these are the common ones.</p>${rows(
  common.map((agent) =>
    row({
      lead: productMark(agent.mark),
      name: agent.name,
      description: agent.description,
      end: linkButton("Get it", agent.href, {
        size: "sm",
        icon: "external",
        newTab: true,
        ariaLabel: `Get ${agent.name}`
      })
    })
  ),
  true
)}<p class="meta">Install one, then give it the setup line. It does the rest.</p>`;
