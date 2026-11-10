import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { sha256 } from "../../../test/crypto.js";
import { GuestGrants, Patches } from "@patchy/patches";
import {
  reported,
  socket,
  company,
  actor,
  manifest,
  publish,
  readPatch,
  type FormFields,
  request,
  post,
  receiptAfter,
  dialogAfter,
  text,
  heading,
  links,
  forms,
  formFields,
  cardPath
} from "./test/fixtures.js";

it.layer(socket)("the Share dialog on a socket", (it) => {
  it.effect(
    "asks in the Share dialog before a patch goes public, without publishing a version",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const patch = yield* publish(workspace.owner, "scope-save", { title: "Scope <save>" });
        const before = yield* readPatch(workspace.owner, patch.patchId);
        const scopePath = `${cardPath(patch.name)}/scope`;
        const dialog = yield* (yield* request(`/patches?share=${patch.name}`, workspace.admin))
          .text;
        const fields: FormFields = { ...formFields(dialog, scopePath), scope: "public" };
        assert.deepStrictEqual(fields, {
          expectedPatchId: patch.patchId,
          back: "/patches",
          expectedScope: "company",
          scope: "public"
        });
        // Make public is the confirmation, in the dialog, and only its answer applies.
        assert.include(text(dialog), "Make Scope &lt;save&gt; public?");
        assert.include(dialog, 'name="confirm" value="public">Make public</button>');

        // Saving public without it, posted straight at the route, asks again over the same page.
        const asked = yield* post(scopePath, workspace.admin, fields);
        assert.strictEqual(asked.status, 200);
        const confirm = yield* asked.text;
        assert.strictEqual(heading(confirm), "All patches");
        assert.match(confirm, /value="public" checked/);
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
        assert.deepStrictEqual(reported(patch.patchId), []);

        // A member can't answer it.
        const answer = { ...fields, confirm: "public" };
        assert.strictEqual((yield* post(scopePath, workspace.member, answer)).status, 403);
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);

        const response = yield* post(scopePath, workspace.admin, answer);
        assert.strictEqual(response.status, 303);
        assert.strictEqual(response.headers.location, `/patches?share=${patch.name}`);
        const landed = yield* dialogAfter(response, workspace.admin);
        assert.strictEqual(landed.receipt, "Scope &lt;save&gt; is open to anyone on the internet");
        // While it's public, adding guests waits; there's no field for it.
        assert.notInclude(forms(landed.html), `${cardPath(patch.name)}/add-guest`);
        const saved = yield* readPatch(workspace.owner, patch.patchId);
        assert.strictEqual(saved.patch.scope, "public");
        assert.deepStrictEqual(reported(patch.patchId), [
          {
            name: "patch.shared",
            principalId: workspace.admin.id,
            companyId: workspace.id,
            properties: {
              patchId: patch.patchId,
              ownerUserId: workspace.owner.id,
              byAdmin: true,
              scope: "public",
              previousScope: "company"
            }
          }
        ]);
        assert.strictEqual(saved.patch.currentVersionId, before.patch.currentVersionId);
        assert.strictEqual(saved.patch.description, before.patch.description);
        assert.include(
          text(yield* (yield* request(cardPath(patch.name), workspace.member)).text),
          "Anyone on the internet. No sign-in."
        );

        // The same answer again is stale now, and back to the company needs no step.
        const stale = yield* post(scopePath, workspace.admin, answer);
        assert.strictEqual(stale.status, 409);
        assert.include(text(yield* stale.text), "This patch changed while you had this page open");
        const back = yield* post(scopePath, workspace.owner, {
          ...fields,
          scope: "company",
          expectedScope: "public"
        });
        assert.strictEqual(back.status, 303);
        assert.strictEqual(
          (yield* dialogAfter(back, workspace.owner)).receipt,
          "Scope &lt;save&gt; is open to people at Northwind"
        );
        assert.strictEqual(
          (yield* readPatch(workspace.owner, patch.patchId)).patch.scope,
          "company"
        );
      })
  );

  it.effect("adds and removes guests in the Share dialog over the page it opened from", () =>
    Effect.gen(function* () {
      const guests = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE companies SET name = 'Pine Studio' WHERE id = ${guests.id}`;
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "site-notes", { title: "Site notes" });
      const other = yield* publish(workspace.owner, "visit-plan");
      const opened = `/patches?show=pages&share=${patch.name}`;
      const addPath = `${cardPath(patch.name)}/add-guest`;
      const dialog = yield* (yield* request(opened, workspace.owner)).text;
      // Its forms return to the page behind it, the search kept and the dialog left out.
      const fields = formFields(dialog, addPath);
      assert.deepStrictEqual(fields, {
        expectedPatchId: patch.patchId,
        back: "/patches?show=pages"
      });
      assert.isTrue(
        links(dialog).some((link) => link.href === "/patches?show=pages" && link.text === "Done")
      );
      // A member gets the page without it.
      assert.notInclude(forms(yield* (yield* request(opened, workspace.member)).text), addPath);

      // Refusals show under the field, over the same page, with the email kept.
      for (const [email, status, said] of [
        ["nobody@nowhere.example", 422, "nobody@nowhere.example isn’t on Patchy yet"],
        [workspace.member.email, 409, `${workspace.member.email} is already at Northwind`]
      ] as const) {
        const refused = yield* post(addPath, workspace.owner, { ...fields, email });
        assert.strictEqual(refused.status, status);
        const html = yield* refused.text;
        assert.strictEqual(heading(html), "All patches");
        assert.include(
          text(
            html.match(/<div class="note note-refused field-callout"[\s\S]*?<\/div>/)?.[0] ?? ""
          ),
          said
        );
        assert.include(html, `value="${email}"`);
        assert.include(html, 'aria-invalid="true"');
      }

      const added = yield* post(addPath, workspace.owner, {
        ...fields,
        email: ` ${guests.member.email} `
      });
      assert.strictEqual(added.status, 303);
      assert.strictEqual(added.headers.location, opened);
      const landed = yield* dialogAfter(added, workspace.owner);
      assert.strictEqual(landed.receipt, `Shared Site notes with ${guests.member.name}`);
      assert.include(
        text(landed.html),
        `${guests.member.name} ${guests.member.email} · Pine Studio`
      );
      // Sharing again changes nothing.
      assert.strictEqual(
        (yield* post(addPath, workspace.owner, { ...fields, email: guests.member.email })).status,
        303
      );
      // Another patch's dialog suggests them, as someone shared with before.
      const suggesting = yield* (yield* request(`/?share=${other.name}`, workspace.admin)).text;
      assert.include(
        suggesting,
        `<option value="${guests.member.email}">${guests.member.name}, Pine Studio</option>`
      );

      const removePath = `${cardPath(patch.name)}/remove-guest`;
      const removed = yield* post(removePath, workspace.owner, {
        ...formFields(landed.html, removePath),
        guest: guests.member.id
      });
      assert.strictEqual(removed.status, 303);
      const after = yield* dialogAfter(removed, workspace.owner);
      assert.strictEqual(after.receipt, `Stopped sharing Site notes with ${guests.member.name}`);
      assert.notInclude(forms(after.html), removePath);
      // Removing someone who isn't a guest changes nothing and says nothing.
      const again = yield* post(removePath, workspace.owner, {
        ...fields,
        guest: guests.member.id
      });
      assert.strictEqual(again.status, 303);
      assert.strictEqual((yield* dialogAfter(again, workspace.owner)).receipt, "");
      assert.deepStrictEqual(yield* (yield* GuestGrants.GuestGrants).guests(patch.patchId), []);
    })
  );

  it.effect("lists what's shared with a guest on their Home, and removes one after asking", () =>
    Effect.gen(function* () {
      const guests = yield* company();
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE companies SET name = 'Harbor Works' WHERE id = ${workspace.id}`;
      const patch = yield* publish(workspace.owner, "site-notes", { title: "Site notes" });
      const grants = yield* GuestGrants.GuestGrants;
      yield* grants.share({
        patchId: patch.patchId,
        actor: actor(workspace.owner),
        email: guests.member.email
      });
      const shelf = (html: string) =>
        text(
          html.match(/<section class="section" id="shared"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? ""
        );

      // Home's own empty state stays, with the section after it; a search leaves Home.
      const home = yield* (yield* request("/", guests.member)).text;
      assert.include(text(home), "No patches yet");
      assert.include(shelf(home), "Shared with you Site notes Harbor Works");
      assert.isTrue(links(home).some((link) => link.href === `/${workspace.handle}/${patch.name}`));
      assert.strictEqual(shelf(yield* (yield* request("/?q=site", guests.member)).text), "");
      // Nobody else sees it.
      assert.strictEqual(shelf(yield* (yield* request("/", guests.owner)).text), "");

      const path = `/shared/${patch.patchId}/remove`;
      const asking = yield* (yield* request(path, guests.member)).text;
      assert.strictEqual(heading(asking), "Remove Site notes?");
      assert.include(text(asking), "until someone at Harbor Works shares it with you again");
      assert.strictEqual((yield* request(path, guests.owner)).status, 404);

      const removed = yield* post(path, guests.member, {});
      assert.strictEqual(removed.status, 303);
      assert.strictEqual(yield* receiptAfter(removed, guests.member), "Removed Site notes");
      assert.strictEqual(shelf(yield* (yield* request("/", guests.member)).text), "");
      assert.deepStrictEqual(yield* grants.guests(patch.patchId), []);
    })
  );

  it.effect("refuses public sharing while tier 2 is served and allows it after rollback", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "tier-two-scope", {
        manifest: { ...manifest, name: "tier-two-scope", tier: 1 }
      });
      yield* publish(workspace.owner, patch.name, {
        intent: "update",
        patchId: patch.patchId,
        manifest: { ...manifest, name: patch.name, tier: 2, handlers: {} },
        server: {
          objectKey: `patches/${patch.patchId}/scope-test.server.js`,
          sha256: sha256(""),
          bytes: 0
        }
      });
      const before = yield* readPatch(workspace.owner, patch.patchId);
      // A tool's dialog never offers it, and has nothing to confirm.
      const dialog = yield* (yield* request(
        `${cardPath(patch.name)}?share=${patch.name}`,
        workspace.owner
      )).text;
      assert.match(
        dialog,
        /<input class="field-radio" type="radio" name="scope" value="public" disabled>/
      );
      assert.notInclude(dialog, "Make public");
      const refused = yield* post(`${cardPath(patch.name)}/scope`, workspace.owner, {
        expectedPatchId: patch.patchId,
        scope: "public",
        expectedScope: "company"
      });
      assert.strictEqual(refused.status, 422);
      assert.include(yield* refused.text, 'role="alert"');
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
      // Its answer is refused too, without a step in between.
      const answered = yield* post(`${cardPath(patch.name)}/scope`, workspace.owner, {
        expectedPatchId: patch.patchId,
        scope: "public",
        expectedScope: "company",
        confirm: "public"
      });
      assert.strictEqual(answered.status, 422);
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
      yield* (yield* Patches.Patches).rollback(patch.patchId, actor(workspace.owner), 1);
      const shared = yield* post(`${cardPath(patch.name)}/scope`, workspace.owner, {
        expectedPatchId: patch.patchId,
        scope: "public",
        expectedScope: "company",
        confirm: "public"
      });
      assert.strictEqual(shared.status, 303);
      assert.strictEqual((yield* readPatch(workspace.owner, patch.patchId)).patch.scope, "public");
    })
  );
});
