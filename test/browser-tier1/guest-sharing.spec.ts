import { test, expect, prepare } from "./fixtures.js";

test("admin People guests link to Share, revoke there and refuse the recipient's next load", async ({
  page,
  browser,
  instance
}, testInfo) => {
  await instance.platform.query(
    "INSERT INTO companies (id, handle, name) VALUES ('cmp_roster_other', 'roster-other', 'Other company')"
  );
  await instance.platform.query(
    "UPDATE users SET company_id = 'cmp_roster_other', role = 'admin' WHERE id = 'usr_colleague'"
  );
  const patch = await instance.publish(
    "company",
    "<!doctype html><html><head><title>Roster brief</title></head><body><h1>Roster brief</h1></body></html>",
    undefined,
    { tier: 0, tables: {}, files: {} }
  );
  const settings = `${instance.origin}/patches/${patch.name}/settings`;
  const people = `${instance.origin}/company`;
  await page.goto(settings);
  await page.getByLabel("Existing Patchy account email").fill("colleague@patchy.local");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByText("Has access", { exact: true })).toBeVisible();
  const guestContext = await browser.newContext();
  try {
    await prepare(guestContext, instance);
    await instance.session(guestContext, "colleague");
    const guest = await guestContext.newPage();
    expect((await guest.goto(patch.address))?.status()).toBe(200);
    await expect(
      guest.frameLocator("#patch").getByRole("heading", { name: "Roster brief" })
    ).toBeVisible();

    // This account is an admin elsewhere and a guest here. Forged parameters cannot select here.
    expect(
      (await guest.goto(`${people}?show=guests&companyId=cmp_dev&guestId=anything`))?.status()
    ).toBe(200);
    await expect(guest.getByText("No guests yet.", { exact: true })).toBeVisible();
    await expect(guest.getByRole("link", { name: "Roster brief", exact: true })).toHaveCount(0);
    expect((await guest.goto(settings))?.status()).toBe(404);

    await page.goto(people);
    const members = await page.locator("main").innerText();
    expect(members).not.toContain("colleague@patchy.local");
    await page.getByRole("link", { name: "Guests", exact: true }).click();
    await expect(page.getByText("colleague@patchy.local", { exact: true })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: "colleague@patchy.local" });
    await expect(row.getByRole("cell", { name: "Active", exact: true })).toBeVisible();
    await expect(row).toContainText("Has access");
    await page.screenshot({ path: testInfo.outputPath("guests-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("guests-phone.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await row.getByRole("link", { name: "Roster brief", exact: true }).click();
    await expect(page).toHaveURL(`${settings}#share`);
    await page
      .getByRole("list", { name: "Named guests" })
      .getByRole("listitem")
      .filter({ hasText: "colleague@patchy.local" })
      .getByRole("button", { name: /^Revoke access for / })
      .click();
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    await page.goto(`${people}?show=guests`);
    await expect(page.getByRole("row").filter({ hasText: "colleague@patchy.local" })).toContainText(
      "Revoked"
    );
    await expect(page.getByText("No current patch access.", { exact: true })).toBeVisible();
    expect((await guest.goto(patch.address))?.status()).toBe(404);
    await expect(guest.locator("iframe#patch")).toHaveCount(0);

    await instance.platform.query("UPDATE patches SET disabled_at = now() WHERE id = $1", [
      patch.patchId
    ]);
    await page.reload();
    await expect(page.getByRole("row").filter({ hasText: "colleague@patchy.local" })).toContainText(
      "Roster brief"
    );
    await expect(page.getByRole("link", { name: "Roster brief", exact: true })).toHaveCount(0);
    await instance.platform.query("UPDATE patches SET disabled_at = NULL WHERE id = $1", [
      patch.patchId
    ]);

    // Existing active-member and deactivated-member gates still apply to a forged filter.
    await instance.platform.query("UPDATE users SET role = 'member' WHERE id = 'usr_dev'");
    expect((await page.goto(`${people}?show=guests`))?.status()).toBe(403);
    await expect(page.getByText("colleague@patchy.local", { exact: true })).toHaveCount(0);
    await page.goto(people);
    await expect(page.getByRole("link", { name: "Guests", exact: true })).toHaveCount(0);
    await instance.platform.query(
      "UPDATE users SET role = 'admin', deactivated_at = now() WHERE id = 'usr_dev'"
    );
    expect((await page.goto(`${people}?show=guests`))?.status()).toBe(403);
    await expect(page.getByText("colleague@patchy.local", { exact: true })).toHaveCount(0);
  } finally {
    await guestContext.close();
  }
});

test("admin deactivation suspends two guest shares and reactivation restores only valid grants", async ({
  page,
  browser,
  instance
}, testInfo) => {
  await instance.platform.query(
    "INSERT INTO companies (id, handle, name) VALUES ('cmp_recipient', 'recipient', 'Recipient company'), ('cmp_independent', 'independent', 'Independent company')"
  );
  await instance.platform.query(
    "UPDATE users SET company_id = 'cmp_recipient' WHERE id = 'usr_colleague'"
  );
  const publish = (title: string) =>
    instance.publish(
      "company",
      `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
      undefined,
      { tier: 0, tables: {}, files: {} }
    );
  const first = await publish("First guest brief");
  const second = await publish("Second guest brief");
  const independent = await publish("Independent brief");
  await instance.platform.query(
    "INSERT INTO users (id, clerk_user_id, company_id, email, name, role) VALUES ('usr_independent', 'user_independent', 'cmp_independent', 'owner@independent.local', 'Independent owner', 'admin')"
  );
  // A separate company's real guest grant, unaffected by this company's controls.
  await instance.platform.query(
    "UPDATE patches SET company_id = 'cmp_independent', owner_user_id = 'usr_independent' WHERE id = $1",
    [independent.patchId]
  );
  await instance.platform.query(
    "UPDATE patch_names SET company_id = 'cmp_independent' WHERE patch_id = $1",
    [independent.patchId]
  );
  await instance.platform.query(
    "INSERT INTO company_guests (id, company_id, clerk_user_id, email, name) VALUES ('gst_independent', 'cmp_independent', 'user_colleague', 'colleague@patchy.local', 'Colleague')"
  );
  await instance.platform.query(
    "INSERT INTO patch_guest_grants (id, company_id, patch_id, guest_id) VALUES ('grt_independent', 'cmp_independent', $1, 'gst_independent')",
    [independent.patchId]
  );
  const independentAddress = `${instance.origin}/independent/${independent.name}`;
  const settings = (patch: typeof first) => `${instance.origin}/patches/${patch.name}/settings`;
  const share = async (patch: typeof first) => {
    await page.goto(settings(patch));
    await page.getByLabel("Existing Patchy account email").fill("colleague@patchy.local");
    await page.getByRole("button", { name: "Share", exact: true }).click();
  };
  await share(first);
  await expect(page.getByText("Has access", { exact: true })).toBeVisible();
  await share(second);
  await expect(page.getByText("Has access", { exact: true })).toBeVisible();
  const tokensBefore = (
    await instance.platform.query("SELECT id, user_id, revoked_at FROM machine_tokens ORDER BY id")
  ).rows;
  const patchesBefore = (
    await instance.platform.query("SELECT id, company_id, owner_user_id FROM patches ORDER BY id")
  ).rows;
  const guestContext = await browser.newContext();
  try {
    await prepare(guestContext, instance);
    await instance.session(guestContext, "colleague");
    const guest = await guestContext.newPage();
    const admitted = async (address: string, title: string) => {
      expect((await guest.goto(address))?.status()).toBe(200);
      await expect(
        guest.frameLocator("#patch").getByRole("heading", { name: title, exact: true })
      ).toBeVisible();
    };
    const refused = async (address: string) => {
      expect((await guest.goto(address))?.status()).toBe(404);
      await expect(guest.locator("iframe#patch")).toHaveCount(0);
    };
    await admitted(first.address, "First guest brief");
    await admitted(second.address, "Second guest brief");
    await admitted(independentAddress, "Independent brief");
    await guest.goto(instance.origin);
    await guest.getByRole("button", { name: "Later", exact: true }).click();
    const shared = guest.getByRole("region", { name: "Shared with you" });
    await expect(shared.getByRole("link", { name: /First guest brief/ })).toBeVisible();
    await expect(shared.getByRole("link", { name: /Second guest brief/ })).toBeVisible();

    const usersBefore = (await instance.platform.query("SELECT * FROM users ORDER BY id")).rows;
    const people = `${instance.origin}/company?show=guests`;
    const row = page.getByRole("row").filter({ hasText: "colleague@patchy.local" });
    await page.goto(people);
    const guestName = await row.locator("strong").innerText();
    await row.getByRole("button", { name: "Deactivate", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(`Deactivated ${guestName}`);
    await expect(row.getByRole("cell", { name: "Deactivated", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Reactivate", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("guest-deactivated.png"), fullPage: true });
    await guest.reload();
    await expect(
      shared.getByRole("link", { name: /First guest brief|Second guest brief/ })
    ).toHaveCount(0);
    await expect(shared.getByRole("link", { name: /Independent brief/ })).toBeVisible();
    await refused(first.address);
    await refused(second.address);
    await admitted(independentAddress, "Independent brief");
    await share(first);
    await expect(page.getByRole("alert")).toContainText("This guest relationship is deactivated.");
    await page.goto(settings(second));
    await page.getByRole("button", { name: /^Revoke access for / }).click();
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    await page.goto(people);
    await row.getByRole("button", { name: "Reactivate", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(`Reactivated ${guestName}`);
    await expect(row.getByRole("cell", { name: "Active", exact: true })).toBeVisible();
    await expect(row).toContainText("Revoked");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath("guest-reactivated-phone.png"),
      fullPage: true
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await admitted(first.address, "First guest brief");
    await refused(second.address);
    await admitted(independentAddress, "Independent brief");
    await guest.goto(instance.origin);
    await expect(shared.getByRole("link", { name: /First guest brief/ })).toBeVisible();
    await expect(shared.getByRole("link", { name: /Second guest brief/ })).toHaveCount(0);

    // Ending while suspended keeps the row and its reverse action; clearing suspension alone grants nothing.
    await row.getByRole("button", { name: "Deactivate", exact: true }).click();
    await page.goto(settings(first));
    await page.getByRole("radio", { name: "Anyone on the internet" }).check();
    await page.getByRole("button", { name: "Save who can open it" }).click();
    await page.getByRole("button", { name: /Make .* public/ }).click();
    await page.getByRole("radio", { name: "People at the company" }).check();
    await page.getByRole("button", { name: "Save who can open it" }).click();
    await instance.platform.query(
      "UPDATE company_guests SET ended_at = now() WHERE company_id = 'cmp_dev' AND clerk_user_id = 'user_colleague'"
    );
    await page.goto(people);
    await expect(row).toContainText("Ended · Deactivated");
    await row.getByRole("button", { name: "Reactivate", exact: true }).click();
    await expect(row.getByRole("cell", { name: "Ended", exact: true })).toBeVisible();
    await refused(first.address);
    await refused(second.address);
    await share(first);
    await expect(page.getByText("Has access", { exact: true })).toBeVisible();
    await admitted(first.address, "First guest brief");
    await refused(second.address);
    await admitted(independentAddress, "Independent brief");
    expect((await instance.platform.query("SELECT * FROM users ORDER BY id")).rows).toEqual(
      usersBefore
    );
    expect(
      (
        await instance.platform.query(
          "SELECT id, user_id, revoked_at FROM machine_tokens ORDER BY id"
        )
      ).rows
    ).toEqual(tokensBefore);
    expect(
      (
        await instance.platform.query(
          "SELECT id, company_id, owner_user_id FROM patches ORDER BY id"
        )
      ).rows
    ).toEqual(patchesBefore);
  } finally {
    await guestContext.close();
  }
});

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
