import type { ConsoleMessage, Locator, Request } from "@playwright/test";
import type { CheckContext, CheckOutcome, Opened, Task } from "../task.js";
import { chooseField, fillRest, formAround, reveal, settle, shows, visibleText } from "./page.js";

/** A recipe a check adds. Its last step is the words that tell its page from any other's. */
interface Recipe {
  readonly title: string;
  readonly ingredients: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<string>;
}

const lastStep = (recipe: Recipe) => recipe.steps.at(-1)!;

/** What a recipe's own fields go by; a title is looked for by name before by "recipe". */
const TITLES = [/title|name|dish|called/i, /recipe/i];
const INGREDIENTS = /ingredient|you.?ll need|you need/i;
const STEPS = /step|instruction|method|direction|how to|preparation/i;
/** What opens a recipe form; never a share or copy control on a recipe already there. */
const OPENERS = [/\b(add|new|create|write)\b.*\brecipe/i, /^\s*(\+|new|add)\s*$/i];
/** What saves one, most specific first; an "Add ingredient" or "Add step" never does. */
const SAVES = [
  /\b(save|add|create|submit|publish|post)\b.*\brecipe/i,
  /^\s*(save|submit|create|publish|post|done)\b/i,
  /^\s*\+?\s*add\s*$/i
];

/** The first visible control among `candidates`, most specific first. */
const firstVisible = async (candidates: ReadonlyArray<Locator>) => {
  for (const each of candidates)
    for (const control of await each.all())
      if (await control.isVisible().catch(() => false)) return control;
  return undefined;
};

const chooseTitle = async (view: Opened) => {
  for (const words of TITLES) {
    const field = await chooseField(view.frame, words);
    if (field !== undefined) return field;
  }
  return undefined;
};

/** Types a list as the field takes it: a line each in a text area, or one line. */
const fillList = async (field: Locator, items: ReadonlyArray<string>, joiner: string) => {
  const lines = await field
    .evaluate((element) => element instanceof HTMLTextAreaElement)
    .catch(() => false);
  await field.fill(items.join(lines ? "\n" : joiner));
};

/**
 * Adds `recipe` the way a person would: opens the form if one waits behind a
 * button, writes the title, the ingredients and the steps, fills anything
 * else the form asks for and saves it. The reason it couldn't be added, or
 * null once its adder sees it in the book.
 */
const add = async (view: Opened, recipe: Recipe) => {
  const { frame, page } = view;
  // What the page sends Patchy from the press on, to tell a recipe that never left from one that hid.
  let pressed = "";
  let sent = 0;
  // A frame's sandbox has no `allow-forms`: the browser drops a native submission, saying so only in the console.
  let blocked = false;
  const count = (request: Request) => {
    if (pressed !== "" && request.url().includes("/api/runtime/") && request.method() === "POST")
      sent++;
  };
  const read = (message: ConsoleMessage) => {
    if (/blocked form submission/i.test(message.text())) blocked = true;
  };
  page.on("request", count);
  page.on("console", read);
  // Adding is deliberate, from opening the form to saving it: it reaches Patchy.
  const refused = await view.barrier
    .deliberately(async () => {
      let title = await chooseTitle(view);
      if (title === undefined) {
        // A button or a link: some pages open the form at a route of its own.
        const opener = await firstVisible(
          OPENERS.flatMap((name) => [
            frame.getByRole("button", { name }),
            frame.getByRole("link", { name })
          ])
        );
        if (opener === undefined) return "found no title to fill in or button to add a recipe";
        await opener.click();
        for (let waited = 0; title === undefined && waited < 5_000; waited += 500) {
          await page.waitForTimeout(500);
          title = await chooseTitle(view);
        }
      }
      if (title === undefined) return "found no title to fill in";
      await settle(view);
      await title.fill(recipe.title);
      const ingredients = await chooseField(frame, INGREDIENTS);
      if (ingredients === undefined) return "found no field for the ingredients";
      await fillList(ingredients, recipe.ingredients, ", ");
      const steps = await chooseField(frame, STEPS);
      if (steps === undefined) return "found no field for the steps";
      await fillList(steps, recipe.steps, ". ");
      const form = await formAround(frame, SAVES);
      if (form === undefined) return "found no button to save the recipe";
      await fillRest(form.scope);
      if (!(await form.send.isEnabled().catch(() => false)))
        return "found the button to save it still disabled once the form was filled";
      pressed = (await form.send.innerText().catch(() => "")).trim() || "save";
      await form.send.click();
      return null;
    })
    .finally(() => {
      page.off("request", count);
      page.off("console", read);
    });
  if (refused !== null) return refused;
  if (sent === 0)
    return `pressed ${pressed}, but the page sent Patchy nothing${blocked ? " (the browser blocked the form's native submission, which a patch's sandboxed frame doesn't allow)" : ""}`;
  return (await reveal(view, recipe.title))
    ? null
    : "saved a recipe, but it never showed up for them in the book";
};

/** `key` adds `recipe` from a page of their own; the check's failure when they couldn't. */
const added = async (ctx: CheckContext, key: string, recipe: Recipe) => {
  const view = await ctx.open(key);
  const refused = await add(view, recipe);
  await view.close();
  return refused === null
    ? null
    : ({ ok: false, reason: `${ctx.person(key).name} ${refused}.` } as const);
};

/**
 * Opens the recipe holding `recipe.title` in `view` as a person would, only
 * looking: finds it in the book, clicks its title and waits for its steps.
 * Whether it found the recipe, and what the address was just before the click.
 */
const openRecipe = async (view: Opened, recipe: Recipe) => {
  if (!(await reveal(view, recipe.title))) return { found: false, before: "" } as const;
  const before = view.page.url();
  await view.frame.getByText(recipe.title).filter({ visible: true }).first().click();
  return { found: await shows(view, lastStep(recipe)), before } as const;
};

/** How long the address may take to follow the recipe a page opened. */
const ROUTE_MS = 5_000;

/**
 * The link `key` would paste for `recipe`: what their address bar shows once
 * they open it from a fresh look at the book, as a path under the patch's
 * address; or the check's failure.
 */
const linkTo = async (
  ctx: CheckContext,
  key: string,
  recipe: Recipe
): Promise<{ readonly ok: true; readonly path: string } | Extract<CheckOutcome, { ok: false }>> => {
  const who = ctx.person(key).name;
  const view = await ctx.open(key);
  try {
    const { found, before } = await openRecipe(view, recipe);
    if (!found)
      return { ok: false, reason: `${who} can't open ${recipe.title} and see its steps.` };
    let now = view.page.url();
    for (let waited = 0; now === before && waited < ROUTE_MS; waited += 500) {
      await view.page.waitForTimeout(500);
      now = view.page.url();
    }
    // A page can refine the path a moment later, such as adding the recipe's name.
    await view.page.waitForTimeout(1_000);
    now = view.page.url();
    if (now === before)
      return {
        ok: false,
        reason: `Opening ${recipe.title} left ${who}'s address as it was: the recipe has no link of its own.`
      };
    if (!now.startsWith(ctx.target.address))
      return {
        ok: false,
        reason: `Opening ${recipe.title} took ${who}'s address away from the recipe book.`
      };
    return { ok: true, path: now.slice(ctx.target.address.length) };
  } finally {
    await view.close();
  }
};

/**
 * Whether `key`, opening `link` in a fresh browser, lands on `recipe` alone:
 * its steps show, and `other`'s never do, so the book with every recipe in
 * it doesn't pass for the recipe's own page. The check's failure, or null.
 */
const landsOn = async (
  ctx: CheckContext,
  key: string,
  link: string,
  recipe: Recipe,
  other: Recipe
): Promise<Extract<CheckOutcome, { ok: false }> | null> => {
  const who = ctx.person(key).name;
  const view = await ctx.open(key, link);
  try {
    if (!(await shows(view, lastStep(recipe))))
      return {
        ok: false,
        reason: `${who} opened the link to ${recipe.title} (${link}), and its steps never showed.`
      };
    await settle(view);
    return (await visibleText(view)).includes(lastStep(other))
      ? {
          ok: false,
          reason: `${who} opened the link to ${recipe.title} (${link}), and saw ${other.title}'s steps too: it opens the book, not the recipe.`
        }
      : null;
  } finally {
    await view.close();
  }
};

/**
 * A team recipe book where every recipe has a link of its own: nothing to
 * keep against the viewer, so a page and its own table do it all, and the
 * reference task for a page's own routes. Ben adds a recipe and Cleo opens
 * it, ingredients and steps. Then Ada adds two, opens each and takes the
 * address her browser shows, and Cleo, opening each link fresh, must land
 * on that recipe and not the other.
 */
export default {
  id: "recipe-book",
  scenario: "team",
  words:
    "We keep losing the team's recipes in chat. Make a recipe book where anyone at our company can add a recipe with a title, its ingredients and its steps, and give every recipe its own link I can paste to someone so it opens right on that recipe. Publish it.",
  target: { create: "repo" },
  minutes: 25,
  heldOut: true,
  rubric: [
    "Tier 1: anyone may add and read recipes, so there is no rule to keep against the viewer, no write that must be atomic across rows and no agent area; the page writes its own table directly, and tier 2 handlers would add machinery the request doesn't need.",
    "One owned table of recipes: the title, the ingredients and the steps (lines of text, or lists kept as JSON and validated when read), with Patchy's own id and creation time, and who added it from `me()` as a fair extra. The book reads it through a live query, so a recipe someone adds shows up for everyone without a reload.",
    "Each recipe has a path of the page's own through `patchy.route`: opening a recipe sets it (such as `/recipes/<id>`), the page starts at the path it was opened on and follows back and forward, and the book is `/`. A path to a recipe that doesn't exist says so, with a way back. The address the browser shows is the link to paste: no hash routes or frame navigation. A page can't read its own full address, so anything it offers as the link, such as a copy button, mustn't rest on the frame's location or on an address that stops opening the recipe once the patch moves.",
    "The form asks for a title, ingredients and steps and refuses an empty one; a recipe's page shows its ingredients and its steps as lists, in order. Clear empty state, the company look, and a layout that works on a phone. No router or other extra dependencies."
  ].join("\n"),
  checks: [
    {
      name: "a recipe Ben adds reaches Cleo, ingredients and steps",
      run: async (ctx) => {
        const recipe: Recipe = {
          title: `Lemon drizzle cake ${ctx.code}`,
          ingredients: ["225g self-raising flour", "zest of 2 lemons", "85g icing sugar"],
          steps: [
            "Beat the butter and sugar until pale",
            "Fold in the flour and the lemon zest",
            "Pour the lemon syrup over the warm cake"
          ]
        };
        const refused = await added(ctx, "ben", recipe);
        if (refused !== null) return refused;
        const cleo = await ctx.open("cleo");
        if (!(await openRecipe(cleo, recipe)).found)
          return {
            ok: false,
            reason: (await reveal(cleo, recipe.title))
              ? "Cleo finds Ben's recipe, but not its steps."
              : "Cleo never sees the recipe Ben added."
          };
        return (await shows(cleo, "zest of 2 lemons"))
          ? { ok: true }
          : { ok: false, reason: "Cleo sees Ben's recipe and its steps, but not its ingredients." };
      }
    },
    {
      name: "each recipe's own link opens it for someone else",
      run: async (ctx) => {
        const risotto: Recipe = {
          title: `Mushroom risotto ${ctx.code}`,
          ingredients: ["300g arborio rice", "250g chestnut mushrooms", "1 litre hot stock"],
          steps: [
            "Soften the onion in butter",
            "Add the stock a ladle at a time",
            "Stir in the parmesan off the heat"
          ]
        };
        const curry: Recipe = {
          title: `Chickpea curry ${ctx.code}`,
          ingredients: ["2 tins of chickpeas", "1 tin of coconut milk", "2 tbsp curry paste"],
          steps: [
            "Fry the curry paste for a minute",
            "Simmer the chickpeas in the coconut milk",
            "Finish with lime juice and coriander"
          ]
        };
        for (const recipe of [risotto, curry]) {
          const refused = await added(ctx, "ada", recipe);
          if (refused !== null) return refused;
        }
        const links: Array<string> = [];
        for (const recipe of [risotto, curry]) {
          const link = await linkTo(ctx, "ada", recipe);
          if (!link.ok) return link;
          links.push(link.path);
        }
        const [toRisotto, toCurry] = links as [string, string];
        if (toRisotto === toCurry)
          return {
            ok: false,
            reason: `Both recipes Ada opened left the same address (${toRisotto}).`
          };
        return (
          (await landsOn(ctx, "cleo", toRisotto, risotto, curry)) ??
          (await landsOn(ctx, "cleo", toCurry, curry, risotto)) ?? { ok: true }
        );
      }
    }
  ]
} satisfies Task;
