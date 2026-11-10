import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { DeviceLogins, SetupLinks } from "@patchy/auth";
import { PUBLIC_BASE_URL } from "@patchy/auth/testing";
import { sha256 } from "../../../test/crypto.js";
import { Patches } from "@patchy/patches";
import {
  DAY,
  events,
  socket,
  type Person,
  company,
  actor,
  manifest,
  publish,
  readPatch,
  request,
  post,
  text,
  heading,
  links,
  cardPath,
  lineOf,
  steps,
  shelf,
  unread,
  menuItems,
  invoke,
  seedOf,
  publishTier2
} from "./test/fixtures.js";

it.layer(socket)("Home and the guide on a socket", (it) => {
  it.effect("lays Final step over Home until the person connects their agent", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      const fresh = yield* request("/", workspace.owner);
      assert.strictEqual(fresh.status, 200);
      const html = yield* fresh.text;
      // Home is still Home, inert and blurred behind the panel.
      assert.strictEqual(heading(html), "Nothing here yet");
      assert.include(html, '<div class="app" inert>');
      assert.include(
        html,
        '<section class="modal-panel final-step" role="dialog" aria-modal="true" aria-labelledby="final-step-heading" data-guide-modal>'
      );
      assert.include(
        html,
        '<h1 class="page-heading" id="final-step-heading" tabindex="-1">Final step</h1>'
      );
      assert.deepStrictEqual(steps(html), [
        ["current", "Give your agent this line"],
        ["upcoming", "Confirm it’s you"]
      ]);
      // The line carries the person's setup link, kept across reloads.
      const setup = lineOf(html);
      assert.match(
        setup,
        new RegExp(`^Set up Patchy using ${PUBLIC_BASE_URL}/llms\\.txt\\?s=[a-z2-7]{26}$`)
      );
      assert.include(html, `data-copy="${setup}"`);
      assert.strictEqual(lineOf(yield* (yield* request("/", workspace.owner)).text), setup);
      assert.include(html, '<script defer src="/assets/guide.js"></script>');
      assert.include(html, '<form class="final-step-later" method="post" action="/guide/later">');
      // Home's own way back stays while nothing is connected.
      assert.include(html, '<a class="tile-row tile-row-placeholder" href="/guide">');

      // Later is for this sign-in only, and only from this account's page.
      const cross = yield* request("/guide/later", workspace.owner, { user: workspace.owner.id });
      assert.strictEqual(cross.status, 403);
      const stale = yield* post("/guide/later", workspace.owner, { user: workspace.member.id });
      assert.strictEqual(stale.status, 409);
      assert.include(yield* (yield* request("/", workspace.owner)).text, "data-guide-modal");
      const later = yield* post("/guide/later", workspace.owner, { user: workspace.owner.id });
      assert.strictEqual(later.status, 303);
      assert.strictEqual(later.headers.location, "/");
      assert.notInclude(yield* (yield* request("/", workspace.owner)).text, "data-guide-modal");
      const next = yield* (yield* request("/", workspace.owner, undefined, { sid: "sess_2" })).text;
      assert.include(next, "data-guide-modal");

      // Someone with a live machine token sees Home alone, without the way back.
      const member = yield* (yield* request("/", workspace.member)).text;
      assert.notInclude(member, "data-guide-modal");
      assert.notInclude(member, '<div class="app" inert>');
      assert.notInclude(member, 'class="tile-row tile-row-placeholder"');
    })
  );

  it.effect(
    "shows the panel for the first week or the first three sign-ins, whichever is longer",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE machine_tokens SET revoked_at = now()
        WHERE user_id IN (${workspace.owner.id}, ${workspace.member.id})`;
        yield* sql`UPDATE users SET created_at = now() - interval '8 days'
        WHERE id IN (${workspace.owner.id}, ${workspace.member.id})`;
        const shown = (person: Person, sid: string) =>
          request("/", person, undefined, { sid }).pipe(
            Effect.flatMap((response) => response.text),
            Effect.map((html) => html.includes("data-guide-modal"))
          );
        assert.deepStrictEqual(
          [
            yield* shown(workspace.owner, "s1"),
            yield* shown(workspace.owner, "s2"),
            yield* shown(workspace.owner, "s3"),
            yield* shown(workspace.owner, "s4"),
            yield* shown(workspace.owner, "s1"),
            yield* shown(workspace.owner, "s5")
          ],
          [true, true, true, false, true, false]
        );
        // Inside the first week every sign-in shows it, a fifth included, and Later sticks for the
        // sign-in that pressed it alone.
        yield* sql`UPDATE users SET created_at = now() WHERE id = ${workspace.owner.id}`;
        assert.isTrue(yield* shown(workspace.owner, "s6"));
        const later = yield* request(
          "/guide/later",
          workspace.owner,
          { user: workspace.owner.id },
          { origin: PUBLIC_BASE_URL, sid: "s6" }
        );
        assert.strictEqual(later.status, 303);
        assert.isFalse(yield* shown(workspace.owner, "s6"));
        assert.isTrue(yield* shown(workspace.owner, "s7"));
        // A connected person's sign-ins count too, so revoking every key later never reopens it.
        yield* sql`UPDATE machine_tokens SET revoked_at = NULL WHERE user_id = ${workspace.member.id}`;
        for (const sid of ["m1", "m2", "m3", "m4"]) yield* shown(workspace.member, sid);
        yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.member.id}`;
        assert.isFalse(yield* shown(workspace.member, "m5"));
      })
  );

  it.effect("counts two new sign-ins arriving at once as two, not both third", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      yield* sql`UPDATE users SET created_at = now() - interval '8 days' WHERE id = ${workspace.owner.id}`;
      const shown = (sid: string) =>
        request("/", workspace.owner, undefined, { sid }).pipe(
          Effect.flatMap((response) => response.text),
          Effect.map((html) => html.includes("data-guide-modal"))
        );
      yield* shown("c1");
      yield* shown("c2");
      const both = yield* Effect.all([shown("c3"), shown("c4")], { concurrency: 2 });
      assert.sameMembers(both, [true, false]);
    })
  );

  it.effect("follows a person's setup on /guide and /guide/steps from Patchy's records", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      const page = yield* (yield* request("/guide", workspace.owner)).text;
      assert.strictEqual(heading(page), "Final step");
      assert.notInclude(page, "data-guide-modal");
      assert.notInclude(page, "/guide/later");
      const state = (html: string) => html.match(/data-state="([a-z]+)"/)?.[1];
      assert.strictEqual(
        state(yield* (yield* request("/guide/steps", workspace.owner)).text),
        "waiting"
      );

      // Connected: /guide sends them Home, and the steps say they're set. The key was made just
      // before the test clock's now, so what the member publishes next counts as since then.
      yield* sql`UPDATE machine_tokens SET created_at = to_timestamp(${1_767_225_600 - 3600})
        WHERE user_id = ${workspace.member.id}`;
      const guide = yield* request("/guide", workspace.member);
      assert.strictEqual(guide.status, 303);
      assert.strictEqual(guide.headers.location, "/");
      const connected = yield* (yield* request("/guide/steps", workspace.member)).text;
      assert.strictEqual(state(connected), "connected");
      assert.include(text(connected), "You’re set");
      assert.deepStrictEqual(steps(connected), [
        ["done", "Give your agent this line"],
        ["done", "Confirm it’s you"]
      ]);

      // The first publication after connecting is the live note, a welcome page by its name.
      yield* publish(workspace.member, "welcome");
      const live = yield* (yield* request("/guide/steps", workspace.member)).text;
      assert.strictEqual(state(live), "live");
      assert.include(text(live), "Your welcome page is live");
      const watch = yield* (yield* request("/guide/steps?mode=watch", workspace.member)).text;
      assert.strictEqual(state(watch), "live");
      assert.notInclude(watch, 'class="steps"');
      // Home's watch puts in Home's one-line note, not the panel's.
      assert.include(watch, 'class="note note-ok note-inline"');
      assert.include(text(watch), "Your welcome page is live");
    })
  );

  it.effect("follows the setup line's link through the agent's fetch, login and key", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      const value = lineOf(yield* (yield* request("/", workspace.owner)).text).split("?s=")[1]!;
      assert.lengthOf(
        events.filter(
          (event) => event.name === "setup.line_shown" && event.principalId === workspace.owner.id
        ),
        1
      );
      const state = Effect.gen(function* () {
        const html = yield* (yield* request("/guide/steps", workspace.owner)).text;
        return [html.match(/data-state="([a-z_-]+)"/)?.[1], text(html)] as const;
      });
      assert.strictEqual((yield* state)[0], "waiting");
      yield* SetupLinks.pickUp(value);
      const [picked, pickedText] = yield* state;
      assert.strictEqual(picked, "picked_up");
      assert.include(pickedText, "Your agent opened the line.");
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "laptop", setupLink: value });
      const [pending, pendingText] = yield* state;
      assert.strictEqual(pending, "login_pending");
      // The login's own confirmation, right in the panel, still asking for the code check.
      assert.include(pendingText, "A computer wants to publish as you");
      assert.include(pendingText, `Does your agent show ${login.userCode} ?`);
      const fragment = yield* request("/guide/steps", workspace.owner);
      // The fragment carries a confirmation, so nothing may frame it, and the script reloads
      // rather than swap in a fragment for whichever account signed in since.
      assert.include(fragment.headers["content-security-policy"] ?? "", "frame-ancestors 'none'");
      const form = yield* fragment.text;
      assert.include(form, `data-viewer="${workspace.owner.id}"`);
      assert.include(form, `<input type="hidden" name="setup" value="${value}">`);
      // Not me answers even when the name was cleared.
      assert.include(
        form,
        '<button class="btn" type="submit" name="action" value="deny" formnovalidate>Not me</button>'
      );
      yield* logins.confirm({
        userCode: login.userCode,
        userId: workspace.owner.id,
        machineName: "Laptop"
      });
      assert.strictEqual((yield* state)[0], "confirming");
      yield* logins.poll(login.deviceCode);
      assert.strictEqual((yield* state)[0], "connected");

      // A second login with a fresh line contests it; Get a new line starts over.
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.admin.id}`;
      const first = lineOf(yield* (yield* request("/guide", workspace.admin)).text);
      const link = first.split("?s=")[1]!;
      yield* logins.start({ machineNameHint: "laptop", setupLink: link });
      yield* logins.start({ machineNameHint: "elsewhere", setupLink: link });
      const contested = yield* (yield* request("/guide/steps", workspace.admin)).text;
      assert.include(contested, 'data-state="fallback-contested"');
      assert.include(text(contested), "Two computers used this line");
      assert.strictEqual(
        (yield* request("/guide/new-line", workspace.admin, { user: workspace.admin.id })).status,
        403
      );
      assert.strictEqual(
        (yield* post("/guide/new-line", workspace.admin, { user: workspace.owner.id })).status,
        409
      );
      const renewed = yield* post("/guide/new-line", workspace.admin, { user: workspace.admin.id });
      assert.strictEqual(renewed.status, 303);
      assert.strictEqual(renewed.headers.location, "/guide");
      const next = lineOf(yield* (yield* request("/guide", workspace.admin)).text);
      assert.notStrictEqual(next, first);
      assert.include(
        yield* (yield* request("/guide/steps", workspace.admin)).text,
        'data-state="waiting"'
      );

      // A login left unanswered shows as expired once it runs out, with no poll or start after.
      yield* logins.start({ machineNameHint: "laptop", setupLink: next.split("?s=")[1]! });
      assert.include(
        yield* (yield* request("/guide/steps", workspace.admin)).text,
        'data-state="login_pending"'
      );
      yield* TestClock.adjust("11 minutes");
      assert.include(
        yield* (yield* request("/guide/steps", workspace.admin)).text,
        'data-state="fallback-expired"'
      );
    }).pipe(Effect.provide(DeviceLogins.layer))
  );

  it.effect("names the first patch on Home for a day, in one line", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      yield* publish(workspace.admin, "crm");
      const mine = yield* publish(workspace.member, "lead-tracker", { title: "Lead <tracker>" });
      const shipped = yield* (yield* request("/", workspace.member)).text;
      assert.include(shipped, "Lead &lt;tracker&gt; is live");
      assert.notInclude(text(shipped), "Your first patch is live");
      assert.isTrue(
        links(shipped).some(
          (link) => link.href === `/${workspace.handle}/lead-tracker` && link.text === "Open"
        )
      );
      assert.include(shipped, 'aria-label="Copy link to Lead &lt;tracker&gt;"');
      assert.notInclude(
        text(yield* (yield* request(cardPath(mine.name), workspace.member)).text),
        "is live"
      );
      yield* TestClock.adjust(DAY);
      assert.notInclude(text(yield* (yield* request("/", workspace.member)).text), "is live");
    })
  );

  it.effect("tells an owner whose only patches are off that nothing is live", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "shelved-tool");
      yield* (yield* Patches.Patches).retire(patch.patchId, actor(workspace.owner));
      const offOnly = yield* (yield* request("/", workspace.owner)).text;
      assert.strictEqual(heading(offOnly), "Nothing is live");
      assert.isTrue(links(offOnly).some((link) => link.href === "/patches?show=off"));
      assert.deepStrictEqual(shelf(offOnly, "tile-link"), []);
      // A colleague who owns nothing sees the same, with the way to what is off.
      const member = yield* (yield* request("/", workspace.member)).text;
      assert.strictEqual(heading(member), "Nothing is live");
      assert.isTrue(links(member).some((link) => link.href === "/patches?show=off"));
    })
  );

  it.effect("fills Your usual from the viewer's own opens of the last 30 days alone", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const alpha = yield* publish(workspace.admin, "alpha");
      const bravo = yield* publish(workspace.admin, "bravo");
      const charlie = yield* publish(workspace.admin, "charlie");
      const delta = yield* publish(workspace.admin, "delta");
      const echo = yield* publish(workspace.admin, "echo");
      for (let visit = 0; visit < 3; visit++) yield* patches.recordVisit(echo.patchId);
      yield* patches.recordVisit(delta.patchId);
      const open = (person: Person, patch: Patches.Recorded, times = 1) =>
        Effect.forEach(Array.from({ length: times }), () =>
          patches.recordOpen(person.id, patch.patchId, patch.versionId)
        );

      // No opens: the company's most visited, by name after visits.
      const popular = yield* (yield* request("/", workspace.member)).text;
      assert.strictEqual(heading(popular), "Home");
      assert.include(text(popular), "Popular at Northwind");
      assert.deepStrictEqual(shelf(popular, "tile-link"), ["echo", "delta", "alpha", "bravo"]);

      // Opened 31 days ago, it has left; once they open anything, the company's picks give way.
      yield* open(workspace.member, charlie, 5);
      yield* TestClock.adjust(31 * DAY);
      yield* open(workspace.member, bravo);
      // Another member's opens never move this one's shelf.
      yield* open(workspace.owner, alpha, 9);
      const usual = yield* (yield* request("/", workspace.member)).text;
      assert.include(text(usual), "Your usual");
      assert.deepStrictEqual(shelf(usual, "tile-link"), ["bravo"]);
      assert.notInclude(text(usual), "Popular at Northwind");
      assert.notInclude(text(usual), "Opened");

      // A rename keeps the opens; retiring takes the patch off every shelf.
      yield* publish(workspace.admin, "bravo-two", { intent: "update", patchId: bravo.patchId });
      yield* patches.retire(echo.patchId, actor(workspace.admin));
      const after = yield* (yield* request("/", workspace.member)).text;
      assert.deepStrictEqual(shelf(after, "tile-link").slice(0, 1), ["bravo-two"]);
      assert.notInclude(shelf(after, "tile-link"), "echo");
      assert.notInclude(shelf(after, "home-page"), "echo");
    })
  );

  it.effect(
    "puts the viewer's own tools first and moves a patch between shelves with its tier",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const patches = yield* Patches.Patches;
        const theirs = yield* publishTier2(workspace.admin, "busy-tool");
        for (let visit = 0; visit < 5; visit++) yield* patches.recordVisit(theirs.patchId);
        const mine = yield* publishTier2(workspace.owner, "quiet-tool");
        // A page is tier 1, from a repo or a single file.
        const page = yield* publish(workspace.owner, "grows-up", {
          manifest: { ...manifest, name: "grows-up", tier: 1 }
        });
        yield* TestClock.adjust(60_000);
        const single = yield* publish(workspace.owner, "file-notes");
        const before = yield* (yield* request("/", workspace.owner)).text;
        assert.deepStrictEqual(shelf(before, "home-tool"), [mine.name, theirs.name]);
        assert.deepStrictEqual(shelf(before, "home-page"), [single.name, page.name]);
        // A republish at tier 2 makes the page a tool.
        yield* publish(workspace.owner, page.name, {
          intent: "update",
          patchId: page.patchId,
          filename: null,
          manifest: { ...manifest, name: page.name, tier: 2, handlers: {} },
          server: {
            objectKey: `patches/${page.patchId}/grows-up.server.js`,
            sha256: sha256(""),
            bytes: 0
          }
        });
        const after = yield* (yield* request("/", workspace.owner)).text;
        assert.deepStrictEqual(shelf(after, "home-tool"), [page.name, mine.name, theirs.name]);
        assert.deepStrictEqual(shelf(after, "home-page"), [single.name]);
      })
  );

  it.effect("marks a colleague's company page new until the viewer opens it", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const fresh = yield* publish(workspace.admin, "weekly-recap");
      const shared = yield* publish(workspace.admin, "press-kit", { scope: "public" });
      const mine = yield* publish(workspace.member, "my-notes");
      const old = yield* publish(workspace.admin, "old-brief");
      yield* TestClock.adjust(8 * DAY);
      yield* publish(workspace.admin, fresh.name, { intent: "update", patchId: fresh.patchId });
      yield* publish(workspace.admin, shared.name, { intent: "update", patchId: shared.patchId });
      yield* publish(workspace.member, mine.name, { intent: "update", patchId: mine.patchId });
      const html = yield* (yield* request("/", workspace.member)).text;
      assert.deepStrictEqual(unread(html), [fresh.name]);
      assert.include(shelf(html, "home-page"), old.name);

      // Opening the current version clears it; rolling back to an older one doesn't make it new.
      const current = yield* readPatch(workspace.admin, fresh.patchId);
      yield* patches.recordOpen(
        workspace.member.id,
        fresh.patchId,
        current.patch.currentVersionId!
      );
      assert.deepStrictEqual(unread(yield* (yield* request("/", workspace.member)).text), []);
      yield* TestClock.adjust(60_000);
      yield* patches.rollback(fresh.patchId, actor(workspace.admin), 1);
      assert.deepStrictEqual(unread(yield* (yield* request("/", workspace.member)).text), []);
    })
  );

  it.effect("searches Home past the shelf limits and hands a miss to the agent", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      for (let index = 0; index < 14; index++)
        yield* publishTier2(workspace.admin, `report-tool-${index}`);
      yield* publish(workspace.owner, "rota", { description: "Who covers the December reports." });
      yield* publish(workspace.owner, "lunch", { title: "Team lunch REPORT" });
      const found = yield* (yield* request("/?q=report", workspace.member)).text;
      assert.strictEqual(heading(found), "Home");
      // The sidebar's search keeps what was searched.
      assert.include(found, 'id="app-search" type="search" name="q" value="report"');
      assert.include(text(found), "16 matches for “report”");
      assert.strictEqual(shelf(found, "home-tool").length, 12);
      assert.isTrue(
        links(found).some(
          (link) =>
            link.href === "/patches?show=tools&amp;q=report" &&
            link.text === "All 14 matching tools"
        )
      );
      assert.sameMembers(shelf(found, "home-page"), ["rota", "lunch"]);
      assert.include(found, "<mark>report</mark>");
      assert.deepStrictEqual(shelf(found, "tile-link"), []);
      const byOwner = yield* (yield* request("/?q=priya", workspace.member)).text;
      assert.sameMembers(shelf(byOwner, "home-page"), ["rota", "lunch"]);

      const miss = yield* (yield* request("/?q=%3Cb%3Efreelancer", workspace.member)).text;
      assert.include(miss, "Nothing at Northwind matches “&lt;b&gt;freelancer”");
      assert.notInclude(miss, "<b>freelancer");
      assert.include(miss, 'data-copy="Build us a Patchy tool for &lt;b&gt;freelancer"');
      // A connected viewer isn't sent to the setup panel.
      assert.isFalse(links(miss).some((link) => link.href === "/guide"));
      assert.isTrue(
        links(miss).some((link) => link.href === "/patches?show=off&amp;q=%3Cb%3Efreelancer")
      );
      // Old links to the index still land.
      assert.strictEqual((yield* request("/?all=1", workspace.member)).status, 200);
    })
  );

  it.effect("marks where each search result matched, by name, description, title or owner", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      yield* publish(workspace.owner, "rota", { description: "Who covers the December reports." });
      yield* publish(workspace.owner, "lunch", { title: "Team lunch REPORT" });
      yield* publish(workspace.owner, "desk-map", {
        description: "Find a desk. Book the quiet room for writing reports too."
      });
      yield* publish(workspace.admin, "budget", { description: "Spend by month." });
      const found = yield* (yield* request("/?q=report", workspace.member)).text;
      const rows = Object.fromEntries(
        [
          ...found.matchAll(
            /<a class="tile-row tile-row-plain home-page" href="\/[^/"]+\/([a-z0-9-]+)">([\s\S]*?)<\/a>/g
          )
        ].map((match) => [match[1]!, match[2]!])
      );
      assert.sameMembers(Object.keys(rows), ["rota", "lunch", "desk-map"]);
      assert.include(rows.rota, "December <mark>report</mark>s");
      assert.include(rows.lunch, "Team lunch <mark>REPORT</mark>");
      assert.include(rows["desk-map"], "…");
      assert.include(rows["desk-map"], "writing <mark>report</mark>s too");
      const byOwner = yield* (yield* request("/?q=sam", workspace.member)).text;
      assert.include(byOwner, "<mark>Sam</mark>");
    })
  );

  it.effect(
    "keeps a search whole when it is cut to 200 characters, and searches with nothing live",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const query = `${"a".repeat(199)}🙂`;
        for (const path of ["/", "/patches"]) {
          const response = yield* request(
            `${path}?q=${encodeURIComponent(query)}`,
            workspace.member
          );
          assert.strictEqual(response.status, 200);
        }
        // An owner whose patches are all off can still search and ask an agent.
        const shelved = yield* publish(workspace.owner, "shelved-tool");
        yield* (yield* Patches.Patches).retire(shelved.patchId, actor(workspace.owner));
        const miss = yield* (yield* request("/?q=freelancer", workspace.owner)).text;
        assert.include(miss, 'data-copy="Build us a Patchy tool for freelancer"');
        assert.isTrue(
          links(miss).some((link) => link.href === "/patches?show=off&amp;q=freelancer")
        );
      })
  );

  it.effect("offers About on every Home shelf's menu, and Settings only to owners and admins", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const page = yield* publish(workspace.owner, "office-map");
      const tool = yield* publishTier2(workspace.owner, "desk-booker");
      for (const [person, shown] of [
        [workspace.member, false],
        [workspace.owner, true],
        [workspace.admin, true]
      ] as const) {
        const html = yield* (yield* request("/", person)).text;
        for (const [shelfName, patch] of [
          ["usual", page],
          ["pages", page],
          ["tools", tool]
        ] as const) {
          const menu = menuItems(html, `${shelfName}-${patch.patchId}`);
          assert.include(
            menu,
            `Open in a new tab Copy link${shown ? " Share…" : ""} About this patch`,
            shelfName
          );
          assert.strictEqual(menu.includes("Settings"), shown, shelfName);
        }
        assert.isTrue(links(html).some((link) => link.href === cardPath(tool.name)));
      }
    })
  );

  it.effect("calls a patch by its title on Home's tiles, rows and menus, and in search", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const titled = yield* publish(workspace.owner, "office-map", {
        title: "Office <map>",
        description: "Find a desk. Keep the second sentence on the card."
      });

      // Home's tiles, rows and menus say the title; Home cuts the description.
      const home = yield* (yield* request("/", workspace.member)).text;
      assert.include(home, '<span class="tile-name">Office &lt;map&gt;</span>');
      assert.include(menuItems(home, `pages-${titled.patchId}`), "Office &lt;map&gt;");
      assert.include(text(home), "Office &lt;map&gt; Find a desk");
      assert.notInclude(text(home), "Keep the second sentence");

      // Search finds the name behind a title, and says so.
      const byTitle = yield* (yield* request("/?q=MAP", workspace.member)).text;
      assert.include(byTitle, "Office &lt;<mark>map</mark>&gt;");
      const byName = yield* (yield* request("/?q=office-m", workspace.member)).text;
      assert.deepStrictEqual(shelf(byName, "home-page"), ["office-map"]);
      assert.include(byName, '<span class="tile-meta"><mark>office-m</mark>ap</span>');
    })
  );

  it.effect("names an owner's failing tier 2 tools at the top of Home, counting the last day", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const failing = yield* publishTier2(workspace.owner, "client-health");
      const fine = yield* publishTier2(workspace.owner, "web-analytics");
      const old = seedOf(workspace.id, failing);
      yield* invoke(old, workspace.member, {
        handler: "accounts.burn",
        kind: "action",
        outcome: "failure"
      });
      yield* TestClock.adjust(2 * DAY);
      for (let index = 0; index < 3; index++)
        yield* invoke(seedOf(workspace.id, failing), workspace.member, {
          handler: "accounts.burn",
          kind: "action",
          outcome: "handler_error",
          outcomeCode: "warehouse_timeout"
        });
      yield* invoke(seedOf(workspace.id, fine), workspace.member, {
        handler: "visits.load",
        kind: "action"
      });

      // The owner's Home names the failing tool, counting only the last day, with its failed log.
      const home = yield* (yield* request("/", workspace.owner)).text;
      assert.include(text(home), "One of your tools is failing");
      assert.include(text(home), "client-health : 3 calls failed in the last day");
      assert.isTrue(
        links(home).some((link) => link.href === "/patches/client-health/log?outcome=failed")
      );
      // The tool's title opens the tool, as everywhere on Home; the count opens its failures.
      assert.isTrue(
        links(home).some(
          (link) => link.href.endsWith("/client-health") && link.text === "client-health"
        )
      );
      for (const person of [workspace.member, workspace.admin])
        assert.notInclude(text(yield* (yield* request("/", person)).text), "is failing");
    })
  );
});
