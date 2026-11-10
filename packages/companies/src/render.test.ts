import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { NodeCryptography } from "@patchy/core";
import * as Testing from "@patchy/sql/testing";
import * as Companies from "./Companies.js";
import * as Users from "./Users.js";
import * as Teams from "./Teams.js";
import * as TeamsPage from "./TeamsPage.js";

const services = Layer.mergeAll(Companies.layer, Users.layer).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(NodeCryptography.layer)
);
const view = (viewer: Parameters<typeof TeamsPage.handle>[0], query: string) =>
  TeamsPage.handle(viewer, "view").pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(`https://page.example${TeamsPage.path}${query}`))
    )
  );
it.layer(services)("team lifecycle rendering", (it) => {
  it.effect("escapes names and targets the same identity in delete and restore confirmations", () =>
    Effect.gen(function* () {
      const company = yield* (yield* Companies.Companies).create({
        handle: "render-recovery",
        name: "Company",
        clerkUserId: "clerk_render_recovery",
        email: "render@example.test",
        userName: "Owner"
      });
      const viewer = { ...company, role: "super_admin" as const };
      const ref = { companyId: company.company.id, actorId: company.user.id };
      const team = yield* Teams.create({ ...ref, name: "Research <script>" });
      const confirmation = yield* view(viewer, `?team=${team.id}&confirm=delete`);
      assert.include(confirmation.body, "Research &lt;script&gt;");
      assert.notInclude(confirmation.body, "<script>");
      assert.include(confirmation.body, `action="${TeamsPage.path}/delete?team=${team.id}"`);
      yield* Teams.setDeleted({ ...ref, teamId: team.id, deleted: true }).pipe(
        Effect.provideService(Teams.References, () => Effect.succeed(false))
      );
      const active = yield* view(viewer, "");
      assert.notInclude(active.body, "Research &lt;script&gt;");
      const deleted = yield* view(viewer, `?team=${team.id}&deleted=1&confirm=restore`);
      assert.include(deleted.body, "Research &lt;script&gt;");
      assert.notInclude(deleted.body, "<script>");
      assert.include(deleted.body, `action="${TeamsPage.path}/restore?team=${team.id}"`);
    })
  );
  it.effect("keeps deleted teams and confirmation controls out of ordinary member views", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const company = yield* companies.create({
        handle: "render-private",
        name: "Company",
        clerkUserId: "clerk_render_private",
        email: "private@example.test",
        userName: "Owner"
      });
      const invite = yield* companies.createInvite({
        companyId: company.company.id,
        invitedBy: company.user.id,
        email: "member-render@example.test",
        role: "member"
      });
      const member = yield* companies.consumeInvite({
        inviteId: invite.id,
        clerkUserId: "clerk_render_member",
        email: invite.email,
        name: "Member"
      });
      const viewer = { company: company.company, user: member, role: "member" as const };
      const active = yield* view(viewer, "");
      assert.notInclude(active.body, "Deleted teams");
      assert.notInclude(active.body, "Delete team");
      const refused = yield* view(viewer, "?deleted=1");
      assert.equal("status" in refused ? refused.status : undefined, 403);
    })
  );
});
