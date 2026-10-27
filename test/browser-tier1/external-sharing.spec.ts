import { test, expect, prepare, installSessionRefreshBoundary } from "./fixtures.js";
import type { Instance } from "./instance.js";
import { recipient, recipientSession } from "./external-recipient.js";

test.use({ serverEnvironment: { PATCHY_DEV_EXTERNAL_SHARING: "true" } });

async function sharedPage(instance: Instance) {
  const patch = await instance.publish(
    "company",
    "<!doctype html><html><head><title>Partner brief</title></head><body><h1>Partner brief</h1><p>For this recipient.</p></body></html>",
    undefined,
    { tier: 0, tables: {}, files: {}, uses: {} }
  );
  // The provider boundary stays offline. Acceptance and revocation use real UI forms,
  // signed-cookie verification, grant storage and page serving.
  await instance.platform.query(
    "INSERT INTO patch_grants (id,patch_id,email,created_by) VALUES ('share_browser',$1,$2,'usr_dev')",
    [patch.patchId, recipient.email]
  );
  return patch;
}

test("a recipient without membership accepts one patch, cannot build, and loses an open patch on revoke", async ({
  browser,
  page: owner,
  instance
}, testInfo) => {
  const patch = await sharedPage(instance);
  const unrelated = await instance.publish(
    "company",
    "<!doctype html><html><head><title>Private forecast</title></head><body><h1>Private forecast</h1></body></html>"
  );
  const context = await browser.newContext();
  try {
    await prepare(context, instance);
    await recipientSession(context, instance);
    await installSessionRefreshBoundary(context, () => recipientSession(context, instance));
    const page = await context.newPage();
    expect((await page.goto(`${instance.origin}/`))?.status()).toBe(200);
    await expect(page.getByRole("searchbox", { name: "Search shared patches" })).toBeVisible();
    await expect(page.getByText("Partner brief", { exact: true })).toBeVisible();
    await expect(page.getByText("Private forecast", { exact: true })).toHaveCount(0);
    for (const href of ["/company", "/patches", "/machines", "/join"])
      await expect(page.locator(`a[href="${href}"]`)).toHaveCount(0);
    expect((await page.goto(`${instance.origin}/~shared/invite/share_browser`))?.status()).toBe(
      200
    );
    await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect(page).toHaveURL(patch.address);
    await expect(
      page.frameLocator("#patch").getByRole("heading", { name: "Partner brief" })
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("recipient-shared-patch.png"),
      fullPage: true
    });
    const contentUrl = `${instance.origin}/~content/${patch.patchId}/${patch.versionId}`;
    expect((await context.request.get(contentUrl)).status()).toBe(200);
    expect((await context.request.get(unrelated.address)).status()).toBe(404);
    expect(
      (
        await context.request.get(
          `${instance.origin}/~content/${unrelated.patchId}/${unrelated.versionId}`
        )
      ).status()
    ).toBe(404);
    for (const path of ["/company", "/patches", "/join", "/login/device", "/oauth/authorize"])
      expect((await context.request.get(`${instance.origin}${path}`)).status(), path).toBe(403);
    expect(
      (await context.request.post(`${instance.origin}/api/publish`, { data: {} })).status()
    ).toBe(401);
    const runtime = await context.request.post(`${instance.origin}/api/runtime/call`, {
      headers: {
        origin: instance.origin,
        "x-patchy-wire": String(instance.wire),
        "x-patchy-principal": "null"
      },
      data: {
        patchId: patch.patchId,
        versionId: patch.versionId,
        principal: null,
        wire: instance.wire,
        op: "me",
        args: {}
      }
    });
    expect(runtime.status()).toBe(403);
    expect(await runtime.json()).toMatchObject({ ok: false, code: "access_denied" });
    // Even a valid operation with a forged owner principal cannot reach company resources.
    for (const operation of [
      { op: "tables.list", args: { table: "rows" } },
      { op: "files.list", args: { store: "assets" } }
    ]) {
      const denied = await context.request.post(`${instance.origin}/api/runtime/call`, {
        headers: {
          origin: instance.origin,
          "x-patchy-wire": String(instance.wire),
          "x-patchy-principal": JSON.stringify({ userId: "usr_dev" })
        },
        data: {
          patchId: unrelated.patchId,
          versionId: unrelated.versionId,
          principal: { userId: "usr_dev" },
          wire: instance.wire,
          ...operation
        }
      });
      expect(denied.status(), operation.op).toBe(403);
      expect(await denied.json()).toMatchObject({ ok: false, code: "access_denied" });
    }
    expect(
      (
        await instance.platform.query("SELECT id FROM users WHERE clerk_user_id=$1", [
          recipient.sub
        ])
      ).rows
    ).toEqual([]);

    expect((await owner.goto(`${instance.origin}/shared`))?.status()).toBe(200);
    await expect(owner.getByText(`${recipient.email} · Accepted`, { exact: true })).toBeVisible();
    await owner.getByRole("button", { name: "Revoke access", exact: true }).click();
    await expect(owner.getByText(`${recipient.email} · Revoked`, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${instance.origin}/~shared/ended`);
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "This patch is no longer available" })
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("recipient-revoked.png"), fullPage: true });
    expect((await context.request.get(contentUrl)).status()).toBe(404);
    expect((await context.request.get(patch.address)).status()).toBe(404);
    await page.goto(`${instance.origin}/`);
    await expect(page.getByText("Nothing has been shared with you yet.")).toBeVisible();
    expect(
      (
        await instance.platform.query("SELECT id FROM users WHERE clerk_user_id=$1", [
          recipient.sub
        ])
      ).rows
    ).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const changedAccount of [false, true]) {
  test(
    changedAccount
      ? "closes the patch when session refresh signs in a different account"
      : "refreshes an expired recipient session before treating a patch as revoked",
    async ({ browser, instance }) => {
      const patch = await sharedPage(instance);
      await instance.platform.query("UPDATE patch_grants SET subject=$1 WHERE id='share_browser'", [
        recipient.sub
      ]);
      const context = await browser.newContext();
      try {
        await prepare(context, instance);
        await recipientSession(context, instance);
        let refreshes = 0;
        await installSessionRefreshBoundary(context, () => {
          refreshes++;
          return recipientSession(
            context,
            instance,
            false,
            changedAccount ? { sub: "user_other_browser", email: "other@example.com" } : recipient
          );
        });
        const page = await context.newPage();
        await page.goto(patch.address);
        await expect(
          page.frameLocator("#patch").getByRole("heading", { name: "Partner brief" })
        ).toBeVisible();
        await recipientSession(context, instance, true);
        await expect.poll(() => refreshes).toBe(1);
        if (changedAccount) {
          await expect(page).toHaveURL(`${instance.origin}/~shared/ended`);
          await expect(page.locator("iframe")).toHaveCount(0);
          expect((await context.request.get(patch.address)).status()).toBe(404);
          return;
        }
        await expect(page).toHaveURL(patch.address);
        await expect(
          page.frameLocator("#patch").getByRole("heading", { name: "Partner brief" })
        ).toBeVisible();
        expect(
          (
            await context.request.get(
              `${instance.origin}/~shared/access/${patch.patchId}/${patch.versionId}`
            )
          ).status()
        ).toBe(200);
      } finally {
        await context.close();
      }
    }
  );
}
