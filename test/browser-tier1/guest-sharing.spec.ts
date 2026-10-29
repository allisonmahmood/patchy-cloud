import { test, expect, prepare } from "./fixtures.js";

test("public confirmation ends guest access until the owner explicitly shares again", async ({
  page,
  browser,
  instance
}) => {
  // Give the second signed-in account its own company; it has no member rights here.
  await instance.platform.query(
    "INSERT INTO companies (id, handle, name) VALUES ('cmp_guest_home', 'guest-home', 'Guest home')"
  );
  await instance.platform.query(
    "UPDATE users SET company_id = 'cmp_guest_home' WHERE id = 'usr_colleague'"
  );
  const patch = await instance.publish(
    "company",
    "<!doctype html><html><head><title>Guest brief</title></head><body><h1>Guest brief</h1></body></html>",
    undefined,
    { tier: 0, tables: {}, files: {} }
  );
  const settings = `${instance.origin}/patches/${patch.name}/settings`;
  const guestContext = await browser.newContext();
  try {
    await prepare(guestContext, instance);
    await instance.session(guestContext, "colleague");
    const guest = await guestContext.newPage();
    const admitted = async () => {
      expect((await guest.goto(patch.address))?.status()).toBe(200);
      await expect(
        guest.frameLocator("#patch").getByRole("heading", { name: "Guest brief" })
      ).toBeVisible();
    };
    const share = async () => {
      await page.getByLabel("Existing Patchy account email").fill("colleague@patchy.local");
      await page.getByRole("button", { name: "Share", exact: true }).click();
      await expect(page.getByText("Has access", { exact: true })).toBeVisible();
    };
    const askPublic = async () => {
      await page.getByRole("radio", { name: "Anyone on the internet" }).check();
      await page.getByRole("button", { name: "Save who can open it" }).click();
      await expect(page.getByRole("heading", { name: /Make .* public\?/ })).toBeVisible();
      await expect(
        page.getByText(
          /Anyone with the link can open it without signing in\. Named guest grants will end\./
        )
      ).toBeVisible();
    };

    await page.goto(settings);
    await share();
    await admitted();
    const grants = () =>
      instance.platform.query(
        "SELECT id, ended_at, end_reason FROM patch_guest_grants WHERE patch_id = $1 ORDER BY granted_at",
        [patch.patchId]
      );
    const original = (await grants()).rows;
    await askPublic();
    await page.getByRole("link", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("radio", { name: "People at the company" })).toBeChecked();
    expect((await grants()).rows).toEqual(original);
    await admitted();

    await askPublic();
    await page.getByRole("button", { name: /Make .* public/ }).click();
    await expect(page.getByRole("radio", { name: "Anyone on the internet" })).toBeChecked();
    const ended = (await grants()).rows;
    expect(ended).toEqual([
      { id: original[0]!.id, ended_at: expect.any(Date), end_reason: "public" }
    ]);
    await page.getByRole("radio", { name: "People at the company" }).check();
    await page.getByRole("button", { name: "Save who can open it" }).click();
    await expect(page.getByRole("radio", { name: "People at the company" })).toBeChecked();
    expect((await guest.goto(patch.address))?.status()).toBe(404);
    await expect(guest.locator("iframe#patch")).toHaveCount(0);
    expect((await grants()).rows).toEqual(ended);

    await share();
    const fresh = (await grants()).rows;
    expect(fresh).toHaveLength(2);
    expect(fresh[0]).toEqual(ended[0]);
    expect(fresh[1].id).not.toBe(original[0]!.id);
    expect(fresh[1].ended_at).toBeNull();
    await admitted();
  } finally {
    await guestContext.close();
  }
});

for (const recipient of ["other company", "deactivated member", "deactivated admin"] as const) {
  test(`Home discovers and removes a named share for ${recipient} recipient`, async ({
    page,
    browser,
    instance
  }) => {
    if (recipient === "other company") {
      await instance.platform.query(
        "INSERT INTO companies (id, handle, name) VALUES ('cmp_home_recipient', 'home-recipient', 'Recipient company')"
      );
      await instance.platform.query(
        "UPDATE users SET company_id = 'cmp_home_recipient' WHERE id = 'usr_colleague'"
      );
    } else {
      await instance.platform.query(
        "UPDATE users SET role = $1, deactivated_at = now() WHERE id = 'usr_colleague'",
        [recipient === "deactivated admin" ? "admin" : "member"]
      );
    }
    const content =
      "<!doctype html><html><head><title>Home guest brief</title></head><body><h1>Home guest brief</h1></body></html>";
    const patch = await instance.publish("company", content, undefined, {
      tier: 0,
      tables: {},
      files: {}
    });
    const unrelated = await instance.publish("company", content, undefined, {
      tier: 0,
      tables: {},
      files: {}
    });
    const guestContext = await browser.newContext();
    try {
      await prepare(guestContext, instance);
      await instance.session(guestContext, "colleague");
      const guest = await guestContext.newPage();
      const home = `${instance.origin}/`;
      await guest.goto(home);
      if (recipient === "other company")
        await guest.getByRole("button", { name: "Later", exact: true }).click();
      await expect(guest.getByRole("heading", { name: "Shared with you" })).toHaveCount(0);
      await page.goto(`${instance.origin}/patches/${patch.name}/settings`);
      await page.getByLabel("Existing Patchy account email").fill("colleague@patchy.local");
      await page.getByRole("button", { name: "Share", exact: true }).click();
      await expect(page.getByText("Has access", { exact: true })).toBeVisible();
      expect((await guest.goto(home))?.status()).toBe(200);
      const shares = guest.getByRole("region", { name: "Shared with you" });
      await expect(shares.getByText("Patchy Dev", { exact: true })).toBeVisible();
      await shares.getByRole("link", { name: /Home guest brief/ }).click();
      await expect(guest).toHaveURL(patch.address);
      await expect(
        guest.frameLocator("#patch").getByRole("heading", { name: "Home guest brief" })
      ).toBeVisible();
      expect((await guest.goto(unrelated.address))?.status()).toBe(404);
      for (const path of ["/patches", `/patches/${patch.name}/settings`, "/company", "/guide"]) {
        if (recipient !== "other company")
          expect((await guest.goto(`${instance.origin}${path}`))?.status()).toBe(403);
      }
      await guest.goto(home);
      if (recipient !== "other company") {
        await expect(
          guest.locator('a[href="/guide"], a[href="/company"], a[href="/patches"]')
        ).toHaveCount(0);
        const user = await instance.platform.query(
          "SELECT deactivated_at, role FROM users WHERE id = 'usr_colleague'"
        );
        expect(user.rows[0].deactivated_at).toBeInstanceOf(Date);
        expect(user.rows[0].role).toBe(recipient === "deactivated admin" ? "admin" : "member");
      }
      await page.getByRole("button", { name: /^Revoke access for / }).click();
      await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
      const refreshed = await guest.reload();
      expect(refreshed?.status()).toBe(recipient === "other company" ? 200 : 403);
      await expect(guest.getByRole("heading", { name: "Shared with you" })).toHaveCount(0);
      await expect(guest.getByRole("link", { name: /Home guest brief/ })).toHaveCount(0);
      expect((await guest.goto(patch.address))?.status()).toBe(404);
    } finally {
      await guestContext.close();
    }
  });
}
