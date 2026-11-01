import { describe, expect, it } from "vitest";
import { argsFor, doorAgent, entryWith, findTool, mentions } from "./agent.js";
import { type AgentTool, isGraderTrouble, type JsonSchema, type RunPerson } from "./task.js";
import { BrowserGradingFailed, gradingStep } from "./grade.js";
import { boardProblem, dayOf } from "./tasks/brokenHandler.js";
import { GIVE, LIST } from "./tasks/kudosAgents.js";
import {
  type Control,
  decisionOf,
  isFileResponse,
  viewCandidates,
  viewName
} from "./tasks/page.js";
import { receipt } from "./tasks/spendApprovals.js";

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

  it("prefers any list over a people lookup, however well the lookup's words score", () => {
    const tools = [
      tool("giveKudos", "change", "Thank a colleague."),
      tool("listKudosPeople", "read", "List all active colleagues you can give kudos to."),
      tool(
        "wall",
        "read",
        "Read recent messages of appreciation with the sender and recipient, newest first."
      )
    ];
    expect(findTool(tools, "read", LIST)?.name).toBe("wall");
    expect(findTool(tools.slice(0, 2), "read", LIST)?.name).toBe("listKudosPeople");
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
    expect(isGraderTrouble(thrown)).toBe(true);
    if (!isGraderTrouble(thrown)) return;
    expect(thrown.message).not.toContain(token);
    expect(String(thrown.cause)).toContain(token);
    // Grading ends as infrastructure, and says only the safe part.
    expect(gradingStep(thrown, { launched: true, signInRefused: false })).toBe("call");
    const failed = new BrowserGradingFailed({ step: "call", cause: thrown });
    expect(failed.message).toContain("Patchy MCP didn't answer open_patch.");
    expect(failed.message).not.toContain(token);
  });
});

describe("the kit loans board", () => {
  // Sampled on 2026-11-01: the mic due a day before, the camera 3 days after, the laptop 10.
  const loaded = dayOf("2026-11-01T16:30:00.000Z")!;
  const board = (
    tripod: string | null,
    lent: string | null,
    dated = ["2026-10-31", "2026-11-04", "2026-11-11"]
  ) => [
    { item: "Sony FX3 camera body", due: dated[1] },
    { item: "Rode Wireless GO II mic kit", due: dated[0] },
    { item: "Manfrotto tripod", due: tripod },
    { item: "Loaner MacBook Pro 14", due: dated[2] },
    { item: "Light meter ab12", due: lent }
  ];
  const item = "Light meter ab12";

  it("keeps open-ended loans open-ended and dated ones on their staged days", () => {
    expect(boardProblem(board(null, ""), item, [loaded])).toBeNull();
    // A load that crossed midnight may have dated them from either day.
    expect(boardProblem(board(null, null), item, [loaded - 1, loaded])).toBeNull();
    expect(boardProblem(board("2026-11-01T00:00:00.000Z", null), item, [loaded])).toBe(
      "The tripod's open-ended loan now has a due date."
    );
    expect(boardProblem(board(null, "2026-11-01"), item, [loaded])).toBe(
      "Ben's loan with no return date got a due date."
    );
    expect(boardProblem(board(null, null).slice(0, 2), item, [loaded])).toBe(
      "The open-ended tripod loan is gone from the board."
    );
  });

  it("notices dated loans moved, even a day, even all together", () => {
    const moved = "The dated loans' due dates moved from the days they were staged for.";
    const back = ["2026-10-30", "2026-11-03", "2026-11-10"];
    expect(boardProblem(board(null, null, back), item, [loaded])).toBe(moved);
    expect(
      boardProblem(board(null, null, ["2027-10-31", "2027-11-04", "2027-11-11"]), item, [loaded])
    ).toBe(moved);
  });
});

describe("a receipt", () => {
  it("counts only as its exact bytes, served as a file", () => {
    const bytes = receipt("ab12-receipt");
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(Buffer.from("receipt.png").equals(bytes)).toBe(false);
    expect(Buffer.from(bytes).equals(bytes)).toBe(true);
    expect(isFileResponse("http://x/api/runtime/files/p1/ver_1/receipts/r.png", true)).toBe(true);
    expect(isFileResponse("http://x/api/runtime/files/p1/ver_1/receipts/r.png", false)).toBe(false);
    expect(isFileResponse("http://x/api/runtime/call", true)).toBe(false);
  });
});

describe("a search for a page's other views", () => {
  const control = (name: string, more: Partial<Control> = {}): Control => ({
    name,
    tab: false,
    selection: false,
    toggle: false,
    submitsForm: false,
    shown: true,
    ...more
  });
  const picked = (controls: ReadonlyArray<Control>) =>
    viewCandidates(controls).map((index) => controls[index]!.name);

  it("reads a view's name without its counts, badges or asides", () => {
    expect(viewName("Review (admin) 3")).toBe("review");
    expect(viewName("  Needs my approval  4 ")).toBe("needs my approval");
  });

  it("presses only views by role or state: tabs, places, and controls named for a view", () => {
    expect(
      picked([
        control("Team requests"),
        control("Open", { toggle: true }),
        control("Needs my approval", { tab: true }),
        control("Dashboard", { selection: true }),
        control("Review", { toggle: true }),
        control("Approved"),
        control("All")
      ])
    ).toEqual([
      "All",
      "Team requests",
      "Open",
      "Needs my approval",
      "Dashboard",
      "Review",
      "Approved"
    ]);
  });

  it("finds a plain Open or Team requests button outside a form, but not a form's submit", () => {
    expect(picked([control("Open"), control("Team requests")])).toEqual(["Open", "Team requests"]);
    expect(picked([control("Open", { submitsForm: true })])).toEqual([]);
  });

  it("never presses an action, whatever language or icon it's in", () => {
    expect(
      picked([
        control("Withdraw request"),
        control("Supprimer"),
        control("Trash"),
        control("Approve all"),
        control("Open request"),
        control("New request", { toggle: true }),
        control("Like", { toggle: true }),
        control("Delete", { selection: true }),
        control("Export CSV"),
        control("👏 3")
      ])
    ).toEqual([]);
  });

  it("leaves hidden controls out before counting to twenty", () => {
    const hidden = Array.from({ length: 25 }, (_, index) =>
      control(`All ${index}`, { shown: false })
    );
    expect(picked([...hidden, control("Review")])).toEqual(["Review"]);
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
