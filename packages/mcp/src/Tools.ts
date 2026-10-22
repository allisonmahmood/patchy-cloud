/**
 * What every worker agent is shown first: the door's four fixed tools, which disclose a
 * company's patches progressively, and the instructions naming who the agent acts for
 * (docs/product.md › The door › What a client learns first). The tool list is identical for
 * everyone, so it carries the loop in its descriptions for clients that skip instructions.
 */
import { type JsonSchema, type ToolCallResult, toolRefusal } from "@patchy/api";

/** The door's tool names, in the order `tools/list` shows them. */
export const NAMES = ["find_patches", "open_patch", "read_patch", "change_patch"] as const;
export type Name = (typeof NAMES)[number];

export const isName = (name: string): name is Name => NAMES.some((known) => known === name);

/** A tool as `tools/list` shows it. */
export interface Tool {
  readonly name: Name;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema & { readonly type: "object" };
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
}

const patch: JsonSchema = {
  type: "string",
  description:
    "The patch's name as find_patches lists it, its id, or its address. Another company's address is never found."
};
const tool: JsonSchema = { type: "string", description: "The tool's name, from open_patch." };
const args: JsonSchema & { readonly type: "object" } = {
  type: "object",
  description: "The tool's arguments, as its schema in open_patch describes them. {} for none."
};

export const tools: readonly Tool[] = [
  {
    name: "find_patches",
    title: "Find patches",
    description:
      "List the company's patches (its internal tools) that the person you act for can open: each one's name, description, owner, address and agent tools, patches with tools first. Then open_patch one to see what its tools do and take. search matches words in names, titles, descriptions and owners; cursor continues from next; detail: \"tools\" adds each tool's kind and description.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Words to look for. Leave it out to list all." },
        cursor: { type: "string", description: "The next of a previous answer, to continue." },
        detail: {
          type: "string",
          enum: ["tools"],
          description: "tools adds each tool's kind and description."
        }
      },
      required: [],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "open_patch",
    title: "Open a patch",
    description:
      "Open one patch to see its agent tools: what each does, whether it reads or changes, the JSON arguments it takes and what it returns. Call it before read_patch or change_patch, and again when a call says the patch changed. You reach only the tools its builder added for agents; when what the person wants isn't one, say so and name the patch's owner.",
    inputSchema: {
      type: "object",
      properties: { patch },
      required: ["patch"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "read_patch",
    title: "Read from a patch",
    description:
      'Run one of a patch\'s read tools (kind "read" in open_patch) as the person you act for. A read never changes anything.',
    inputSchema: {
      type: "object",
      properties: { patch, tool, args },
      required: ["patch", "tool", "args"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "change_patch",
    title: "Change a patch",
    description:
      'Run one of a patch\'s change tools (kind "change" in open_patch) as the person you act for. Colleagues see the change live, and it is logged as them via you. Give each change you mean to make a fresh key and reuse it only to retry that change, so a retry never applies it twice. When a change may have partly happened, read before trying again with a new key.',
    inputSchema: {
      type: "object",
      properties: {
        patch,
        tool,
        args,
        key: {
          type: "string",
          description: "Your name for this one change: fresh for each change, the same on a retry."
        }
      },
      required: ["patch", "tool", "args", "key"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }
];

/** The most characters of a name the instructions carry, so they stay under 512. */
const NAME_LIMIT = 64;

const cut = (name: string) =>
  [...name].length > NAME_LIMIT ? `${[...name].slice(0, NAME_LIMIT - 1).join("")}…` : name;

/**
 * What a connection is told first, under 512 characters: who it acts for and at which company,
 * the loop, that it reaches only what builders added, and that every change is logged.
 */
export const instructions = (identity: {
  readonly user: { readonly name: string; readonly email: string };
  readonly company: { readonly name: string };
}): string => {
  const person = cut(identity.user.name.trim() === "" ? identity.user.email : identity.user.name);
  const company = cut(identity.company.name);
  return `You act for ${person} at ${company} through Patchy, where the company's internal tools are patches. find_patches lists the ones they can open, open_patch shows one's tools, then read_patch runs a read and change_patch a change. You reach only the tools each patch's builder added for agents; when one is missing, say so and name the patch's owner. Every change you make is logged as them, via you.`;
};

/** A tool the door lists before it is built: a refusal, so nothing is read or changed. */
export const notBuilt = (name: Name): ToolCallResult =>
  toolRefusal({
    code: "not_built",
    from: "patchy",
    message: `${name} isn't built on this instance yet, so nothing was read or changed. Tell the person Patchy's MCP isn't ready here.`
  });

/** "Ada", "Ada and Ben", "Ada, Ben and Cleo". */
const listed = (names: readonly string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Every tool call's refusal while the company's agent access is off: where an admin turns it
 * on, and the active admins by name, never anything else about them.
 */
export const agentAccessOff = (off: {
  readonly company: string;
  readonly admins: readonly string[];
  readonly turnOnAt: string;
}): ToolCallResult =>
  toolRefusal({
    code: "agent_access_off",
    from: "patchy",
    message: `Agent access is off at ${off.company}, so Patchy refuses every agent until an admin turns it on at ${off.turnOnAt}.${off.admins.length === 0 ? " Tell the person." : ` ${off.company}'s admins are ${listed(off.admins)}; tell the person to ask one of them.`}`
  });
