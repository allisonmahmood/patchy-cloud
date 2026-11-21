import type { ConsoleMessage, FrameLocator, Locator, Request } from "@playwright/test";
import type { CheckContext, CheckOutcome, Opened, Task } from "../task.js";
import { around, chooseField, fillRest, formAround, reveal, settle } from "./page.js";

/** A recipe a check adds. Its last step is the words that tell its page from any other's. */
interface Recipe {
  readonly title: string;
  readonly ingredients: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<string>;
}

type Failure = Extract<CheckOutcome, { ok: false }>;

const lastStep = (recipe: Recipe) => recipe.steps.at(-1)!;

const POLL_MS = 500;
/** How long one click may take: grading sets no action timeout, and a covered target is retried forever. */
const CLICK_MS = 5_000;

/**
 * The `items` the patch's frame doesn't show within `ms`, as visible text;
 * case aside, since a page's styles can change it.
 */
const unseen = async (view: Opened, items: ReadonlyArray<string>, ms = 10_000) => {
  for (let waited = 0; ; waited += POLL_MS) {
    const text = (
      await view.frame
        .locator("body")
        .innerText({ timeout: POLL_MS })
        .catch(() => "")
    ).toLowerCase();
    const missing = items.filter((item) => !text.includes(item.toLowerCase()));
    if (missing.length === 0 || waited >= ms) return missing;
    await view.page.waitForTimeout(POLL_MS);
  }
};

const showsSteps = async (view: Opened, recipe: Recipe) =>
  (await unseen(view, [lastStep(recipe)])).length === 0;

/** A title as a page's styles can show it: as written, upper case, lower case, or each word capitalised. */
const casings = (title: string) => [
  ...new Set([
    title,
    title.toUpperCase(),
    title.toLowerCase(),
    title.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
  ])
];

/**
 * Whether `title` shows in `view`, case aside: on the page as it opens, or
 * behind its tabs and view toggles (`reveal`, which matches case), in any
 * casing a page's styles give it.
 */
const find = async (view: Opened, title: string) => {
  await settle(view);
  if ((await unseen(view, [title], 5_000)).length === 0) return true;
  for (const casing of casings(title)) if (await reveal(view, casing)) return true;
  return false;
};

/** What a recipe's own fields go by; a title is looked for by name before by "recipe". */
const TITLES = [/title|name|dish|called/i, /recipe/i];
const INGREDIENTS = /ingredient|you.?ll need|you need/i;
const STEPS = /step|instruction|method|direction|how to|preparation/i;
/** What opens a new recipe's form; never a share or copy control on a recipe already there. */
const NEW_RECIPE = [/\b(add|new|create|write)\b.*\brecipe/i, /^\s*(\+|new|add)\s*$/i];
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
          NEW_RECIPE.flatMap((name) => [
            frame.getByRole("button", { name }),
            frame.getByRole("link", { name })
          ])
        );
        if (opener === undefined) return "found no title to fill in or button to add a recipe";
        await opener.click({ timeout: CLICK_MS });
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
      await form.send.click({ timeout: CLICK_MS });
      return null;
    })
    .finally(() => {
      page.off("request", count);
      page.off("console", read);
    });
  if (refused !== null) return refused;
  if (sent === 0)
    return `pressed ${pressed}, but the page sent Patchy nothing${blocked ? " (the browser blocked the form's native submission, which a patch's sandboxed frame doesn't allow)" : ""}`;
  return (await find(view, recipe.title))
    ? null
    : "saved a recipe, but it never showed up for them in the book";
};

/** `key` adds `recipe` from a page of their own; the check's failure when they couldn't. */
const added = async (ctx: CheckContext, key: string, recipe: Recipe): Promise<Failure | null> => {
  const view = await ctx.open(key);
  const refused = await add(view, recipe);
  await view.close();
  return refused === null ? null : { ok: false, reason: `${ctx.person(key).name} ${refused}.` };
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words that name another action than opening, or a part of the recipe a control only shows. */
const NOT_OPENING = String.raw`(?!.*\b(copy|share|edit|delete|remove|print|download|save|like|favou?rite|ingredients?|steps?|method)\b)`;

/**
 * What a control that opens `recipe` is named, best first: the recipe's
 * name alone, a name starting with View, Open, Read or See (View full recipe,
 * See recipe), or the recipe's name with more words, such as a whole card
 * that is a button. Never one for another action or a part of the recipe:
 * "Show ingredients", "View steps" or "Copy link to …".
 */
const opensNames = (recipe: Recipe) => [
  new RegExp(`^\\W*${escaped(recipe.title)}\\W*$`, "i"),
  new RegExp(`^\\W*(view|open|read|see)\\b${NOT_OPENING}`, "i"),
  new RegExp(`^${NOT_OPENING}.*${escaped(recipe.title)}`, "i")
];

const opens = (scope: FrameLocator | Locator, name: RegExp) =>
  scope.getByRole("button", { name }).or(scope.getByRole("link", { name }));

/**
 * Opens `recipe` in `view` as a person would, only looking: finds it in the
 * book, then presses its card's own control for opening it (`opensNames`),
 * the innermost part of the page holding the title and one; clicking the
 * title only where there is none. Steps already on the page don't count as
 * opened, since opening is what makes its link. Each click has a short
 * timeout, and one that can't land is passed over. Whether its steps then
 * show, and the address just before the first click.
 */
const openRecipe = async (view: Opened, recipe: Recipe) => {
  if (!(await find(view, recipe.title))) return { found: false, before: "" } as const;
  const before = view.page.url();
  const names = opensNames(recipe);
  const card = around(view.frame, recipe.title, {
    has: names.map((name) => opens(view.frame, name)).reduce((all, each) => all.or(each))
  });
  let pressed = false;
  if ((await card.count()) > 0)
    for (const name of names) {
      const control = opens(card, name).filter({ visible: true }).first();
      if ((await control.count()) === 0) continue;
      pressed = await control.click({ timeout: CLICK_MS }).then(
        () => true,
        () => false
      );
      if (pressed) break;
    }
  if (!pressed)
    await view.frame
      .getByText(recipe.title)
      .filter({ visible: true })
      .first()
      .click({ timeout: CLICK_MS })
      .catch(() => undefined);
  return { found: await showsSteps(view, recipe), before } as const;
};

/** How long the address may take to follow the recipe a page opened. */
const ROUTE_MS = 5_000;

/**
 * The link `key` would paste for `recipe`: what their address bar shows once
 * they open it from a fresh look at the book, as a path under the patch's
 * address; or the check's failure. A recipe the page already showed can keep
 * its address, but never the book's own bare one.
 */
const linkTo = async (
  ctx: CheckContext,
  key: string,
  recipe: Recipe
): Promise<{ readonly ok: true; readonly path: string } | Failure> => {
  const who = ctx.person(key).name;
  const view = await ctx.open(key);
  try {
    const { found, before } = await openRecipe(view, recipe);
    if (!found)
      return { ok: false, reason: `${who} can't open ${recipe.title} and see its steps.` };
    let now = view.page.url();
    for (let waited = 0; now === before && waited < ROUTE_MS; waited += POLL_MS) {
      await view.page.waitForTimeout(POLL_MS);
      now = view.page.url();
    }
    // A page can refine the path a moment later, such as adding the recipe's name.
    await view.page.waitForTimeout(1_000);
    now = view.page.url();
    if (!now.startsWith(ctx.target.address))
      return {
        ok: false,
        reason: `Opening ${recipe.title} took ${who}'s address away from the recipe book.`
      };
    const path = now.slice(ctx.target.address.length);
    return path.replace(/\/+$/, "") === ""
      ? {
          ok: false,
          reason: `Opening ${recipe.title} left ${who}'s address at the book's own: the recipe has no link of its own.`
        }
      : { ok: true, path };
  } finally {
    await view.close();
  }
};

/** How long the frame's intersection observer may take to answer. */
const OBSERVED_MS = 3_000;

/**
 * Whether any rendered element showing one of `items` is in view, as an
 * intersection observer in the frame sees it: inside the frame's viewport and
 * any scrolling part that clips it. Undefined when the observer didn't answer.
 */
const inView = async (view: Opened, items: ReadonlyArray<string>): Promise<boolean | undefined> => {
  const shown = items
    .map((item) => view.frame.getByText(item))
    .reduce((all, each) => all.or(each))
    .filter({ visible: true });
  if ((await shown.count()) === 0) return false;
  // In view as soon as one element says so; out of view only once every one has answered.
  const observed = shown.evaluateAll(
    (elements) =>
      new Promise<boolean>((resolve) => {
        let waiting = elements.length;
        for (const element of elements) {
          const observer = new IntersectionObserver(([entry]) => {
            observer.disconnect();
            if (entry?.isIntersecting === true) resolve(true);
            else if (--waiting === 0) resolve(false);
          });
          observer.observe(element);
        }
      })
  );
  return Promise.race([observed, view.page.waitForTimeout(OBSERVED_MS).then(() => undefined)]);
};

/**
 * What a landing looks like, to tell two apart: how many times each recipe's
 * last step is rendered, and every scroll offset, down and across, in the
 * frame and the page around it, so a deck swiped to the linked recipe counts
 * too. A whole book shown the same way whatever its link looks the same on
 * every link; text that shifts a little as it loads doesn't move a scroll.
 */
const lookOf = async (view: Opened, recipes: ReadonlyArray<Recipe>) => {
  const counts = await Promise.all(
    recipes.map((recipe) =>
      view.frame.getByText(lastStep(recipe)).filter({ visible: true }).count()
    )
  );
  const inside = await view.frame
    .locator("body")
    .evaluate((body) =>
      Array.from(
        body.ownerDocument.querySelectorAll("*"),
        (element) => `${Math.round(element.scrollTop)}:${Math.round(element.scrollLeft)}`
      ).filter((offsets) => offsets !== "0:0")
    );
  const outside = await view.page.evaluate(
    () => `${Math.round(window.scrollY)}:${Math.round(window.scrollX)}`
  );
  return `${counts.join(",")}|${inside.join(",")}|${outside}`;
};

/**
 * `key` opens `link` in a fresh browser: `recipe`'s steps have to show, and
 * some of its ingredients or steps be in view, since a long recipe's last
 * step can sit below the fold. What the landing looks like, or the check's
 * failure; an observer that never answers fails it, as the grader can't tell.
 */
const land = async (
  ctx: CheckContext,
  key: string,
  link: string,
  recipe: Recipe,
  pair: ReadonlyArray<Recipe>
): Promise<{ readonly ok: true; readonly look: string } | Failure> => {
  const opened = `${ctx.person(key).name} opened the link to ${recipe.title} (${link})`;
  const view = await ctx.open(key, link);
  try {
    if (!(await showsSteps(view, recipe)))
      return { ok: false, reason: `${opened}, and its steps never showed.` };
    await settle(view);
    // A page can scroll to the recipe it opens on smoothly.
    await view.page.waitForTimeout(1_000);
    const seen = await inView(view, [...recipe.ingredients, ...recipe.steps]);
    if (seen !== true)
      return {
        ok: false,
        reason:
          seen === false
            ? `${opened}, and the recipe is on the page but out of view.`
            : `${opened}, and the grader couldn't tell whether the recipe was in view.`
      };
    return { ok: true, look: await lookOf(view, pair) };
  } finally {
    await view.close();
  }
};

/**
 * A team recipe book where every recipe has a link of its own: nothing to
 * keep against the viewer, so a page and its own table do it all, and the
 * reference task for a page's own routes. Ben adds a recipe and Cleo opens
 * it, with every ingredient and step he wrote. Then Ada adds two and takes
 * the address her browser shows for each: their own, not the book's. Ben
 * adds another, so a link that only means "the newest" opens the wrong one.
 * Cleo then opens each link fresh: it has to bring its own recipe into view,
 * and the two landings can't look the same, so the whole book never passes
 * for a recipe's page.
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
            reason: (await find(cleo, recipe.title))
              ? "Cleo finds Ben's recipe, but not its steps."
              : "Cleo never sees the recipe Ben added."
          };
        // Every ingredient and step Ben wrote, so a recipe that lost any of them doesn't pass.
        const missing = await unseen(cleo, [...recipe.ingredients, ...recipe.steps], 2_000);
        return missing.length === 0
          ? { ok: true }
          : {
              ok: false,
              reason: `Cleo opens Ben's recipe, but it's missing ${missing.map((item) => `"${item}"`).join(", ")}.`
            };
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
        const pair = [risotto, curry];
        for (const recipe of pair) {
          const refused = await added(ctx, "ada", recipe);
          if (refused !== null) return refused;
        }
        const links: Array<string> = [];
        for (const recipe of pair) {
          const link = await linkTo(ctx, "ada", recipe);
          if (!link.ok) return link;
          links.push(link.path);
        }
        const [toRisotto, toCurry] = links as [string, string];
        if (toRisotto === toCurry)
          return {
            ok: false,
            reason: `Ada opened each recipe, and her address showed ${toRisotto} both times: the recipes have no links of their own.`
          };
        // A link has to keep opening its recipe once the book changes, not whichever is newest.
        const refused = await added(ctx, "ben", {
          title: `Banana bread ${ctx.code}`,
          ingredients: ["3 ripe bananas", "250g plain flour", "100g soft brown sugar"],
          steps: ["Mash the bananas", "Stir everything together", "Bake for an hour until risen"]
        });
        if (refused !== null) return refused;
        const landings: Array<string> = [];
        for (const [recipe, link] of [
          [risotto, toRisotto],
          [curry, toCurry]
        ] as const) {
          const landing = await land(ctx, "cleo", link, recipe, pair);
          if (!landing.ok) return landing;
          landings.push(landing.look);
        }
        return landings[0] === landings[1]
          ? {
              ok: false,
              reason:
                "Cleo's two links landed on the same view of the book, both recipes shown the same way: it opens the book, not the recipe."
            }
          : { ok: true };
      }
    }
  ]
} satisfies Task;
