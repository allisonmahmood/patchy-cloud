import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, prepare, open, installSessionRefreshBoundary } from "./fixtures.js";
import { recipient, recipientSession } from "./external-recipient.js";

test.use({ serverEnvironment: { PATCHY_DEV_EXTERNAL_SHARING: "true" } });

test("revoking on another host ends the recipient stream and file access without wrapper polling", async ({
  browser,
  page: owner,
  instance
}) => {
  const patch = await instance.publish();
  await instance.platform.query(
    "INSERT INTO patch_grants (id,patch_id,email,subject,created_by,access) VALUES ('share_replica',$1,$2,$3,'usr_dev','write')",
    [patch.patchId, recipient.email, recipient.sub]
  );
  const replica = await instance.startReplica();
  const external = await browser.newContext();
  try {
    const ownerFrame = await open(owner, patch);
    await ownerFrame.evaluate(() =>
      (window as unknown as FixtureWindow).harness.client.files.assets!.put(
        "shared.txt",
        new TextEncoder().encode("Owner file"),
        { contentType: "text/plain" }
      )
    );
    await prepare(external, instance);
    await recipientSession(external, instance);
    await installSessionRefreshBoundary(external, () => recipientSession(external, instance));
    // Isolate runtime stream revocation from the wrapper's independent two-second check.
    await external.route("**/~shared/session.js*", (route) =>
      route.fulfill({ contentType: "text/javascript", body: "" })
    );
    const page = await external.newPage();
    const frame = await open(page, patch);
    await frame.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
    await expect(frame.locator("#subscription-rows")).toHaveText("[]");
    const cookie = async (context: typeof external) =>
      (await context.cookies(instance.origin))
        .map(({ name, value }) => `${name}=${value}`)
        .join("; ");
    const ownerCookie = await cookie(owner.context());
    const recipientCookie = await cookie(external);
    const write = await fetch(`${replica.origin}/api/runtime/call`, {
      method: "POST",
      headers: {
        cookie: ownerCookie,
        origin: instance.origin,
        "content-type": "application/json",
        "x-patchy-wire": String(instance.wire),
        "x-patchy-principal": JSON.stringify({ userId: "usr_dev" })
      },
      body: JSON.stringify({
        patchId: patch.patchId,
        versionId: patch.versionId,
        wire: instance.wire,
        principal: { userId: "usr_dev" },
        op: "tables.insert",
        args: { table: "rows", row: { label: "Written on the other host" } }
      })
    });
    expect(write.status).toBe(200);
    await expect(frame.locator("#subscription-rows")).toHaveText('["Written on the other host"]');
    const file = (origin: string) =>
      fetch(`${origin}/api/runtime/files/${patch.patchId}/${patch.versionId}/assets/shared.txt`, {
        headers: {
          cookie: recipientCookie,
          "sec-fetch-site": "same-origin",
          "x-patchy-wire": String(instance.wire),
          "x-patchy-principal": JSON.stringify({ userId: `recipient:${recipient.sub}` })
        }
      });
    expect(await (await file(replica.origin)).text()).toBe("Owner file");
    const revoked = await fetch(`${replica.origin}/~shared/revoke/share_replica`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: ownerCookie, origin: instance.origin }
    });
    expect(revoked.status).toBe(303);
    await expect(page).toHaveURL(/\/~shell\/notice\/access_denied\?/);
    await expect(page.locator("iframe")).toHaveCount(0);
    for (const origin of [instance.origin, replica.origin]) {
      const denied = await file(origin);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ ok: false, code: "access_denied" });
    }
    expect((await owner.request.get(patch.address)).status()).toBe(200);
  } finally {
    await external.close();
    await replica.stop();
  }
});
