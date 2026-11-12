import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as Cookies from "effect/http/Cookies";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { PUBLIC_BASE_URL } from "@patchy/auth/testing";
import { Companies, Teams, Users } from "@patchy/companies";
import { sha256 } from "../../../test/crypto.js";
import { GuestGrants, Patches } from "@patchy/patches";
import {
  DAY,
  reported,
  socket,
  type Person,
  company,
  actor,
  manifest,
  publish,
  publishSource,
  publishDependant,
  readPatch,
  type FormFields,
  sessionCookie,
  acknowledgements,
  request,
  post,
  receiptAfter,
  text,
  heading,
  links,
  forms,
  hidden,
  formFields,
  inputs,
  cardPath,
  menuItems,
  assertStale,
  invoke,
  operation,
  seedOf,
  logPath,
  agentHandlers,
  publishAgentArea,
  publishTier2
} from "./test/fixtures.js";

/** Overview's Recent activity section. */
const activity = (html: string) =>
  html.match(/<section class="section" id="recent-activity">[\s\S]*?<\/section>/)?.[0] ?? "";
/** A log filter chip's choices, as `[label, href]`. */
const chipChoices = (html: string, key: string) =>
  links(
    html.match(new RegExp(`<div class="menu" id="menu-log-${key}"[\\s\\S]*?</div>`))?.[0] ?? ""
  ).map((link) => [link.text, link.href.replaceAll("&amp;", "&")] as const);
/** The Reassign dialog's choices of a new owner, by user id, in order. */
const ownerChoices = (html: string) =>
  [
    ...(html.match(/<select[^>]*name="user"[\s\S]*?<\/select>/)?.[0] ?? "").matchAll(
      /<option value="([^"]*)"/g
    )
  ].map((match) => match[1]);

/** The page's tabs, as their links read. */
const tabLinks = (html: string) =>
  links(html.match(/<nav class="tabs"[\s\S]*?<\/nav>/)?.[0] ?? "").map((link) => link.text);

it.layer(socket)("a patch's card on a socket", (it) => {
  it.effect("shows member, owner and admin views of one card and its retained versions", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "office-map", {
        title: "A useful office tool"
      });
      for (let version = 2; version <= 5; version++) {
        yield* TestClock.adjust(DAY);
        yield* publish(workspace.owner, patch.name, {
          intent: "update",
          patchId: patch.patchId,
          title: "A useful office tool"
        });
      }
      for (const person of [workspace.member, workspace.owner, workspace.admin]) {
        const response = yield* request(`${cardPath(patch.name)}`, person);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        const html = yield* response.text;
        // The title leads; the address its name makes sits under it, with the kind.
        assert.strictEqual(heading(html), "A useful office tool");
        assert.include(
          text(html.match(/<p class="ph-meta">[\s\S]*?<\/p>/)?.[0] ?? ""),
          `Page · ${PUBLIC_BASE_URL.replace(/^https?:\/\//, "")}/${workspace.handle}/${patch.name}`
        );
        assert.include(text(html), "Find the right person. Includes the whole company.");
        assert.include(text(html), "v5");
        assert.include(text(html), "by Priya");
        assert.isTrue(
          links(html).some(
            (link) => link.href === `/${workspace.handle}/${patch.name}` && link.text === "Open"
          )
        );
        assert.include(html, `data-copy="${PUBLIC_BASE_URL}/${workspace.handle}/${patch.name}"`);
        // Overview holds no forms; the tabs say where they are.
        assert.deepStrictEqual(
          forms(html).filter((path) => path.startsWith(cardPath(patch.name))),
          []
        );
        // Share sits beside Open for those who manage the patch; ⋯ holds the rest.
        assert.strictEqual(
          links(html).some((link) => link.href === `${cardPath(patch.name)}?share=${patch.name}`),
          person !== workspace.member
        );
        assert.strictEqual(
          menuItems(html, `patch-${patch.patchId}`),
          `A useful office tool Open in a new tab Copy link${person === workspace.member ? "" : " Retire… Delete…"}`
        );
        const settings = yield* request(`${cardPath(patch.name)}/settings`, person);
        if (person === workspace.member) {
          assert.deepStrictEqual(tabLinks(html), ["Overview", "Versions 5"]);
          assert.strictEqual(settings.status, 403);
          assert.include(
            text(yield* settings.text),
            "Only the owner or an admin can change this patch's settings."
          );
        } else {
          assert.deepStrictEqual(tabLinks(html), ["Overview", "Log", "Versions 5", "Settings"]);
          assert.strictEqual(settings.status, 200);
          const manage = yield* settings.text;
          assert.deepStrictEqual(tabLinks(manage), ["Overview", "Log", "Versions 5", "Settings"]);
          assert.include(text(manage), "Edited by Priya");
          const controls = forms(manage).filter((path) => path.startsWith(cardPath(patch.name)));
          // Who can open it changes in the Share dialog.
          assert.deepStrictEqual(controls, [`${cardPath(patch.name)}/description`]);
          assert.isTrue(
            links(manage).some(
              (link) =>
                link.href === `${cardPath(patch.name)}/settings?share=${patch.name}` &&
                link.text === "Change…"
            )
          );
          for (const action of ["retire", "delete"])
            assert.isTrue(
              links(manage).some((link) => link.href === `${cardPath(patch.name)}/${action}`)
            );
          assert.isDefined(hidden(manage, "expectedDescriptionUpdatedAt"));
          assert.strictEqual(
            links(manage).some((link) => link.href === `${cardPath(patch.name)}/reassign`),
            person === workspace.admin
          );
        }
        const versions = yield* request(`${cardPath(patch.name)}/versions`, person);
        assert.strictEqual(versions.status, 200);
        const history = yield* versions.text;
        for (const version of [5, 4, 3, 2, 1])
          assert.match(history, new RegExp(`>\\s*v${version}\\s*<`));
        assert.include(text(history), "Priya");
        assert.include(text(history), "Serving");
        // Versions holds no forms; Serve this version… asks in a dialog first.
        assert.isFalse(forms(history).some((path) => path.includes("/rollback")));
        const serve = links(history)
          .filter((link) => link.text === "Serve this version…")
          .map((link) => link.href);
        if (person === workspace.member) assert.deepStrictEqual(serve, []);
        else {
          assert.deepStrictEqual(
            serve,
            [4, 3, 2, 1].map((version) => `${cardPath(patch.name)}/rollback?version=${version}`)
          );
          const asked = yield* request(serve[0]!.replaceAll("&amp;", "&"), person);
          assert.strictEqual(asked.status, 200);
          const dialog = yield* asked.text;
          assert.include(text(dialog), "Serve v4 instead of v5?");
          assert.include(forms(dialog), `${cardPath(patch.name)}/rollback`);
          assert.strictEqual(hidden(dialog, "versionNumber"), "4");
          assert.isDefined(hidden(dialog, "expectedCurrentVersionId"));
          assert.include(dialog, `data-close="${cardPath(patch.name)}/versions"`);
        }
      }
      // A member can't ask, and a version that isn't kept or already serves has nothing to ask.
      const memberAsks = yield* request(
        `${cardPath(patch.name)}/rollback?version=4`,
        workspace.member
      );
      assert.strictEqual(memberAsks.status, 403);
      for (const version of ["5", "9", "x", ""]) {
        const nothing = yield* request(
          `${cardPath(patch.name)}/rollback?version=${version}`,
          workspace.owner
        );
        assert.strictEqual(nothing.status, 303);
        assert.strictEqual(nothing.headers.location, `${cardPath(patch.name)}/versions`);
      }
    })
  );

  it.effect("keeps retired and deleted cards at their names with only the allowed acts", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      for (const state of ["retired", "deleted"] as const) {
        const patch = yield* publish(workspace.owner, `office-${state}`);
        if (state === "retired") yield* service.retire(patch.patchId, actor(workspace.admin));
        else yield* service.delete(patch.patchId, actor(workspace.admin));
        yield* TestClock.adjust(2 * DAY);
        for (const person of [workspace.member, workspace.owner, workspace.admin]) {
          const response = yield* request(cardPath(patch.name), person);
          assert.strictEqual(response.status, 200);
          const html = yield* response.text;
          assert.strictEqual(heading(html), patch.name);
          // The status line says who took it down and when, and what that means now.
          const status = text(html.match(/<div class="ph-status">[\s\S]*?<\/div>/)?.[0] ?? "");
          if (state === "retired")
            assert.match(
              status,
              /^Retired Retired by Sam on 1 Jan 2026 \. Nobody can open it until it’s restored\.$/
            );
          else
            assert.match(
              status,
              /^Deleted Deleted by Sam on 3 Jan 2026 \. Gone for good on 2 Feb 2026 unless restored\.$/
            );
          assert.isFalse(links(html).some((link) => link.text === "Open"));
          assert.notInclude(html, `${cardPath(patch.name)}/scope`);
          assert.notInclude(html, `${cardPath(patch.name)}/rollback`);
          assert.notInclude(html, `${cardPath(patch.name)}/retire`);
          const controls = forms(html).filter((path) => path.startsWith(cardPath(patch.name)));
          if (person === workspace.member) {
            assert.deepStrictEqual(controls, []);
            assert.notInclude(html, "<dt>");
            assert.notInclude(html, `${cardPath(patch.name)}/restore`);
          } else {
            // Restore is the header's primary; the rest of managing is under Settings.
            assert.deepStrictEqual(controls, [`${cardPath(patch.name)}/restore`]);
            assert.strictEqual(hidden(html, "expectedState"), state);
            const manage = yield* (yield* request(`${cardPath(patch.name)}/settings`, person)).text;
            const settings = forms(manage).filter((path) => path.startsWith(cardPath(patch.name)));
            assert.notInclude(manage, `${cardPath(patch.name)}/scope`);
            assert.notInclude(manage, `${cardPath(patch.name)}/retire`);
            if (state === "retired") {
              assert.include(settings, `${cardPath(patch.name)}/description`);
              assert.include(manage, `${cardPath(patch.name)}/delete`);
            } else assert.notInclude(manage, `${cardPath(patch.name)}/description`);
            assert.strictEqual(
              manage.includes(`${cardPath(patch.name)}/reassign`),
              person === workspace.admin
            );
          }
        }
      }
    })
  );

  it.effect(
    "says on Overview's status line how many calls failed in the last day, for those who manage it",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const patch = yield* publishTier2(workspace.owner, "failing-tool");
        const seed = seedOf(workspace.id, patch);
        const statusOf = (html: string) =>
          text(html.match(/<div class="ph-status">[\s\S]*?<\/div>/)?.[0] ?? "");
        yield* invoke(seed, workspace.member, { handler: "deals.list", kind: "query" });
        const quiet = yield* (yield* request(cardPath(patch.name), workspace.owner)).text;
        assert.notInclude(quiet, 'class="ph-status"');
        const fail = invoke(seed, workspace.member, {
          handler: "deals.move",
          kind: "mutation",
          outcome: "failure",
          outcomeCode: "handler_failed"
        });
        yield* fail;
        yield* fail;
        for (const person of [workspace.owner, workspace.admin]) {
          const html = yield* (yield* request(cardPath(patch.name), person)).text;
          assert.strictEqual(statusOf(html), "2 failed calls in the last 24 hours View log");
          assert.include(
            links(html).map((link) => link.href),
            logPath(patch.name, "?outcome=failed")
          );
          // Only on Overview; the other tabs keep the header quiet.
          const versions = yield* (yield* request(`${cardPath(patch.name)}/versions`, person)).text;
          assert.notInclude(versions, 'class="ph-status"');
        }
        const member = yield* (yield* request(cardPath(patch.name), workspace.member)).text;
        assert.notInclude(member, 'class="ph-status"');
        // A day later they have dropped out of the window.
        yield* TestClock.adjust(DAY + 1);
        const later = yield* (yield* request(cardPath(patch.name), workspace.owner)).text;
        assert.notInclude(later, 'class="ph-status"');
      })
  );

  it.effect("holds one notice: a refusal over Overview leaves out why guests can't open it", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const guest = (yield* company()).member;
      const source = yield* publishSource(workspace.owner, "guest-source");
      // A patch reading another patch's table turns its guests away.
      const patch = yield* publishDependant(workspace.owner, "guest-reader", source.patchId);
      yield* (yield* GuestGrants.GuestGrants).grant({
        patchId: patch.patchId,
        userId: guest.id,
        grantedBy: workspace.owner.id
      });
      // The page's own notices; the shell's Tell Patchy keeps its one note inert outside the page.
      const notices = (html: string) =>
        [
          ...html.slice(html.indexOf("<main")).matchAll(/<p class="notice-title">([^<]*)<\/p>/g)
        ].map((match) => match[1]);
      const clean = yield* (yield* request(cardPath(patch.name), workspace.admin)).text;
      assert.deepStrictEqual(notices(clean), ["Guests can't open this"]);
      yield* (yield* Patches.Patches).reassign(
        patch.patchId,
        actor(workspace.admin),
        workspace.member.id
      );
      const stale = yield* post(`${cardPath(patch.name)}/reassign`, workspace.admin, {
        expectedPatchId: patch.patchId,
        expectedOwnerUserId: workspace.owner.id,
        user: workspace.admin.id
      });
      assert.strictEqual(stale.status, 409);
      const refused = notices(yield* stale.text);
      assert.strictEqual(refused.length, 1);
      assert.match(refused[0]!, /^This patch changed while you had this page open/);
    })
  );

  it.effect("marks a deactivated owner on the card and warns admins", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      yield* publish(workspace.admin, "charlie-deactivated");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${workspace.admin.id}`;
      const inactive = yield* (yield* request("/patches/charlie-deactivated", workspace.owner))
        .text;
      assert.include(text(inactive), "Sam (deactivated)");
      yield* sql`UPDATE users SET role = 'admin' WHERE id = ${workspace.owner.id}`;
      const managed = yield* (yield* request("/patches/charlie-deactivated", workspace.owner)).text;
      assert.include(text(managed), "Nobody can publish to this patch");
    })
  );

  // render.test.ts owns the clause table; this pins the card and Home wiring.

  it.effect("calls a patch by its title, less its company, its name in the address under it", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const description = "Find a desk. Keep the second sentence on the card.";
      const titled = yield* publish(workspace.owner, "office-map", {
        title: "Office <map> · Northwind",
        description
      });
      const untitled = yield* publish(workspace.owner, "blank-title", {
        title: "",
        description: ""
      });

      const card = yield* (yield* request(cardPath(titled.name), workspace.member)).text;
      assert.strictEqual(heading(card), "Office &lt;map&gt;");
      assert.include(card, "<title>Office &lt;map&gt; – All patches – Northwind</title>");
      assert.include(
        text(card.match(/<p class="ph-meta">[\s\S]*?<\/p>/)?.[0] ?? ""),
        `/${workspace.handle}/office-map`
      );
      assert.include(text(card.split(/<\/h1>/)[1] ?? ""), description);
      const bare = yield* (yield* request(cardPath(untitled.name), workspace.member)).text;
      assert.strictEqual(heading(bare), "blank-title");
      // A member sees no description where there is none; its owner gets the way to add one.
      assert.notInclude(text(bare), "No description");
      const owned = yield* (yield* request(cardPath(untitled.name), workspace.owner)).text;
      assert.include(text(owned), "No description yet. Add one");
      assert.include(
        links(owned).map((link) => link.href),
        `${cardPath(untitled.name)}/settings`
      );
    })
  );

  it.effect("saves normalized descriptions without a version and does not gate on rollback", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "description-save");
      yield* publish(workspace.owner, patch.name, { intent: "update", patchId: patch.patchId });
      const before = yield* readPatch(workspace.owner, patch.patchId);
      yield* TestClock.adjust(1_000);
      yield* (yield* Patches.Patches).rollback(patch.patchId, actor(workspace.admin), 1);
      const response = yield* post(`${cardPath(patch.name)}/description`, workspace.owner, {
        expectedPatchId: patch.patchId,
        description: "  Find\n a desk <quickly>  ",
        expectedDescriptionUpdatedAt: before.patch.descriptionUpdatedAt ?? ""
      });
      assert.strictEqual(response.status, 303);
      assert.strictEqual(response.headers.location, `${cardPath(patch.name)}/settings`);
      assert.strictEqual(
        yield* receiptAfter(response, workspace.owner),
        "Saved description-save’s description"
      );
      const saved = yield* readPatch(workspace.owner, patch.patchId);
      assert.strictEqual(saved.patch.description, "Find a desk <quickly>");
      assert.strictEqual(saved.currentVersion, 1);
      assert.strictEqual(saved.patch.descriptionUpdatedBy, workspace.owner.id);
      const html = yield* (yield* request(response.headers.location!, workspace.owner)).text;
      assert.include(html, "Find a desk &lt;quickly&gt;");
    })
  );

  it.effect("names what each act did on the page it lands on, and nothing for a refusal", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "receipt-trail", { title: "Receipt trail" });
      yield* publish(workspace.owner, patch.name, {
        intent: "update",
        patchId: patch.patchId,
        title: "Receipt trail"
      });
      const path = (action: string) => `${cardPath(patch.name)}/${action}`;
      const expectedPatchId = patch.patchId;
      const current = yield* readPatch(workspace.owner, patch.patchId);
      const acts = [
        [
          workspace.owner,
          "rollback",
          { versionNumber: "1", expectedCurrentVersionId: current.patch.currentVersionId! },
          "Receipt trail now serves v1"
        ],
        [
          workspace.admin,
          "reassign",
          { expectedOwnerUserId: workspace.owner.id, user: workspace.member.id },
          "Receipt trail now belongs to Alex"
        ],
        [workspace.member, "retire", { expectedState: "live" }, "Retired Receipt trail"],
        [workspace.member, "restore", { expectedState: "retired" }, "Restored Receipt trail"],
        [
          workspace.member,
          "delete",
          { expectedState: "not-deleted", confirm: patch.name },
          "Deleted Receipt trail; it can be restored for 30 days"
        ]
      ] as const;
      for (const [person, action, fields, receipt] of acts) {
        const response = yield* post(path(action), person, { expectedPatchId, ...fields });
        assert.strictEqual(response.status, 303, action);
        assert.strictEqual(yield* receiptAfter(response, person), receipt);
      }
      // Priya no longer owns it, so her restore is refused and claims nothing.
      const refused = yield* post(path("restore"), workspace.owner, {
        expectedPatchId,
        expectedState: "deleted"
      });
      assert.strictEqual(refused.status, 403);
      assert.strictEqual(Cookies.toCookieHeader(refused.cookies), "");
    })
  );

  it.effect(
    "rolls back to the target retained version without moving the description or inventory",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const patch = yield* publish(workspace.owner, "rollback-save");
        yield* publish(workspace.owner, patch.name, {
          intent: "update",
          patchId: patch.patchId,
          description: "The current description"
        });
        const before = yield* readPatch(workspace.owner, patch.patchId);
        const service = yield* Patches.Patches;
        const inventory = yield* service.inventory(patch.patchId, workspace.owner.id);
        const response = yield* post(`${cardPath(patch.name)}/rollback`, workspace.owner, {
          expectedPatchId: patch.patchId,
          versionNumber: "1",
          expectedCurrentVersionId: before.patch.currentVersionId ?? ""
        });
        assert.strictEqual(response.status, 303);
        assert.strictEqual(response.headers.location, `${cardPath(patch.name)}/versions`);
        const saved = yield* readPatch(workspace.owner, patch.patchId);
        assert.strictEqual(saved.currentVersion, 1);
        assert.deepStrictEqual(reported(patch.patchId), [
          {
            name: "patch.rolled_back",
            principalId: workspace.owner.id,
            companyId: workspace.id,
            properties: {
              patchId: patch.patchId,
              ownerUserId: workspace.owner.id,
              byAdmin: false,
              versionNumber: 1,
              fromVersionNumber: 2
            }
          }
        ]);
        assert.strictEqual(saved.patch.currentVersionId, patch.versionId);
        assert.strictEqual(saved.patch.description, before.patch.description);
        assert.strictEqual(saved.patch.descriptionUpdatedAt, before.patch.descriptionUpdatedAt);
        assert.deepStrictEqual(
          yield* service.inventory(patch.patchId, workspace.owner.id),
          inventory
        );
      })
  );

  for (const action of ["retire", "delete"] as const) {
    it.effect(
      `${action} lets owners and admins confirm without acknowledgement when nothing depends on it`,
      () =>
        Effect.gen(function* () {
          const workspace = yield* company();
          for (const person of [workspace.owner, workspace.admin]) {
            const patch = yield* publish(workspace.owner, `${action}-${person.role}`);
            const path = `${cardPath(patch.name)}/${action}`;
            const before = yield* readPatch(workspace.owner, patch.patchId);
            const page = yield* request(path, person);
            assert.strictEqual(page.status, 200);
            assert.strictEqual(page.headers["cache-control"], "private, no-store");
            const html = yield* page.text;
            assert.include(forms(html), path);
            assert.strictEqual(
              hidden(html, "expectedState"),
              action === "retire" ? "live" : "not-deleted"
            );
            // "Are you sure" for Retire, the typed name for Delete, each naming the act and the patch.
            assert.include(
              text(html.match(/<section class="dialog"[\s\S]*<\/section>/)?.[0] ?? ""),
              action === "retire"
                ? `Retire ${patch.name}? Nobody can open it until you or an admin restores it.`
                : `Delete ${patch.name} It goes off its address now and is gone for good on`
            );
            assert.strictEqual(inputs(html, "confirm", "text").length, action === "delete" ? 1 : 0);
            // Nothing reads it, so the dialog acknowledges nothing; Cancel goes back to Settings.
            assert.isUndefined(hidden(html, "ack"));
            assert.deepStrictEqual(inputs(html, "ack", "checkbox"), []);
            assert.include(html, `data-close="${cardPath(patch.name)}/settings"`);
            assert.include(
              links(html).map((link) => link.href),
              `${cardPath(patch.name)}/settings`
            );
            assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
            const response = yield* post(path, person, {
              expectedPatchId: patch.patchId,
              expectedState: action === "retire" ? "live" : "not-deleted",
              ...(action === "delete" ? { confirm: patch.name } : {})
            });
            assert.strictEqual(response.status, 303);
            assert.strictEqual(response.headers.location, `${cardPath(patch.name)}`);
            const saved = yield* readPatch(workspace.owner, patch.patchId);
            assert.strictEqual(saved.patch.state, action === "retire" ? "retired" : "deleted");
            assert.deepStrictEqual(reported(patch.patchId), [
              {
                name: action === "retire" ? "patch.retired" : "patch.deleted",
                principalId: person.id,
                companyId: workspace.id,
                properties: {
                  patchId: patch.patchId,
                  ownerUserId: workspace.owner.id,
                  byAdmin: person === workspace.admin
                }
              }
            ]);
            assert.strictEqual(saved.patch.lastChangedBy, person.id);
            assert.strictEqual(
              saved.patch[action === "retire" ? "retiredBy" : "deletedBy"],
              person.id
            );
            assert.strictEqual(saved.patch.currentVersionId, before.patch.currentVersionId);
            const card = yield* (yield* request(`${cardPath(patch.name)}`, workspace.member)).text;
            assert.include(
              text(card),
              `${action === "retire" ? "Retired" : "Deleted"} by ${person.name}`
            );
          }
        })
    );

    for (const kind of ["table", "store"] as const)
      it.effect(
        `${action} recomputes ${kind} dependants after GET and requires exactly ack=1`,
        () =>
          Effect.gen(function* () {
            const workspace = yield* company();
            const source = yield* publishSource(workspace.owner, `${action}-${kind}-source`, kind);
            const first = yield* publishDependant(
              workspace.member,
              `${action}-first`,
              source.patchId,
              kind
            );
            const path = `${cardPath(source.name)}/${action}`;
            const page = yield* request(path, workspace.owner);
            assert.strictEqual(page.status, 200);
            const html = yield* page.text;
            // The dialog names who reads it and what; pressing it is the acknowledgement.
            assert.include(text(html), first.name);
            assert.include(text(html), kind === "table" ? "notes" : "photos");
            assert.include(text(html), workspace.member.name);
            assert.strictEqual(hidden(html, "ack"), "1");
            assert.deepStrictEqual(inputs(html, "ack", "checkbox"), []);
            const card = yield* (yield* request(cardPath(source.name), workspace.owner)).text;
            assert.include(
              text(card.match(/<dt>Used by<\/dt><dd>[\s\S]*?<\/dd>/)?.[0] ?? ""),
              first.name
            );
            const later = yield* publishDependant(
              workspace.owner,
              `${action}-later`,
              source.patchId,
              kind
            );
            const before = yield* readPatch(workspace.owner, source.patchId);
            const fields = {
              expectedPatchId: source.patchId,
              expectedState: action === "retire" ? "live" : "not-deleted",
              ...(action === "delete" ? { confirm: source.name } : {})
            };
            for (const acknowledgement of acknowledgements) {
              const refused = yield* post(path, workspace.owner, { ...fields, ...acknowledgement });
              assert.strictEqual(refused.status, 409);
              const fresh = yield* refused.text;
              assert.include(text(fresh), first.name);
              assert.include(text(fresh), later.name);
              assert.include(forms(fresh), path);
              assert.strictEqual(hidden(fresh, "ack"), "1");
              assert.include(
                text(fresh),
                "These patches read this patch's tables. Acknowledge that they will break before continuing. Nothing was done."
              );
              assert.deepStrictEqual(yield* readPatch(workspace.owner, source.patchId), before);
              assert.deepStrictEqual(reported(source.patchId), []);
            }
            const accepted = yield* post(path, workspace.admin, { ...fields, ack: "1" });
            assert.strictEqual(accepted.status, 303);
            assert.strictEqual(accepted.headers.location, `${cardPath(source.name)}`);
            const saved = yield* readPatch(workspace.owner, source.patchId);
            assert.strictEqual(saved.patch.state, action === "retire" ? "retired" : "deleted");
            assert.strictEqual(saved.patch.lastChangedBy, workspace.admin.id);
            for (const dependant of [first, later]) {
              const read = yield* readPatch(workspace.owner, dependant.patchId);
              assert.strictEqual(read.patch.state, "live");
              assert.strictEqual(read.reads[0]!.state, saved.patch.state);
            }
          })
      );

    it.effect(
      `${action} goes through when every patch reading it is one the owner can't open`,
      () =>
        Effect.gen(function* () {
          const workspace = yield* company();
          const service = yield* Patches.Patches;
          const source = yield* publishSource(workspace.owner, `${action}-hidden-source`, "table");
          const reader = yield* publishDependant(
            workspace.member,
            `${action}-hidden-reader`,
            source.patchId
          );
          const teams = yield* Teams.Teams;
          const team = yield* teams.create({
            companyId: workspace.id,
            actorId: workspace.admin.id,
            name: `${action} readers`
          });
          yield* teams.setMemberships({
            companyId: workspace.id,
            actorId: workspace.admin.id,
            teamId: team.id,
            add: [workspace.member.id]
          });
          yield* service.setSharing({
            patchId: reader.patchId,
            actor: actor(workspace.member),
            audience: { kind: "teams", teamIds: [team.id] }
          });
          const path = `${cardPath(source.name)}/${action}`;
          const dialog = yield* (yield* request(path, workspace.owner)).text;
          const done = yield* post(path, workspace.owner, {
            ...formFields(dialog, path),
            ...(action === "delete" ? { confirm: source.name } : {})
          });
          assert.strictEqual(done.status, 303);
          assert.strictEqual(
            (yield* readPatch(workspace.owner, source.patchId)).patch.state,
            action === "retire" ? "retired" : "deleted"
          );
        })
    );

    it.effect(`refuses a stale ${action} confirmation with the fresh state and actor`, () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const patch = yield* publish(workspace.owner, `stale-${action}-confirmation`);
        const path = `${cardPath(patch.name)}/${action}`;
        const page = yield* request(path, workspace.owner);
        assert.strictEqual(page.status, 200);
        const fields = {
          expectedPatchId: patch.patchId,
          expectedState: hidden(yield* page.text, "expectedState")!,
          ...(action === "delete" ? { confirm: patch.name } : {})
        };
        if (action === "retire") yield* service.retire(patch.patchId, actor(workspace.admin));
        else yield* service.delete(patch.patchId, actor(workspace.admin));
        yield* TestClock.adjust(2 * 60 * 1_000);
        const before = yield* readPatch(workspace.owner, patch.patchId);
        const unavailable = yield* request(path, workspace.owner);
        assert.strictEqual(unavailable.status, 409);
        const unavailableHtml = yield* unavailable.text;
        assert.strictEqual(heading(unavailableHtml), patch.name);
        assert.include(
          text(unavailableHtml),
          `${action === "retire" ? "Retired" : "Deleted"} by Sam`
        );
        assert.notInclude(forms(unavailableHtml), path);
        const response = yield* post(path, workspace.owner, fields);
        assert.strictEqual(response.status, 409);
        const html = yield* response.text;
        assert.strictEqual(heading(html), patch.name);
        assertStale(html, action === "retire" ? "retired" : "deleted");
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
      })
    );
  }

  for (const action of [
    "description",
    "scope",
    "rollback",
    "restore",
    "retire",
    "delete",
    "reassign"
  ] as const) {
    it.effect(`refuses an old ${action} form once its name belongs to another patch`, () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const person = action === "reassign" ? workspace.admin : workspace.owner;
        const original = yield* publish(workspace.owner, `reused-${action}`);
        if (action === "rollback")
          yield* publish(workspace.owner, original.name, {
            intent: "update",
            patchId: original.patchId
          });
        if (action === "restore") yield* service.retire(original.patchId, actor(workspace.owner));
        const path = `${cardPath(original.name)}/${action}`;
        // Each form's page: its tab, or the dialog it asks in.
        const formPage = {
          description: `${cardPath(original.name)}/settings`,
          scope: `${cardPath(original.name)}?share=${original.name}`,
          rollback: `${cardPath(original.name)}/rollback?version=1`,
          restore: cardPath(original.name),
          retire: path,
          delete: path,
          reassign: path
        }[action];
        const page = yield* (yield* request(formPage, person)).text;
        const entered: Record<typeof action, FormFields> = {
          description: { description: "Overwritten" },
          scope: { scope: "public" },
          rollback: {},
          restore: {},
          retire: {},
          delete: { confirm: original.name },
          reassign: { user: workspace.member.id }
        };
        const fields: FormFields = { ...formFields(page, path), ...entered[action] };
        if (action === "restore") yield* service.restore(original.patchId, actor(workspace.owner));
        yield* publish(workspace.owner, `archived-${action}`, {
          intent: "update",
          patchId: original.patchId
        });
        const replacement = yield* publish(workspace.owner, original.name);
        if (action === "restore")
          yield* service.retire(replacement.patchId, actor(workspace.owner));
        const before = [
          yield* readPatch(workspace.owner, original.patchId),
          yield* readPatch(workspace.owner, replacement.patchId)
        ];
        const { expectedPatchId, ...withoutId } = fields;
        assert.strictEqual(expectedPatchId, original.patchId);
        for (const [submitted, notice] of [
          [fields, "This name now belongs to a different patch. Nothing was done."],
          [withoutId, "This form is out of date. Nothing was done."]
        ] as const) {
          const response = yield* post(path, person, submitted);
          assert.strictEqual(response.status, 409);
          const html = yield* response.text;
          assert.include(text(html), notice);
          assert.strictEqual(heading(html), original.name);
          // No form at all, not even the replacement's Restore: any would act on another patch.
          assert.deepStrictEqual(
            forms(html).filter((path) => path.startsWith("/patches/")),
            []
          );
          assert.notInclude(html, original.patchId);
          assert.deepStrictEqual(
            [
              yield* readPatch(workspace.owner, original.patchId),
              yield* readPatch(workspace.owner, replacement.patchId)
            ],
            before
          );
        }
      })
    );
  }

  it.effect("says the name moved on even when someone else's patch took it", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const original = yield* publish(workspace.owner, "reused-by-alex");
      const path = `${cardPath(original.name)}/scope`;
      const page = yield* (yield* request(
        `${cardPath(original.name)}?share=${original.name}`,
        workspace.owner
      )).text;
      const fields = { ...formFields(page, path), scope: "public" };
      yield* publish(workspace.owner, "kept-by-priya", {
        intent: "update",
        patchId: original.patchId
      });
      const replacement = yield* publish(workspace.member, original.name);
      const before = yield* readPatch(workspace.member, replacement.patchId);
      const response = yield* post(path, workspace.owner, fields);
      assert.strictEqual(response.status, 409);
      assert.include(
        text(yield* response.text),
        "This name now belongs to a different patch. Nothing was done."
      );
      assert.deepStrictEqual(yield* readPatch(workspace.member, replacement.patchId), before);
    })
  );

  it.effect(
    "uses the current state to decide delete warnings across live and retired transitions",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        for (const initialState of ["live", "retired"] as const) {
          const source = yield* publishSource(workspace.owner, `delete-from-${initialState}`);
          const dependant = yield* publishDependant(
            workspace.member,
            `reader-from-${initialState}`,
            source.patchId
          );
          if (initialState === "retired")
            yield* service.retire(source.patchId, actor(workspace.owner), true);
          const path = `${cardPath(source.name)}/delete`;
          const page = yield* request(path, workspace.owner);
          assert.strictEqual(page.status, 200);
          // The dialog's own form, not the Restore behind it while retired.
          const fields: FormFields = {
            ...formFields(yield* page.text, path),
            confirm: source.name
          };
          assert.strictEqual(fields.expectedState, "not-deleted");
          // Live, the dialog names its reader and acknowledges it; retired, it has none to name.
          assert.strictEqual(fields.ack, initialState === "live" ? "1" : undefined);
          if (initialState === "live")
            yield* service.retire(source.patchId, actor(workspace.admin), true);
          else yield* service.restore(source.patchId, actor(workspace.admin));
          const before = yield* readPatch(workspace.owner, source.patchId);
          const response = yield* post(path, workspace.owner, fields);
          if (initialState === "live") {
            assert.strictEqual(response.status, 303);
          } else {
            assert.strictEqual(response.status, 409);
            const html = yield* response.text;
            assert.include(text(html), dependant.name);
            assert.strictEqual(hidden(html, "ack"), "1");
            assert.deepStrictEqual(yield* readPatch(workspace.owner, source.patchId), before);
            assert.strictEqual(
              (yield* post(path, workspace.owner, { ...fields, ack: "1" })).status,
              303
            );
          }
          const saved = yield* readPatch(workspace.owner, source.patchId);
          assert.strictEqual(saved.patch.state, "deleted");
          assert.strictEqual(saved.patch.deletedBy, workspace.owner.id);
        }
      })
  );

  it.effect(
    "deletes a retired source without warning again and starts a fresh 30-day recovery clock",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const source = yield* publishSource(workspace.owner, "retired-delete-source");
        const dependant = yield* publishDependant(
          workspace.member,
          "retired-delete-reader",
          source.patchId
        );
        yield* service.retire(source.patchId, actor(workspace.owner), true);
        yield* TestClock.adjust(7 * DAY);
        const path = `${cardPath(source.name)}/delete`;
        const page = yield* request(path, workspace.owner);
        assert.strictEqual(page.status, 200);
        const html = yield* page.text;
        assert.notInclude(text(html), dependant.name);
        assert.deepStrictEqual(inputs(html, "ack", "checkbox"), []);
        assert.match(text(html), /30.day/);
        assert.include(text(html), "7 Feb 2026");
        const response = yield* post(path, workspace.owner, {
          expectedPatchId: source.patchId,
          expectedState: "not-deleted",
          confirm: source.name
        });
        assert.strictEqual(response.status, 303);
        const saved = yield* readPatch(workspace.owner, source.patchId);
        assert.strictEqual(saved.patch.state, "deleted");
        assert.strictEqual(saved.patch.deletedBy, workspace.owner.id);
        assert.strictEqual(saved.patch.deletedAt, "2026-01-08T00:00:00.000Z");
        assert.strictEqual(saved.patch.purgeAt, "2026-02-07T00:00:00.000Z");
        assert.strictEqual(
          (yield* readPatch(workspace.member, dependant.patchId)).patch.state,
          "live"
        );
      })
  );

  it.effect("keeps a mismatched typed delete name escaped and leaves the patch unchanged", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "exact-delete-name");
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const submitted = '<script>alert("wrong")</script>';
      const path = `${cardPath(patch.name)}/delete`;
      const response = yield* post(path, workspace.owner, {
        expectedPatchId: patch.patchId,
        expectedState: "not-deleted",
        confirm: submitted
      });
      assert.strictEqual(response.status, 422);
      const html = yield* response.text;
      assert.include(forms(html), path);
      assert.strictEqual(
        hidden(html, "confirm"),
        "&lt;script&gt;alert(&quot;wrong&quot;)&lt;/script&gt;"
      );
      assert.notInclude(html, submitted);
      assert.match(inputs(html, "confirm", "text")[0]!, /\baria-invalid="true"/);
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
    })
  );

  it.effect(
    "forbids members on every confirmation route and forbids non-admin owners from reassigning",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const patch = yield* publish(workspace.owner, "confirmation-permissions");
        for (const [action, fields] of [
          ["retire", { expectedState: "live" }],
          ["delete", { expectedState: "not-deleted", confirm: patch.name }],
          ["reassign", { expectedOwnerUserId: workspace.owner.id, user: workspace.member.id }],
          ["restore", { expectedState: "retired" }]
        ] as const) {
          if (action === "restore") yield* service.retire(patch.patchId, actor(workspace.owner));
          const before = yield* readPatch(workspace.owner, patch.patchId);
          for (const person of action === "reassign"
            ? [workspace.member, workspace.owner]
            : [workspace.member]) {
            const path = `${cardPath(patch.name)}/${action}`;
            for (const response of [
              yield* request(path, person),
              yield* post(path, person, { expectedPatchId: patch.patchId, ...fields })
            ]) {
              assert.strictEqual(response.status, 403);
              const html = yield* response.text;
              assert.strictEqual(heading(html), patch.name);
              assert.notInclude(forms(html), path);
            }
            assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
          }
        }
      })
  );

  it.effect(
    "restores retired and deleted patches at the same address without an acknowledgement",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const source = yield* publishSource(workspace.owner, "live-restore-source");
        for (const [state, person] of [
          ["retired", workspace.owner],
          ["deleted", workspace.admin]
        ] as const) {
          const patch = yield* publishDependant(
            workspace.owner,
            `restore-${state}`,
            source.patchId
          );
          if (state === "retired") yield* service.retire(patch.patchId, actor(workspace.owner));
          else yield* service.delete(patch.patchId, actor(workspace.owner));
          const before = yield* readPatch(workspace.owner, patch.patchId);
          for (const viewer of [workspace.owner, workspace.admin]) {
            const page = yield* request(`${cardPath(patch.name)}/restore`, viewer);
            assert.strictEqual(page.status, 303);
            assert.strictEqual(page.headers.location, `${cardPath(patch.name)}`);
          }
          const response = yield* post(`${cardPath(patch.name)}/restore`, person, {
            expectedPatchId: patch.patchId,
            expectedState: state
          });
          assert.strictEqual(response.status, 303);
          assert.strictEqual(response.headers.location, `${cardPath(patch.name)}`);
          const saved = yield* readPatch(workspace.owner, patch.patchId);
          assert.strictEqual(saved.patch.state, "live");
          // After the setup's own retirement or deletion, the restore reports once.
          assert.deepStrictEqual(reported(patch.patchId).slice(1), [
            {
              name: "patch.restored",
              principalId: person.id,
              companyId: workspace.id,
              properties: {
                patchId: patch.patchId,
                ownerUserId: workspace.owner.id,
                byAdmin: person === workspace.admin,
                from: state
              }
            }
          ]);
          assert.strictEqual(saved.patch.name, patch.name);
          assert.strictEqual(saved.patch.currentVersionId, before.patch.currentVersionId);
          assert.strictEqual(saved.patch.description, before.patch.description);
          assert.strictEqual(saved.patch.lastChangedBy, person.id);
          assert.isTrue(
            links(yield* (yield* request(cardPath(patch.name), workspace.member)).text).some(
              (link) => link.text === "Open"
            )
          );
        }
      })
  );

  for (const action of ["description", "scope", "rollback", "restore"] as const) {
    it.effect(`refuses a stale ${action} field with a fresh card and changes nothing`, () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const patch = yield* publish(workspace.owner, `stale-${action}`);
        let fields: Record<string, string>;
        let changed: string;
        if (action === "description") {
          fields = {
            description: "Overwritten",
            expectedDescriptionUpdatedAt: patch.descriptionUpdatedAt ?? ""
          };
          yield* TestClock.adjust(1_000);
          yield* service.setDescription(patch.patchId, actor(workspace.admin), "Sam's description");
          changed = "description changed";
        } else if (action === "scope") {
          fields = {
            scope: "company",
            expectedLifecycleRevision: (yield* readPatch(workspace.owner, patch.patchId)).patch
              .lifecycleRevision
          };
          yield* service.setSharing({
            patchId: patch.patchId,
            actor: actor(workspace.admin),
            audience: { kind: "public" }
          });
          changed = "sharing changed";
        } else if (action === "rollback") {
          yield* publish(workspace.owner, patch.name, { intent: "update", patchId: patch.patchId });
          const current = yield* publish(workspace.owner, patch.name, {
            intent: "update",
            patchId: patch.patchId
          });
          fields = { versionNumber: "2", expectedCurrentVersionId: current.versionId };
          yield* service.rollback(patch.patchId, actor(workspace.admin), 1);
          changed = "rolled back to v1";
        } else {
          yield* service.retire(patch.patchId, actor(workspace.owner));
          fields = { expectedState: "retired" };
          yield* service.delete(patch.patchId, actor(workspace.admin));
          changed = "deleted";
        }
        const before = yield* readPatch(workspace.owner, patch.patchId);
        yield* TestClock.adjust(2 * 60 * 1_000);
        const response = yield* post(`${cardPath(patch.name)}/${action}`, workspace.owner, {
          expectedPatchId: patch.patchId,
          ...fields
        });
        assert.strictEqual(response.status, 409);
        const html = yield* response.text;
        assert.strictEqual(heading(html), patch.name);
        assertStale(html, changed);
        if (action === "description") assert.include(html, ">Overwritten</textarea>");
        const expectedName = {
          description: "expectedDescriptionUpdatedAt",
          scope: "expectedLifecycleRevision",
          rollback: "expectedCurrentVersionId",
          restore: "expectedState"
        }[action];
        const expectedValue = {
          description: before.patch.descriptionUpdatedAt ?? "",
          scope: before.patch.lifecycleRevision,
          rollback: before.patch.currentVersionId ?? "",
          restore: before.patch.state
        }[action];
        // The fresh form: on the tab, or, for a version, in the dialog Versions links to.
        const fresh =
          action === "rollback"
            ? yield* (yield* request(`${cardPath(patch.name)}/rollback?version=2`, workspace.owner))
                .text
            : html;
        assert.strictEqual(hidden(fresh, expectedName), expectedValue);
        assert.include(forms(fresh), `${cardPath(patch.name)}/${action}`);
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
      })
    );
  }

  it.effect("names the intervening restore when an old restore form is posted", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const patch = yield* publish(workspace.owner, "already-restored");
      yield* service.retire(patch.patchId, actor(workspace.owner));
      const form = yield* (yield* request(cardPath(patch.name), workspace.owner)).text;
      yield* service.restore(patch.patchId, actor(workspace.admin));
      yield* TestClock.adjust(2 * 60 * 1_000);
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const redirect = yield* request(`${cardPath(patch.name)}/restore`, workspace.owner);
      assert.strictEqual(redirect.status, 303);
      assert.strictEqual(redirect.headers.location, `${cardPath(patch.name)}`);
      const response = yield* post(
        `${cardPath(patch.name)}/restore`,
        workspace.owner,
        formFields(form, `${cardPath(patch.name)}/restore`)
      );
      assert.strictEqual(response.status, 409);
      assertStale(yield* response.text, "restored");
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
    })
  );

  it.effect("keeps a description refused because its patch was deleted, to copy", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "deleted-draft");
      const before = yield* readPatch(workspace.owner, patch.patchId);
      yield* (yield* Patches.Patches).delete(patch.patchId, actor(workspace.admin));
      const response = yield* post(`${cardPath(patch.name)}/description`, workspace.owner, {
        expectedPatchId: patch.patchId,
        description: "A <draft> worth keeping",
        expectedDescriptionUpdatedAt: before.patch.descriptionUpdatedAt ?? ""
      });
      assert.strictEqual(response.status, 409);
      const html = yield* response.text;
      assert.include(text(html), "Your description, not saved");
      assert.include(html, '<pre class="code-panel">A &lt;draft&gt; worth keeping</pre>');
      assert.notInclude(forms(html), `${cardPath(patch.name)}/description`);
    })
  );

  it.effect("refuses member edits before stale checks and keeps the card read-only", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "member-refused");
      for (const [action, fields] of [
        ["description", { description: "Intrusion", expectedDescriptionUpdatedAt: "" }],
        ["scope", { scope: "public", expectedScope: "public" }],
        ["rollback", { versionNumber: "999", expectedCurrentVersionId: "stale" }]
      ] as const) {
        const before = yield* readPatch(workspace.owner, patch.patchId);
        const response = yield* post(`${cardPath(patch.name)}/${action}`, workspace.member, {
          expectedPatchId: patch.patchId,
          ...fields
        });
        assert.strictEqual(response.status, 403);
        const html = yield* response.text;
        assert.strictEqual(heading(html), patch.name);
        assert.include(text(html), "Only the owner or an admin can do that. Nothing was done.");
        assert.isFalse(forms(html).some((path) => path.startsWith(cardPath(patch.name))));
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
      }
    })
  );

  it.effect("redisplays an invalid submitted description safely and changes nothing", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "description-invalid");
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const invalid = `<script>${"x".repeat(501)}</script>`;
      const response = yield* post(`${cardPath(patch.name)}/description`, workspace.owner, {
        expectedPatchId: patch.patchId,
        description: invalid,
        expectedDescriptionUpdatedAt: patch.descriptionUpdatedAt ?? ""
      });
      assert.strictEqual(response.status, 422);
      const html = yield* response.text;
      assert.match(
        html,
        /<textarea\b[^>]*>[\s\S]*&lt;script&gt;x{501}&lt;\/script&gt;[\s\S]*<\/textarea>/
      );
      assert.notInclude(html, invalid);
      assert.match(html, /<label\b[^>]*for="description"[^>]*>Description<\/label>/);
      assert.match(
        html,
        /<textarea\b[^>]*aria-describedby="description-error"[^>]*aria-invalid="true"/
      );
      assert.match(html, /<p\b[^>]*id="description-error"[^>]*>[^<]*500[^<]*<\/p>/);
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
    })
  );

  it.effect("rejects a rollback version outside PostgreSQL's integer range on the card", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "rollback-invalid");
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const response = yield* post(`${cardPath(patch.name)}/rollback`, workspace.owner, {
        expectedPatchId: patch.patchId,
        versionNumber: "2147483648",
        expectedCurrentVersionId: patch.versionId
      });
      assert.strictEqual(response.status, 422);
      const html = yield* response.text;
      assert.include(
        links(html).map((link) => link.href),
        "/settings/people"
      );
      assert.strictEqual(heading(html), patch.name);
      // No such version to ask about again, so Versions says what was refused.
      assert.include(html, 'aria-current="page">Versions');
      assert.include(text(html), "Nothing was done.");
      assert.notInclude(html, "data-dialog");
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
    })
  );

  it.effect("draws the Serve dialog again with its refusal, its version kept", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      // A tool's version can't serve while the patch is public.
      const patch = yield* publishTier2(workspace.owner, "serve-refused");
      yield* publish(workspace.owner, patch.name, { intent: "update", patchId: patch.patchId });
      yield* service.setSharing({
        patchId: patch.patchId,
        actor: actor(workspace.owner),
        audience: { kind: "public" }
      });
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const path = `${cardPath(patch.name)}/rollback`;
      const asked = yield* (yield* request(`${path}?version=1`, workspace.owner)).text;
      const response = yield* post(path, workspace.owner, formFields(asked, path));
      assert.strictEqual(response.status, 422);
      const html = yield* response.text;
      const dialog = html.match(/<section class="dialog"[\s\S]*<\/section>/)?.[0] ?? "";
      assert.include(text(dialog), "Serve v1 instead of v2?");
      assert.strictEqual(hidden(dialog, "versionNumber"), "1");
      // The refusal sits above the buttons and takes focus in place of Keep v2.
      assert.match(
        dialog,
        /<div class="refusal" tabindex="-1" autofocus><div class="notice notice-danger" role="alert">/
      );
      assert.include(text(dialog), "Nothing was done.");
      assert.strictEqual(dialog.match(/autofocus/g)?.length, 1);
      assert.include(html, `data-close="${cardPath(patch.name)}/versions"`);
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
    })
  );

  it.effect(
    "refuses rollback on an off card without drawing its form, and still changes who can open it",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const patch = yield* publish(workspace.owner, "retired-act");
        yield* service.retire(patch.patchId, actor(workspace.admin));
        yield* service.setDescription(patch.patchId, actor(workspace.admin), "Edited after retire");
        const before = yield* readPatch(workspace.owner, patch.patchId);
        const response = yield* post(`${cardPath(patch.name)}/rollback`, workspace.owner, {
          expectedPatchId: patch.patchId,
          versionNumber: "1",
          expectedCurrentVersionId: patch.versionId
        });
        assert.strictEqual(response.status, 409);
        const html = yield* response.text;
        assert.strictEqual(heading(html), patch.name);
        assert.notInclude(html, `${cardPath(patch.name)}/rollback`);
        const notice = text(
          html.match(/<div\b[^>]*role="alert"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ""
        );
        assert.include(notice, "description changed by Sam");
        assert.match(notice, /\bretired\b/);
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
        // Its audience still changes, so a team it names can be deleted; it stays retired.
        const shared = yield* post(`${cardPath(patch.name)}/scope`, workspace.owner, {
          expectedPatchId: patch.patchId,
          expectedLifecycleRevision: before.patch.lifecycleRevision,
          scope: "public",
          confirm: "public"
        });
        assert.strictEqual(shared.status, 303);
        const after = yield* readPatch(workspace.owner, patch.patchId);
        assert.deepStrictEqual(
          [after.patch.audience, after.patch.state],
          [{ kind: "public" }, "retired"]
        );
      })
  );

  it.effect("recomputes off sources for restore GET and POST before acknowledgement", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      // Patches owns which sources count as off; one gone source shows the portal's
      // warning, which names a source by id once its name is reclaimed.
      const gone = yield* publishSource(workspace.owner, "source-gone");
      const consumer = yield* publishDependant(workspace.owner, "reads-sources", gone.patchId);
      yield* service.retire(consumer.patchId, actor(workspace.owner));
      const drawn = yield* (yield* request(`${cardPath(consumer.name)}`, workspace.owner)).text;
      assert.include(forms(drawn), `${cardPath(consumer.name)}/restore`);
      yield* service.delete(gone.patchId, actor(workspace.owner));
      yield* TestClock.adjust(30 * DAY);
      yield* service.purgeDeleted(gone.patchId);
      for (const [state, person] of [
        ["retired", workspace.owner],
        ["deleted", workspace.admin]
      ] as const) {
        if (state === "deleted") yield* service.delete(consumer.patchId, actor(workspace.owner));
        const path = `${cardPath(consumer.name)}/restore`;
        const before = yield* readPatch(workspace.owner, consumer.patchId);
        const refused = yield* post(path, person, {
          expectedPatchId: consumer.patchId,
          expectedState: state
        });
        assert.strictEqual(refused.status, 409);
        const refusedHtml = yield* refused.text;
        for (const viewer of [workspace.owner, workspace.admin]) {
          const page = yield* request(path, viewer);
          assert.strictEqual(page.status, 200);
          for (const html of [yield* page.text, refusedHtml]) {
            assert.include(text(html), `${gone.patchId} notes · gone`);
            assert.include(forms(html), path);
            assert.strictEqual(hidden(html, "expectedPatchId"), consumer.patchId);
            assert.strictEqual(hidden(html, "expectedState"), state);
            // The dialog names the sources still off; pressing Restore acknowledges them.
            assert.strictEqual(hidden(html, "ack"), "1");
            assert.include(
              links(html).map((link) => link.href),
              `${cardPath(consumer.name)}`
            );
          }
        }
        assert.deepStrictEqual(yield* readPatch(workspace.owner, consumer.patchId), before);
        const fresh = yield* (yield* request(`${cardPath(consumer.name)}`, workspace.owner)).text;
        assert.notInclude(forms(fresh), path);
        assert.include(
          links(fresh).map((link) => link.href),
          path
        );
        const restored = yield* post(path, person, {
          expectedPatchId: consumer.patchId,
          expectedState: state,
          ack: "1"
        });
        assert.strictEqual(restored.status, 303);
        assert.strictEqual(restored.headers.location, `${cardPath(consumer.name)}`);
        const saved = yield* readPatch(workspace.owner, consumer.patchId);
        assert.strictEqual(saved.patch.state, "live");
        assert.strictEqual(saved.patch.lastChangedBy, person.id);
        assert.strictEqual(saved.patch.currentVersionId, before.patch.currentVersionId);
      }
    })
  );

  it.effect(
    "offers reassignment to active company members and redisplays invalid targets without changing ownership",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const foreign = yield* company();
        const users = yield* Users.Users;
        const patch = yield* publish(workspace.owner, "reassign-picker");
        const path = `${cardPath(patch.name)}/reassign`;
        const page = yield* request(path, workspace.admin);
        assert.strictEqual(page.status, 200);
        const html = yield* page.text;
        // A dialog over Settings, one form choosing among the company's active people.
        assert.include(html, `data-close="${cardPath(patch.name)}/settings"`);
        assert.deepStrictEqual(ownerChoices(html), [
          "",
          workspace.member.id,
          workspace.owner.id,
          workspace.admin.id
        ]);
        assert.include(
          text(html),
          `${workspace.owner.name} (${workspace.owner.email}), owns it now`
        );
        // A choice, not a destructive act: the dialog starts on the field, not on Cancel.
        assert.notInclude(html.slice(html.indexOf('id="patch-reassign"')), "autofocus");
        assert.notInclude(html, foreign.owner.email);
        assert.strictEqual(hidden(html, "expectedOwnerUserId"), workspace.owner.id);
        yield* users.deactivate({ companyId: workspace.id, userId: workspace.member.id });
        const before = yield* readPatch(workspace.owner, patch.patchId);
        for (const target of [workspace.member.id, foreign.owner.id, "usr_missing", ""]) {
          const refused = yield* post(path, workspace.admin, {
            expectedPatchId: patch.patchId,
            expectedOwnerUserId: workspace.owner.id,
            user: target
          });
          assert.strictEqual(refused.status, 409);
          const fresh = yield* refused.text;
          // The refusal sits under the owner field it is about, which the dialog starts on.
          assert.match(
            fresh,
            /<select\b[^>]*aria-describedby="reassign-owner-error"[^>]*aria-invalid="true"[^>]*name="user"/
          );
          assert.include(
            fresh,
            '<p class="field-error" id="reassign-owner-error">Choose an active member of this company. Nothing was done.</p>'
          );
          assert.notInclude(fresh.slice(fresh.indexOf('id="patch-reassign"')), "autofocus");
          assert.deepStrictEqual(ownerChoices(fresh), ["", workspace.owner.id, workspace.admin.id]);
          assert.include(forms(fresh), path);
          assert.include(
            links(fresh).map((link) => link.href),
            `${cardPath(patch.name)}/settings`
          );
          assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
        }
        const recovered = yield* post(path, workspace.admin, {
          expectedPatchId: patch.patchId,
          expectedOwnerUserId: workspace.owner.id,
          user: workspace.admin.id
        });
        assert.strictEqual(recovered.status, 303);
        assert.strictEqual(
          (yield* readPatch(workspace.admin, patch.patchId)).owner.id,
          workspace.admin.id
        );
      })
  );

  // Patches owns which stamps a reassignment keeps; a deleted card shows reassignment
  // still works in the most restricted state.

  it.effect("reassigns a deleted patch twice and treats the current owner as a no-op", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const patch = yield* publish(workspace.owner, "reassign-deleted");
      yield* service.delete(patch.patchId, actor(workspace.owner));
      const original = yield* readPatch(workspace.owner, patch.patchId);
      const path = `${cardPath(patch.name)}/reassign`;
      let currentOwner = workspace.owner.id;
      for (const next of [workspace.member, workspace.admin]) {
        const card = yield* (yield* request(`${cardPath(patch.name)}/settings`, workspace.admin))
          .text;
        assert.include(
          links(card).map((link) => link.href),
          path
        );
        const page = yield* request(path, workspace.admin);
        assert.strictEqual(page.status, 200);
        const html = yield* page.text;
        assert.strictEqual(hidden(html, "expectedOwnerUserId"), currentOwner);
        assert.include(ownerChoices(html), next.id);
        yield* TestClock.adjust(1_000);
        const response = yield* post(path, workspace.admin, {
          expectedPatchId: patch.patchId,
          expectedOwnerUserId: currentOwner,
          user: next.id
        });
        assert.strictEqual(response.status, 303);
        assert.strictEqual(response.headers.location, `${cardPath(patch.name)}`);
        const saved = yield* readPatch(workspace.owner, patch.patchId);
        assert.strictEqual(saved.owner.id, next.id);
        assert.strictEqual(saved.patch.reassignedBy, workspace.admin.id);
        assert.strictEqual(saved.patch.state, "deleted");
        assert.strictEqual(saved.patch.purgeAt, original.patch.purgeAt);
        currentOwner = next.id;
      }
      const beforeNoop = yield* readPatch(workspace.owner, patch.patchId);
      yield* TestClock.adjust(DAY);
      const noop = yield* post(path, workspace.admin, {
        expectedPatchId: patch.patchId,
        expectedOwnerUserId: currentOwner,
        user: currentOwner
      });
      assert.strictEqual(noop.status, 303);
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), beforeNoop);
      const reassigned = (from: Person, to: Person): Analytics.AnalyticsEvent => ({
        name: "patch.reassigned",
        principalId: workspace.admin.id,
        companyId: workspace.id,
        properties: { patchId: patch.patchId, ownerUserId: to.id, fromUserId: from.id }
      });
      assert.deepStrictEqual(reported(patch.patchId).slice(1), [
        reassigned(workspace.owner, workspace.member),
        reassigned(workspace.member, workspace.admin)
      ]);
    })
  );

  it.effect("refuses reassignment against an old owner and returns the fresh card and actor", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const patch = yield* publish(workspace.owner, "stale-reassign");
      const path = `${cardPath(patch.name)}/reassign`;
      const page = yield* request(path, workspace.admin);
      assert.strictEqual(page.status, 200);
      const expectedOwner = hidden(yield* page.text, "expectedOwnerUserId")!;
      yield* service.reassign(patch.patchId, actor(workspace.admin), workspace.member.id);
      yield* TestClock.adjust(2 * 60 * 1_000);
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const response = yield* post(path, workspace.admin, {
        expectedPatchId: patch.patchId,
        expectedOwnerUserId: expectedOwner,
        user: workspace.admin.id
      });
      assert.strictEqual(response.status, 409);
      const html = yield* response.text;
      assert.strictEqual(heading(html), patch.name);
      assertStale(html, "reassigned");
      assert.include(text(html), workspace.member.name);
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
    })
  );

  it.effect("requires a browser session and same-origin forms before making any change", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "guarded-tool");
      for (const path of [
        "/",
        cardPath(patch.name),
        `${cardPath(patch.name)}/versions`,
        `${cardPath(patch.name)}/log`,
        ...["retire", "delete", "restore", "reassign"].map(
          (action) => `${cardPath(patch.name)}/${action}`
        )
      ]) {
        const response = yield* request(path, null, undefined, {
          authorization: "Bearer patchy-dev-token"
        });
        assert.strictEqual(response.status, 401);
        assert.include(text(yield* response.text), "Sign in");
      }
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const fields = {
        expectedPatchId: patch.patchId,
        description: "Not allowed",
        expectedDescriptionUpdatedAt: patch.descriptionUpdatedAt ?? ""
      };
      const refusedHeaders: ReadonlyArray<Record<string, string>> = [
        {},
        { origin: "https://foreign.invalid" },
        { "sec-fetch-site": "cross-site" }
      ];
      for (const headers of refusedHeaders) {
        const response = yield* request(
          `${cardPath(patch.name)}/description`,
          workspace.owner,
          fields,
          headers
        );
        assert.strictEqual(response.status, 403);
        assert.include(text(yield* response.text), "Submit this form from this Patchy instance.");
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
      }
      for (const [action, actionFields] of [
        ["retire", { expectedState: "live" }],
        ["delete", { expectedState: "not-deleted", confirm: patch.name }],
        ["restore", { expectedState: "retired" }],
        ["reassign", { expectedOwnerUserId: workspace.owner.id, user: workspace.member.id }]
      ] as const) {
        const path = `${cardPath(patch.name)}/${action}`;
        const signedOut = yield* request(path, null, actionFields, { origin: PUBLIC_BASE_URL });
        assert.strictEqual(signedOut.status, 401);
        const crossOrigin = yield* request(path, workspace.admin, actionFields, {
          origin: "https://foreign.invalid"
        });
        assert.strictEqual(crossOrigin.status, 403);
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
      }
      const accepted = yield* request(
        `${cardPath(patch.name)}/description`,
        workspace.owner,
        { ...fields, description: "Same-origin browser" },
        { "sec-fetch-site": "same-origin" }
      );
      assert.strictEqual(accepted.status, 303);
      assert.strictEqual(
        (yield* readPatch(workspace.owner, patch.patchId)).patch.description,
        "Same-origin browser"
      );
    })
  );

  it.effect(
    "returns app-shell not-found for unknown, foreign, old and reclaimed names and bounds long names",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const foreign = yield* company();
        const other = yield* publish(foreign.owner, "foreign-secret", {
          audience: { kind: "public" },
          description: "Foreign confidential text"
        });
        const renamed = yield* publish(workspace.owner, "old-address");
        yield* publish(workspace.owner, "new-address", {
          intent: "update",
          patchId: renamed.patchId
        });
        const deleted = yield* publish(workspace.owner, "deleted-address");
        const service = yield* Patches.Patches;
        yield* service.delete(deleted.patchId, actor(workspace.owner));
        assert.strictEqual((yield* request(cardPath(deleted.name), workspace.member)).status, 200);
        yield* TestClock.adjust(30 * DAY);
        yield* service.purgeDeleted(deleted.patchId);
        for (const name of ["unknown-address", other.name, "old-address", deleted.name]) {
          for (const suffix of [
            "",
            "/versions",
            "/log",
            "/retire",
            "/delete",
            "/restore",
            "/reassign"
          ]) {
            const response = yield* request(`${cardPath(name)}${suffix}`, workspace.member);
            assert.strictEqual(response.status, 404);
            const html = yield* response.text;
            assert.include(
              links(html).map((link) => link.href),
              "/settings/people"
            );
            assert.notInclude(html, "Foreign confidential text");
            assert.notInclude(html, "A useful office tool");
          }
          assert.strictEqual(
            (yield* post(`${cardPath(name)}/description`, workspace.owner, {
              description: "No row",
              expectedDescriptionUpdatedAt: ""
            })).status,
            404
          );
        }
        assert.strictEqual((yield* request("/patches/new-address", workspace.member)).status, 200);
        for (const suffix of [
          "",
          "/versions",
          "/log",
          "/retire",
          "/delete",
          "/restore",
          "/reassign"
        ]) {
          assert.strictEqual(
            (yield* request(`${cardPath("a".repeat(33))}${suffix}`, workspace.owner)).status,
            414
          );
        }
        assert.strictEqual(
          (yield* post(`${cardPath("a".repeat(33))}/description`, workspace.owner, {
            description: "Too long",
            expectedDescriptionUpdatedAt: ""
          })).status,
          414
        );
        for (const [action, fields] of [
          ["retire", { expectedState: "live" }],
          ["delete", { expectedState: "not-deleted", confirm: "unknown-address" }],
          ["restore", { expectedState: "retired" }],
          ["reassign", { expectedOwnerUserId: workspace.owner.id, user: workspace.member.id }]
        ] as const) {
          assert.strictEqual(
            (yield* post(`${cardPath("a".repeat(33))}/${action}`, workspace.admin, fields)).status,
            414
          );
          assert.strictEqual(
            (yield* post(`${cardPath("unknown-address")}/${action}`, workspace.admin, fields))
              .status,
            404
          );
        }
        assert.strictEqual((yield* request(cardPath("a".repeat(32)), workspace.owner)).status, 404);

        // Past the router's 100-character parameter bound only the GET fallback answers:
        // a 414 page for a viewer, the door when signed out, and no form route at all.
        const long = "x".repeat(101);
        for (const suffix of [
          "",
          "/versions",
          "/log",
          "/retire",
          "/delete",
          "/restore",
          "/reassign"
        ]) {
          const response = yield* request(`${cardPath(long)}${suffix}`, workspace.owner);
          assert.strictEqual(response.status, 414, suffix);
          assert.strictEqual(response.headers["cache-control"], "private, no-store");
          assert.include(
            links(yield* response.text).map((link) => link.href),
            "/settings/people"
          );
        }
        assert.strictEqual((yield* request(cardPath(long), null)).status, 401);
        for (const action of [
          "description",
          "scope",
          "rollback",
          "retire",
          "delete",
          "restore",
          "reassign"
        ]) {
          assert.strictEqual(
            (yield* post(`${cardPath(long)}/${action}`, workspace.admin, {})).status,
            404,
            action
          );
        }
        // An encoded slash stays in a name the router matched, but splits the fallback's path.
        const sixteen = "x".repeat(16);
        for (const [path, status] of [
          [`/patches/${sixteen}%2F${sixteen}`, 414],
          [`/%70atches/${"%78".repeat(33)}/versions`, 414],
          [`/patches/x%2F${long}/versions`, 404]
        ] as const) {
          assert.strictEqual((yield* request(path, workspace.owner)).status, status, path);
        }
        const client = yield* HttpClient.HttpClient;
        for (const name of ["x".repeat(33), long]) {
          const head = yield* client.execute(
            HttpClientRequest.head(`${cardPath(name)}/versions`).pipe(
              HttpClientRequest.setHeader("cookie", sessionCookie(workspace.owner))
            )
          );
          assert.strictEqual(head.status, 414);
          assert.strictEqual(head.headers["cache-control"], "private, no-store");
          assert.strictEqual(yield* head.text, "");
        }
      })
  );

  it.effect(
    "warns its owner on the card when a patch with guests uses a connection that blocks them",
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
        const card = (person: Person) =>
          Effect.flatMap(request(cardPath(payroll.name), person), (response) => response.text);
        // Nobody to turn away yet.
        assert.notInclude(text(yield* card(workspace.owner)), "postgres/payroll");

        yield* (yield* GuestGrants.GuestGrants).grant({
          patchId: payroll.patchId,
          userId: guest.member.id,
          grantedBy: workspace.owner.id
        });
        assert.include(text(yield* card(workspace.owner)), "postgres/payroll");
        assert.notInclude(text(yield* card(workspace.member)), "postgres/payroll");
      })
  );
});

const agentPanel = (html: string) => html.match(/<aside class="aside">[\s\S]*?<\/aside>/)?.[0];
/** The aside's tools as `name kind`, in order. */
const agentTools = (html: string) =>
  [
    ...(agentPanel(html) ?? "").matchAll(
      /<span class="row-name code">([^<]*)<\/span>[\s\S]*?<span class="meta">(\w+)<\/span>/g
    )
  ].map((match) => `${match[1]} ${match[2]}`);

it.layer(socket)("what agents can do on a socket", (it) => {
  it.effect("shows everyone a live card's agent tools, and who can turn agent access on", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publishAgentArea(workspace.owner, "new-business");
      const companies = yield* Companies.Companies;
      yield* companies.setAgentAccess({
        companyId: workspace.id,
        on: true,
        by: workspace.admin.id
      });

      for (const person of [workspace.member, workspace.owner, workspace.admin]) {
        const html = yield* (yield* request(cardPath(patch.name), person)).text;
        assert.include(html, '<div class="split"><div class="split-main">');
        const panel = agentPanel(html) ?? "";
        // In open_patch's order, page handlers left out; a read-only action reads.
        assert.deepStrictEqual(agentTools(html), [
          "addNote Changes",
          "exportDeals Reads",
          "findDeals Reads",
          "moveDeal Changes"
        ]);
        assert.include(
          text(panel),
          "Your agent can, as you addNote Add a note to a deal's timeline Changes"
        );
        assert.include(panel, "Search the pipeline for &lt;b&gt;open&lt;/b&gt; deals");
        assert.deepStrictEqual(links(panel), [
          { href: "/agents/connect", text: "Use with your agent" }
        ]);
        assert.notInclude(text(panel), "Agent access is off");
      }
      // Only beside the Overview.
      const versions = yield* (yield* request(`${cardPath(patch.name)}/versions`, workspace.member))
        .text;
      assert.isUndefined(agentPanel(versions));
      assert.notInclude(versions, `<div class="split">`);

      // Off, the panel names the admins in place of the connect link; an admin can turn it on.
      yield* companies.setAgentAccess({
        companyId: workspace.id,
        on: false,
        by: workspace.admin.id
      });
      const member = agentPanel(
        yield* (yield* request(cardPath(patch.name), workspace.member)).text
      );
      assert.include(
        text(member ?? ""),
        "Agent access is off at Northwind, so no agent can use these yet. Only admins can turn it on: Sam."
      );
      assert.deepStrictEqual(links(member ?? ""), []);
      assert.strictEqual(agentTools(member ?? "").length, 4);
      const admin = agentPanel(yield* (yield* request(cardPath(patch.name), workspace.admin)).text);
      assert.include(text(admin ?? ""), "Only admins can turn it on: you.");
      assert.deepStrictEqual(links(admin ?? ""), [
        { href: "/settings/agent-access", text: "Turn it on" }
      ]);
    })
  );

  it.effect("leaves a card without live agent tools as it was", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      yield* (yield* Companies.Companies).setAgentAccess({
        companyId: workspace.id,
        on: true,
        by: workspace.admin.id
      });
      const pageOnly = yield* publishAgentArea(workspace.owner, "page-only", {
        "deals.update": agentHandlers["deals.update"]!
      });
      const page = yield* publish(workspace.owner, "kickoff-brief");
      // The current version decides: rolled back to one without tools, the panel goes.
      const rolled = yield* publishAgentArea(workspace.owner, "rolled-back", {});
      yield* publishAgentArea(workspace.owner, rolled.name, agentHandlers, {
        intent: "update",
        patchId: rolled.patchId
      });
      yield* (yield* Patches.Patches).rollback(rolled.patchId, actor(workspace.owner), 1);
      const retired = yield* publishAgentArea(workspace.owner, "retired-tools");
      yield* (yield* Patches.Patches).retire(retired.patchId, actor(workspace.owner));

      for (const name of [pageOnly.name, page.name, rolled.name, retired.name]) {
        const html = yield* (yield* request(cardPath(name), workspace.admin)).text;
        assert.isUndefined(agentPanel(html), name);
        assert.notInclude(html, `<div class="split">`, name);
        assert.notInclude(text(html), "Your agent can, as you", name);
      }
    })
  );
});

it.layer(socket)("patch log on a socket", (it) => {
  it.effect("shows an owner the tree of a failed action and refuses another owner's log", () =>
    Effect.gen(function* () {
      const workspace = yield* company("cmp_portal_log");
      const crm = yield* publish(workspace.owner, "sales-crm", { title: "Sales CRM" });
      const other = yield* publish(workspace.member, "other-tool");
      const seed = seedOf(workspace.id, crm);
      yield* invoke(seedOf(workspace.id, other), workspace.member, {
        handler: "secret.export",
        kind: "action"
      });
      yield* invoke(seed, workspace.member, {
        handler: "leads.import",
        kind: "action",
        outcome: "failure",
        outcomeCode: "handler_failed",
        durationMs: 2_400,
        logLines: [
          { message: "importing 412 rows from warehouse" },
          { message: "row 57 is invalid", details: { owner: "<sam@>" } }
        ],
        inside: (id) =>
          Effect.gen(function* () {
            yield* operation(seed, id, {
              op: "postgres.list",
              resource: '"public"."customers"',
              as: workspace.member,
              outcome: "success",
              rowCount: 412
            });
            yield* TestClock.adjust(1_000);
            yield* invoke(seed, workspace.member, {
              handler: "leads.create",
              kind: "mutation",
              parentId: id,
              attempts: 2,
              inside: (nested) =>
                operation(seed, nested, {
                  op: "tables.insert",
                  resource: "leads",
                  as: "patch",
                  outcome: "success",
                  rowCount: 1
                })
            });
          })
      });

      const response = yield* request(logPath(crm.name), workspace.owner);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers["cache-control"], "private, no-store");
      const html = yield* response.text;
      const page = text(html);
      assert.strictEqual(heading(html), "Sales CRM");
      assert.notInclude(page, "secret.export");
      assert.include(page, "Today · Thursday 1 Jan");
      assert.include(page, "Alex leads.import action v1 Failed handler_failed 2.4 s");
      // A failed entry opens to its calls; the permalink names the disclosure, which it opens.
      const tree = text(
        html.match(/<details id="entry-[^"]+" open>([\s\S]*?)<\/details>/)?.[1] ?? ""
      );
      assert.strictEqual(
        tree,
        [
          "3 calls · 2 log lines",
          "postgres/warehouse.customers.list (connection call) · as Alex Succeeded 12 ms · 412 rows",
          "leads.create (mutation) · as the patch Succeeded 30 ms · 2 attempts",
          "tables.insert leads (table write) · as the patch Succeeded 12 ms · 1 row",
          `importing 412 rows from warehouse row 57 is invalid {&quot;owner&quot;:&quot;&lt;sam@&gt;&quot;}`
        ].join(" ")
      );

      const refused = yield* request(logPath(other.name), workspace.owner);
      assert.strictEqual(refused.status, 403);
      const card = yield* refused.text;
      assert.include(text(card), "Only the owner or an admin can read this patch's log.");
      assert.notInclude(card, "secret.export");
    })
  );

  it.effect("lets admins read every log and moves the owner's access on reassignment", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const first = yield* publish(workspace.owner, "first-tool");
      const second = yield* publish(workspace.member, "second-tool");
      yield* invoke(seedOf(workspace.id, first), workspace.owner, {
        handler: "first.save",
        kind: "mutation"
      });
      yield* invoke(seedOf(workspace.id, second), workspace.member, {
        handler: "second.save",
        kind: "mutation"
      });
      for (const [patch, handler] of [
        [first, "first.save"],
        [second, "second.save"]
      ] as const) {
        const response = yield* request(logPath(patch.name), workspace.admin);
        assert.strictEqual(response.status, 200);
        assert.include(text(yield* response.text), handler);
      }
      yield* (yield* Patches.Patches).reassign(
        first.patchId,
        actor(workspace.admin),
        workspace.member.id
      );
      assert.strictEqual((yield* request(logPath(first.name), workspace.owner)).status, 403);
      const moved = yield* request(logPath(first.name), workspace.member);
      assert.strictEqual(moved.status, 200);
      assert.include(text(yield* moved.text), "first.save");
    })
  );

  it.effect("shows the card's recent activity only to the owner and admins", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "busy-tool", { title: "Busy Tool" });
      const seed = seedOf(workspace.id, patch);
      yield* invoke(seed, workspace.member, { handler: "oldest.run", kind: "action" });
      yield* invoke(seed, workspace.member, {
        handler: "leads.export",
        kind: "action",
        durationMs: 1_800,
        replyDelivered: false
      });
      yield* invoke(seed, workspace.owner, {
        handler: "deals.moveStage",
        kind: "mutation",
        outcome: "failure",
        outcomeCode: "write_conflict",
        attempts: 3
      });
      yield* invoke(seed, workspace.admin, { handler: "pipeline.summary", kind: "query" });
      for (const person of [workspace.owner, workspace.admin]) {
        const html = yield* (yield* request(cardPath(patch.name), person)).text;
        const section = text(activity(html));
        assert.strictEqual(
          section,
          [
            "Recent activity View log",
            "Sam · pipeline.summary 1 Jan 00:00 UTC · v1 query · 30 ms Succeeded",
            "Priya · deals.moveStage 1 Jan 00:00 UTC · v1 mutation · 30 ms · 3 attempts Refused write_conflict",
            "Alex · leads.export 1 Jan 00:00 UTC · v1 action · 1.8 s · reply not delivered Succeeded"
          ].join(" ")
        );
        // Each entry opens its place in the log.
        assert.isTrue(
          links(activity(html)).every((link) =>
            new RegExp(`^${logPath(patch.name)}(#entry-[^"]+)?$`).test(link.href)
          )
        );
        assert.include(
          links(html).map((link) => link.href),
          logPath(patch.name)
        );
      }
      const member = yield* (yield* request(cardPath(patch.name), workspace.member)).text;
      assert.notInclude(text(member), "Recent activity");
      assert.notInclude(member, logPath(patch.name));
    })
  );

  it.effect("names an agent's work as its person via the client they approved, escaped", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "call-log", { title: "Call Log" });
      const seed = seedOf(workspace.id, patch);
      const agent = { name: "Claude <Code> & co" };
      const shown = "Alex via Claude &lt;Code&gt; &amp; co";
      yield* invoke(seed, workspace.member, { handler: "calls.add", kind: "mutation" });
      yield* invoke(seed, workspace.member, {
        handler: "agent.logCalls",
        kind: "action",
        agent,
        inside: (id) =>
          operation(seed, id, {
            op: "postgres.list",
            resource: '"public"."customers"',
            as: workspace.member,
            agent,
            outcome: "success",
            rowCount: 2
          })
      });

      const log = yield* (yield* request(logPath(patch.name), workspace.owner)).text;
      assert.notInclude(log, "<Code>");
      assert.include(text(log), `${shown} agent.logCalls action v1 Succeeded`);
      assert.include(text(log), "Alex calls.add mutation v1 Succeeded");
      assert.include(
        text(log),
        `customers.list (connection call) · as ${shown} Succeeded 12 ms · 2 rows`
      );
      // The person filter is unchanged: the agent's work is its person's.
      assert.deepStrictEqual(
        chipChoices(log, "person").map(([label]) => label),
        ["Anyone", "Alex"]
      );

      const card = yield* (yield* request(cardPath(patch.name), workspace.owner)).text;
      assert.notInclude(card, "<Code>");
      const recent = text(activity(card));
      assert.include(recent, `${shown} · agent.logCalls 1 Jan 00:00 UTC · v1 action`);
      assert.include(recent, "Alex · calls.add 1 Jan 00:00 UTC · v1 mutation");
    })
  );

  it.effect("names a guest from another company in the log, its filter and the card", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const guest = (yield* company()).member;
      const patch = yield* publish(workspace.owner, "guest-log", { title: "Guest Log" });
      yield* invoke(seedOf(workspace.id, patch), guest, { handler: "notes.add", kind: "mutation" });

      const log = yield* (yield* request(logPath(patch.name), workspace.owner)).text;
      assert.notInclude(text(log), guest.id);
      assert.include(text(log), `${guest.name} notes.add mutation v1 Succeeded`);
      assert.deepStrictEqual(chipChoices(log, "person"), [
        ["Anyone", logPath(patch.name)],
        [guest.name, logPath(patch.name, `?person=${guest.id}`)]
      ]);
      const card = yield* (yield* request(cardPath(patch.name), workspace.owner)).text;
      assert.include(text(activity(card)), `${guest.name} · notes.add`);
    })
  );

  it.effect("keeps the header on the Log tab, its Share opening over Overview", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "logged-tool");
      const html = yield* (yield* request(logPath(patch.name), workspace.owner)).text;
      assert.include(html, "<title>Log – logged-tool – All patches – Northwind</title>");
      assert.deepStrictEqual(tabLinks(html), ["Overview", "Log", "Versions 1", "Settings"]);
      assert.strictEqual(
        menuItems(html, `patch-${patch.patchId}`),
        "logged-tool Open in a new tab Copy link Retire… Delete…"
      );
      assert.strictEqual(
        links(html).find((link) => link.text === "Share")?.href,
        `${cardPath(patch.name)}?share=${patch.name}`
      );
    })
  );

  it.effect("pages by cursor, filters, and says when nothing is logged or matches", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "paged-tool");
      const empty = yield* (yield* request(logPath(patch.name), workspace.owner)).text;
      assert.include(text(empty), "Nothing logged yet");
      assert.notInclude(empty, "<table");
      const seed = seedOf(workspace.id, patch);
      for (let index = 0; index < 26; index++)
        yield* invoke(seed, workspace.member, {
          handler: `step.${String(index).padStart(2, "0")}`,
          kind: "mutation",
          ...(index === 0 ? { outcome: "handler_error" as const, outcomeCode: "not_allowed" } : {})
        });
      const first = yield* (yield* request(logPath(patch.name), workspace.owner)).text;
      const handlers = (html: string) =>
        [...html.matchAll(/<td><code>(step\.\d+)<\/code>/g)].map((match) => match[1]);
      assert.strictEqual(handlers(first).length, 25);
      assert.strictEqual(handlers(first)[0], "step.25");
      const older = links(first).find((link) => link.text === "Older entries");
      assert.isDefined(older);
      const second = yield* (yield* request(older!.href.replaceAll("&amp;", "&"), workspace.owner))
        .text;
      assert.deepStrictEqual(handlers(second), ["step.00"]);
      assert.include(text(second), "Refused not_allowed");
      assert.isUndefined(links(second).find((link) => link.text === "Older entries"));

      const failed = yield* (yield* request(
        logPath(patch.name, "?outcome=failed"),
        workspace.owner
      )).text;
      assert.deepStrictEqual(handlers(failed), ["step.00"]);
      // The chip says what narrows the list, and Any drops it again.
      assert.include(failed, '<span class="chip-key">Outcome</span>Failed');
      assert.deepStrictEqual(chipChoices(failed, "outcome")[0], ["Any", logPath(patch.name)]);
      const nothing = yield* (yield* request(
        logPath(patch.name, `?outcome=failed&person=${workspace.owner.id}`),
        workspace.owner
      )).text;
      assert.include(text(nothing), "No entries match these filters");
      assert.strictEqual(
        links(nothing).find((link) => link.text === "Clear filters")?.href,
        logPath(patch.name)
      );
    })
  );
});
