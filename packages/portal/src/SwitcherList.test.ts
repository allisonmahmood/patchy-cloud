import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cookies from "effect/http/Cookies";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { MachineTokens } from "@patchy/auth";
import { publishableKey, signedInCookies, signSession } from "@patchy/auth/testing";
import { GuestGrants, Patches } from "@patchy/patches";
import { Cryptography, WhatsNew } from "@patchy/core";
import {
  clerk,
  socket,
  type Person,
  company,
  actor,
  publish,
  sessionCookie,
  request
} from "./test/fixtures.js";

/** `/switcher.json` as a script on a Patchy page asks for it, unless `headers` say otherwise. */
const switcher = (
  person: Person | null,
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" }
) => request("/switcher.json", person, undefined, headers);
/** A person's switcher list, which no cache keeps. */
const switcherList = Effect.fn("SwitcherListTest.switcherList")(function* (person: Person) {
  const response = yield* switcher(person);
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers["cache-control"], "private, no-store");
  return yield* response.json;
});
/** The list's own fields for `person`, a member who has never looked at What's new. */
const listFor = (person: Person, handle: string) => ({
  viewer: { id: person.id, companyId: person.companyId, role: person.role },
  company: { handle, name: "Northwind" },
  whatsNewUnseen: WhatsNew.changesSince(0).length
});

it.layer(socket)("the switcher's list", (it) => {
  it.effect("lists the company's live patches with the viewer's own opens, and no one else's", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const other = yield* company();
      const patches = yield* Patches.Patches;
      const sql = yield* SqlClient.SqlClient;
      const notes = yield* publish(workspace.owner, "team-notes", { title: "Team notes" });
      const kit = yield* publish(workspace.admin, "press-kit", { scope: "public" });
      const retired = yield* publish(workspace.owner, "old-board");
      yield* patches.retire(retired.patchId, actor(workspace.owner));
      const disabled = yield* publish(workspace.owner, "rota");
      yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${disabled.patchId}`;
      yield* publish(other.owner, "their-notes");
      yield* publish(other.owner, "their-kit", { scope: "public" });
      yield* patches.recordOpen(workspace.member.id, notes.patchId, notes.versionId);
      const rows = (viewer: Person) => ({
        kit: {
          id: kit.patchId,
          name: "press-kit",
          title: "press-kit",
          tier: 1,
          mine: viewer === workspace.admin
        },
        notes: {
          id: notes.patchId,
          name: "team-notes",
          title: "Team notes",
          tier: 1,
          mine: viewer === workspace.owner,
          ...(viewer === workspace.member ? { openedAt: "2026-01-01T00:00:00.000Z", score: 1 } : {})
        }
      });

      // Each viewer's own patches come first; only the member opened Team notes.
      const { member, owner, admin } = workspace;
      for (const [viewer, order] of [
        [member, ["kit", "notes"]],
        [owner, ["notes", "kit"]],
        [admin, ["kit", "notes"]]
      ] as const)
        assert.deepStrictEqual(yield* switcherList(viewer), {
          ...listFor(viewer, workspace.handle),
          patches: order.map((key) => rows(viewer)[key]),
          shared: []
        });
    })
  );

  it.effect("lists what's shared with a guest while they can open it and it isn't public", () =>
    Effect.gen(function* () {
      const guests = yield* company();
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE companies SET name = 'Harbor Works' WHERE id = ${workspace.id}`;
      const patches = yield* Patches.Patches;
      const grants = yield* GuestGrants.GuestGrants;
      const board = yield* publish(workspace.owner, "site-board");
      const notes = yield* publish(workspace.owner, "site-notes", { title: "Site notes" });
      const retired = yield* publish(workspace.owner, "old-notes");
      yield* publish(workspace.owner, "price-list", { scope: "public" });
      for (const patch of [board, notes, retired])
        yield* grants.grant({
          patchId: patch.patchId,
          userId: guests.member.id,
          grantedBy: workspace.owner.id
        });
      yield* patches.retire(retired.patchId, actor(workspace.owner));
      const harbor = { handle: workspace.handle, name: "Harbor Works" };
      const row = {
        board: {
          id: board.patchId,
          company: harbor,
          name: "site-board",
          title: "site-board",
          tier: 1
        },
        notes: {
          id: notes.patchId,
          company: harbor,
          name: "site-notes",
          title: "Site notes",
          tier: 1
        }
      };
      const listed = (...shared: ReadonlyArray<keyof typeof row>) =>
        Effect.map(switcherList(guests.member), (body) =>
          assert.deepStrictEqual(body, {
            ...listFor(guests.member, guests.handle),
            patches: [],
            shared: shared.map((key) => row[key])
          })
        );

      // Never Harbor Works' own public patch, nor one the guest can't open now.
      yield* listed("board", "notes");
      // The same grant drops a patch while it is public, and lists it once it isn't.
      yield* patches.setSharing({
        patchId: notes.patchId,
        actor: actor(workspace.owner),
        audience: { members: { kind: "public" } }
      });
      yield* listed("board");
      yield* patches.setSharing({
        patchId: notes.patchId,
        actor: actor(workspace.owner),
        audience: { members: { kind: "company" } }
      });
      yield* listed("board", "notes");
      yield* grants.revoke({ patchId: board.patchId, userId: guests.member.id });
      yield* listed("notes");
      yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${notes.patchId}`;
      yield* listed();
    })
  );

  it.effect("answers only this origin's scripts and a signed-in member, in JSON", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const { member } = workspace;
      const sql = yield* SqlClient.SqlClient;
      const refused = Effect.fn("SwitcherListTest.refused")(function* (
        response: HttpClientResponse.HttpClientResponse,
        status: number,
        code: string
      ) {
        assert.strictEqual(response.status, status);
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        assert.strictEqual(response.headers["content-type"], "application/json");
        assert.deepInclude(yield* response.json, { ok: false, code });
      });
      const now = Math.floor(Date.now() / 1_000);
      const stale = signedInCookies(
        signSession({
          sub: member.clerkUserId,
          email: member.email,
          name: member.name,
          iat: now - 120,
          nbf: now - 120,
          exp: now - 60
        })
      );

      // Refused before authentication, so a stale session gets no refresh: other sites, a
      // page the browser opened itself, a request without fetch metadata, and machine tokens.
      const { token } = yield* (yield* MachineTokens.MachineTokens).mint({
        userId: member.id,
        name: "Switcher test machine"
      });
      for (const cookie of [sessionCookie(member), stale, ""]) {
        for (const site of ["cross-site", "same-site", "none"])
          yield* refused(
            yield* switcher(null, { cookie, "sec-fetch-site": site }),
            403,
            "access_denied"
          );
        yield* refused(yield* switcher(null, { cookie }), 403, "access_denied");
        yield* refused(
          yield* switcher(null, {
            cookie,
            "sec-fetch-site": "same-origin",
            authorization: `Bearer ${token}`
          }),
          403,
          "access_denied"
        );
      }

      const sameOrigin = (cookie: string) =>
        switcher(null, { cookie, "sec-fetch-site": "same-origin" });
      yield* refused(yield* sameOrigin(stale), 401, "session_refresh_required");
      yield* refused(yield* sameOrigin(""), 401, "session_expired");
      // Signed in to Clerk, but not yet anyone's member.
      const stranger = sessionCookie({
        ...member,
        clerkUserId: "clerk_switcher_stranger",
        email: "stranger@patchy.local"
      });
      yield* refused(yield* sameOrigin(stranger), 403, "access_denied");
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${member.id}`;
      yield* refused(yield* switcher(member), 403, "access_denied");
    })
  );

  it.effect("keeps the session Clerk refreshed on the way", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const { member } = workspace;
      const now = Math.floor(Date.now() / 1_000);
      const claims = { sub: member.clerkUserId, email: member.email, name: member.name };
      // Clerk refreshes an expired session itself when the browser also holds its refresh
      // cookie, whose name carries the instance's suffix.
      const digest = yield* (yield* Cryptography.Cryptography).digest("SHA-1", publishableKey());
      const refresh = `__refresh_${Buffer.from(digest).toString("base64url").slice(0, 8)}`;
      const token = signSession(claims);
      clerk.refreshed = [
        `__session=${token}; Path=/; SameSite=Lax`,
        `${refresh}=refresh-new; Path=/; HttpOnly; SameSite=Lax`
      ];
      const expired = signedInCookies(
        signSession({ ...claims, iat: now - 120, nbf: now - 120, exp: now - 60 })
      );

      const response = yield* switcher(null, {
        cookie: `${expired}; ${refresh}=refresh-old`,
        "sec-fetch-site": "same-origin"
      });
      assert.strictEqual(response.status, 200);
      assert.deepInclude(yield* response.json, {
        viewer: listFor(member, workspace.handle).viewer
      });
      assert.deepStrictEqual(
        [
          Cookies.getValue(response.cookies, "__session"),
          Cookies.getValue(response.cookies, refresh)
        ],
        [Option.some(token), Option.some("refresh-new")]
      );
    })
  );
});
