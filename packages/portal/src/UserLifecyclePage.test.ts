import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { PUBLIC_BASE_URL } from "@patchy/auth/testing";
import { Teams, Users } from "@patchy/companies";
import { Patches } from "@patchy/patches";
import { Wakes } from "@patchy/runtime";
import {
  reported,
  routes,
  lifecycleEvents,
  services,
  socket,
  company,
  actor,
  publish,
  publishSource,
  publishDependant,
  readPatch,
  acknowledgements,
  request,
  post,
  text,
  links,
  forms,
  hidden,
  inputs,
  inputValues,
  userPath,
  readUser,
  cardPath,
  type FormFields,
  type Person
} from "./test/fixtures.js";

/**
 * Chooses Retire or Restore some or all: the choice redirects to the confirmation's own address,
 * which a GET draws, as a reload, Back or a new tab would.
 */
const choose = Effect.fn("UserLifecyclePage.choose")(function* (
  path: string,
  person: Person,
  fields: FormFields
) {
  const chosen = yield* post(path, person, fields);
  assert.strictEqual(chosen.status, 303);
  const location = chosen.headers.location!;
  assert.isTrue(location.startsWith(`${path}?choice=`));
  return yield* request(location, person);
});

it.layer(socket)("user lifecycle pages on a socket", (it) => {
  for (const action of ["deactivate", "reactivate"] as const) {
    it.effect(
      `refuses ${action} when a selected patch is reassigned while confirmation waits`,
      () =>
        Effect.gen(function* () {
          const workspace = yield* company();
          const patches = yield* Patches.Patches;
          const users = yield* Users.Users;
          const sql = yield* SqlClient.SqlClient;
          const unrelated = yield* publish(workspace.member, `${action}-unrelated`);
          const first = yield* publish(workspace.owner, `z-${action}-first`);
          const moved = yield* publish(workspace.owner, `a-${action}-moved`);
          if (action === "reactivate") {
            yield* patches.retire(first.patchId, actor(workspace.admin));
            yield* patches.retire(moved.patchId, actor(workspace.admin));
            yield* users.deactivate({ companyId: workspace.id, userId: workspace.owner.id });
          }
          const beforeUser = yield* readUser(workspace.owner);
          const beforeFirst = yield* readPatch(workspace.admin, first.patchId);
          const locked = yield* Deferred.make<number>();
          const commit = yield* Deferred.make<void>();
          const reassigning = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const reassigned = yield* patches.reassign(
                  moved.patchId,
                  actor(workspace.admin),
                  workspace.member.id,
                  workspace.owner.id
                );
                const [backend] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
                yield* Deferred.succeed(locked, backend!.pid);
                yield* Deferred.await(commit);
                return reassigned;
              })
            )
            .pipe(Effect.forkScoped);
          const blocker = yield* Deferred.await(locked);
          const confirmation = yield* post(userPath(workspace.owner, action), workspace.admin, {
            choice: "confirm",
            patch: [moved.patchId, first.patchId]
          }).pipe(Effect.forkScoped);
          // Wait for the real HTTP transaction to reach the reassignment's row lock.
          yield* sql<{ pid: number }>`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database()
              AND ${blocker} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`.pipe(
            Effect.repeat({ until: (rows) => rows.length === 1 }),
            Effect.timeout("10 seconds"),
            TestClock.withLive
          );
          yield* patches
            .setDescription(
              unrelated.patchId,
              actor(workspace.member),
              "Edited during confirmation"
            )
            .pipe(Effect.timeout("10 seconds"), TestClock.withLive);
          yield* Deferred.succeed(commit, undefined);
          const reassigned = yield* Fiber.join(reassigning);
          const response = yield* Fiber.join(confirmation);
          assert.strictEqual(response.status, 409);
          assert.deepStrictEqual(yield* readUser(workspace.owner), beforeUser);
          assert.deepStrictEqual(yield* readPatch(workspace.admin, first.patchId), beforeFirst);
          // The batch changed the first patch before the moved one refused; it rolled back unreported.
          assert.deepStrictEqual(
            reported(first.patchId).map((event) => event.name),
            action === "reactivate" ? ["patch.retired"] : []
          );
          assert.deepStrictEqual(
            (yield* readPatch(workspace.admin, moved.patchId)).patch,
            reassigned
          );
          assert.strictEqual(
            (yield* readPatch(workspace.member, unrelated.patchId)).patch.description,
            "Edited during confirmation"
          );
          assert.deepStrictEqual(lifecycleEvents(workspace.id), []);
        }).pipe(Effect.scoped),
      15_000
    );
  }

  it.effect(
    "stops waiting and reports nothing when the admin disconnects during a lock wait",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const retiring = yield* publish(workspace.owner, "lock-wait-retiring");
        const sql = yield* SqlClient.SqlClient;
        const locked = yield* Deferred.make<number>();
        const release = yield* Deferred.make<void>();
        // Hold the company row, as an invitation does while Clerk delivers it.
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT id FROM companies WHERE id = ${workspace.id} FOR UPDATE`;
              const [backend] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
              yield* Deferred.succeed(locked, backend!.pid);
              yield* Deferred.await(release);
            })
          )
          .pipe(Effect.forkScoped);
        const blocker = yield* Deferred.await(locked);
        const waiting = (count: number) =>
          sql<{ pid: number }>`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND ${blocker} = ANY(pg_blocking_pids(pid))`.pipe(
            Effect.repeat({ until: (rows) => rows.length === count }),
            Effect.timeout("10 seconds"),
            TestClock.withLive
          );
        // The retirement runs first, then deactivation waits on the company row.
        const confirmation = yield* post(userPath(workspace.owner, "deactivate"), workspace.admin, {
          choice: "confirm",
          patch: [retiring.patchId]
        }).pipe(Effect.forkScoped);
        yield* waiting(1);
        yield* Fiber.interrupt(confirmation);
        // The lock is still held, so only cancellation can end the wait.
        yield* waiting(0);
        yield* Deferred.succeed(release, undefined);
        assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
        assert.strictEqual(
          (yield* readPatch(workspace.admin, retiring.patchId)).patch.state,
          "live"
        );
        assert.deepStrictEqual(lifecycleEvents(workspace.id), []);
        assert.deepStrictEqual(reported(retiring.patchId), []);
      }).pipe(Effect.scoped),
    15_000
  );

  it.effect("renders lifecycle picks and previews while company mutation locks are held", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "preview-without-locks");
      const sql = yield* SqlClient.SqlClient;
      const users = yield* Users.Users;
      const patches = yield* Patches.Patches;
      for (const action of ["deactivate", "reactivate"] as const) {
        if (action === "reactivate") {
          yield* (yield* Patches.Patches).retire(patch.patchId, actor(workspace.admin));
          yield* users.deactivate({ companyId: workspace.id, userId: workspace.owner.id });
        }
        const before = yield* readUser(workspace.owner);
        yield* patches.withDependencyLock(workspace.admin.id)(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM patches WHERE company_id = ${workspace.id} FOR UPDATE`;
            yield* sql`SELECT id FROM companies WHERE id = ${workspace.id} FOR UPDATE`;
            const path = userPath(workspace.owner, action);
            const pick = yield* request(path, workspace.admin);
            assert.strictEqual(pick.status, 200);
            assert.sameMembers(inputValues(yield* pick.text, "patch", "checkbox"), [patch.patchId]);
            const preview = yield* choose(path, workspace.admin, { choice: "all" });
            assert.strictEqual(preview.status, 200);
            assert.sameMembers(inputValues(yield* preview.text, "patch", "hidden"), [
              patch.patchId
            ]);
          })
        );
        assert.deepStrictEqual(yield* readUser(workspace.owner), before);
      }
    })
  );

  it.effect(
    "lists live patch choices with their dependants and leaves off patches unselectable",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const source = yield* publishSource(workspace.owner, "leaving-source");
        const own = yield* publishDependant(workspace.owner, "leaving-own-reader", source.patchId);
        const colleague = yield* publishDependant(
          workspace.member,
          "leaving-colleague-reader",
          source.patchId
        );
        const offReader = yield* publishDependant(
          workspace.member,
          "leaving-off-reader",
          source.patchId
        );
        yield* service.retire(offReader.patchId, actor(workspace.member));
        const retired = yield* publish(workspace.owner, "leaving-retired");
        const deleted = yield* publish(workspace.owner, "leaving-deleted");
        yield* service.retire(retired.patchId, actor(workspace.owner));
        yield* service.delete(deleted.patchId, actor(workspace.admin));

        const path = userPath(workspace.owner, "deactivate");
        const response = yield* request(path, workspace.admin);
        assert.strictEqual(response.status, 200);
        const html = yield* response.text;
        assert.include(forms(html), path);
        assert.sameMembers(inputValues(html, "patch", "checkbox"), [source.patchId, own.patchId]);
        assert.match(text(html), new RegExp(`${own.name}[^)]*\\btheirs\\b`));
        assert.match(text(html), new RegExp(`${colleague.name}[^a-zA-Z]*Alex`));
        assert.notInclude(text(html), offReader.name);
        assert.include(text(html), retired.name);
        assert.include(text(html), deleted.name);
        for (const label of ["Keep them live", "Retire some", "Retire all"])
          assert.include(text(html), label);
        // Keep is the choice already made; the others go to a confirmation.
        assert.match(html, /name="choice" value="keep"[^>]* checked/);
        assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
      })
  );

  it.effect("tells apart patches with the same title by their names, picking and confirming", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const first = yield* publish(workspace.owner, "same-title-first", { title: "Report" });
      const second = yield* publish(workspace.owner, "same-title-second", { title: "Report" });
      const path = userPath(workspace.owner, "deactivate");
      const pick = text(yield* (yield* request(path, workspace.admin)).text);
      for (const name of [first.name, second.name]) assert.include(pick, `Report (${name})`);
      const preview = yield* choose(path, workspace.admin, {
        choice: "selected",
        patch: [second.patchId]
      });
      const confirmation = text(yield* preview.text);
      assert.include(confirmation, `Retire Report (${second.name}).`);
      assert.notInclude(confirmation, first.name);
    })
  );

  it.effect(
    "keeps checked patches live and deactivates immediately when the admin chooses keep",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const source = yield* publishSource(workspace.owner, "keep-live-source");
        const reader = yield* publishDependant(
          workspace.member,
          "keep-live-reader",
          source.patchId
        );
        const response = yield* post(userPath(workspace.owner, "deactivate"), workspace.admin, {
          choice: "keep",
          patch: [source.patchId]
        });
        assert.strictEqual(response.status, 303);
        assert.strictEqual(response.headers.location, "/settings/people");
        assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);
        assert.strictEqual((yield* readPatch(workspace.admin, source.patchId)).patch.state, "live");
        assert.strictEqual((yield* readPatch(workspace.admin, reader.patchId)).patch.state, "live");
        const card = yield* (yield* request(cardPath(source.name), workspace.member)).text;
        assert.include(text(card), "Priya (deactivated)");
        assert.strictEqual((yield* request("/", workspace.owner)).status, 403);
        // Repeating it is refused and reports nothing more.
        const repeated = yield* post(userPath(workspace.owner, "deactivate"), workspace.admin, {
          choice: "keep"
        });
        assert.strictEqual(repeated.status, 409);
        assert.deepStrictEqual(lifecycleEvents(workspace.id), [
          ["user.deactivated", workspace.admin.id, workspace.owner.id]
        ]);
      })
  );

  for (const action of ["deactivate", "reactivate"] as const)
    it.effect(
      `draws ${action}'s confirmation again at its own address, where only its button acts`,
      () =>
        Effect.gen(function* () {
          const workspace = yield* company();
          const patches = yield* Patches.Patches;
          const first = yield* publish(workspace.owner, `${action}-address-first`);
          const second = yield* publish(workspace.owner, `${action}-address-second`);
          if (action === "reactivate") {
            yield* patches.retire(first.patchId, actor(workspace.admin));
            yield* patches.retire(second.patchId, actor(workspace.admin));
            yield* (yield* Users.Users).deactivate({
              companyId: workspace.id,
              userId: workspace.owner.id
            });
          }
          const before = yield* readUser(workspace.owner);
          const path = userPath(workspace.owner, action);
          const question = `${action === "deactivate" ? "Deactivate" : "Reactivate"} ${workspace.owner.name}?`;
          const chosen = yield* post(path, workspace.admin, {
            choice: "selected",
            patch: [second.patchId]
          });
          assert.strictEqual(chosen.status, 303);
          const address = new URL(chosen.headers.location!, PUBLIC_BASE_URL);
          assert.strictEqual(address.pathname, path);
          assert.deepStrictEqual(
            [...address.searchParams],
            [
              ["choice", "selected"],
              ["patch", second.patchId]
            ]
          );
          // Reloaded, or opened in another tab, the address draws the same confirmation.
          const drawn = Effect.gen(function* () {
            const page = yield* request(chosen.headers.location!, workspace.admin);
            assert.strictEqual(page.status, 200);
            const html = yield* page.text;
            assert.include(text(html), question);
            assert.strictEqual(hidden(html, "choice"), "confirm");
            assert.deepStrictEqual(inputValues(html, "patch", "hidden"), [second.patchId]);
          });
          yield* drawn;
          yield* drawn;
          // All's address is its choice; what it covers is read when it is drawn.
          const all = yield* post(path, workspace.admin, { choice: "all" });
          assert.strictEqual(all.headers.location, `${path}?choice=all`);
          const allPage = yield* (yield* request(`${path}?choice=all`, workspace.admin)).text;
          assert.include(text(allPage), question);
          assert.sameMembers(inputValues(allPage, "patch", "hidden"), [
            first.patchId,
            second.patchId
          ]);
          // A GET never acts, whatever its query says: the pick starts on Keep.
          for (const query of ["choice=keep", `choice=confirm&patch=${second.patchId}`]) {
            const page = yield* request(`${path}?${query}`, workspace.admin);
            assert.strictEqual(page.status, 200);
            assert.match(yield* page.text, /name="choice" value="keep"[^>]* checked/);
          }
          // An address naming a patch that isn't theirs to choose is refused on the pick.
          const foreign = yield* company();
          const other = yield* publish(foreign.owner, `${action}-address-foreign`);
          const stale = yield* request(
            `${path}?choice=selected&patch=${other.patchId}`,
            workspace.admin
          );
          assert.strictEqual(stale.status, 409);
          assert.include(text(yield* stale.text), "The selected patches changed.");
          assert.deepStrictEqual(yield* readUser(workspace.owner), before);
          // A member gets no confirmation from the address either.
          assert.strictEqual(
            (yield* request(chosen.headers.location!, workspace.member)).status,
            403
          );

          // The confirmation's button still acts, on what it named.
          const committed = yield* post(path, workspace.admin, {
            choice: "confirm",
            patch: [second.patchId]
          });
          assert.strictEqual(committed.status, 303);
          assert.strictEqual(committed.headers.location, "/settings/people");
          assert.strictEqual(
            (yield* readUser(workspace.owner)).deactivatedAt === null,
            action === "reactivate"
          );
          const [acted, kept] = action === "deactivate" ? ["retired", "live"] : ["live", "retired"];
          assert.strictEqual(
            (yield* readPatch(workspace.admin, second.patchId)).patch.state,
            acted
          );
          assert.strictEqual((yield* readPatch(workspace.admin, first.patchId)).patch.state, kept);
        })
    );

  it.effect(
    "rejects an empty selection and retires an entirely selected chain without breakage",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const source = yield* publishSource(workspace.owner, "selected-chain-source");
        const reader = yield* publishDependant(
          workspace.owner,
          "selected-chain-reader",
          source.patchId
        );
        const path = userPath(workspace.owner, "deactivate");
        const empty = yield* post(path, workspace.admin, { choice: "selected" });
        assert.strictEqual(empty.status, 422);
        const emptyHtml = yield* empty.text;
        assert.include(text(emptyHtml), "Select at least one, or keep their patches live.");
        assert.sameMembers(inputValues(emptyHtml, "patch", "checkbox"), [
          source.patchId,
          reader.patchId
        ]);
        assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);

        const selection = [source.patchId, reader.patchId];
        const wakes = yield* Wakes.Wakes;
        const patchService = yield* Patches.Patches;
        const userService = yield* Users.Users;
        const committedKeys: string[][] = [];
        yield* wakes.subscribe((keys) =>
          Effect.gen(function* () {
            if (!keys.some((key) => selection.some((id) => key === `patch:${id}`))) return;
            assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);
            for (const id of selection) {
              const saved = yield* readPatch(workspace.admin, id);
              assert.strictEqual(saved.patch.state, "retired");
              assert.strictEqual(saved.patch.lifecycleRevision, "2");
            }
            committedKeys.push([...keys]);
          }).pipe(
            Effect.provideService(Patches.Patches, patchService),
            Effect.provideService(Users.Users, userService),
            Effect.orDie
          )
        );
        const preview = yield* choose(path, workspace.admin, {
          choice: "selected",
          patch: selection
        });
        assert.strictEqual(preview.status, 200);
        const html = yield* preview.text;
        assert.include(text(html), "Nothing breaks");
        assert.deepStrictEqual(inputs(html, "ack", "checkbox"), []);
        assert.sameMembers(inputValues(html, "patch", "hidden"), selection);
        assert.strictEqual(hidden(html, "choice"), "confirm");
        assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
        for (const patchId of selection)
          assert.strictEqual((yield* readPatch(workspace.admin, patchId)).patch.state, "live");
        assert.deepStrictEqual(committedKeys, []);
        assert.deepStrictEqual(selection.flatMap(reported), []);
        assert.deepStrictEqual(lifecycleEvents(workspace.id), []);

        const committed = yield* post(path, workspace.admin, {
          choice: "confirm",
          patch: selection
        });
        assert.strictEqual(committed.status, 303);
        assert.strictEqual(committed.headers.location, "/settings/people");
        assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);
        assert.deepStrictEqual(committedKeys, [selection.map((id) => `patch:${id}`).sort()]);
        assert.sameDeepMembers(
          selection.flatMap(reported),
          selection.map((patchId): Analytics.AnalyticsEvent => ({
            name: "patch.retired",
            principalId: workspace.admin.id,
            companyId: workspace.id,
            properties: { patchId, ownerUserId: workspace.owner.id, byAdmin: true }
          }))
        );
        for (const patchId of selection) {
          const saved = yield* readPatch(workspace.admin, patchId);
          assert.strictEqual(saved.patch.state, "retired");
          assert.strictEqual(saved.patch.retiredBy, workspace.admin.id);
          assert.strictEqual(saved.patch.lastChangedBy, workspace.admin.id);
          const card = yield* (yield* request(cardPath(saved.patch.name), workspace.member)).text;
          assert.include(text(card), "Retired by Sam");
        }
        assert.deepStrictEqual(lifecycleEvents(workspace.id), [
          ["user.deactivated", workspace.admin.id, workspace.owner.id]
        ]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "recomputes outside dependants including the same owner before accepting acknowledgement",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const source = yield* publishSource(workspace.owner, "outside-source");
        const own = yield* publishDependant(workspace.owner, "outside-own-reader", source.patchId);
        const path = userPath(workspace.owner, "deactivate");
        const preview = yield* choose(path, workspace.admin, {
          choice: "selected",
          patch: [source.patchId]
        });
        assert.strictEqual(preview.status, 200);
        const html = yield* preview.text;
        assert.include(text(html), own.name);
        assert.notInclude(text(html), "Nothing breaks");
        assert.strictEqual(inputs(html, "ack", "checkbox").length, 1);
        const later = yield* publishDependant(
          workspace.member,
          "outside-later-reader",
          source.patchId
        );
        for (const acknowledgement of acknowledgements) {
          const refused = yield* post(path, workspace.admin, {
            choice: "confirm",
            patch: [source.patchId],
            ...acknowledgement
          });
          assert.strictEqual(refused.status, 409);
          const fresh = yield* refused.text;
          assert.include(text(fresh), own.name);
          assert.include(text(fresh), later.name);
          assert.include(text(fresh), workspace.member.name);
          assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
          assert.strictEqual(
            (yield* readPatch(workspace.admin, source.patchId)).patch.state,
            "live"
          );
        }
        const committed = yield* post(path, workspace.admin, {
          choice: "confirm",
          patch: [source.patchId],
          ack: "1"
        });
        assert.strictEqual(committed.status, 303);
        assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);
        assert.strictEqual(
          (yield* readPatch(workspace.admin, source.patchId)).patch.state,
          "retired"
        );
        for (const reader of [own, later])
          assert.strictEqual(
            (yield* readPatch(workspace.admin, reader.patchId)).patch.state,
            "live"
          );
      })
  );

  it.effect(
    "skips the pick with no live patches and keeps them retired on immediate reactivation",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const retired = yield* publish(workspace.owner, "shortcut-retired");
        const deleted = yield* publish(workspace.owner, "shortcut-deleted");
        yield* service.retire(retired.patchId, actor(workspace.owner));
        yield* service.delete(deleted.patchId, actor(workspace.admin));
        const beforeRetired = yield* readPatch(workspace.admin, retired.patchId);
        const beforeDeleted = yield* readPatch(workspace.admin, deleted.patchId);
        const path = userPath(workspace.owner, "deactivate");
        const page = yield* request(path, workspace.admin);
        assert.strictEqual(page.status, 200);
        const html = yield* page.text;
        assert.strictEqual(hidden(html, "choice"), "confirm");
        assert.deepStrictEqual(inputs(html, "patch", "checkbox"), []);
        // With nothing selected there is no selection to choose again; People is the way back.
        assert.deepStrictEqual(
          links(html.slice(html.indexOf("<main"))).filter((link) =>
            link.href.startsWith("/settings/people")
          ),
          [
            { href: "/settings/people", text: "People" },
            { href: "/settings/people", text: "Cancel" }
          ]
        );
        assert.include(text(html), "Nothing breaks");
        assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
        assert.strictEqual((yield* post(path, workspace.admin, { choice: "confirm" })).status, 303);
        assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);

        const returning = userPath(workspace.owner, "reactivate");
        const pick = yield* (yield* request(returning, workspace.admin)).text;
        assert.include(text(pick), "Keep them retired");
        const kept = yield* post(returning, workspace.admin, {
          choice: "keep",
          patch: [retired.patchId]
        });
        assert.strictEqual(kept.status, 303);
        assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
        assert.deepStrictEqual(yield* readPatch(workspace.admin, retired.patchId), beforeRetired);
        assert.deepStrictEqual(yield* readPatch(workspace.admin, deleted.patchId), beforeDeleted);
        assert.strictEqual((yield* request("/", workspace.owner)).status, 200);
        assert.deepStrictEqual(lifecycleEvents(workspace.id), [
          ["user.deactivated", workspace.admin.id, workspace.owner.id],
          ["user.reactivated", workspace.admin.id, workspace.owner.id]
        ]);
      })
  );

  it.effect("refuses foreign, reassigned and retired patches in an exact confirmation", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const first = yield* publish(workspace.owner, "stale-selection-first");
      const second = yield* publish(workspace.owner, "stale-selection-second");
      const path = userPath(workspace.owner, "deactivate");
      const preview = yield* choose(path, workspace.admin, { choice: "all" });
      assert.strictEqual(preview.status, 200);
      assert.sameMembers(inputValues(yield* preview.text, "patch", "hidden"), [
        first.patchId,
        second.patchId
      ]);
      const foreign = yield* company();
      const other = yield* publish(foreign.owner, "foreign-selection-tool");
      const forged = yield* post(path, workspace.admin, {
        choice: "confirm",
        patch: [first.patchId, other.patchId]
      });
      assert.strictEqual(forged.status, 409);
      assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
      assert.strictEqual((yield* readPatch(workspace.admin, first.patchId)).patch.state, "live");
      assert.strictEqual((yield* readPatch(foreign.admin, other.patchId)).patch.state, "live");
      const fields = { choice: "confirm", patch: [first.patchId, second.patchId] };
      yield* service.reassign(second.patchId, actor(workspace.admin), workspace.member.id);
      const reassigned = yield* post(path, workspace.admin, fields);
      assert.strictEqual(reassigned.status, 409);
      // The pick comes back on the choice that was being confirmed, with what's still theirs
      // checked, and its refusal is where focus starts; it never falls back to Keep.
      const again = yield* reassigned.text;
      assert.match(again, /name="choice" value="selected"[^>]* checked/);
      assert.notMatch(again, /name="choice" value="keep"[^>]* checked/);
      assert.sameMembers(
        inputs(again, "patch", "checkbox")
          .filter((input) => / checked/.test(input))
          .map((input) => input.match(/value="([^"]*)"/)?.[1]),
        [first.patchId]
      );
      assert.include(again, '<div class="refusal" tabindex="-1" autofocus>');
      assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
      assert.strictEqual((yield* readPatch(workspace.admin, first.patchId)).patch.state, "live");
      const moved = yield* readPatch(workspace.admin, second.patchId);
      assert.strictEqual(moved.patch.state, "live");
      assert.strictEqual(moved.patch.ownerUserId, workspace.member.id);

      yield* service.reassign(second.patchId, actor(workspace.admin), workspace.owner.id);
      yield* service.retire(first.patchId, actor(workspace.admin));
      const retired = yield* post(path, workspace.admin, fields);
      assert.strictEqual(retired.status, 409);
      assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
      assert.strictEqual((yield* readPatch(workspace.admin, second.patchId)).patch.state, "live");
    })
  );

  it.effect(
    "offers every retired patch however retired but never restores deleted or reassigned patches",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const own = yield* publish(workspace.owner, "returning-own-retirement");
        const admin = yield* publish(workspace.owner, "returning-admin-retirement");
        const deleted = yield* publish(workspace.owner, "returning-deleted");
        const moved = yield* publish(workspace.owner, "returning-reassigned");
        yield* service.retire(own.patchId, actor(workspace.owner));
        yield* service.retire(admin.patchId, actor(workspace.admin));
        yield* service.delete(deleted.patchId, actor(workspace.admin));
        yield* service.retire(moved.patchId, actor(workspace.owner));
        yield* service.reassign(moved.patchId, actor(workspace.admin), workspace.member.id);
        yield* (yield* Users.Users).deactivate({
          companyId: workspace.id,
          userId: workspace.owner.id
        });
        const beforeDeleted = yield* readPatch(workspace.admin, deleted.patchId);
        const beforeMoved = yield* readPatch(workspace.admin, moved.patchId);
        const path = userPath(workspace.owner, "reactivate");
        const page = yield* request(path, workspace.admin);
        assert.strictEqual(page.status, 200);
        const html = yield* page.text;
        assert.sameMembers(inputValues(html, "patch", "checkbox"), [own.patchId, admin.patchId]);
        assert.notInclude(text(html), moved.name);
        for (const label of ["Keep them retired", "Restore some", "Restore all"])
          assert.include(text(html), label);
        const empty = yield* post(path, workspace.admin, { choice: "selected" });
        assert.strictEqual(empty.status, 422);
        assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);

        const preview = yield* choose(path, workspace.admin, { choice: "all" });
        assert.strictEqual(preview.status, 200);
        const confirmation = yield* preview.text;
        assert.sameMembers(inputValues(confirmation, "patch", "hidden"), [
          own.patchId,
          admin.patchId
        ]);
        assert.deepStrictEqual(inputs(confirmation, "ack", "checkbox"), []);
        const wakes = yield* Wakes.Wakes;
        const userService = yield* Users.Users;
        const committedKeys: string[][] = [];
        yield* wakes.subscribe((keys) =>
          Effect.gen(function* () {
            if (!keys.includes(`patch:${own.patchId}`)) return;
            assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
            for (const patch of [own, admin]) {
              const saved = yield* readPatch(workspace.admin, patch.patchId);
              assert.strictEqual(saved.patch.state, "live");
              assert.strictEqual(saved.patch.lifecycleRevision, "3");
            }
            committedKeys.push([...keys]);
          }).pipe(
            Effect.provideService(Patches.Patches, service),
            Effect.provideService(Users.Users, userService),
            Effect.orDie
          )
        );
        const committed = yield* post(path, workspace.admin, {
          choice: "confirm",
          patch: [own.patchId, admin.patchId]
        });
        assert.strictEqual(committed.status, 303);
        assert.strictEqual(committed.headers.location, "/settings/people");
        assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
        assert.deepStrictEqual(committedKeys, [
          [own.patchId, admin.patchId].sort().map((id) => `patch:${id}`)
        ]);
        for (const patch of [own, admin]) {
          const saved = yield* readPatch(workspace.admin, patch.patchId);
          assert.strictEqual(saved.patch.state, "live");
          // After the setup's retirement, reactivation restores once.
          assert.deepStrictEqual(reported(patch.patchId).slice(1), [
            {
              name: "patch.restored",
              principalId: workspace.admin.id,
              companyId: workspace.id,
              properties: {
                patchId: patch.patchId,
                ownerUserId: workspace.owner.id,
                byAdmin: true,
                from: "retired"
              }
            }
          ]);
          assert.strictEqual(saved.patch.lastChangedBy, workspace.admin.id);
          const card = yield* (yield* request(cardPath(patch.name), workspace.member)).text;
          assert.notInclude(text(card), "Priya (deactivated)");
        }
        const stillDeleted = yield* readPatch(workspace.admin, deleted.patchId);
        assert.deepStrictEqual(stillDeleted.patch, beforeDeleted.patch);
        assert.isFalse(stillDeleted.owner.deactivated);
        assert.deepStrictEqual(yield* readPatch(workspace.admin, moved.patchId), beforeMoved);
      }).pipe(Effect.scoped)
  );

  it.effect("restores a selected source chain without treating its own off sources as broken", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const source = yield* publishSource(workspace.owner, "z-returning-chain-source");
      const reader = yield* publishDependant(
        workspace.owner,
        "a-returning-chain-reader",
        source.patchId
      );
      yield* service.retire(reader.patchId, actor(workspace.owner));
      yield* service.retire(source.patchId, actor(workspace.admin));
      yield* (yield* Users.Users).deactivate({
        companyId: workspace.id,
        userId: workspace.owner.id
      });
      const path = userPath(workspace.owner, "reactivate");
      const selection = [reader.patchId, source.patchId];
      const preview = yield* choose(path, workspace.admin, {
        choice: "selected",
        patch: selection
      });
      assert.strictEqual(preview.status, 200);
      const html = yield* preview.text;
      assert.deepStrictEqual(inputs(html, "ack", "checkbox"), []);
      assert.sameMembers(inputValues(html, "patch", "hidden"), selection);
      assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);
      const committed = yield* post(path, workspace.admin, { choice: "confirm", patch: selection });
      assert.strictEqual(committed.status, 303);
      assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
      for (const patchId of selection)
        assert.strictEqual((yield* readPatch(workspace.admin, patchId)).patch.state, "live");
    })
  );

  // Patches owns which sources count as off; one source that goes off after the preview
  // shows the warning is recomputed at commit.
  it.effect("warns about off sources and recomputes them before restoring", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const source = yield* publishSource(workspace.member, "return-source");
      const reader = yield* publishDependant(
        workspace.owner,
        "return-broken-reader",
        source.patchId
      );
      yield* service.retire(reader.patchId, actor(workspace.owner));
      yield* (yield* Users.Users).deactivate({
        companyId: workspace.id,
        userId: workspace.owner.id
      });
      const path = userPath(workspace.owner, "reactivate");
      const preview = yield* choose(path, workspace.admin, {
        choice: "selected",
        patch: [reader.patchId]
      });
      assert.strictEqual(preview.status, 200);
      assert.deepStrictEqual(inputs(yield* preview.text, "ack", "checkbox"), []);

      yield* service.retire(source.patchId, actor(workspace.member));
      const refused = yield* post(path, workspace.admin, {
        choice: "confirm",
        patch: [reader.patchId]
      });
      assert.strictEqual(refused.status, 409);
      const refusedHtml = yield* refused.text;
      assert.include(text(refusedHtml), `${source.name} / notes: retired`);
      assert.strictEqual(inputs(refusedHtml, "ack", "checkbox").length, 1);
      assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);
      assert.strictEqual(
        (yield* readPatch(workspace.admin, reader.patchId)).patch.state,
        "retired"
      );
      const committed = yield* post(path, workspace.admin, {
        choice: "confirm",
        patch: [reader.patchId],
        ack: "1"
      });
      assert.strictEqual(committed.status, 303);
      assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
      assert.strictEqual((yield* readPatch(workspace.admin, reader.patchId)).patch.state, "live");
      assert.strictEqual(
        (yield* readPatch(workspace.admin, source.patchId)).patch.state,
        "retired"
      );
    })
  );

  it.effect(
    "refuses the last active admin on GET and rechecks the rule after a pick was drawn",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const users = yield* Users.Users;
        const patch = yield* publish(workspace.admin, "last-admin-tool");
        const path = userPath(workspace.admin, "deactivate");
        const page = yield* request(path, workspace.admin);
        assert.strictEqual(page.status, 409);
        const html = yield* page.text;
        assert.include(text(html), "The last active admin cannot be demoted or deactivated.");
        assert.notInclude(forms(html), path);
        assert.strictEqual((yield* post(path, workspace.admin, { choice: "keep" })).status, 409);
        yield* users.setRole({
          companyId: workspace.id,
          userId: workspace.owner.id,
          role: "admin"
        });
        assert.strictEqual((yield* request(path, workspace.admin)).status, 200);
        yield* users.deactivate({ companyId: workspace.id, userId: workspace.owner.id });
        const refused = yield* post(path, workspace.admin, {
          choice: "confirm",
          patch: [patch.patchId]
        });
        assert.strictEqual(refused.status, 409);
        assert.isNull((yield* readUser(workspace.admin)).deactivatedAt);
        assert.strictEqual((yield* readPatch(workspace.admin, patch.patchId)).patch.state, "live");
        assert.deepStrictEqual(lifecycleEvents(workspace.id), []);
      })
  );

  it.effect(
    "requires an admin browser session, company membership and same-origin lifecycle forms",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const foreign = yield* company();
        const service = yield* Patches.Patches;
        const patch = yield* publish(workspace.owner, "guarded-user-tool");
        for (const action of ["deactivate", "reactivate"] as const) {
          if (action === "reactivate") {
            yield* service.retire(patch.patchId, actor(workspace.admin));
            yield* (yield* Users.Users).deactivate({
              companyId: workspace.id,
              userId: workspace.owner.id
            });
          }
          const path = userPath(workspace.owner, action);
          const beforeUser = yield* readUser(workspace.owner);
          const beforePatch = yield* readPatch(workspace.admin, patch.patchId);
          assert.strictEqual((yield* request(path, null)).status, 401);
          assert.strictEqual(
            (yield* request(path, null, { choice: "keep" }, { origin: PUBLIC_BASE_URL })).status,
            401
          );
          assert.strictEqual((yield* request(path, workspace.member)).status, 403);
          assert.strictEqual((yield* post(path, workspace.member, { choice: "keep" })).status, 403);
          const foreignPath = userPath(foreign.owner, action);
          assert.strictEqual((yield* request(foreignPath, workspace.admin)).status, 404);
          assert.strictEqual(
            (yield* post(foreignPath, workspace.admin, { choice: "keep" })).status,
            404
          );
          const refusedHeaders: ReadonlyArray<Record<string, string>> = [
            {},
            { origin: "https://foreign.invalid" },
            { "sec-fetch-site": "cross-site" }
          ];
          for (const headers of refusedHeaders) {
            const refused = yield* request(path, workspace.admin, { choice: "keep" }, headers);
            assert.strictEqual(refused.status, 403);
          }
          assert.deepStrictEqual(yield* readUser(workspace.owner), beforeUser);
          assert.deepStrictEqual(yield* readPatch(workspace.admin, patch.patchId), beforePatch);
        }
        assert.deepStrictEqual(lifecycleEvents(workspace.id), []);
        assert.deepStrictEqual(lifecycleEvents(foreign.id), []);
      })
  );
  it.effect(
    "retires and restores all of a person's patches, a team patch the admin can't open included",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const teams = yield* Teams.Teams;
        const patches = yield* Patches.Patches;
        const sql = yield* SqlClient.SqlClient;
        const teamOf = Effect.fn("UserLifecyclePageTest.teamOf")(function* (
          name: string,
          person: Person
        ) {
          const viewer = { companyId: workspace.id, actorId: workspace.admin.id };
          const team = yield* teams.create({ ...viewer, name });
          yield* teams.setMemberships({
            ...viewer,
            teamId: team.id,
            userIds: [person.id],
            added: true
          });
          return { kind: "teams" as const, teamIds: [team.id] };
        });
        const shared = yield* publishSource(workspace.owner, "everyone-source");
        const finance = yield* publish(workspace.owner, "finance-only");
        yield* patches.setSharing({
          patchId: finance.patchId,
          actor: actor(workspace.owner),
          audience: yield* teamOf("Lifecycle finance", workspace.owner)
        });
        // A colleague's patch the admin can't open reads the Company patch.
        const reader = yield* publishDependant(workspace.member, "hidden-reader", shared.patchId);
        yield* patches.setSharing({
          patchId: reader.patchId,
          actor: actor(workspace.member),
          audience: yield* teamOf("Lifecycle readers", workspace.member)
        });
        const owned = [shared.patchId, finance.patchId];
        const states = Effect.map(
          sql<{ readonly retired: boolean }>`SELECT retired_at IS NOT NULL AS retired
            FROM patches WHERE id IN ${sql.in(owned)}`,
          (rows) => rows.map((row) => row.retired)
        );

        const deactivate = userPath(workspace.owner, "deactivate");
        const retiring = yield* (yield* choose(deactivate, workspace.admin, { choice: "all" }))
          .text;
        assert.sameMembers(inputValues(retiring, "patch", "hidden"), owned);
        assert.include(text(retiring), "1 patch you can’t open.");
        assert.lengthOf(inputs(retiring, "ack", "checkbox"), 1);
        const retired = yield* post(deactivate, workspace.admin, {
          choice: "confirm",
          patch: owned,
          ack: "1"
        });
        assert.strictEqual(retired.status, 303);
        assert.deepStrictEqual(yield* states, [true, true]);

        const reactivate = userPath(workspace.owner, "reactivate");
        const restoring = yield* (yield* choose(reactivate, workspace.admin, { choice: "all" }))
          .text;
        assert.sameMembers(inputValues(restoring, "patch", "hidden"), owned);
        const restored = yield* post(reactivate, workspace.admin, {
          choice: "confirm",
          patch: owned
        });
        assert.strictEqual(restored.status, 303);
        assert.deepStrictEqual(yield* states, [false, false]);
      })
  );
});

it.layer(services)("user lifecycle transaction failure on a socket", (it) => {
  it.effect(
    "reports a committed deactivation and its retirement when the admin disconnects while wakes publish",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const retiring = yield* publish(workspace.owner, "wake-paused");
        const wakes = yield* Wakes.Wakes;
        const publishing = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        // Wakes go out after the commit; pause there.
        const pausedWakes = Layer.succeed(
          Wakes.Wakes,
          Wakes.Wakes.of({
            subscribe: wakes.subscribe,
            publish: (keys, cause) =>
              Deferred.succeed(publishing, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(wakes.publish(keys, cause))
              )
          })
        );
        const pausedServer = HttpRouter.serve(routes, {
          disableLogger: true,
          disableListenLog: true
        }).pipe(
          Layer.provide(Layer.fresh(Patches.layer).pipe(Layer.provide(pausedWakes))),
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
        );
        yield* Effect.gen(function* () {
          const confirmation = yield* post(
            userPath(workspace.owner, "deactivate"),
            workspace.admin,
            {
              choice: "confirm",
              patch: [retiring.patchId]
            }
          ).pipe(Effect.forkChild);
          yield* Deferred.await(publishing);
          yield* Fiber.interrupt(confirmation);
          // Let the closed socket reach the server before publication resumes.
          yield* Effect.sleep("200 millis").pipe(TestClock.withLive);
          yield* Deferred.succeed(resume, undefined);
          yield* Effect.sync(() => lifecycleEvents(workspace.id)).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 millis"),
              until: (reported) => reported.length > 0
            }),
            Effect.timeout("10 seconds"),
            TestClock.withLive
          );
        }).pipe(Effect.provide(pausedServer));
        assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);
        assert.deepStrictEqual(lifecycleEvents(workspace.id), [
          ["user.deactivated", workspace.admin.id, workspace.owner.id]
        ]);
        assert.deepStrictEqual(
          reported(retiring.patchId).map((event) => event.name),
          ["patch.retired"]
        );
      }),
    15_000
  );

  it.effect("rolls back the selected retirements and user when deactivation fails", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const first = yield* publish(workspace.owner, "atomic-first");
      const second = yield* publish(workspace.owner, "atomic-second");
      const users = yield* Users.Users;
      const patches = yield* Patches.Patches;
      const beforeUser = yield* readUser(workspace.owner);
      const beforeFirst = yield* readPatch(workspace.admin, first.patchId);
      const beforeSecond = yield* readPatch(workspace.admin, second.patchId);
      const announced: string[] = [];
      yield* (yield* Wakes.Wakes).subscribe((keys) =>
        Effect.sync(() => {
          announced.push(...keys);
        })
      );
      let reachedDeactivation = false;
      const failDeactivation = Layer.succeed(Users.Users, {
        ...users,
        deactivate: Effect.fn("UserLifecyclePageTest.failDeactivation")(
          function* (ref: Users.UserRef) {
            yield* users.deactivate(ref);
            assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);
            assert.strictEqual(
              (yield* readPatch(workspace.admin, first.patchId).pipe(Effect.orDie)).patch.state,
              "retired"
            );
            assert.strictEqual(
              (yield* readPatch(workspace.admin, second.patchId).pipe(Effect.orDie)).patch.state,
              "retired"
            );
            assert.deepStrictEqual(announced, []);
            reachedDeactivation = true;
            return yield* new Users.UserNotFound(ref);
          },
          Effect.provideService(Users.Users, users),
          Effect.provideService(Patches.Patches, patches)
        )
      });
      const failingServer = HttpRouter.serve(routes, {
        disableLogger: true,
        disableListenLog: true
      }).pipe(
        Layer.provide(failDeactivation),
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
      );
      const status = yield* Effect.gen(function* () {
        const response = yield* post(userPath(workspace.owner, "deactivate"), workspace.admin, {
          choice: "confirm",
          patch: [first.patchId, second.patchId]
        });
        yield* response.text;
        return response.status;
      }).pipe(Effect.provide(failingServer));
      assert.strictEqual(status, 404);
      assert.isTrue(reachedDeactivation);
      assert.deepStrictEqual(yield* readUser(workspace.owner), beforeUser);
      assert.deepStrictEqual(yield* readPatch(workspace.admin, first.patchId), beforeFirst);
      assert.deepStrictEqual(yield* readPatch(workspace.admin, second.patchId), beforeSecond);
      assert.deepStrictEqual(announced, []);
      assert.deepStrictEqual(lifecycleEvents(workspace.id), []);
      assert.deepStrictEqual([first.patchId, second.patchId].flatMap(reported), []);
    }).pipe(Effect.scoped)
  );
});
