import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { PUBLIC_BASE_URL } from "@patchy/auth/testing";
import { sha256 } from "../../../test/crypto.js";
import { unopenedName } from "@patchy/core";
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
  shareDialog,
  dialogAfter,
  invoke,
  seedOf,
  publishTier2,
  post,
  formFields
} from "./test/fixtures.js";

/** One cell of the table row whose patch is `name`, by its column, as HTML. */
const cell = (html: string, name: string, column: number) => {
  const row = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].find((match) =>
    match[1]!.includes(`/${name}">`)
  )?.[1];
  return [...(row ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][column]?.[1];
};

it.layer(socket)("all patches on a socket", (it) => {
  it.effect("lists every patch A–Z in filters with URLs, searched by the sidebar's query", () =>
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
      assert.include(
        all,
        '<nav class="seg" aria-label="Show"><a href="/patches" aria-current="page">'
      );
      assert.notInclude(all, "<script>alert(1)</script>");
      assert.include(all, "&lt;script&gt;alert(1)&lt;/script&gt; Shout-outs");
      assert.include(all, `<script defer src="/assets/copy.js"></script>`);
      // The page has no search of its own; the sidebar's searches it.
      assert.strictEqual(all.match(/role="search"/g)?.length, 1);
      assert.include(all, '<form class="app-search" method="get" action="/patches" role="search">');

      const tools = yield* (yield* request("/patches?show=tools", workspace.owner)).text;
      assert.deepStrictEqual(listed(tools), [tool.name]);
      // A search shows as a chip that clears it, keeps its filter, and counts what it finds.
      const pages = yield* (yield* request("/patches?show=pages&q=REVENUE", workspace.owner)).text;
      assert.deepStrictEqual(listed(pages), [page.name]);
      assert.include(text(pages), "All 1 Tools 0 Pages 1 Yours 1");
      assert.isTrue(
        links(pages).some(
          (link) => link.href === "/patches?show=pages" && link.text === "Matching REVENUE"
        )
      );
      assert.isTrue(links(pages).some((link) => link.href === "/patches?show=tools&amp;q=REVENUE"));
      assert.include(pages, 'id="app-search" type="search" name="q" value="REVENUE"');
      const byOwner = yield* (yield* request("/patches?q=alex", workspace.owner)).text;
      assert.deepStrictEqual(listed(byOwner), [busy.name]);
      // People's See their patches narrows to one person exactly, as a chip that clears it, and
      // its filters keep it.
      const alex = workspace.member.id;
      const theirs = yield* (yield* request(`/patches?owner=${alex}`, workspace.owner)).text;
      assert.deepStrictEqual(listed(theirs), [busy.name]);
      assert.include(text(theirs), "All 1 Tools 0 Pages 1 Yours 0 Retired and deleted 1");
      assert.isTrue(
        links(theirs).some((link) => link.href === "/patches" && link.text === "Owner Alex")
      );
      assert.isTrue(
        links(theirs).some((link) => link.href === `/patches?show=off&amp;owner=${alex}`)
      );
      assert.include(
        text(yield* (yield* request(`/patches?show=yours&owner=${alex}`, workspace.owner)).text),
        "Alex has no patches here"
      );
      // Someone who isn't a member here narrows nothing.
      const stranger = yield* (yield* request("/patches?owner=usr_elsewhere", workspace.owner))
        .text;
      assert.deepStrictEqual(listed(stranger), listed(all));
      assert.isFalse(links(stranger).some((link) => link.text.startsWith("Owner ")));
      const yours = yield* (yield* request("/patches?show=yours", workspace.owner)).text;
      assert.deepStrictEqual(listed(yours), [tool.name, page.name]);

      const off = yield* (yield* request("/patches?show=off", workspace.owner)).text;
      assert.deepStrictEqual(listed(off), [deleted.name, retired.name]);
      assert.include(text(off), "Deleted Gone for good in 30 days");
      assert.include(text(off), "Retired by Priya");
    })
  );

  it.effect("sorts from its headings, by when the viewer last opened each among them", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const viewer = workspace.owner;
      // Published an hour apart, so Updated runs from delta back to alpha.
      const published = new Map<string, { readonly patchId: string; readonly versionId: string }>();
      for (const name of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]) {
        published.set(name, yield* publish(viewer, name));
        yield* TestClock.adjust(DAY / 24);
      }
      const open = (name: string) => {
        const { patchId, versionId } = published.get(name)!;
        return patches.recordOpen(viewer.id, patchId, versionId);
      };
      for (const name of ["bravo", "bravo", "delta", "delta"])
        yield* patches.recordVisit(published.get(name)!.patchId);
      // Opened, then retired: Retired and deleted keeps its own order.
      yield* open("foxtrot");
      yield* TestClock.adjust(DAY / 24);
      yield* open("charlie");
      yield* TestClock.adjust(DAY / 24);
      yield* open("alpha");
      for (const name of ["echo", "foxtrot"])
        yield* patches.retire(published.get(name)!.patchId, actor(viewer));
      const page = (path: string) => Effect.flatMap(request(path, viewer), (r) => r.text);

      // A–Z by default, Patch marked and adding nothing to the address.
      const atoz = yield* page("/patches");
      assert.deepStrictEqual(listed(atoz), ["alpha", "bravo", "charlie", "delta"]);
      assert.include(
        atoz,
        '<th scope="col" class="cell-grow" aria-sort="ascending"><a href="/patches">Patch<svg'
      );
      assert.isTrue(
        links(atoz).some((link) => link.href === "/patches?sort=opened" && link.text === "Opened")
      );

      // Opened: the last opened first, with when, and the never opened after, A–Z, with a dash.
      const opened = yield* page("/patches?sort=opened");
      assert.deepStrictEqual(listed(opened), ["alpha", "charlie", "bravo", "delta"]);
      assert.strictEqual(opened.match(/aria-sort="descending"/g)?.length, 1);
      assert.include(opened, 'aria-sort="descending"><a href="/patches?sort=opened">Opened<svg');
      assert.strictEqual(text(cell(opened, "alpha", 2) ?? ""), "just now");
      assert.strictEqual(text(cell(opened, "charlie", 2) ?? ""), "1 hour ago");
      assert.strictEqual(cell(opened, "bravo", 2), '<span class="muted">—</span>');
      // Updated newest first; Visits most first, a tie A–Z.
      assert.deepStrictEqual(listed(yield* page("/patches?sort=updated")), [
        "delta",
        "charlie",
        "bravo",
        "alpha"
      ]);
      assert.deepStrictEqual(listed(yield* page("/patches?sort=visits")), [
        "bravo",
        "delta",
        "alpha",
        "charlie"
      ]);

      // The filters and the search chip keep it; pressing Patch returns to A–Z.
      const kept = (html: string, href: string) => links(html).some((link) => link.href === href);
      assert.isTrue(kept(opened, "/patches?show=tools&amp;sort=opened"));
      assert.isTrue(kept(opened, "/patches?show=off&amp;sort=opened"));
      assert.isTrue(
        links(opened).some((link) => link.href === "/patches" && link.text === "Patch")
      );
      const searched = yield* page("/patches?q=alpha&sort=opened");
      assert.isTrue(
        links(searched).some(
          (link) => link.href === "/patches?sort=opened" && link.text === "Matching alpha"
        )
      );
      // A new search from the sidebar starts from Patch.
      assert.notInclude(searched, 'name="sort"');
      // Retired and deleted keeps its own table and order, and its way back keeps the sort.
      const off = yield* page("/patches?show=off&sort=opened");
      assert.deepStrictEqual(listed(off), ["echo", "foxtrot"]);
      assert.notInclude(off, "aria-sort=");
      assert.isTrue(kept(off, "/patches?sort=opened"));
    })
  );

  it.effect("offers a search that finds nothing the line that has an agent build it", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* publish(workspace.owner, "kudos");
      const retired = yield* publish(workspace.owner, "zebra-board");
      yield* (yield* Patches.Patches).retire(retired.patchId, actor(workspace.owner));

      const nothing = yield* (yield* request("/patches?q=%3Cb%3Ezebra", workspace.owner)).text;
      assert.include(text(nothing), "No patches match “&lt;b&gt;zebra”");
      assert.include(
        nothing,
        '<code aria-label="Request for your agent, select to copy">Build us a Patchy tool for &lt;b&gt;zebra</code>'
      );
      assert.notInclude(text(nothing), "Connect your agent");
      // A retired match is a filter away, and the line still offers to build one.
      const zebra = yield* (yield* request("/patches?q=zebra", workspace.owner)).text;
      assert.include(text(zebra), "Retired and deleted 1");
      assert.include(text(zebra), "Build us a Patchy tool for zebra");

      // Someone without an agent is told how to connect one.
      yield* sql`DELETE FROM machine_tokens WHERE user_id = ${workspace.member.id}`;
      const unconnected = yield* (yield* request("/patches?q=zebra", workspace.member)).text;
      assert.isTrue(
        links(unconnected).some(
          (link) => link.href === "/guide" && link.text === "Connect your agent"
        )
      );
      // A search that finds live patches, just not in this filter, offers no line.
      const elsewhere = yield* (yield* request("/patches?show=tools&q=kudos", workspace.owner))
        .text;
      assert.include(text(elsewhere), "No patches match “kudos”");
      assert.notInclude(elsewhere, "Build us a Patchy tool");
    })
  );

  it.effect("pages the table 50 rows at a time, keeping the filter, search and sort", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      for (let index = 0; index < 51; index++)
        yield* publish(workspace.owner, `board-${String(index).padStart(2, "0")}`);
      const last = yield* publish(workspace.owner, "board-51");

      const first = yield* (yield* request("/patches?q=board", workspace.owner)).text;
      assert.strictEqual(listed(first).length, 50);
      assert.strictEqual(listed(first)[0], "board-00");
      assert.include(text(first), "1–50 of 52");
      assert.isTrue(
        links(first).some(
          (link) => link.href === "/patches?q=board&amp;page=2" && link.text === "Next"
        )
      );
      assert.isFalse(links(first).some((link) => link.text === "Previous"));
      const second = yield* (yield* request("/patches?q=board&page=2", workspace.owner)).text;
      assert.deepStrictEqual(listed(second), ["board-50", "board-51"]);
      assert.include(text(second), "51–52 of 52");
      assert.isTrue(
        links(second).some((link) => link.href === "/patches?q=board" && link.text === "Previous")
      );
      // The menu's Share… returns to the same page.
      assert.include(second, 'href="/patches?q=board&amp;page=2&amp;share=board-50"');
      // A page past the last is the last; one short table has no paging.
      assert.deepStrictEqual(
        listed(yield* (yield* request("/patches?q=board&page=9", workspace.owner)).text),
        ["board-50", "board-51"]
      );
      assert.notInclude(
        yield* (yield* request("/patches?q=board-0", workspace.owner)).text,
        'aria-label="Pages"'
      );

      // Sorted by Opened, the one they opened leads, and Next keeps the sort.
      yield* (yield* Patches.Patches).recordOpen(workspace.owner.id, last.patchId, last.versionId);
      const opened = yield* (yield* request("/patches?q=board&sort=opened", workspace.owner)).text;
      assert.deepStrictEqual(listed(opened).slice(0, 2), ["board-51", "board-00"]);
      assert.isTrue(
        links(opened).some(
          (link) =>
            link.href === "/patches?q=board&amp;sort=opened&amp;page=2" && link.text === "Next"
        )
      );
      const later = yield* (yield* request("/patches?q=board&sort=opened&page=2", workspace.owner))
        .text;
      assert.deepStrictEqual(listed(later), ["board-49", "board-50"]);
      // Its headings start again from the first page.
      assert.isTrue(
        links(later).some(
          (link) => link.href === "/patches?q=board&amp;sort=visits" && link.text === "Visits"
        )
      );
      // Sharing from a row comes back to the same sorted page, refused or saved, and so does Close.
      const sorted = "/patches?q=board&sort=opened&page=2";
      const sharing = `${sorted}&share=board-49`;
      assert.include(later, `href="${sharing.replaceAll("&", "&amp;")}"`);
      const addPath = `${cardPath("board-49")}/add-guest`;
      const fields = formFields(yield* (yield* request(sharing, workspace.owner)).text, addPath);
      assert.strictEqual(fields.back, sorted.replaceAll("&", "&amp;"));
      const refused = yield* post(addPath, workspace.owner, {
        ...fields,
        back: sorted,
        email: "nobody@nowhere.example"
      });
      assert.strictEqual(refused.status, 422);
      const behind = yield* refused.text;
      assert.deepStrictEqual(listed(behind), ["board-49", "board-50"]);
      assert.isTrue(
        links(shareDialog(behind)).some(
          (link) => link.href === sorted.replaceAll("&", "&amp;") && link.text === "Close"
        )
      );
      const guest = (yield* company()).member;
      const saved = yield* post(addPath, workspace.owner, {
        ...fields,
        back: sorted,
        email: guest.email
      });
      assert.strictEqual(saved.status, 303);
      assert.strictEqual(saved.headers.location, sharing);
      const shared = yield* dialogAfter(saved, workspace.owner);
      assert.include(shared.receipt, `with ${guest.name}`);
      const close = links(shared.html).find((link) => link.text === "Close")?.href;
      assert.strictEqual(close, sorted.replaceAll("&", "&amp;"));
      const closed = yield* (yield* request(sorted, workspace.owner)).text;
      assert.deepStrictEqual(listed(closed), ["board-49", "board-50"]);
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
      const opening = "office-map Pin patch Open in a new tab Copy link";
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
      assert.include(
        html,
        `<a class="row-link" href="/${workspace.handle}/office-map">${unopenedName("office-map")}</a>`
      );
      // The viewer's own patches say so in Owner; sharing stays in the row menu.
      const mine = yield* (yield* request("/patches", workspace.owner)).text;
      assert.include(mine, `<span title="${workspace.owner.name}">You</span>`);
      assert.notInclude(mine, '<span class="badge">You</span>');
      assert.isTrue(
        links(mine).some(
          (link) => link.href === "/patches?share=office-map" && link.text === "Share…"
        )
      );
      for (const person of [workspace.member, workspace.admin])
        assert.notInclude(
          yield* (yield* request("/patches", person)).text,
          'aria-label="Share office-map"'
        );
      // An off patch can't be opened, so its name goes to its card.
      const off = yield* (yield* request("/patches?show=off", workspace.owner)).text;
      assert.include(off, `<a class="row-link" href="${cardPath(shelved.name)}">old-map</a>`);
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
        assert.include(
          text(yield* (yield* request("/patches", workspace.member)).text),
          "Company + 1 guest"
        );
        // Its Share dialog says why, and a tool's general access why it stays in the company.
        const dialog = shareDialog(
          yield* (yield* request(`/patches?share=${payroll.name}`, workspace.owner)).text
        );
        assert.include(text(dialog), "Guests can't open this");
        assert.notInclude(dialog, 'value="public"');
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
      assert.include(text(theirsOnly), "Nothing needs your attention");

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
        `<a class="row-link" href="/${workspace.handle}/office-map">${unopenedName("Office <map>")}</a>`
      );
      assert.include(all, `>${unopenedName("blank-title")}</a>`);
    })
  );
});

it.layer(socket)("patch health on a socket", (it) => {
  it.effect(
    "shows owners and admins the last 24 hours' failures of the tier 2 patches they manage",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const failing = yield* publishTier2(workspace.owner, "client-health");
        const fine = yield* publishTier2(workspace.owner, "web-analytics");
        const idle = yield* publishTier2(workspace.owner, "quiet-tool");
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

        // Failures (24 h): a count linked to the log, None, or No calls yet; never "Healthy". A
        // row with no calls to count has a dash.
        const failures = (html: string, name: string) => cell(html, name, 6);
        for (const person of [workspace.owner, workspace.admin]) {
          const all = yield* (yield* request("/patches", person)).text;
          assert.include(all, '<th scope="col" class="hide-sm nowrap">Failures (24 h)</th>');
          assert.strictEqual(
            failures(all, failing.name),
            `<a href="/patches/client-health/log?outcome=failed"><span class="badge badge-danger">3 failed</span></a>`
          );
          // On a phone, where the column is gone, the failing tool says so under its name.
          assert.include(
            all,
            `<span class="show-sm"><a href="/patches/client-health/log?outcome=failed"><span class="badge badge-danger">3 failed</span></a></span>`
          );
          assert.strictEqual(failures(all, fine.name), '<span class="muted">None</span>');
          assert.strictEqual(failures(all, idle.name), '<span class="muted">No calls yet</span>');
          assert.strictEqual(failures(all, page.name), '<span class="muted">—</span>');
          assert.notInclude(text(all), "Healthy");
          const attention = yield* (yield* request("/patches?show=attention", person)).text;
          assert.deepStrictEqual(listed(attention), [failing.name]);
          assert.include(text(attention), "3 calls failed in the last day");
          assert.isTrue(
            links(attention).some(
              (link) =>
                link.href === "/patches/client-health/log?outcome=failed" &&
                link.text === "View log"
            )
          );
        }
        // Pages have no handlers, so no column.
        assert.notInclude(
          yield* (yield* request("/patches?show=pages", workspace.owner)).text,
          "Failures (24 h)"
        );
        const member = yield* (yield* request("/patches", workspace.member)).text;
        assert.notInclude(member, "Failures (24 h)");
        assert.notInclude(text(member), "3 failed");
        assert.notInclude(text(member), "Needs attention");
        assert.include(listed(member), page.name);
      })
  );
});
