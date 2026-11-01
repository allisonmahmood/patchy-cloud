import { describe, expect, it } from "vitest";
import { argsFor, entryWith, findTool, mentions } from "./agent.js";
import type { AgentTool, JsonSchema, RunPerson } from "./task.js";
import { GIVE, LIST } from "./tasks/kudosAgents.js";
import { decisionOf } from "./tasks/page.js";

const priya: RunPerson = {
  id: "usr_env_brightline-ab12cd_priya",
  key: "priya",
  name: "Priya Shah",
  email: "priya+ab12cd@brightline.example",
  role: "member"
};

const text: JsonSchema = { type: "string" };
const tool = (name: string, kind: AgentTool["kind"], description = ""): AgentTool => ({
  name,
  kind,
  description,
  args: { type: "object" }
});

describe("an agent's arguments", () => {
  it("names a colleague every way, the member id first, and says the words", () => {
    const give: JsonSchema = {
      type: "object",
      properties: {
        recipient: text,
        value: { type: "string", enum: ["craft", "teamwork"] },
        message: text
      },
      required: ["recipient", "value", "message"]
    };
    expect(argsFor(give, { person: priya, text: "Thanks" })).toEqual(
      [priya.id, priya.email, priya.name].map((recipient) => ({
        recipient,
        value: "craft",
        message: "Thanks"
      }))
    );
  });

  it("names a colleague the way the field asks first", () => {
    const byEmail: JsonSchema = {
      type: "object",
      properties: { to: { type: "string", description: "Their work email." } },
      required: ["to"]
    };
    expect(argsFor(byEmail, { person: priya })[0]).toEqual({ to: priya.email });
    const byName: JsonSchema = {
      type: "object",
      properties: { recipientName: text },
      required: ["recipientName"]
    };
    expect(argsFor(byName, { person: priya })[0]).toEqual({ recipientName: priya.name });
  });

  it("leaves optional fields out and fills required ones plainly", () => {
    const list: JsonSchema = {
      type: "object",
      properties: {
        recipient: { anyOf: [text, { type: "null" }] },
        limit: { type: "integer", minimum: 1, maximum: 25 },
        newestFirst: { type: "boolean" },
        cursor: text
      },
      required: ["recipient", "limit", "newestFirst"]
    };
    expect(argsFor(list, {})).toEqual([{ recipient: null, limit: 25, newestFirst: false }]);
  });
});

describe("an agent's tools and answers", () => {
  const tools = [
    tool("listPeople", "read", "Active colleagues."),
    tool("recent", "read", "The newest kudos, newest first."),
    tool("react", "change", "Adds an emoji to a kudos."),
    tool("giveKudos", "change", "Thanks a colleague.")
  ];

  it("picks a tool by its name, then its description, the most telling words first", () => {
    expect(findTool(tools, "read", [/kudo/i, /list|recent/i])?.name).toBe("recent");
    expect(findTool(tools, "change", [/kudo|give/i, /add|send/i])?.name).toBe("giveKudos");
    expect(findTool(tools.slice(0, 1), "read", [/kudo/i])?.name).toBe("listPeople");
    expect(findTool(tools, "read", [/standup/i])).toBeUndefined();
  });

  it("tells kudos-agents' tools from a people lookup named for kudos", () => {
    const built = [
      tool("findKudosPeople", "read", "Find colleagues to give kudos to."),
      tool("giveKudos", "change", "Thank a colleague."),
      tool("listKudos", "read", "List the studio's kudos, newest first.")
    ];
    expect(findTool(built, "read", LIST)?.name).toBe("listKudos");
    expect(findTool(built, "change", GIVE)?.name).toBe("giveKudos");
    expect(findTool([tool("wall", "read"), tool("people", "read")], "read", LIST)?.name).toBe(
      "wall"
    );
  });

  it("finds the entry holding words, however the list around it is shaped", () => {
    const entry = { id: "k2", recipient: { name: "Priya Shah" }, message: "Thanks ab12" };
    expect(entryWith({ kudos: [{ id: "k1", message: "Other" }, entry], next: null }, "ab12")).toBe(
      entry
    );
    expect(entryWith([entry], "zz99")).toBeUndefined();
    expect(mentions(entry, priya)).toBe(true);
    expect(mentions({ recipient: priya.id }, priya)).toBe(true);
    expect(mentions({ recipient: "usr_other" }, priya)).toBe(false);
  });
});

describe("a request's decision", () => {
  it("reads approved, rejected, undecided or nothing from the words around it", () => {
    expect(decisionOf("Team lunch · $42 · Approved by Ada")).toBe("approved");
    expect(decisionOf("Team lunch · Declined")).toBe("rejected");
    expect(decisionOf("Team lunch · Pending\nApprove Reject")).toBe("undecided");
    expect(decisionOf("Team lunch · not yet approved")).toBe("undecided");
    expect(decisionOf("Team lunch · $42")).toBeNull();
  });
});
