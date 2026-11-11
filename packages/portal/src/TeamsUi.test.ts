import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { Teams } from "@patchy/companies";
import { Patches } from "@patchy/patches";
import {
  socket,
  company,
  actor,
  publish,
  publishSource,
  publishDependant,
  request,
  post,
  formFields,
  cardPath
} from "./test/fixtures.js";

it.layer(socket)("team access in the portal", (it) => {
  it.effect(
    "keeps excluded owners informed and gives super admins metadata-only recovery with eligible recipients",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE users SET role='super_admin' WHERE id=${workspace.admin.id}`;
        const teams = yield* Teams.Teams;
        const ref = { companyId: workspace.id, actorId: workspace.admin.id };
        const team = yield* teams.create({ ...ref, name: "Design" });
        yield* teams.setMemberships({
          ...ref,
          teamId: team.id,
          userIds: [workspace.owner.id, workspace.member.id],
          added: true
        });
        const patch = yield* publish(workspace.owner, "private-design", {
          title: "Protected content title",
          description: "Protected description"
        });
        const patches = yield* Patches.Patches;
        yield* patches.setSharing({
          patchId: patch.patchId,
          actor: actor(workspace.owner),
          audience: { members: { kind: "teams", teamIds: [team.id] } }
        });
        yield* teams.setMemberships({
          ...ref,
          teamId: team.id,
          userIds: [workspace.owner.id],
          added: false
        });
        const owner = yield* request(cardPath(patch.name), workspace.owner);
        assert.strictEqual(owner.status, 200);
        const ownerHtml = yield* owner.text;
        assert.include(ownerHtml, "Ask an admin to restore your team access or reassign it.");
        assert.notInclude(ownerHtml, "Protected content title");
        assert.notInclude(ownerHtml, "Protected description");
        assert.notInclude(ownerHtml, 'href="/patches/private-design/reassign"');
        const overview = yield* (yield* request(cardPath(patch.name), workspace.admin)).text;
        assert.include(overview, "You can manage this patch");
        assert.notInclude(overview, "Protected description");
        const dialog = yield* (yield* request(`${cardPath(patch.name)}/reassign`, workspace.admin))
          .text;
        assert.include(dialog, `<option value="${workspace.member.id}"`);
        assert.notInclude(dialog, `<option value="${workspace.admin.id}"`);
        const path = `${cardPath(patch.name)}/reassign`;
        const response = yield* post(path, workspace.admin, {
          ...formFields(dialog, path),
          user: workspace.member.id
        });
        assert.strictEqual(response.status, 303);
        const views = yield* patches.management(workspace.id, workspace.admin.id, {
          id: patch.patchId
        });
        assert.strictEqual(views[0]?.record.ownerId, workspace.member.id);
      }).pipe(Effect.provide(Teams.layer))
  );

  it.effect(
    "previews dependants and carries an explicit, bounded acknowledgement when narrowing access",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const teams = yield* Teams.Teams;
        const ref = { companyId: workspace.id, actorId: workspace.admin.id };
        const team = yield* teams.create({ ...ref, name: "Design" });
        yield* teams.setMemberships({
          ...ref,
          teamId: team.id,
          userIds: [workspace.owner.id],
          added: true
        });
        const source = yield* publishSource(workspace.owner, "shared-source");
        const dependent = yield* publishDependant(workspace.member, "consumer", source.patchId);
        const path = `${cardPath(source.name)}/scope`;
        const dialog = yield* (yield* request(
          `${cardPath(source.name)}?share=${source.name}`,
          workspace.owner
        )).text;
        assert.include(dialog, "Other patches use this patch");
        assert.include(dialog, dependent.name);
        assert.include(dialog, 'name="force" value="true"');
        const fields = { ...formFields(dialog, path), scope: "teams", teamIds: team.id };
        const refused = yield* post(path, workspace.owner, fields);
        assert.strictEqual(refused.status, 409);
        const refusedHtml = yield* refused.text;
        assert.include(refusedHtml, 'name="expectedDependants"');
        assert.include(refusedHtml, 'name="scope"');
        const confirmed = yield* post(path, workspace.owner, { ...fields, force: "true" });
        assert.strictEqual(confirmed.status, 303);
        const views = yield* (yield* Patches.Patches).management(workspace.id, workspace.owner.id, {
          id: source.patchId
        });
        assert.strictEqual(views[0]?.record.audience.members.kind, "teams");
      }).pipe(Effect.provide(Teams.layer))
  );
});
