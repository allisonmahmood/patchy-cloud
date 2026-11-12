import { test, expect } from "./fixtures.js";

for (const [screen, viewport] of [
  ["a desktop", { width: 1280, height: 720 }],
  ["a phone", { width: 390, height: 844 }]
] as const)
  test(`a roster's ticks are counted live in a bar stuck to the bottom of ${screen}`, async ({
    page,
    context,
    instance
  }) => {
    await page.setViewportSize(viewport);
    // Enough people that the roster runs past the screen.
    await instance.platform.query(
      "INSERT INTO users (id, clerk_user_id, company_id, email, name, role) SELECT 'usr_roster_' || n, 'user_roster_' || n, 'cmp_dev', 'roster' || n || '@patchy.local', 'Roster ' || lpad(n::text, 2, '0'), 'member' FROM generate_series(1, 30) AS n"
    );
    const created = await context.request.post(`${instance.origin}/settings/company/teams/create`, {
      headers: { origin: instance.origin },
      form: { name: "Design" }
    });
    expect(created.ok()).toBe(true);
    const team = new URL(created.url()).searchParams.get("team") ?? "";
    await page.goto(`${instance.origin}/settings/company/teams?team=${team}`);
    const review = page.getByRole("button", { name: "Review…" });
    await expect(review).toBeHidden();

    await page.getByRole("checkbox", { name: /^Roster 01/ }).check();
    await page.getByRole("checkbox", { name: /^Roster 02/ }).check();
    await expect(page.getByText("Add 2", { exact: true })).toBeVisible();
    await expect(review).toBeInViewport();
    await page.getByRole("checkbox", { name: /^Roster 02/ }).uncheck();
    await expect(page.getByText("Add 1", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: /^Roster 20/ }).scrollIntoViewIfNeeded();
    await expect(review).toBeInViewport();
    await page.getByRole("checkbox", { name: /^Roster 01/ }).uncheck();
    await expect(review).toBeHidden();

    await page.getByRole("checkbox", { name: /^Roster 03/ }).check();
    await review.click();
    await expect(page.getByRole("dialog", { name: "Save changes to Design?" })).toBeVisible();
  });

test("a member on a phone still sees whom to ask on a team's own screen", async ({
  page,
  context,
  instance
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const created = await context.request.post(`${instance.origin}/settings/company/teams/create`, {
    headers: { origin: instance.origin },
    form: { name: "Design" }
  });
  expect(created.ok()).toBe(true);
  const team = new URL(created.url()).searchParams.get("team") ?? "";
  await instance.session(context, "colleague");
  await page.goto(`${instance.origin}/settings/company/teams?team=${team}`);
  await expect(page.getByText(/Only admins change teams/)).toBeVisible();
});
