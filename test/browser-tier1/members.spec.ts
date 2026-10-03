import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, open, notice, installSessionRefreshBoundary } from "./fixtures.js";

test.use({ tls: true, ignoreHTTPSErrors: true });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Subscriptions target Chromium desktop."
);

const uses = { members: { kind: "members" as const } };

test("public directory broker pins one private principal for calls, subscriptions and reconnect", async ({
  page,
  context,
  instance
}) => {
  let refreshes = 0;
  await installSessionRefreshBoundary(context, () => {
    refreshes++;
    return instance.session(context);
  });
  const patch = await instance.publish("public", undefined, undefined, { uses });
  const shell = await context.request.get(patch.address);
  const html = await shell.text();
  expect(html).not.toContain("data-viewer-id");
  expect(html).not.toContain("usr_dev");
  const frame = await open(page, patch);
  await expect(frame.locator("#identity")).toHaveText("anonymous");
  expect(instance.streamConnections.size).toBe(0);
  expect(await page.locator('script[src="/auth/session.js"]').count()).toBe(0);
  await frame.evaluate((wire) => {
    const harness = (window as unknown as FixtureWindow).harness;
    for (const [id, op, args] of [
      ["list", "members.list", {}],
      ["search", "members.search", { text: "colleague" }],
      ["get", "members.get", { id: "usr_colleague" }],
      ["getMany", "members.getMany", { ids: ["usr_colleague"] }],
      ["subscribe", "subscriptions.subscribe", { id: "directory", op: "members.list", args: {} }]
    ])
      harness.raw({ v: wire, id, op, args });
  }, instance.wire);
  for (const id of ["list", "search", "get", "getMany"]) {
    await expect
      .poll(() =>
        frame.evaluate((id) => {
          const reply = (window as unknown as FixtureWindow).harness.replies.find(
            (reply) => reply.id === id
          );
          return reply?.kind === "result" && JSON.stringify(reply.value).includes("usr_colleague");
        }, id)
      )
      .toBe(true);
  }
  await expect
    .poll(() =>
      frame.evaluate(() =>
        (window as unknown as FixtureWindow).harness.replies.some(
          (reply) =>
            reply.data?.type === "snapshot" &&
            reply.data.id === "directory" &&
            JSON.stringify(reply.data.result).includes("usr_colleague")
        )
      )
    )
    .toBe(true);
  expect(
    instance.runtimeRequests.filter(
      (request) =>
        request.path === "/api/runtime/call" && JSON.parse(request.body).op === "principal"
    )
  ).toHaveLength(1);
  expect(
    await frame.evaluate(() => (window as unknown as FixtureWindow).harness.client.me())
  ).toBeNull();
  expect(
    await frame.evaluate(async () => {
      try {
        await (window as unknown as FixtureWindow).harness.client.tables.rows!.list();
        return "unexpected success";
      } catch (error) {
        return error !== null && typeof error === "object" && "code" in error ? error.code : null;
      }
    })
  ).toBe("not_available_on_public");

  instance.pauseStreams(true);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  instance.pauseStreams(false);
  await expect
    .poll(() =>
      frame.evaluate(
        () =>
          (window as unknown as FixtureWindow).harness.replies.filter(
            (reply) => reply.data?.type === "hello"
          ).length
      )
    )
    .toBe(2);
  await expect
    .poll(() =>
      frame.evaluate(() =>
        (window as unknown as FixtureWindow).harness.replies.some(
          (reply) => reply.data?.type === "up-to-date" && reply.data.id === "directory"
        )
      )
    )
    .toBe(true);
  instance.pauseStreams(true);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  await instance.session(context, "expired");
  instance.pauseStreams(false);
  await expect.poll(() => refreshes).toBe(1);
  await expect
    .poll(() =>
      frame.evaluate(
        () =>
          (window as unknown as FixtureWindow).harness.replies.filter(
            (reply) => reply.data?.type === "hello"
          ).length
      )
    )
    .toBe(3);
  await expect(page.locator('script[src="/auth/session.js"]')).toHaveCount(1);
  await expect(page.locator("[data-notice]")).toHaveCount(0);
  instance.pauseStreams(true);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  await instance.session(context, "colleague");
  instance.pauseStreams(false);
  await notice(page, "principal_changed");
});

test("public directory broker refuses outsiders without breaking public routes", async ({
  page,
  context,
  instance
}) => {
  const patch = await instance.publish("public", undefined, undefined, { uses });
  await instance.platform.query(
    "INSERT INTO companies (id, handle, name) VALUES ('cmp_foreign', 'foreign', 'Foreign')"
  );
  for (const viewer of ["anonymous", "foreign", "deactivated"] as const) {
    if (viewer === "anonymous") await instance.session(context, "none");
    else {
      await instance.platform.query(
        "UPDATE users SET company_id = $1, deactivated_at = $2 WHERE id = 'usr_colleague'",
        [
          viewer === "foreign" ? "cmp_foreign" : "cmp_dev",
          viewer === "deactivated" ? new Date() : null
        ]
      );
      await instance.session(context, "colleague");
    }
    const frame = await open(page, patch, "/items/2");
    await frame.evaluate((wire) => {
      const harness = (window as unknown as FixtureWindow).harness;
      harness.raw({ v: wire, id: "denied-list", op: "members.list", args: {} });
      harness.raw({
        v: wire,
        id: "denied-subscription",
        op: "subscriptions.subscribe",
        args: {
          id: "directory",
          op: "members.list",
          args: {}
        }
      });
    }, instance.wire);
    for (const id of ["denied-list", "denied-subscription"]) {
      await expect
        .poll(() =>
          frame.evaluate(
            (id) =>
              (window as unknown as FixtureWindow).harness.replies.find((reply) => reply.id === id)
                ?.error?.code,
            id
          )
        )
        .toBe(viewer === "anonymous" ? "session_expired" : "access_denied");
    }
    expect(instance.streamConnections.size).toBe(0);
    await frame.getByRole("button", { name: "Next route" }).click();
    await expect(page).toHaveURL(`${patch.address}/items/3`);
  }
});

test.describe("on a one-second reconcile tick", () => {
  // The tick is a deployment operating limit (30 seconds by default); shortening it
  // here keeps the subscription recheck inside expect's 15-second poll.
  test.use({
    serverEnvironment: {
      PATCHY_LIMITS_JSON: JSON.stringify({ "subscriptions.reconcile.interval": 1_000 })
    }
  });

  test("public directory calls and subscriptions keep the served tier 2 gate", async ({
    page,
    context,
    instance
  }) => {
    await installSessionRefreshBoundary(context, () => instance.session(context));
    const patch = await instance.publish("public", undefined, undefined, { uses });
    const frame = await open(page, patch);
    await frame.evaluate((wire) => {
      (window as unknown as FixtureWindow).harness.raw({
        v: wire,
        id: "subscribe",
        op: "subscriptions.subscribe",
        args: {
          id: "directory",
          op: "members.list",
          args: {}
        }
      });
    }, instance.wire);
    await expect
      .poll(() =>
        frame.evaluate(() =>
          (window as unknown as FixtureWindow).harness.replies.some(
            (reply) => reply.data?.type === "snapshot"
          )
        )
      )
      .toBe(true);
    await instance.share(patch.patchId, "company");
    const next = await instance.publish("company", undefined, patch.patchId, { uses });
    await instance.platform.query(
      "UPDATE patch_versions SET tier = 2, manifest = jsonb_set(manifest, '{tier}', '2') WHERE id = $1",
      [next.versionId]
    );
    await instance.lifecycle(patch.patchId, "rollback", 2);
    await frame.evaluate((wire) => {
      (window as unknown as FixtureWindow).harness.raw({
        v: wire,
        id: "upgraded-call",
        op: "members.list",
        args: {}
      });
    }, instance.wire);
    await expect
      .poll(() =>
        frame.evaluate(
          () =>
            (window as unknown as FixtureWindow).harness.replies.find(
              (reply) => reply.id === "upgraded-call"
            )?.error?.code
        )
      )
      .toBe("server_required");
    // Existing directory subscriptions recheck authority on the reconcile tick.
    await expect
      .poll(() =>
        frame.evaluate(() =>
          (window as unknown as FixtureWindow).harness.replies.some(
            (reply) =>
              reply.data?.type === "error" &&
              reply.data.id === "directory" &&
              reply.data.error.code === "server_required"
          )
        )
      )
      .toBe(true);
  });
});

test("public directory bootstrap refreshes an already-stale cookie before binding", async ({
  page,
  context,
  instance
}) => {
  let refreshes = 0;
  await installSessionRefreshBoundary(context, () => {
    refreshes++;
    return instance.session(context);
  });
  const patch = await instance.publish("public", undefined, undefined, { uses });
  await instance.session(context, "expired");
  const frame = await open(page, patch);
  await frame.evaluate((wire) => {
    const harness = (window as unknown as FixtureWindow).harness;
    harness.raw({ v: wire, id: "list", op: "members.list", args: {} });
    harness.raw({
      v: wire,
      id: "subscribe",
      op: "subscriptions.subscribe",
      args: {
        id: "directory",
        op: "members.list",
        args: {}
      }
    });
  }, instance.wire);
  await expect
    .poll(() =>
      frame.evaluate(() =>
        (window as unknown as FixtureWindow).harness.replies.find((reply) => reply.id === "list")
      )
    )
    .toMatchObject({
      kind: "result",
      value: { rows: expect.arrayContaining([expect.objectContaining({ id: "usr_dev" })]) }
    });
  await expect
    .poll(() =>
      frame.evaluate(() =>
        (window as unknown as FixtureWindow).harness.replies.some(
          (reply) => reply.data?.type === "snapshot"
        )
      )
    )
    .toBe(true);
  expect(refreshes).toBe(1);
  expect(
    instance.runtimeRequests.filter(
      (request) =>
        request.path === "/api/runtime/call" && JSON.parse(request.body).op === "principal"
    )
  ).toHaveLength(2);
  await expect(frame.locator("#identity")).toHaveText("anonymous");
});

test("public directory retries a failed bootstrap on the next member request", async ({
  page,
  context,
  instance
}) => {
  await installSessionRefreshBoundary(context, () => instance.session(context));
  const patch = await instance.publish("public", undefined, undefined, { uses });
  let dropped = false;
  await page.route("**/api/runtime/call", async (route) => {
    if (!dropped && route.request().postDataJSON().op === "principal") {
      dropped = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  const frame = await open(page, patch);
  for (const id of ["lost", "retry"]) {
    await frame.evaluate(
      ({ wire, id }) => {
        (window as unknown as FixtureWindow).harness.raw({
          v: wire,
          id,
          op: "members.list",
          args: {}
        });
      },
      { wire: instance.wire, id }
    );
    await expect
      .poll(() =>
        frame.evaluate(
          (id) =>
            (window as unknown as FixtureWindow).harness.replies.find((reply) => reply.id === id),
          id
        )
      )
      .toMatchObject(
        id === "lost"
          ? { kind: "error", error: { code: "unknown_outcome" } }
          : {
              kind: "result",
              value: { rows: expect.arrayContaining([expect.objectContaining({ id: "usr_dev" })]) }
            }
      );
  }
  expect(dropped).toBe(true);
  await expect(frame.locator("#identity")).toHaveText("anonymous");
});

for (const loss of ["deactivation", "company change"] as const) {
  test(`public call-only directory stops after viewer ${loss}`, async ({
    page,
    context,
    instance
  }) => {
    await installSessionRefreshBoundary(context, () => instance.session(context));
    const patch = await instance.publish("public", undefined, undefined, { uses });
    const frame = await open(page, patch);
    await frame.evaluate((wire) => {
      (window as unknown as FixtureWindow).harness.raw({
        v: wire,
        id: "initial",
        op: "members.list",
        args: {}
      });
    }, instance.wire);
    await expect
      .poll(() =>
        frame.evaluate(
          () =>
            (window as unknown as FixtureWindow).harness.replies.find(
              (reply) => reply.id === "initial"
            )?.kind
        )
      )
      .toBe("result");
    expect(instance.streamConnections.size).toBe(0);
    if (loss === "deactivation")
      await instance.platform.query("UPDATE users SET deactivated_at=now() WHERE id='usr_dev'");
    else {
      await instance.platform.query(
        "INSERT INTO companies (id, handle, name) VALUES ('cmp_foreign', 'foreign', 'Foreign')"
      );
      await instance.platform.query("UPDATE users SET company_id='cmp_foreign' WHERE id='usr_dev'");
    }
    await frame.evaluate((wire) => {
      (window as unknown as FixtureWindow).harness.raw({
        v: wire,
        id: "refused",
        op: "members.list",
        args: {}
      });
    }, instance.wire);
    await notice(page, "access_denied");
  });
}
