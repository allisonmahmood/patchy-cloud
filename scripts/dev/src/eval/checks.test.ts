import { describe, expect, it } from "vitest";
import { argsFor, doorAgent, entryWith, findTool, mentions } from "./agent.js";
import type { AgentTool, JsonSchema, RunPerson } from "./task.js";
import { boardProblem } from "./tasks/brokenHandler.js";
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

  it("knows a person by a field's description when its name says nothing", () => {
    const give: JsonSchema = {
      type: "object",
      properties: {
        id: { type: "string", description: "The recipient's active colleague member id." },
        message: { type: "string", description: "What to tell the recipient." }
      },
      required: ["id", "message"]
    };
    expect(argsFor(give, { person: priya, text: "Thanks" })[0]).toEqual({
      id: priya.id,
      message: "Thanks"
    });
  });

  it("names a person inside an object about them, each field as it asks", () => {
    const give: JsonSchema = {
      type: "object",
      properties: {
        recipient: {
          type: "object",
          properties: { email: text, ref: text },
          required: ["email"]
        },
        note: { anyOf: [text, { type: "null" }] }
      },
      required: ["recipient"]
    };
    expect(argsFor(give, { person: priya, text: "Thanks" })).toEqual(
      [priya.id, priya.email, priya.name].map((ref) => ({
        recipient: { email: priya.email, ref },
        note: "Thanks"
      }))
    );
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

  it("picks the tool that means what's asked, kudos before a bare verb", () => {
    expect(findTool(tools, "read", LIST)?.name).toBe("recent");
    expect(findTool(tools, "change", GIVE)?.name).toBe("giveKudos");
    expect(findTool(tools.slice(0, 1), "read", LIST)?.name).toBe("listPeople");
    expect(findTool(tools, "read", { about: /standup/i, does: /summarize/i })).toBeUndefined();
  });

  it("tells kudos-agents' tools from a people lookup, whatever either is named", () => {
    const terra = [
      tool("findKudosPeople", "read", "Find colleagues to give kudos to."),
      tool("giveKudos", "change", "Thank a colleague."),
      tool("listKudos", "read", "List the studio's kudos, newest first.")
    ];
    expect(findTool(terra, "read", LIST)?.name).toBe("listKudos");
    expect(findTool(terra, "change", GIVE)?.name).toBe("giveKudos");
    const generic = [
      tool("getKudos", "read", "Returns recent kudos, newest first."),
      tool("listPeople", "read", "Active colleagues to give kudos to."),
      tool("giveKudos", "change", "Thank a colleague.")
    ];
    expect(findTool(generic, "read", LIST)?.name).toBe("getKudos");
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

describe("an agent's door", () => {
  it("never puts the bearer in a thrown message, only in its cause", async () => {
    const token = "pmcp_live_secret_token";
    const agent = doorAgent({
      request: {
        post: async () => {
          throw new Error(`connect ECONNREFUSED; headers: authorization: Bearer ${token}`);
        }
      },
      apiUrl: "http://127.0.0.1:1",
      token,
      patch: "p1",
      keys: "k"
    });
    const thrown = await agent.tools().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).not.toContain(token);
    expect(String((thrown as Error).cause)).toContain(token);
  });
});

describe("the kit loans board", () => {
  const board = (tripod: string | null, lent: string | null, mic = "2026-10-31") => [
    { item: "Sony FX3 camera body", due: "2026-11-04" },
    { item: "Rode Wireless GO II mic kit", due: mic },
    { item: "Manfrotto tripod", due: tripod },
    { item: "Loaner MacBook Pro 14", due: "2026-11-11" },
    { item: "Light meter ab12", due: lent }
  ];

  it("keeps open-ended loans open-ended and dated ones where they were", () => {
    expect(boardProblem(board(null, ""), "Light meter ab12")).toBeNull();
    expect(boardProblem(board("2026-11-01T00:00:00.000Z", null), "Light meter ab12")).toBe(
      "The tripod's open-ended loan now has a due date."
    );
    expect(boardProblem(board(null, "2026-11-01"), "Light meter ab12")).toBe(
      "Ben's loan with no return date got a due date."
    );
    expect(boardProblem(board(null, null, "2026-11-01"), "Light meter ab12")).toBe(
      "The dated loans' due dates moved."
    );
    expect(boardProblem(board(null, null).slice(0, 2), "Light meter ab12")).toBe(
      "The open-ended tripod loan is gone from the board."
    );
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
