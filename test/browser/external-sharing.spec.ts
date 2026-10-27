import { test, expect, openSeededPatch, signIn } from "./fixtures.js";

test.use({ externalSharing: true });

test("a fresh recipient signs up through the real invitation and cannot enroll as a builder", async ({
  live
}, testInfo) => {
  test.skip(
    !live.settings.recipientEmail,
    "Set CLERK_TEST_RECIPIENT_EMAIL to a fresh disposable alias and run headed for Clerk's human verification."
  );
  testInfo.setTimeout(900_000);
  const client = live.client;
  const email = live.settings.recipientEmail!;
  expect((await client.users.getUserList({ emailAddress: [email] })).totalCount).toBe(0);
  const owner = await openSeededPatch(live);
  const context = await live.newContext();
  try {
    await owner.goto(`${live.origin}/shared`);
    await owner.getByLabel("Recipient’s email", { exact: true }).fill(email);
    await owner.getByRole("button", { name: "Invite to this patch", exact: true }).click();
    const invitations = await client.invitations.getInvitationList({
      query: email,
      status: "pending"
    });
    const invitation = invitations.data.find((item) => item.emailAddress === email)!;
    expect(invitation.publicMetadata?.patchySignup).toBe("patch-recipient");
    const recipient = await context.newPage();
    const invitationUrl = new URL(invitation.url!);
    const testing = await client.testingTokens.createTestingToken();
    invitationUrl.searchParams.set("__clerk_testing_token", testing.token);
    await recipient.goto(invitationUrl.href);
    // The hosted portal can require a human challenge despite API testing tokens.
    // Leave that to the person in the headed browser; never automate the CAPTCHA.
    await recipient
      .getByRole("button", { name: "Continue", exact: true })
      .waitFor({ timeout: 600_000 });
    const first = recipient.getByLabel(/^First name/);
    const last = recipient.getByLabel(/^Last name/);
    if (await first.count()) await first.fill("Patch");
    if (await last.count()) await last.fill("Recipient");
    const legal = recipient.getByRole("checkbox");
    if (await legal.count()) await legal.check();
    await recipient.getByRole("button", { name: "Continue", exact: true }).click();
    await recipient.waitForURL(
      (url) => url.origin === live.origin && url.pathname.startsWith("/~shared/invite/")
    );
    await recipient.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect(recipient).toHaveURL(live.patchUrl);
    await expect(
      recipient
        .frameLocator("iframe")
        .getByRole("heading", { name: "Company-only browser fixture" })
    ).toBeVisible();
    const users = await client.users.getUserList({ emailAddress: [email] });
    expect(users.totalCount).toBe(1);
    expect(users.data[0]!.publicMetadata.patchySignup).toBe("patch-recipient");
    expect(
      users.data[0]!.emailAddresses.find((item) => item.emailAddress === email)?.verification
        ?.status
    ).toBe("verified");
    const create = await context.request.post(`${live.origin}/join`, {
      headers: { origin: live.origin },
      form: { action: "create", name: "Should not exist", handle: "recipient-escalation" },
      maxRedirects: 0
    });
    expect(create.status()).toBe(403);
    expect((await context.request.get(`${live.origin}/company`)).status()).toBe(403);
    expect((await context.request.post(`${live.origin}/api/publish`, { data: {} })).status()).toBe(
      401
    );
    await recipient.goto(`${live.origin}/`);
    await expect(
      recipient.getByRole("heading", { name: "Shared with you", exact: true })
    ).toBeVisible();
    await owner.reload();
    await owner.getByRole("button", { name: "Revoke access", exact: true }).click();
    expect((await context.request.get(live.patchUrl)).status()).toBe(404);
  } finally {
    await context.close();
    // The assertion above refuses pre-existing accounts before any mail or cleanup.
    const users = await client.users.getUserList({ emailAddress: [email] });
    for (const user of users.data) await client.users.deleteUser(user.id);
    const pending = await client.invitations.getInvitationList({ query: email, status: "pending" });
    for (const invitation of pending.data)
      if (invitation.emailAddress === email)
        await client.invitations.revokeInvitation(invitation.id);
  }
});

test("an existing member receives a real patch invitation without changing their own company", async ({
  live
}) => {
  await live.createOutsider();
  const owner = await openSeededPatch(live);
  const context = await live.newContext();
  try {
    const recipient = await context.newPage();
    await recipient.goto(`${live.origin}/join`);
    await signIn(
      recipient,
      live.settings.outsiderEmail,
      (url) => url.origin === live.origin && url.pathname === "/join"
    );
    await recipient.getByLabel("Company name", { exact: true }).fill("Recipient Company");
    await recipient.getByLabel("Company handle", { exact: true }).fill("receiving-company");
    await recipient.getByRole("button", { name: "Create company", exact: true }).click();
    await expect(
      recipient.getByRole("link", { name: "Recipient Company", exact: true })
    ).toBeVisible();
    expect((await context.request.get(live.patchUrl)).status()).toBe(404);
    await owner.goto(`${live.origin}/shared`);
    const patchId = await owner.getByLabel("Patch", { exact: true }).inputValue();
    await owner.getByLabel("Recipient’s email", { exact: true }).fill(live.settings.outsiderEmail);
    await owner.getByRole("button", { name: "Invite to this patch", exact: true }).click();
    await recipient.goto(`${live.origin}/shared`);
    await recipient.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect(recipient).toHaveURL(live.patchUrl);
    await expect(
      recipient
        .frameLocator("iframe")
        .getByRole("heading", { name: "Company-only browser fixture" })
    ).toBeVisible();
    expect(
      (
        await context.request.post(`${live.origin}/~shared/grant`, {
          headers: { origin: live.origin },
          form: { patchId, email: "forward@example.com", access: "write" },
          maxRedirects: 0
        })
      ).status()
    ).toBe(403);
    for (const path of ["/company", "/patches", "/machines"])
      expect((await context.request.get(`${live.origin}${path}`)).status(), path).toBe(200);
    await recipient.goto(`${live.origin}/company`);
    await expect(
      recipient.getByRole("link", { name: "Recipient Company", exact: true })
    ).toBeVisible();
    await owner.reload();
    await owner.getByRole("button", { name: "Revoke access", exact: true }).click();
    expect((await context.request.get(live.patchUrl)).status()).toBe(404);
    expect((await context.request.get(`${live.origin}/company`)).status()).toBe(200);
  } finally {
    await context.close();
  }
});
