import { namespace, quoteIdentifier } from "../../packages/company-database/src/Inventory.js";
import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, open } from "./fixtures.js";

test.use({ tls: true, ignoreHTTPSErrors: true });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Subscriptions target Chromium desktop."
);

test("cross-host writes recover after listener loss and publisher death between commit and NOTIFY", async ({
  page,
  context,
  instance
}) => {
  const patch = await instance.publish();
  const reader = await open(page, patch);
  await reader.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
  await expect(reader.locator("#subscription-rows")).toHaveText("[]");
  let replica = await instance.startReplica();
  let blockedBackend: number | undefined;
  const cookie = (await context.cookies(instance.origin))
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const insert = async (label: string) => {
    const response = await fetch(`${replica.origin}/api/runtime/call`, {
      method: "POST",
      headers: {
        cookie,
        origin: instance.origin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        "x-patchy-wire": String(instance.wire),
        "x-patchy-principal": JSON.stringify({ userId: "usr_dev" })
      },
      body: JSON.stringify({
        patchId: patch.patchId,
        versionId: patch.versionId,
        wire: instance.wire,
        principal: { userId: "usr_dev" },
        op: "tables.insert",
        args: { table: "rows", row: { label } }
      })
    });
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ ok: true, value: { label } });
  };
  try {
    await insert("written on another host");
    await expect(reader.locator("#subscription-rows")).toHaveText('["written on another host"]');

    const listenerQuery = `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
      AND query ~* '^\\s*LISTEN\\s+"?patchy_runtime_wakes'`;
    await expect.poll(async () => (await instance.platform.query(listenerQuery)).rowCount).toBe(2);
    const listeners = await instance.platform.query<{ pid: number }>(listenerQuery);
    await instance.platform.query(
      "SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid",
      [listeners.rows.map(({ pid }) => pid)]
    );
    await insert("written during listener recovery");
    await expect(reader.locator("#subscription-rows")).toHaveText(
      '["written during listener recovery","written on another host"]'
    );
    const company = await instance.company();
    const revision = async () =>
      (
        await company.query<{ revision: string }>(
          "SELECT resource_revision::text AS revision FROM patchy.tables WHERE patch_id=$1 AND name='rows'",
          [patch.patchId]
        )
      ).rows[0]!.revision;
    const before = await revision();
    await replica.stop();
    // Only this disposable database shadows pg_notify. A fresh host resolves the
    // barrier before the builtin, so its real write commits but cannot notify.
    await instance.platform.query(`
      CREATE FUNCTION public.pg_notify(channel text, payload text) RETURNS void
        LANGUAGE plpgsql AS $barrier$
      BEGIN
        IF channel = 'patchy_runtime_wakes' THEN
          PERFORM pg_catalog.pg_advisory_lock(426, 394);
        END IF;
        PERFORM pg_catalog.pg_notify(channel, payload);
      END
      $barrier$;
      ALTER DATABASE patchy SET search_path = public, pg_catalog;
      SELECT pg_advisory_lock(426, 394);
    `);
    replica = await instance.startReplica();
    const reply = insert("committed before publisher death").then(
      () => "answered",
      () => "disconnected"
    );
    await expect
      .poll(async () => {
        const blocked = await instance.platform.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event='advisory' AND query LIKE 'SELECT pg_notify%'`
        );
        blockedBackend = blocked.rows[0]?.pid;
        return blocked.rows.length;
      })
      .toBe(1);
    expect(await revision()).toBe(String(BigInt(before) + 1n));
    expect(
      (
        await company.query<{ label: string }>(
          `SELECT label FROM ${quoteIdentifier(namespace(patch.patchId))}."rows"
            WHERE label=$1`,
          ["committed before publisher death"]
        )
      ).rows
    ).toEqual([{ label: "committed before publisher death" }]);
    await replica.stop("SIGKILL");
    expect(await reply).toBe("disconnected");
    // Keep NOTIFY blocked until the surviving host has reconciled the committed row.
    await expect(reader.locator("#subscription-rows")).toHaveText(
      '["committed before publisher death","written during listener recovery","written on another host"]',
      { timeout: 45_000 }
    );
    await expect(page.locator('[data-stream-status="reconnecting"]')).toBeHidden();
  } finally {
    await replica.stop("SIGKILL");
    if (blockedBackend !== undefined)
      await instance.platform.query("SELECT pg_terminate_backend($1)", [blockedBackend]);
    await instance.platform.query("SELECT pg_advisory_unlock(426, 394)");
  }
});
