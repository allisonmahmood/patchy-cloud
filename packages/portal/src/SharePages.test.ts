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
  cardPath,
  shareDialog
} from "./test/fixtures.js";

/** The ids of the controls that ask for focus, or "" for one without an id. */
const autofocused = (html: string) =>
  [...html.matchAll(/<[a-z]+\b[^>]*\bautofocus\b[^>]*>/g)].map(
    (match) => match[0].match(/\bid="([^"]*)"/)?.[1] ?? ""
  );

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
          expectedOwnerUserId: workspace.owner.id,
          expectedLifecycleRevision: before.patch.lifecycleRevision,
          back: "/patches",
          expectedScope: "company",
          scope: "public"
        });
        // General access offers the internet to a page, and asks before it applies it. Focus
        // starts on the invite field.
        assert.include(dialog, '<option value="public">Anyone on the internet</option>');
        assert.notInclude(dialog, "Make public");
        assert.deepStrictEqual(autofocused(shareDialog(dialog)), ["share-email"]);

        // Saving public lands on the dialog asking, at its own address; only its answer applies.
        const asked = yield* post(scopePath, workspace.admin, fields);
        assert.strictEqual(asked.status, 303);
        const confirmPath = `/patches?share=${patch.name}&confirm=public`;
        assert.strictEqual(asked.headers.location, confirmPath);
        const confirm = yield* (yield* request(confirmPath, workspace.admin)).text;
        assert.strictEqual(heading(confirm), "All patches");
        assert.include(text(shareDialog(confirm)), "Make Scope &lt;save&gt; public?");
        assert.include(confirm, 'name="confirm" value="public">Make public</button>');
        assert.deepStrictEqual(formFields(confirm, scopePath), fields);
        // Its Cancel goes back to the dialog, and starts focused; Done leaves the asking behind.
        assert.include(
          shareDialog(confirm),
          `<a class="btn btn-quiet" href="/patches?share=${patch.name}" autofocus>Cancel</a>`
        );
        assert.isTrue(
          links(confirm).some((link) => link.href === "/patches" && link.text === "Done")
        );
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
        assert.deepStrictEqual(reported(patch.patchId), []);
        // A member asking for it gets the page alone.
        assert.strictEqual(
          shareDialog(yield* (yield* request(confirmPath, workspace.member)).text),
          ""
        );

        // A member can't answer it.
        const answer = { ...fields, confirm: "public" };
        assert.strictEqual((yield* post(scopePath, workspace.member, answer)).status, 403);
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);

        const response = yield* post(scopePath, workspace.admin, answer);
        assert.strictEqual(response.status, 303);
        assert.strictEqual(response.headers.location, `/patches?share=${patch.name}`);
        const landed = yield* dialogAfter(response, workspace.admin);
        assert.strictEqual(landed.receipt, "Scope &lt;save&gt; is open to anyone on the internet");
        // While it's public, inviting waits; there's no field for it, and focus starts on
        // General access.
        assert.notInclude(forms(landed.html), `${cardPath(patch.name)}/add-guest`);
        assert.deepStrictEqual(autofocused(landed.html), ["share-scope"]);
        assert.include(landed.html, '<option value="public" selected>');
        assert.include(text(landed.html), "Anyone with the link can open it without signing in.");
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
          expectedScope: "public",
          expectedLifecycleRevision: saved.patch.lifecycleRevision
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
        expectedOwnerUserId: workspace.owner.id,
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
            html.match(/<p class="field-error" id="share-email-error">([\s\S]*?)<\/p>/)?.[1] ?? ""
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
      // Public, its guests keep their grants, and focus starts on General access, never Remove.
      yield* (yield* Patches.Patches).setSharing({
        patchId: patch.patchId,
        actor: actor(workspace.owner),
        audience: { members: { kind: "public" } },
        expectedScope: "company"
      });
      const open = shareDialog(yield* (yield* request(opened, workspace.owner)).text);
      assert.deepStrictEqual(autofocused(open), ["share-scope"]);
      assert.include(
        text(open),
        "Its guests keep their access if it goes back to people at Northwind."
      );
      assert.include(text(open), `${guests.member.name} ${guests.member.email} · Pine Studio`);
      // An invite sent from before it went public, and refused, keeps its email and why, and
      // takes focus there.
      const late = yield* post(addPath, workspace.owner, {
        ...fields,
        email: "nobody@nowhere.example"
      });
      assert.strictEqual(late.status, 422);
      const lateDialog = shareDialog(yield* late.text);
      assert.deepStrictEqual(autofocused(lateDialog), ["share-email"]);
      assert.include(lateDialog, 'value="nobody@nowhere.example"');
      assert.include(text(lateDialog), "nobody@nowhere.example isn’t on Patchy yet");
      yield* (yield* Patches.Patches).setSharing({
        patchId: patch.patchId,
        actor: actor(workspace.owner),
        audience: { members: { kind: "company" } },
        expectedScope: "public"
      });
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
      const search = yield* request("/?q=site", guests.member);
      assert.strictEqual(search.status, 308);
      assert.strictEqual(search.headers.location, "/patches?q=site");
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
      // A tool's dialog never offers it, says why, and has nothing to confirm.
      const dialog = shareDialog(
        yield* (yield* request(`${cardPath(patch.name)}?share=${patch.name}`, workspace.owner)).text
      );
      assert.notInclude(dialog, 'value="public"');
      assert.include(text(dialog), "People must sign in to use this tool.");
      assert.notInclude(dialog, "Make public");
      const refused = yield* post(`${cardPath(patch.name)}/scope`, workspace.owner, {
        expectedPatchId: patch.patchId,
        scope: "public",
        expectedScope: "company"
      });
      assert.strictEqual(refused.status, 422);
      // The refusal shows in General access, above its control, which takes focus.
      const refusedDialog = shareDialog(yield* refused.text);
      assert.match(
        refusedDialog,
        /<div class="notice notice-danger" role="alert">[\s\S]*<select[^>]*name="scope"/
      );
      assert.deepStrictEqual(autofocused(refusedDialog), ["share-scope"]);
      // The control it focuses is described by the refusal, and marked refused.
      assert.match(
        refusedDialog,
        /<select[^>]*id="share-scope"[^>]*aria-describedby="share-scope-reason share-scope-refusal" aria-invalid="true"/
      );
      assert.include(
        refusedDialog,
        '<div id="share-scope-refusal"><div class="notice notice-danger"'
      );
      // Asking about going public by address changes nothing for a tool.
      assert.notInclude(
        yield* (yield* request(
          `${cardPath(patch.name)}?share=${patch.name}&confirm=public`,
          workspace.owner
        )).text,
        "Make public"
      );
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
