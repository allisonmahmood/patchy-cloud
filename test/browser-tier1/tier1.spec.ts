import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, open, notice } from "./fixtures.js";
import { printFirefoxFrame } from "./firefox-print.js";
import { printChromiumFrame } from "./chromium-print.js";

test("route bridge, real client file URL, shell download, isolation and 2,000-row print", async ({
  page,
  instance,
  browserName
}, testInfo) => {
  const patch = await instance.publish();
  const frame = await open(page, patch, "/items/2?filter=active");
  await expect(frame.locator("#identity")).toHaveText("usr_dev");
  await expect(frame.locator("#route")).toHaveText("/items/2");
  await expect(frame.locator("#copy-status")).toHaveText("Copy unavailable");
  await frame.getByRole("button", { name: "Next route" }).click();
  await expect(page).toHaveURL(`${patch.address}/items/3?filter=active`);
  await page.goBack();
  await expect(frame.locator("#route")).toHaveText("/items/2");
  await page.goForward();
  await expect(frame.locator("#route")).toHaveText("/items/3");
  expect(
    await frame.evaluate(async () => {
      try {
        await (window as unknown as FixtureWindow).harness.client.route.set("/~content/escape");
        return "accepted";
      } catch (error) {
        return error && typeof error === "object" && "code" in error ? error.code : "unexpected";
      }
    })
  ).toBe("invalid_request");
  expect(page.url()).toBe(`${patch.address}/items/3?filter=active`);
  const row = await frame.evaluate(() =>
    (window as unknown as FixtureWindow).harness.client.tables.rows!.insert({
      label: "written through the real runtime"
    })
  );
  expect(
    await frame.evaluate(
      (id) => (window as unknown as FixtureWindow).harness.client.tables.rows!.get(id),
      row.id
    )
  ).toMatchObject({
    id: row.id,
    label: row.label
  });
  const logged = await instance.platform.query(
    "SELECT user_id, outcome FROM runtime_calls WHERE patch_id=$1 AND op='tables.insert'",
    [patch.patchId]
  );
  expect(logged.rows).toEqual([{ user_id: "usr_dev", outcome: "success" }]);

  const transferred = await frame.evaluate(async () => {
    const files = (window as unknown as FixtureWindow).harness.client.files.assets!;
    const bytes = new Uint8Array([0, 10, 20, 255]);
    await files.put("transferred.bin", bytes, { contentType: "application/octet-stream" });
    return { remaining: bytes.byteLength, stored: Array.from(await files.get("transferred.bin")) };
  });
  expect(transferred).toEqual({ remaining: 0, stored: [0, 10, 20, 255] });

  await frame.evaluate(() => (window as unknown as FixtureWindow).harness.image());
  expect(
    await frame.locator("#own-image").evaluate((image: HTMLImageElement) => ({
      blob: image.src.startsWith("blob:"),
      width: image.naturalWidth
    }))
  ).toEqual({ blob: true, width: 1 });
  const download = page.waitForEvent("download");
  await frame.getByRole("button", { name: "Download file" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("active.html");
  expect(await readFile((await file.path())!, "utf8")).toContain("<p>download bytes</p>");

  // Simulate a UA ignoring the download hint: active uploaded HTML must still download,
  // never become a same-origin shell document.
  await page.evaluate(() =>
    document.addEventListener(
      "click",
      (event) => {
        if (event.target instanceof HTMLAnchorElement && event.target.href.startsWith("blob:"))
          event.target.removeAttribute("download");
      },
      { capture: true, once: true }
    )
  );
  const forcedDownload = page.waitForEvent("download");
  await frame.getByRole("button", { name: "Download file" }).click();
  expect(await readFile((await (await forcedDownload).path())!, "utf8")).toContain(
    "<p>download bytes</p>"
  );
  expect(page.url()).toBe(`${patch.address}/items/3?filter=active`);

  await frame.getByRole("button", { name: "Copy text" }).click();
  await expect(frame.locator("#copy-status")).toHaveText("Copied");
  await frame.locator("#pasted-copy").press("Control+V");
  await expect(frame.locator("#pasted-copy")).toHaveValue("Patchy clipboard acceptance");

  const escaped = await frame.evaluate(async () => {
    let storage = "allowed";
    try {
      localStorage.setItem("escape", "yes");
    } catch (error) {
      storage = (error as Error).name;
    }
    let network = "allowed";
    try {
      await fetch("/healthz", { credentials: "include" });
    } catch (error) {
      network = (error as Error).name;
    }
    let popup = false;
    try {
      popup = window.open("/healthz") !== null;
    } catch {
      /* sandbox refusal */
    }
    let cookies: string;
    try {
      cookies = document.cookie;
    } catch (error) {
      cookies = (error as Error).name;
    }
    return { storage, network, popup, cookies, origin: window.origin };
  });
  expect(escaped).toEqual({
    storage: "SecurityError",
    network: "TypeError",
    popup: false,
    cookies: "SecurityError",
    origin: "null"
  });
  expect(page.context().pages()).toHaveLength(1);

  await frame.evaluate(() => (window as unknown as FixtureWindow).harness.printRows());
  await page.emulateMedia({ media: "print" });
  await expect(frame.locator("#rows tr")).toHaveCount(2000);
  await expect(frame.locator("#rows tr").first()).toHaveText("Print row 0001");
  await expect(frame.locator("#rows tr").last()).toHaveText("Print row 2000");
  const pdf = testInfo.outputPath("two-thousand-rows.pdf");
  if (browserName === "chromium") {
    await printChromiumFrame(patch.address, await page.context().cookies(), pdf);
  } else {
    await printFirefoxFrame(patch.address, await page.context().cookies(), pdf);
  }
  const text = execFileSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
  expect(text).toContain("Print row 0001");
  expect(text).toContain("Print row 2000");
});

test("hostile navigation, pending real reads/writes, malformed, oversized and duplicate envelopes", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  for (const target of [
    `${instance.foreignOrigin}/landed`,
    `${instance.foreignOrigin}/redirect`,
    `${instance.foreignOrigin}/204`,
    `${instance.origin}/~tier1/redirect`,
    `${instance.origin}/~tier1/204`
  ]) {
    const frame = await open(page, patch);
    const shell = page.url();
    instance.foreignRequests.length = 0;
    await frame.evaluate((target) => {
      location.href = target;
    }, target);
    // Let CSP violation/load tasks run; no external endpoint may receive even a navigation request.
    await page.waitForTimeout(250);
    expect(instance.foreignRequests).toEqual([]);
    expect(page.url()).toBe(shell);
    expect(
      page.frames().every((candidate) => !candidate.url().startsWith(instance.foreignOrigin))
    ).toBe(true);
  }

  const company = await instance.company();
  const table = `"p_${patch.patchId}"."rows"`;
  for (const op of ["tables.list", "tables.insert"]) {
    const frame = await open(page, patch);
    await company.query("BEGIN");
    await company.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    const marker = `pending-${op}`;
    const before = instance.runtimeRequests.length;
    await frame.evaluate(
      ({ op, marker }) => {
        const rows = (window as unknown as FixtureWindow).harness.client.tables.rows!;
        void (op === "tables.list" ? rows.list() : rows.insert({ label: marker })).catch(() => {});
      },
      { op, marker }
    );
    await expect
      .poll(async () => {
        const result = await instance.platform.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",
          [`%${patch.patchId}%`]
        );
        return result.rows[0].n;
      })
      .toBeGreaterThan(0);
    try {
      await frame.evaluate(() => {
        location.href = "/~tier1/replacement";
      });
      await expect(
        page.frameLocator("#patch").getByRole("heading", { name: "Replacement document" })
      ).toBeVisible();
    } finally {
      await company.query("COMMIT");
    }
    await expect
      .poll(
        () =>
          instance.runtimeRequests
            .slice(before)
            .filter((request) => request.body.includes(`"op":"${op}"`)).length
      )
      .toBe(1);
    await page.waitForTimeout(200);
    const replacement = page
      .frames()
      .find((candidate) => candidate.url().includes("/~tier1/replacement"))!;
    expect(await replacement.evaluate("window.received")).toEqual([]);
    // The write may commit after its caller leaves: once, never replayed into the replacement.
    if (op === "tables.insert") {
      await expect
        .poll(
          async () =>
            (
              await company.query(`SELECT count(*)::int AS n FROM ${table} WHERE label=$1`, [
                marker
              ])
            ).rows[0].n
        )
        .toBe(1);
    }
  }

  const frame = await open(page, patch);
  const beforeMalformed = instance.runtimeRequests.length;
  await frame.evaluate((wire) => {
    const h = (window as unknown as FixtureWindow).harness;
    h.raw(null);
    h.raw({ v: wire, id: "bad-schema", op: "tables.list", args: { table: 123 } });
    h.raw({ v: wire, id: "inherited", op: "toString", args: {} });
    h.raw({
      v: wire,
      id: "large",
      op: "tables.insert",
      args: { table: "rows", row: { label: "x".repeat(3 * 1024 * 1024) } }
    });
  }, instance.wire);
  await expect
    .poll(() =>
      frame.evaluate(() =>
        (window as unknown as FixtureWindow).harness.replies
          .filter((reply) => ["bad-schema", "inherited", "large"].includes(reply.id ?? ""))
          .map((reply) => [reply.id, reply.error?.code])
          .sort()
      )
    )
    .toEqual([
      ["bad-schema", "invalid_request"],
      ["inherited", "invalid_request"],
      ["large", "too_large"]
    ]);
  expect(instance.runtimeRequests.slice(beforeMalformed)).toEqual([]);

  await frame.evaluate((wire) => {
    const bytes = new ArrayBuffer(21 * 1024 * 1024);
    (window as unknown as FixtureWindow).harness.raw(
      {
        v: wire,
        id: "file-over-limit",
        op: "files.put",
        args: { store: "assets", name: "oversize", contentType: "application/octet-stream" },
        bytes
      },
      [bytes]
    );
  }, instance.wire);
  await expect
    .poll(() =>
      frame.evaluate(
        () =>
          (window as unknown as FixtureWindow).harness.replies.find(
            (reply) => reply.id === "file-over-limit"
          )?.error?.code
      )
    )
    .toBe("too_large");
  expect(instance.runtimeRequests.slice(beforeMalformed)).toEqual([]);

  await company.query("BEGIN");
  await company.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
  try {
    await frame.evaluate((wire) => {
      const h = (window as unknown as FixtureWindow).harness;
      for (let i = 0; i < 33; i++)
        h.raw({ v: wire, id: `bounded-${i}`, op: "tables.list", args: { table: "rows" } });
    }, instance.wire);
    await expect
      .poll(() =>
        frame.evaluate(
          () =>
            (window as unknown as FixtureWindow).harness.replies.find(
              (reply) => reply.id === "bounded-32"
            )?.error?.code
        )
      )
      .toBe("too_many_requests");
  } finally {
    await company.query("COMMIT");
  }
  await expect
    .poll(() =>
      frame.evaluate(
        () =>
          (window as unknown as FixtureWindow).harness.replies.filter(
            (reply) => reply.id?.startsWith("bounded-") && reply.id !== "bounded-32"
          ).length
      )
    )
    .toBe(32);
  const bounded = await frame.evaluate(() =>
    (window as unknown as FixtureWindow).harness.replies.filter(
      (reply) => reply.id?.startsWith("bounded-") && reply.id !== "bounded-32"
    )
  );
  // The real company pool may refuse concurrent leases; the broker must settle every accepted call.
  expect(bounded.some((reply) => reply.kind === "result")).toBe(true);
  expect(bounded.every((reply) => reply.kind === "result" || reply.error?.code === "busy")).toBe(
    true
  );

  await company.query("BEGIN");
  await company.query("LOCK TABLE patchy.files IN ACCESS EXCLUSIVE MODE");
  try {
    await frame.evaluate((wire) => {
      const h = (window as unknown as FixtureWindow).harness;
      for (let i = 0; i < 4; i++) {
        const bytes = new ArrayBuffer(17 * 1024 * 1024);
        h.raw(
          {
            v: wire,
            id: `held-${i}`,
            op: "files.put",
            args: { store: "assets", name: `held-${i}`, contentType: "application/octet-stream" },
            bytes
          },
          [bytes]
        );
      }
    }, instance.wire);
    await expect
      .poll(() =>
        frame.evaluate(
          () =>
            (window as unknown as FixtureWindow).harness.replies.find(
              (reply) => reply.id === "held-3"
            )?.error?.code
        )
      )
      .toBe("too_large");
  } finally {
    await company.query("COMMIT");
  }
  await expect
    .poll(() =>
      frame.evaluate(
        () =>
          (window as unknown as FixtureWindow).harness.replies.filter(
            (reply) => reply.id?.startsWith("held-") && reply.kind === "result"
          ).length
      )
    )
    .toBe(3);
  await company.query("BEGIN");
  await company.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
  const beforeDuplicate = instance.runtimeRequests.length;
  await frame.evaluate((wire) => {
    const h = (window as unknown as FixtureWindow).harness;
    const message = {
      v: wire,
      id: "duplicate",
      op: "tables.insert",
      args: { table: "rows", row: { label: "duplicate" } }
    };
    h.raw(message);
    h.raw(message);
  }, instance.wire);
  try {
    await expect
      .poll(() =>
        frame.evaluate(
          () =>
            (window as unknown as FixtureWindow).harness.replies.find(
              (reply) => reply.id === "duplicate"
            )?.error?.code
        )
      )
      .toBe("invalid_request");
  } finally {
    await company.query("COMMIT");
  }
  await page.waitForTimeout(200);
  expect(
    instance.runtimeRequests
      .slice(beforeDuplicate)
      .filter((request) => request.body.includes('"op":"tables.insert"')).length
  ).toBeLessThanOrEqual(1);
  expect(
    (await company.query(`SELECT count(*)::int AS n FROM ${table} WHERE label='duplicate'`)).rows[0]
      .n
  ).toBeLessThanOrEqual(1);
});

test("real sessions: login door, logout, expiry, account switch, revocation and public errors", async ({
  page,
  context,
  instance
}) => {
  const patch = await instance.publish();
  await instance.session(context, "none");
  expect((await page.goto(patch.address))?.status()).toBe(401);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await instance.session(context);
  await open(page, patch);
  for (const user of ["none", "expired", "colleague"] as const) {
    await instance.session(context);
    const frame = await open(page, patch, "/items/2?return=this");
    await instance.session(context, user);
    await frame.evaluate(() => {
      void (window as unknown as FixtureWindow).harness.client.tables.rows!.list().catch(() => {});
    });
    await notice(page, user === "colleague" ? "principal_changed" : "session_expired");
    const login = page.getByRole("link", { name: "Sign in", exact: true });
    const target = new URL((await login.getAttribute("href"))!, instance.origin);
    expect(target.pathname).toBe("/login");
    expect(new URL(target.searchParams.get("return")!, instance.origin).href).toBe(
      `${patch.address}/items/2?return=this`
    );
    // Complete the real return/enrollment hop with a newly issued offline session.
    await instance.session(context, user === "colleague" ? "colleague" : "owner");
    await page.goto(
      `${instance.origin}/join?return=${encodeURIComponent(target.searchParams.get("return")!)}`
    );
    await expect(page).toHaveURL(`${patch.address}/items/2?return=this`);
    await expect(page.frameLocator("#patch").locator("#identity")).toHaveText(
      user === "colleague" ? "usr_colleague" : "usr_dev"
    );
  }
  await instance.session(context);
  const frame = await open(page, patch);
  // Even an activated patch that requests an unload confirmation cannot veto revocation.
  await frame.getByRole("button", { name: "Next route" }).click();
  await frame.evaluate(() => {
    window.addEventListener("beforeunload", (event) => {
      event.preventDefault();
      event.returnValue = "";
    });
  });
  await instance.platform.query("UPDATE users SET deactivated_at=now() WHERE id='usr_dev'");
  try {
    await frame.evaluate(() => {
      void (window as unknown as FixtureWindow).harness.client.tables.rows!.list().catch(() => {});
    });
    await notice(page, "access_denied");
    await expect(page.getByRole("link", { name: /reload|sign in/i })).toHaveCount(0);

    const door = await page.goto(patch.address);
    expect(door?.status()).toBe(403);
    const policy = door!.headers()["content-security-policy"]!;
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("https://clerk.patchy.invalid");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(door!.headers()["referrer-policy"]).toBe("same-origin");
    let signOut: { method: string; origin: string | undefined } | undefined;
    // Stop before the external provider: prove the real browser can submit the Auth form.
    // AuthPages.socket.test covers the handler's revocation/303/cookie-clearing contract offline.
    await context.route("**/logout", async (route) => {
      signOut = { method: route.request().method(), origin: route.request().headers()["origin"] };
      await route.abort();
    });
    try {
      await page
        .getByRole("button", { name: "Sign out", exact: true })
        .click({ noWaitAfter: true });
      await expect.poll(() => signOut).toEqual({ method: "POST", origin: instance.origin });
    } finally {
      await context.unroute("**/logout");
    }
  } finally {
    await instance.platform.query("UPDATE users SET deactivated_at=NULL WHERE id='usr_dev'");
  }
  const publicPatch = await instance.publish("public");
  for (const user of ["none", "owner"] as const) {
    await instance.session(context, user);
    const anonymous = await open(page, publicPatch, "/items/2?filter=public");
    await expect(anonymous.locator("#identity")).toHaveText("anonymous");
    expect(
      await anonymous.evaluate(() => (window as unknown as FixtureWindow).harness.client.me())
    ).toBeNull();
    expect(
      await anonymous.evaluate(() =>
        (window as unknown as FixtureWindow).harness.client.route.get()
      )
    ).toBe("/items/2");
    await anonymous.getByRole("button", { name: "Next route" }).click();
    await expect(page).toHaveURL(`${publicPatch.address}/items/3?filter=public`);
    await page.goBack();
    await expect(anonymous.locator("#route")).toHaveText("/items/2");
    await page.goForward();
    await expect(anonymous.locator("#route")).toHaveText("/items/3");
    expect(
      await anonymous.evaluate(async () => {
        try {
          await (window as unknown as FixtureWindow).harness.client.tables.rows!.list();
          return "accepted";
        } catch (error) {
          return error && typeof error === "object" && "code" in error ? error.code : "unexpected";
        }
      })
    ).toBe("not_available_on_public");
    await expect(page).toHaveURL(`${publicPatch.address}/items/3?filter=public`);
    await expect(anonymous.locator("#identity")).toHaveText("anonymous");
    await anonymous.evaluate(() =>
      (window as unknown as FixtureWindow).harness.client.route.set("/still-open")
    );
    await expect(page).toHaveURL(`${publicPatch.address}/still-open?filter=public`);
  }
});

test("cross-site simple POST refusal, response CSP and one terminal stale public refresh", async ({
  page,
  context,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  await frame.evaluate(() => (window as unknown as FixtureWindow).harness.image());
  const content = await page.locator("#patch").getAttribute("src");
  const headers = {
    "x-patchy-wire": String(instance.wire),
    "x-patchy-principal": JSON.stringify({ userId: "usr_dev" }),
    origin: instance.origin,
    "sec-fetch-site": "same-origin"
  };
  const active = await context.request.get(
    `${instance.origin}/api/runtime/files/${patch.patchId}/${patch.versionId}/assets/active.html`,
    { headers }
  );
  expect(active.status()).toBe(200);
  expect(active.headers()["content-security-policy"]).toContain("sandbox");
  expect(active.headers()["content-disposition"]).toContain("attachment");
  for (const path of [content!, "/~content/missing/missing", "/~tier1/redirect"]) {
    const response = await context.request.get(instance.origin + path, { maxRedirects: 0 });
    expect(response.headers()["content-security-policy"]).toContain("sandbox");
  }
  const htmlResponse = await context.request.get(instance.origin + content!);
  expect(htmlResponse.headers()["content-security-policy"]).toContain("connect-src 'none'");
  expect(htmlResponse.headers()["permissions-policy"]).toContain("camera=()");
  expect(htmlResponse.headers()["content-type"]).toBe("text/html; charset=utf-8");
  const shellResponse = await context.request.get(patch.address);
  expect(shellResponse.headers()["content-security-policy"]).toContain("frame-src 'self'");
  expect(shellResponse.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");

  const unicodeTitle = "Olá — 東京";
  const unicode = await instance.publish(
    "public",
    instance.html.replace("<h1>Tier one acceptance</h1>", `<h1>${unicodeTitle}</h1>`)
  );
  const unicodeFrame = await open(page, unicode);
  await expect(unicodeFrame.locator("h1")).toHaveText(unicodeTitle);
  for (const parent of [`${instance.origin}/~tier1/embed`, `${instance.foreignOrigin}/embed`]) {
    // A CSP-denied frame may expose only a failed navigation, not a response event.
    const framed = page.waitForEvent(
      "requestfailed",
      (request) => request.url() === unicode.address
    );
    await page.goto(`${parent}?target=${encodeURIComponent(unicode.address)}`);
    await framed;
    expect(page.frames().map((child) => child.url())).not.toContain(unicode.address);
  }
  await instance.session(context, "none");
  const denied = await context.request.get(instance.origin + content!);
  expect(denied.status()).toBe(401);
  expect(denied.headers()["content-security-policy"]).toContain("sandbox");

  await instance.session(context);
  const attack = await context.newPage();
  await attack.goto(instance.foreignOrigin);
  const posted = attack.waitForResponse(
    (response) => response.url() === `${instance.origin}/api/runtime/call`
  );
  await attack.evaluate(
    ({ origin, patchId, versionId, wire }) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = `${origin}/api/runtime/call`;
      form.enctype = "text/plain";
      const input = document.createElement("input");
      // text/plain's name=value separator is inside the JSON string: this is a valid envelope,
      // not a parser failure masquerading as CSRF protection.
      const body = JSON.stringify({
        patchId,
        versionId,
        wire,
        principal: { userId: "usr_dev" },
        op: "tables.insert",
        args: { table: "rows", row: { label: "cross-site=" } }
      });
      const separator = body.indexOf("=");
      input.name = body.slice(0, separator);
      input.value = body.slice(separator + 1);
      form.append(input);
      document.body.append(form);
      form.submit();
    },
    {
      origin: instance.origin,
      patchId: patch.patchId,
      versionId: patch.versionId,
      wire: instance.wire
    }
  );
  const refusal = await posted;
  expect(refusal.status()).toBe(400);
  expect(await refusal.json()).toMatchObject({ ok: false, code: "invalid_request" });
  expect(
    (
      await instance.platform.query(
        "SELECT count(*)::int AS n FROM runtime_calls WHERE patch_id=$1 AND op='tables.insert'",
        [patch.patchId]
      )
    ).rows[0].n
  ).toBe(0);
  await attack.close();

  // A cached/deployed bundle speaks the old wire on every load, including after refresh.
  const stale =
    "<!doctype html><html><head><title>Stale public bundle</title></head><body><script>addEventListener('message',e=>{if(e.source===parent&&e.data?.kind==='bootstrap')e.ports[0].postMessage({kind:'ready',wire:999,nonce:e.data.nonce})})</script></body></html>";
  const publicPatch = await instance.publish("public", stale);
  await instance.session(context, "none");
  const addresses: string[] = [];
  page.on("request", (request) => {
    if (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      request.url().startsWith(publicPatch.address)
    )
      addresses.push(request.url());
  });
  await page.goto(publicPatch.address);
  await notice(page, "shell_outdated");
  expect(addresses).toEqual([
    publicPatch.address,
    `${publicPatch.address}?__patchy_shell_reload=1`
  ]);
  await page.waitForTimeout(300);
  expect(addresses).toHaveLength(2);

  // A genuinely retired stored wire never loads the bundle, even on a public address.
  await instance.platform.query("UPDATE patch_versions SET wire_version=999 WHERE id=$1", [
    publicPatch.versionId
  ]);
  expect((await page.goto(publicPatch.address))?.status()).toBe(409);
  await expect(page.locator('[data-notice="needs_rebuild"]')).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);

  const wrongNonce = `<!doctype html><script>addEventListener('message',e=>{if(e.source===parent&&e.data?.kind==='bootstrap')e.ports[0].postMessage({kind:'ready',wire:${instance.wire},nonce:'wrong-document'})})</script>`;
  const unbound = await instance.publish("public", wrongNonce);
  const callsBefore = instance.runtimeRequests.length;
  await page.goto(unbound.address);
  await notice(page, "bootstrap_failed");
  expect(instance.runtimeRequests).toHaveLength(callsBefore);
});
