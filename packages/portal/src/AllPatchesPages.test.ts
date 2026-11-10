import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { PUBLIC_BASE_URL } from "@patchy/auth/testing";
import { sha256 } from "../../../test/crypto.js";
import { GuestGrants, Patches } from "@patchy/patches";
import {
  DAY,
  socket,
  type Person,
  company,
  actor,
  manifest,
  publish,
  request,
  text,
  heading,
  links,
  forms,
  cardPath,
  listed,
  menuItems,
  invoke,
  seedOf,
  publishTier2
} from "./test/fixtures.js";

it.layer(socket)("all patches on a socket", (it) => {
  it.effect("lists every patch in tabs, searched within the tab and sorted by visits", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const tool = yield* publishTier2(workspace.owner, "lead-tracker");
      const page = yield* publish(workspace.owner, "q3-review", {
        description: "Quarterly review of revenue and wins.",
        manifest: { ...manifest, name: "q3-review", tier: 1 }
      });
      const busy = yield* publish(workspace.member, "kudos", {
        description: "<script>alert(1)</script> Shout-outs."
      });
      const retired = yield* publish(workspace.owner, "old-crm");
      const deleted = yield* publish(workspace.member, "lunch-poll");
      yield* patches.retire(retired.patchId, actor(workspace.owner));
      yield* patches.delete(deleted.patchId, actor(workspace.member));
      for (let visit = 0; visit < 3; visit++) yield* patches.recordVisit(busy.patchId);
      yield* patches.recordVisit(tool.patchId);

      const all = yield* (yield* request("/patches", workspace.owner)).text;
      assert.strictEqual(heading(all), "All patches");
      assert.deepStrictEqual(listed(all), [busy.name, tool.name, page.name]);
      assert.include(text(all), "All 3 Tools 1 Pages 2 Yours 2 Retired and deleted 2");
      assert.notInclude(all, "<script>alert(1)</script>");
      assert.include(all, "&lt;script&gt;alert(1)&lt;/script&gt; Shout-outs");
      assert.include(all, `<script defer src="/assets/copy.js"></script>`);

      const tools = yield* (yield* request("/patches?show=tools", workspace.owner)).text;
      assert.deepStrictEqual(listed(tools), [tool.name]);
      const pages = yield* (yield* request("/patches?show=pages&q=REVENUE", workspace.owner)).text;
      assert.deepStrictEqual(listed(pages), [page.name]);
      assert.include(text(pages), "1 match for “REVENUE”");
      assert.include(pages, 'name="show" value="pages"');
      assert.isTrue(links(pages).some((link) => link.href === "/patches?show=tools&amp;q=REVENUE"));
      const byOwner = yield* (yield* request("/patches?q=alex", workspace.owner)).text;
      assert.deepStrictEqual(listed(byOwner), [busy.name]);
      const yours = yield* (yield* request("/patches?show=yours", workspace.owner)).text;
      assert.deepStrictEqual(listed(yours), [tool.name, page.name]);

      const off = yield* (yield* request("/patches?show=off", workspace.owner)).text;
      assert.deepStrictEqual(listed(off), [deleted.name, retired.name]);
      assert.include(text(off), "Deleted · gone in 30 days");
      assert.include(text(off), "Retired by Priya");
      const nothing = yield* (yield* request("/patches?q=zebra", workspace.owner)).text;
      assert.include(text(nothing), "No patches match “zebra”.");
    })
  );

  it.effect("opens a live patch from its name and offers each viewer only their acts", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "office-map");
      const shelved = yield* publish(workspace.owner, "old-map");
      yield* (yield* Patches.Patches).retire(shelved.patchId, actor(workspace.owner));
      const menus = new Map<Person, string>();
      for (const person of [workspace.member, workspace.owner, workspace.admin])
        menus.set(
          person,
          menuItems(yield* (yield* request("/patches", person)).text, patch.patchId)
        );
      const opening = "office-map Open in a new tab Copy link";
      const about = "About this patch";
      assert.strictEqual(menus.get(workspace.member), `${opening} ${about}`);
      assert.strictEqual(
        menus.get(workspace.owner),
        `${opening} Share… ${about} Settings Retire… Delete…`
      );
      assert.strictEqual(
        menus.get(workspace.admin),
        `${opening} Share… ${about} Settings Reassign… Retire… Delete…`
      );
      // Each item says whose it is, its visible label first.
      const named = yield* (yield* request("/patches", workspace.admin)).text;
      for (const label of [
        "Open in a new tab",
        "Copy link",
        "About this patch",
        "Settings",
        "Delete…"
      ])
        assert.include(named, `aria-label="${label}, office-map"`);
      const html = yield* (yield* request("/patches", workspace.admin)).text;
      assert.include(html, `data-copy="${PUBLIC_BASE_URL}/${workspace.handle}/office-map"`);
      assert.include(html, `<a href="/${workspace.handle}/office-map"><strong>office-map</strong>`);
      // The viewer's own patches say so in Owner, without a badge.
      const mine = yield* (yield* request("/patches", workspace.owner)).text;
      assert.include(mine, "<span>You</span>");
      assert.notInclude(mine, '<span class="tag">You</span>');
      // An off patch can't be opened, so its name goes to its card.
      const off = yield* (yield* request("/patches?show=off", workspace.owner)).text;
      assert.include(off, `<a href="${cardPath(shelved.name)}"><strong>old-map</strong>`);
      assert.strictEqual(
        menuItems(off, shelved.patchId),
        "old-map About this patch Settings Restore Delete…"
      );
    })
  );

  it.effect(
    "lists a patch with guests that uses a connection that blocks them as Needs attention",
    () =>
      Effect.gen(function* () {
        const guest = yield* company();
        const workspace = yield* company("cmp_portal_guests");
        const payroll = yield* publish(workspace.owner, "payroll-review", {
          filename: null,
          manifest: {
            ...manifest,
            name: "payroll-review",
            tier: 2,
            handlers: {},
            uses: {
              payroll: { kind: "postgres", handle: "payroll", id: "con_payroll", revision: 1 }
            }
          },
          server: {
            objectKey: "patches/payroll-review/server.js",
            sha256: sha256("payroll"),
            bytes: 0
          }
        });
        const attention = Effect.flatMap(
          request("/patches?show=attention", workspace.owner),
          (response) => response.text
        );
        // Nobody to turn away yet.
        assert.deepStrictEqual(listed(yield* attention), []);

        yield* (yield* GuestGrants.GuestGrants).grant({
          patchId: payroll.patchId,
          userId: guest.member.id,
          grantedBy: workspace.owner.id
        });
        assert.deepStrictEqual(listed(yield* attention), [payroll.name]);
      })
  );

  it.effect("shows Needs attention only to a patch's owner and admins, until recovery ends", () =>
    Effect.gen(function* () {
      // company() sets the clock, so both exist before it moves.
      const outsider = yield* company();
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const sql = yield* SqlClient.SqlClient;
      const deleted = yield* publish(workspace.owner, "lunch-poll");
      const theirs = yield* publish(workspace.admin, "admin-poll");
      const orphan = yield* publish(workspace.member, "asset-library");
      const shelved = yield* publish(workspace.member, "old-crm");
      yield* patches.delete(deleted.patchId, actor(workspace.owner));
      yield* patches.delete(theirs.patchId, actor(workspace.admin));
      yield* patches.retire(shelved.patchId, actor(workspace.member));
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${workspace.member.id}`;
      yield* TestClock.adjust(24 * DAY);

      // An owner sees their own deletion, never a colleague's or an orphan.
      const owner = yield* (yield* request("/patches?show=attention", workspace.owner)).text;
      assert.deepStrictEqual(listed(owner), [deleted.name]);
      assert.include(text(owner), "Gone for good in 6 days");
      assert.include(forms(owner), `${cardPath(deleted.name)}/restore`);
      assert.include(
        text(yield* (yield* request("/patches", workspace.owner)).text),
        "Needs attention 1"
      );
      // An admin sees every deactivated owner's patch, in any state, and every deletion.
      const admin = yield* (yield* request("/patches?show=attention", workspace.admin)).text;
      assert.deepStrictEqual(listed(admin), [theirs.name, orphan.name, deleted.name, shelved.name]);
      assert.include(text(admin), "Its owner is deactivated");
      assert.isTrue(links(admin).some((link) => link.href === `${cardPath(orphan.name)}/reassign`));
      assert.isTrue(
        links(admin).some((link) => link.href === `${cardPath(shelved.name)}/reassign`)
      );
      assert.include(
        text(yield* (yield* request("/patches", workspace.admin)).text),
        "Needs attention 4"
      );
      // Reassigning a deletion moves who sees it.
      yield* patches.reassign(deleted.patchId, actor(workspace.admin), workspace.admin.id);
      assert.notInclude(
        text(yield* (yield* request("/patches", workspace.owner)).text),
        "Needs attention"
      );

      const theirsOnly = yield* (yield* request("/patches?show=attention", outsider.member)).text;
      assert.include(text(theirsOnly), "Nothing needs your attention.");

      yield* TestClock.adjust(7 * DAY);
      const ended = yield* (yield* request("/patches?show=off", workspace.admin)).text;
      assert.include(text(ended), "Recovery ended");
      assert.notInclude(menuItems(ended, theirs.patchId), "Restore");
      assert.include(menuItems(ended, theirs.patchId), "Reassign…");
    })
  );

  it.effect("calls a patch by its title in the table, and by its name without one", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      yield* publish(workspace.owner, "office-map", { title: "Office <map>" });
      yield* publish(workspace.owner, "blank-title", { title: "", description: "" });
      const all = yield* (yield* request("/patches", workspace.member)).text;
      assert.include(
        all,
        `<a href="/${workspace.handle}/office-map"><strong>Office &lt;map&gt;</strong></a>`
      );
      assert.include(all, "<strong>blank-title</strong>");
    })
  );
});

it.layer(socket)("patch health on a socket", (it) => {
  it.effect(
    "shows owners and admins the last day's failed calls of the tier 2 patches they manage",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const failing = yield* publishTier2(workspace.owner, "client-health");
        const fine = yield* publishTier2(workspace.owner, "web-analytics");
        const page = yield* publish(workspace.owner, "weekly-recap");
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

        // All patches: failures beside the tier 2 rows the viewer manages, and a reason to look.
        // None recorded is blank, never OK; a row with no calls to count has a dash.
        const health = (html: string, name: string) =>
          html.match(
            new RegExp(
              `<tr>(?:(?!</tr>)[\\s\\S])*<strong>${name}</strong>(?:(?!</tr>)[\\s\\S])*<td>((?:(?!</td>)[\\s\\S])*)</td><td class="portal-list-actions">`
            )
          )?.[1];
        for (const person of [workspace.owner, workspace.admin]) {
          const all = yield* (yield* request("/patches", person)).text;
          assert.include(text(all), "Health");
          assert.strictEqual(
            health(all, failing.name),
            `<a href="/patches/client-health/log?outcome=failed">3 failed in the last day</a>`
          );
          assert.strictEqual(health(all, fine.name), "");
          assert.strictEqual(health(all, page.name), '<span class="supporting-text">—</span>');
          assert.notInclude(all, '<span class="pill pill-done">OK</span>');
          const attention = yield* (yield* request("/patches?show=attention", person)).text;
          assert.deepStrictEqual(listed(attention), [failing.name]);
          assert.include(text(attention), "3 calls failed in the last day");
        }
        const member = yield* (yield* request("/patches", workspace.member)).text;
        assert.notInclude(member, '<th scope="col">Health</th>');
        assert.notInclude(text(member), "3 failed");
        assert.notInclude(text(member), "Needs attention");
        assert.include(listed(member), page.name);
      })
  );
});
