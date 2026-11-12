import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { NodeCryptography } from "@patchy/core";
import * as Testing from "@patchy/sql/testing";
import * as Companies from "./Companies.js";
import type { Page } from "./CompanyPage.js";
import * as Roster from "./Roster.js";
import * as Teams from "./Teams.js";
import * as TeamsPage from "./TeamsPage.js";
import * as Users from "./Users.js";

// Answers `action` at `path` as `viewer`, posting `form` when one is given.
const answer = (
  viewer: { readonly companyId: string; readonly userId: string; readonly role: Users.Role },
  action: TeamsPage.Action,
  path: string,
  form?: ReadonlyArray<readonly [string, string]>
) =>
  TeamsPage.handle(
    { company: { id: viewer.companyId }, user: { id: viewer.userId }, role: viewer.role },
    action
  ).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request(
          new URL(path, "https://patchy.example"),
          form === undefined
            ? {}
            : {
                method: "POST",
                body: new URLSearchParams(form.map(([name, value]) => [name, value]))
              }
        )
      )
    )
  );
const setup = Effect.fn(function* (handle: string) {
  const sql = yield* SqlClient.SqlClient;
  const { company, user } = yield* (yield* Companies.Companies).create({
    handle,
    name: handle,
    clerkUserId: `clerk_${handle}`,
    email: `${handle}@example.com`,
    userName: "Ada"
  });
  const member = `usr_${handle}_member`;
  yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
    VALUES (${member}, ${member}, ${company.id}, ${`${member}@example.com`}, 'Cleo', 'member')`;
  return {
    ref: { companyId: company.id, actorId: user.id },
    admin: { companyId: company.id, userId: user.id, role: "admin" as const },
    member: { companyId: company.id, userId: member, role: "member" as const }
  };
});

const services = Layer.mergeAll(Companies.layer, Users.layer, Teams.layer).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(NodeCryptography.layer)
);
it.layer(services)("Teams page", (it) => {
  it.effect("draws the admins' names a member is told to ask as text", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { ref, admin, member } = yield* setup("teams-page-names");
      const name = '</p><form action="https://evil.example"><a href=x>';
      yield* sql`UPDATE users SET name = ${name} WHERE id = ${admin.userId}`;
      const escaped = "&lt;/p&gt;&lt;form action=&quot;https://evil.example&quot;&gt;";
      // Once in the page's header with no team, then beside the open team.
      const empty = yield* answer(member, "view", TeamsPage.path);
      yield* (yield* Teams.Teams).create({ ...ref, name: "Design" });
      const open = yield* answer(member, "view", TeamsPage.path);
      for (const page of [empty, open]) {
        assert.include(page.body, escaped);
        assert.notInclude(page.body, "<form");
        assert.notInclude(page.body, "<a href=x>");
      }
    })
  );

  it.effect("refuses a review's save when a membership changed while the review was drawn", () =>
    Effect.gen(function* () {
      const teams = yield* Teams.Teams;
      const { ref, admin, member } = yield* setup("teams-page-review");
      const sales = yield* teams.create({ ...ref, name: "Sales" });
      const finance = yield* teams.create({ ...ref, name: "Finance" });
      yield* teams.setMemberships({ ...ref, teamId: sales.id, add: [member.userId] });
      // Another admin's change lands after the roster is read, while the review is drawn.
      const review: Page = yield* answer(
        admin,
        "view",
        `${TeamsPage.path}?team=${sales.id}&remove=${member.userId}&view=review`
      ).pipe(
        Effect.provideService(TeamsPage.Reach, () =>
          teams
            .setMemberships({ ...ref, teamId: finance.id, add: [member.userId] })
            .pipe(Effect.orDie, Effect.as(Roster.nothing))
        )
      );
      const revision = /name="revision" value="(\d+)"/.exec(review.overlay ?? "")?.[1] ?? "";
      assert.notStrictEqual(revision, "");
      const saved: Page = yield* answer(admin, "save", `${TeamsPage.path}/save?team=${sales.id}`, [
        ["remove", member.userId],
        ["revision", revision]
      ]);
      assert.strictEqual(saved.status, 409);
      assert.deepStrictEqual(yield* teams.members({ ...ref, teamId: sales.id }), [member.userId]);
    })
  );
});
