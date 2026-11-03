import type { Locator, Request } from "@playwright/test";
import { argsFor, entryWith, findTool, type ToolWords } from "../agent.js";
import {
  type Agent,
  type AgentCall,
  type AgentTool,
  type CheckContext,
  type CheckOutcome,
  GraderTrouble,
  type JsonSchema,
  type Opened,
  type RunPerson,
  type Task
} from "../task.js";
import {
  type ViewMemo,
  around,
  chooseField,
  decide,
  fillRest,
  formAround,
  reveal,
  settle,
  shows
} from "./page.js";

const TITLE = /title|name|headline|what.?s (happening|wrong|broken)/i;
const IMPACT = /impact|summary|description|details?|customers?|what.*(happen|broke|see)/i;
/** Where an update is written; a note for a status change comes only after them. */
const UPDATES = [
  /update|timeline|comment|message|progress|what.?s new|what (has )?changed|what.?s happening|share/i,
  /note/i
];
const COMMANDER = /commander|incident lead|\blead\b|\bowner\b|\bic\b|responsible/i;
/**
 * What sends each form, most specific first. A Declare button in a page's
 * header shares an ancestor with every field, so an update's own Post comes
 * before anything else.
 */
const DECLARES = [/declare/i, /submit/i, /create/i, /report/i, /save/i, /send/i];
const POSTS = [/post/i, /send/i, /add/i, /submit/i, /save/i, /update/i];

/** What opens a declare form, most specific first: a nav to "Open incidents" is never one. */
const OPENERS = [/declare/i, /new incident|report (an )?incident|raise/i, /^\s*(\+|new)\s*$/i];

/** How long a colleague's open page may take to show a change without a reload. */
const LIVE_MS = 15_000;

/**
 * Makes `who` the commander where the form asks, as a person would: types
 * their name where it can be searched for, takes the suggestion naming them,
 * and picks them from a list. A form that asks nothing leaves it to the
 * patch, which makes whoever declares it the commander.
 */
const nameCommander = async (view: Opened, part: Locator, who: RunPerson) => {
  const fields = await part.getByLabel(COMMANDER).all();
  // A field labelled as a search, or a list offering "Any", filters the board beside the form.
  const tags = await Promise.all(
    fields.map((field) =>
      field
        .evaluate((element) => {
          const named = [
            element.getAttribute("aria-label"),
            ...Array.from(
              element instanceof HTMLInputElement || element instanceof HTMLSelectElement
                ? (element.labels ?? [])
                : [],
              (label) => label.textContent
            )
          ];
          const filters =
            named.some((words) => /^\s*(search|filter|find)\b/i.test(words ?? "")) ||
            (element instanceof HTMLSelectElement &&
              Array.from(element.options).some((option) => /^\s*(any|all)\b/i.test(option.text)));
          return filters ? "FILTER" : element.tagName;
        })
        .catch(() => "")
    )
  );
  for (const [index, field] of fields.entries()) {
    if (tags[index] !== "INPUT" || !(await field.isVisible().catch(() => false))) continue;
    // A person searching types a first name; the list then offers the person by their full one.
    await field.fill(who.name.split(" ")[0] ?? who.name);
    await view.page.waitForTimeout(800);
    // A suggestion list of the page's own; a native list's options are chosen below, not clicked.
    const suggested = view.frame.locator('[role="option"]:not(option)', { hasText: who.name });
    if (
      await suggested
        .first()
        .isVisible()
        .catch(() => false)
    )
      await suggested
        .first()
        .click({ timeout: 5_000 })
        .catch(() => undefined);
  }
  for (const [index, field] of fields.entries()) {
    if (tags[index] !== "SELECT" || !(await field.isVisible().catch(() => false))) continue;
    // The people to choose from can load a while after the form.
    for (let waited = 0; waited < OFFERED_MS; waited += 500) {
      const label = (await field.locator("option").allInnerTexts()).find((text) =>
        text.includes(who.name)
      );
      if (label !== undefined) {
        await field.selectOption({ label });
        break;
      }
      await view.page.waitForTimeout(500);
    }
  }
};

/** How long a form may take to offer the people a commander is chosen from. */
const OFFERED_MS = 8_000;

/** SEV2 by its name, which can run straight into its meaning ("SEV2A major feature…"). */
const SEV2 = /^\s*(sev\s*2(?!\d)|major\b)/i;

/**
 * Picks SEV2 where the form asks for a severity: a radio or a button of its
 * own first, then a list. A list offering "Any" or "All" filters the board
 * beside the form, so it's never the form's.
 */
const pickSeverity = async (part: Locator) => {
  const radio = part.getByRole("radio", { name: SEV2 }).first();
  if ((await radio.count()) > 0) {
    // A styled choice often hides its radio: check it, or press the label it sits in.
    await radio
      .check({ force: true, timeout: 2_000 })
      .catch(() => part.locator("label", { has: radio }).first().click({ timeout: 2_000 }))
      .catch(() => undefined);
    return;
  }
  const button = part.getByRole("button", { name: SEV2 }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    return;
  }
  for (const field of await part.getByLabel(/severity/i).all()) {
    if ((await field.evaluate((element) => element.tagName).catch(() => "")) !== "SELECT") continue;
    const options = await field.locator("option").allInnerTexts();
    if (options.some((text) => /^\s*(any|all)\b/i.test(text))) continue;
    const label = options.find((text) => SEV2.test(text));
    if (label !== undefined) {
      await field.selectOption({ label });
      return;
    }
  }
};

/**
 * The part of the page the form around `title` lives in: the innermost
 * ancestor of the title field that also holds a severity control, so the
 * board beside it, whose cards can be named for a severity ("SEV2 Checkout
 * failing"), is never pressed. The whole frame when there is none.
 */
const formPart = async (view: Opened, title: Locator) => {
  for (const part of (await title.locator("xpath=ancestor::*").all()).reverse()) {
    const severity = part
      .getByRole("radio", { name: SEV2 })
      .or(part.getByRole("button", { name: SEV2 }))
      .or(part.getByLabel(/severity/i));
    if ((await severity.count()) > 0) return part;
  }
  return view.frame.locator("body");
};

/** The first visible control among `candidates`, most specific first. */
const firstVisible = async (candidates: ReadonlyArray<Locator>) => {
  for (const each of candidates)
    for (const control of await each.all())
      if (await control.isVisible().catch(() => false)) return control;
  return undefined;
};

/**
 * Declares an incident called `title` the way a person would: opens the form
 * if one waits behind a button, names it, says what customers see, makes
 * `commander` its commander where the form asks, fills anything else and
 * sends it. The reason it couldn't be declared, or null once it shows.
 */
const declare = async (view: Opened, title: string, commander: RunPerson, memo: ViewMemo) => {
  const { frame, page } = view;
  // What the page sends Patchy from the press on, to tell a declaration that never left from one that hid.
  let pressed = "";
  let sent = 0;
  const count = (request: Request) => {
    if (pressed !== "" && request.url().includes("/api/runtime/call")) sent++;
  };
  page.on("request", count);
  // Declaring is deliberate, from opening the form to sending it: it reaches Patchy.
  const refused = await view.barrier.deliberately(async () => {
    let name = await chooseField(frame, TITLE);
    if (name === undefined) {
      // A button or a link: some pages open the form at a route of its own.
      const opener = await firstVisible(
        OPENERS.flatMap((words) => [
          frame.getByRole("button", { name: words }),
          frame.getByRole("link", { name: words })
        ])
      );
      if (opener === undefined) return "found no title to fill in or button to declare an incident";
      await opener.click();
      for (let waited = 0; name === undefined && waited < 5_000; waited += 500) {
        await page.waitForTimeout(500);
        name = await chooseField(frame, TITLE);
      }
    }
    if (name === undefined) return "found no title to fill in";
    await settle(view);
    await name.fill(title);
    await (await chooseField(frame, IMPACT))?.fill("Customers can't finish checking out.");
    const part = await formPart(view, name);
    await pickSeverity(part);
    await nameCommander(view, part, commander);
    let form = await formAround(frame, DECLARES);
    if (form === undefined) {
      // A send button can wait on a field nothing chose yet: fill what's around the title, then look again.
      await fillRest(name.locator("xpath=ancestor::*[.//button][1]"));
      form = await formAround(frame, DECLARES);
    }
    if (form === undefined)
      return (await frame
        .getByRole("button", { name: /declare/i })
        .last()
        .isDisabled()
        .catch(() => false))
        ? "found the button to declare it still disabled once the form was filled"
        : "found no button to declare the incident";
    await fillRest(form.scope);
    pressed = (await form.send.innerText().catch(() => "")).trim() || "send";
    await form.send.click();
    return null;
  });
  page.off("request", count);
  if (refused !== null) return refused;
  if (sent === 0) {
    // A field the browser itself holds back, such as an empty required one, says nothing on the page.
    const invalid = await frame
      .locator("input:invalid, textarea:invalid, select:invalid")
      .evaluateAll((fields) =>
        fields.map(
          (field) =>
            field.getAttribute("aria-label") ??
            field.getAttribute("name") ??
            field.getAttribute("id") ??
            field.tagName.toLowerCase()
        )
      )
      .catch(() => []);
    return `pressed ${pressed}, but the page sent Patchy nothing${invalid.length === 0 ? "" : ` (the browser held back ${invalid.join(", ")})`}`;
  }
  if (await reveal(view, title, memo)) return null;
  const said = await complaint(view);
  return `declared an incident, but it never showed up for them${said === "" ? "" : ` (the page said "${said}")`}`;
};

/** What the page says went wrong, in its alerts or error notes; empty when it says nothing. */
const complaint = async (view: Opened) =>
  (
    await view.frame
      .locator(
        '[role="alert"], [aria-invalid="true"], [class*="error"], [class*="alert"], [class*="warn"], [class*="notice"]'
      )
      .allInnerTexts()
      .catch(() => [])
  )
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join(" · ")
    .slice(0, 200);

/** `who` declares an incident from a page of their own, as its commander; the check's failure when they couldn't. */
const declared = async (ctx: CheckContext, key: string, title: string) => {
  const view = await ctx.open(key);
  const refused = await declare(view, title, ctx.person(key), {});
  await view.close();
  return refused === null
    ? null
    : ({ ok: false, reason: `${ctx.person(key).name} ${refused}.` } as const);
};

/** Opens the incident holding `title` in `view`, only looking: its timeline, wherever the page keeps it. */
const openIncident = async (view: Opened, title: string, memo: ViewMemo = {}) => {
  if (!(await reveal(view, title, memo))) return false;
  await view.frame.getByText(title).first().click();
  await view.page.waitForTimeout(1_500);
  return true;
};

/**
 * `who` posts `words` on the timeline of the incident holding `title`, from a
 * fresh page: the reason they couldn't, or null once it's sent.
 */
const postUpdate = async (ctx: CheckContext, key: string, title: string, words: string) => {
  const view = await ctx.open(key);
  const who = ctx.person(key).name;
  if (!(await openIncident(view, title))) return `${who} can't find the incident.`;
  const refused = await view.barrier.deliberately(async () => {
    let field: Locator | undefined;
    for (const words of UPDATES) field ??= await chooseField(view.frame, words);
    if (field === undefined) return `${who} found no field to post an update in.`;
    await field.fill(words);
    const form = await formAround(view.frame, POSTS);
    if (form === undefined) return `${who} found no button to post the update.`;
    await form.send.click();
    return null;
  });
  await view.close();
  return refused;
};

/**
 * A status word standing alone: a badge's text often runs into its
 * neighbours' ("SEV2investigating"), so only letters, not word boundaries,
 * mark where it ends.
 */
const status = (words: string) => new RegExp(`(?<![a-z])(?:${words})(?![a-z])`, "i");
const WORKING = status("investigating|identified|monitoring|ongoing");
const DONE = status("resolved|closed");
const OPEN = status("open|active");
/** For finding the part that shows a status: Playwright matches its `textContent`, where words run together. */
const STATUS = /investigating|identified|monitoring|resolved|closed|open|ongoing|active/i;

/**
 * Whether an incident's words say it's resolved: a working status first, so a
 * resolved tab beside an open card doesn't count, then resolved, then open;
 * undefined when they say no status at all.
 */
export const resolvedIn = (words: string) =>
  WORKING.test(words) ? false : DONE.test(words) ? true : OPEN.test(words) ? false : undefined;

/**
 * Shows every incident where a list filter chooses which (a select offering
 * Open beside All or Resolved), as a person looking for a closed one would.
 * Buttons and tabs are `reveal`'s; choosing a filter only reads.
 */
const showEveryIncident = async (view: Opened) => {
  for (const field of await view.frame.locator("select").all()) {
    if (!(await field.isVisible().catch(() => false))) continue;
    const options = await field.locator("option").allInnerTexts();
    if (!options.some((text) => OPEN.test(text))) continue;
    const every =
      options.find((text) => /^\s*all\b/i.test(text)) ?? options.find((text) => DONE.test(text));
    if (every === undefined) continue;
    await field.selectOption({ label: every });
    await view.page.waitForTimeout(1_000);
    return true;
  }
  return false;
};

/**
 * Whether Marcus sees the incident holding `title` resolved, from a fresh
 * page and wherever its views keep resolved ones; undefined when he can't
 * find it, or it shows no status.
 */
const marcusSeesResolved = async (ctx: CheckContext, title: string, memo: ViewMemo) => {
  const marcus = await ctx.open("marcus");
  const found =
    (await reveal(marcus, title, memo)) ||
    ((await showEveryIncident(marcus)) && (await shows(marcus, title, 5_000)));
  const part = around(marcus.frame, title, { hasText: STATUS });
  const seen = found && (await part.count()) > 0 ? resolvedIn(await part.innerText()) : undefined;
  await marcus.close();
  return seen;
};

/** Patchy's codes for a patch's handler failing on a try: the patch's answer, never expected. */
const PATCH_FAILED = new Set(["handler_failed", "handler_timeout"]);

/**
 * Jordan, the commander, resolves the incident holding `title`. Every call his
 * press sends Patchy is held back in turn while each of `others` sends the
 * same call from their own page, and Marcus must see the incident just as
 * before each try. Each refusal a try draws is the check's own. The check
 * passes once Marcus sees it resolved right after one of Jordan's held calls
 * goes through.
 */
const onlyTheCommanderResolves = async (
  ctx: CheckContext,
  title: string,
  others: ReadonlyArray<string>
): Promise<CheckOutcome> => {
  const marcusWay: ViewMemo = {};
  const before = await marcusSeesResolved(ctx, title, marcusWay);
  if (before === undefined)
    return { ok: false, reason: "Marcus can't find the incident, or its status, on the page." };
  if (before)
    return { ok: false, reason: "The incident shows resolved before anyone resolved it." };
  const jordan = await ctx.open("jordan");
  // `decide` opens the incident itself when its card holds no resolve button.
  if (!(await reveal(jordan, title)))
    return { ok: false, reason: "Jordan can't find the incident they declared." };
  let seen: boolean | undefined = before;
  const pressed = await decide(jordan, title, "resolve", {
    probe: async (call) => {
      seen = await marcusSeesResolved(ctx, title, marcusWay);
      if (seen === true)
        return "The incident was resolved before Jordan's last call: his resolve went through something the grader couldn't hold, so it couldn't try it as anyone else.";
      for (const key of others) {
        const view = await ctx.open(key);
        const answer = await call.tryAs(view, ctx.person(key));
        await view.close();
        // Patchy's own gate refusing them (a guest calling a handler not marked for guests) is a
        // refusal like the handler's; anything else Patchy says isn't about the patch.
        if (
          !answer.ok &&
          !answer.byHandler &&
          !PATCH_FAILED.has(answer.code) &&
          answer.code !== "access_denied"
        )
          throw new GraderTrouble({
            what: `Patchy itself refused the grader's try as ${ctx.person(key).name} (${answer.code}).`
          });
        const after = await marcusSeesResolved(ctx, title, marcusWay);
        if (after !== seen)
          return `${ctx.person(key).name} sent Jordan's resolve call${call.handler === null ? "" : ` (${call.handler})`} as their own, ${answer.ok ? "and" : "and was refused, but"} the incident then showed ${after === true ? "resolved" : "differently"}.`;
        if (!answer.ok && answer.byHandler && call.handler !== null)
          ctx.expectRefusal({
            person: key,
            handler: call.handler,
            code: answer.code,
            at: answer.at
          });
      }
      return null;
    },
    took: async () => (seen = await marcusSeesResolved(ctx, title, marcusWay)) === true
  });
  if (pressed === null)
    return { ok: false, reason: "Jordan, its commander, found no way to resolve the incident." };
  if (pressed.objection !== null) return { ok: false, reason: pressed.objection };
  await jordan.close();
  if (pressed.took) return { ok: true };
  return {
    ok: false,
    reason:
      pressed.held === 0
        ? "Jordan's resolve sent Patchy nothing, and the incident still shows open."
        : "Jordan's resolve never took effect through a call the grader could try as someone else: Marcus doesn't see it resolved."
  };
};

const INCIDENT = /incident|outage|\binc\b/i;
/** The tools to declare an incident and post on its timeline. */
export const DECLARE: ToolWords = {
  about: INCIDENT,
  does: /declare|create|open|report|raise|start|new/i,
  not: /update|status|severity|commander|resolve|close|list|get|find/i
};
export const POST: ToolWords = {
  about: /update|timeline|note|comment/i,
  does: /post|add|write|update/i,
  not: /status|severity|commander|resolve|close|declare|create|list|get|find/i
};
export const LIST: ToolWords = {
  about: INCIDENT,
  does: /list|open|recent|all|search|board/i,
  not: /people|person|member|colleague|timeline|update|entr/i
};

/** A tool named for closing an incident; its description saying it can't is no such tool. */
const CLOSES = /resolve|close/i;

/** A value an agent would give for a SEV1: the most severe of an enum, or 1 for a number. */
const SEV1 = /sev.?1|critical|p0|urgent|highest/i;
const SEVERITY_FIELD = /sev|severity|priority|impact.?level/i;
const REF_FIELD = /incident|number|^id$|ref|key/i;

const props = (schema: JsonSchema) => Object.entries(schema.properties ?? {});
const valueOf = (schema: JsonSchema) =>
  schema.anyOf?.find((option) => option.type !== "null") ?? schema;

/** `args` with every severity a SEV1, where the schema says how severity goes. */
const asSev1 = (schema: JsonSchema, args: Record<string, unknown>) => {
  const out = { ...args };
  for (const [field, property] of props(schema)) {
    const value = valueOf(property);
    const sev1 = value.enum?.find((option) => SEV1.test(option));
    if (sev1 !== undefined) out[field] = sev1;
    else if (!SEVERITY_FIELD.test(field) || value.enum !== undefined) continue;
    // A plain integer carries the safe-integer bounds, so 1 is clamped into them, never taken from them.
    else if (value.type === "integer" || value.type === "number")
      out[field] = Math.min(Math.max(1, value.minimum ?? 1), value.maximum ?? Infinity);
    else if (value.type === "string") out[field] = "sev1";
  }
  return out;
};

/** The ways a tool's answer names the incident it made or read: ids, refs and numbers, shallowest first. */
export const incidentRefs = (result: unknown, depth = 0): ReadonlyArray<string | number> => {
  if (typeof result === "string")
    return [
      ...(/^[\w-]{4,64}$/.test(result) ? [result] : []),
      ...(result.match(/\bINC-\d+\b/gi) ?? []),
      ...[...result.matchAll(/\bINC-(\d+)\b/gi)].map((match) => Number(match[1]))
    ];
  if (depth > 2 || typeof result !== "object" || result === null) return [];
  const own = Object.entries(result).flatMap(([key, value]) =>
    /^(id|incidentid|number|ref|key|incident)$/i.test(key) &&
    (typeof value === "string" || typeof value === "number")
      ? [value]
      : []
  );
  const nested = Object.values(result).flatMap((value) => incidentRefs(value, depth + 1));
  const numbers = own.flatMap((value) =>
    typeof value === "string" && /\d+$/.test(value) ? [Number(/(\d+)$/.exec(value)![1])] : []
  );
  return [...new Set([...own, ...numbers, ...nested])];
};

/** Argument sets naming the incident `refs` name, in each way the tool's reference fields take. */
const naming = (
  schema: JsonSchema,
  base: ReadonlyArray<Record<string, unknown>>,
  refs: ReadonlyArray<string | number>
) => {
  const fields = props(schema).filter(([field]) => REF_FIELD.test(field));
  if (fields.length === 0) return base;
  return base.flatMap((args) =>
    refs.flatMap((ref) => {
      const named = { ...args };
      for (const [field, property] of fields) {
        const type = valueOf(property).type;
        if ((type === "integer" || type === "number") && typeof ref !== "number") return [];
        if (type === "string" && typeof ref !== "string") return [];
        named[field] = ref;
      }
      return [named];
    })
  );
};

const refusal = (answer: Extract<AgentCall, { ok: false }>) =>
  `${answer.code}: ${answer.message.split("\n")[0]}`;

/** Calls `tool` with each of `variants` until one isn't refused: that answer, or every refusal. */
const firstAnswered = async (
  agent: Agent,
  tool: AgentTool,
  variants: ReadonlyArray<Record<string, unknown>>
) => {
  const refused: Array<string> = [];
  for (const args of variants.slice(0, 12)) {
    const answer = await agent.call(tool, args);
    if (answer.ok) return { ok: true, result: answer.result } as const;
    refused.push(refusal(answer));
  }
  return { ok: false, refused: [...new Set(refused)] } as const;
};

/**
 * A live incident room with rules no page can keep alone: only the
 * commander or an admin resolves, a guest from another company works an
 * incident but never resolves one, and people's agents declare and update
 * incidents but never resolve a SEV1. The reference task for how far a
 * single request can push Patchy: tier 2 handlers, live queries, the
 * member directory, files, guests and an agent area at once.
 */
export default {
  id: "war-room",
  scenario: "brightline",
  words:
    "Make us a war room for when production breaks. Anyone can declare an incident with a title, a severity (SEV1 when customers can't use the product, SEV2 when a major feature is broken or slow, SEV3 for anything minor) and what customers are seeing, and pick an incident commander. Everyone works it on one shared timeline that updates live for whoever's watching: updates, status changes (investigating, identified, monitoring), severity changes and screenshots attached as evidence, with a clock running from when it was declared. Only the incident's commander or an admin can resolve it, writing down the root cause, and then anyone can download a postmortem. Resolved incidents stay findable. Taylor at Cedar Works ({email:taylor}), our client, should be able to use it fully, except for resolving incidents. People's agents should be able to see what's open, declare incidents and post updates through Patchy, but never resolve a SEV1: a person has to close those. Publish it.",
  target: { create: "repo" },
  tier: 2,
  minutes: 60,
  heldOut: false,
  rubric: [
    "Tier 2: who may resolve (the commander or an admin), what a guest may do and what an agent may do are rules kept against the viewer, which only server handlers can do.",
    "Owned tables: incidents (a unique, increasing number shown as a ref like INC-12, title, severity, status, an open flag, customer impact, the commander as a member, who declared it from `ctx.viewer` and through which agent, and when each status was first reached), an append-only timeline of entries (kind, words, author from the viewer, the agent when one wrote it), and evidence in an owned file store. The board reads incidents, not every timeline.",
    "Mutations to declare, post an update, change status or severity, hand over command and resolve, each validating its input and refusing with declared errors; a status or severity change writes its timeline entry in the same transaction. Resolving needs a root cause and the commander or an admin. Live queries feed the board and the timeline.",
    "Guests: the handlers a guest needs are marked `guest: true` and resolving isn't; the patch is shared with Taylor. Commanders are chosen from the member directory.",
    "An agent area (`agent/`) with tools to list and read incidents, find people, declare, post updates and change status; resolving refuses a SEV1 with a declared error saying a person has to close it. Agent writes record the agent. Tools share the page's rules (shared helpers) rather than copying them.",
    "Evidence images served from the file store, a postmortem download built from the timeline, the clock, clear empty states, the company look, and a layout that works on a phone. No extra dependencies."
  ].join("\n"),
  checks: [
    {
      name: "an incident Jordan declares and updates reaches Marcus live",
      run: async (ctx) => {
        const title = `Checkout failing ${ctx.code}`;
        // Marcus is watching from before it exists: what he sees comes without a reload.
        const marcus = await ctx.open("marcus");
        const refused = await declared(ctx, "jordan", title);
        if (refused !== null) return refused;
        if (!(await shows(marcus, title, LIVE_MS)))
          return {
            ok: false,
            reason: (await reveal(marcus, title))
              ? "Marcus sees Jordan's incident only once he switches views: the board Marcus had open didn't show it live."
              : "Marcus never sees the incident Jordan declared."
          };
        if (!(await openIncident(marcus, title)))
          return { ok: false, reason: "Marcus can't open Jordan's incident." };
        const words = `Rolled back the bad deploy ${ctx.code}`;
        const posted = await postUpdate(ctx, "jordan", title, words);
        if (posted !== null) return { ok: false, reason: posted };
        return (await shows(marcus, words, LIVE_MS))
          ? { ok: true }
          : {
              ok: false,
              reason:
                "Jordan posted an update, but Marcus, watching the incident, never saw it arrive."
            };
      }
    },
    {
      name: "only the commander or an admin resolves an incident",
      run: async (ctx) => {
        const title = `Search is slow ${ctx.code}`;
        const refused = await declared(ctx, "jordan", title);
        if (refused !== null) return refused;
        // Sofia is a member who isn't its commander.
        return onlyTheCommanderResolves(ctx, title, ["sofia"]);
      }
    },
    {
      name: "Taylor, a guest from Cedar Works, works an incident but can't resolve it",
      run: async (ctx) => {
        const title = `Client portal down ${ctx.code}`;
        const refused = await declared(ctx, "jordan", title);
        if (refused !== null) return refused;
        const opened = await ctx.open("taylor").then(
          async (view) => {
            await view.close();
            return null;
          },
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
        if (opened !== null)
          return {
            ok: false,
            reason: `Taylor, a guest at Cedar Works, can't use the patch (${opened}): it has to be shared with them.`
          };
        const words = `Cedar's login page shows a 502 ${ctx.code}`;
        const posted = await postUpdate(ctx, "taylor", title, words);
        if (posted !== null) return { ok: false, reason: posted };
        const marcus = await ctx.open("marcus");
        const seen = (await openIncident(marcus, title)) && (await shows(marcus, words));
        await marcus.close();
        if (!seen)
          return {
            ok: false,
            reason: "Taylor posted an update, but Marcus doesn't see it on the incident."
          };
        return onlyTheCommanderResolves(ctx, title, ["taylor"]);
      }
    },
    {
      name: "Jordan's agent declares and updates a SEV1, but can't resolve it",
      agents: ["jordan"],
      run: async (ctx) => {
        const agent = ctx.agent("jordan");
        const tools = await agent.tools();
        const declareTool = findTool(tools, "change", DECLARE);
        const postTool = findTool(tools, "change", POST);
        if (declareTool === undefined || postTool === undefined) {
          const named = tools.map((tool) => `${tool.name} (${tool.kind})`).join(", ") || "none";
          return {
            ok: false,
            reason: `Its tools are ${named}; it needs one to declare an incident and one to post an update.`
          };
        }
        const title = `Payments API erroring ${ctx.code}`;
        const jordan = ctx.person("jordan");
        const made = await firstAnswered(
          agent,
          declareTool,
          argsFor(declareTool.args, { person: jordan, text: title }).map((args) =>
            asSev1(declareTool.args, args)
          )
        );
        if (!made.ok)
          return {
            ok: false,
            reason: `${declareTool.name} was refused (${made.refused.join("; ") || "no arguments to give"}).`
          };
        // An agent that isn't told which incident it made finds it by its title, as an agent would.
        let refs = incidentRefs(made.result);
        // Only a list that needs nothing: a call the schema refuses would count against the patch.
        const list = findTool(
          tools.filter((tool) => (tool.args.required ?? []).length === 0),
          "read",
          LIST
        );
        if (list !== undefined) {
          const listed = await agent.call(list, argsFor(list.args, {})[0] ?? {});
          const entry = listed.ok ? entryWith(listed.result, title) : undefined;
          refs = [...new Set([...refs, ...incidentRefs(entry)])];
        }
        const marcus = await ctx.open("marcus");
        if (!(await reveal(marcus, title)))
          return { ok: false, reason: "Marcus doesn't see the incident Jordan's agent declared." };
        const words = `Agent: error rate is back under 1% ${ctx.code}`;
        const posted = await firstAnswered(
          agent,
          postTool,
          naming(postTool.args, argsFor(postTool.args, { text: words }), refs)
        );
        if (!posted.ok)
          return {
            ok: false,
            reason: `${postTool.name} was refused (${posted.refused.join("; ") || "no arguments to give"}).`
          };
        if (!((await openIncident(marcus, title)) && (await shows(marcus, words, LIVE_MS))))
          return {
            ok: false,
            reason: "Jordan's agent posted an update, but Marcus doesn't see it on the incident."
          };
        // Every way the agent might close it: a resolve tool, and a status tool that offers resolved.
        const closers = tools.filter(
          (tool) =>
            tool.kind === "change" &&
            ((CLOSES.test(tool.name) && !/reopen/i.test(tool.name)) ||
              props(tool.args).some(([, property]) =>
                valueOf(property).enum?.some((option) => /resolved|closed/i.test(option))
              ))
        );
        for (const tool of closers) {
          const variants = naming(
            tool.args,
            argsFor(tool.args, { text: "Rolled back the bad deploy." }),
            refs
          ).map((args) => {
            const closing = { ...args };
            for (const [field, property] of props(tool.args)) {
              const resolved = valueOf(property).enum?.find((option) =>
                /resolved|closed/i.test(option)
              );
              if (resolved !== undefined) closing[field] = resolved;
            }
            return closing;
          });
          const closed = await firstAnswered(agent, tool, variants);
          if (closed.ok)
            return {
              ok: false,
              reason: `Jordan's agent resolved a SEV1 through ${tool.name}; a person has to close those.`
            };
        }
        await marcus.close();
        return {
          ok: true,
          note:
            closers.length === 0
              ? "it has no tool that resolves incidents"
              : `refused: ${closers.map((tool) => tool.name).join(", ")}`
        };
      }
    }
  ]
} satisfies Task;
