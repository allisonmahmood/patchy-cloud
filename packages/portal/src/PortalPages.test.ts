import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CURRENT_RELEASE, MANIFEST_VERSION, WIRE_VERSION, sharedTableId } from "@patchy/api";
import { RequireSession, Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import * as Testing from "@patchy/company-database/testing";
import { ConnectionStoreDev } from "@patchy/integrations/dev";
import { Patches } from "@patchy/patches";
import { Tables } from "@patchy/primitives";
import * as PortalPages from "./PortalPages.js";

const DAY = 24 * 60 * 60 * 1_000;
const routes = Layer.merge(
  PortalPages.layer,
  HttpRouter.use((router) => router.add("GET", "/", RequireSession.withViewer(PortalPages.index)))
);
const services = Layer.mergeAll(Patches.layer, Session.layer, Companies.layer, Users.layer).pipe(
  Layer.provideMerge(ConnectionStoreDev.layer([])),
  Layer.provideMerge(Tables.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);
const layer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(services),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
);

interface Person {
  readonly id: string;
  readonly companyId: string;
  readonly clerkUserId: string;
  readonly email: string;
  readonly name: string;
  readonly role: "member" | "admin";
  readonly machineTokenId: string;
}
let counter = 0;
const company = Effect.fn("PortalPagesTest.company")(function* () {
  yield* TestClock.setTime(1_767_225_600_000);
  const sql = yield* SqlClient.SqlClient;
  const id = `cmp_portal_${++counter}`;
  const handle = `portal-${counter}`;
  yield* sql`INSERT INTO companies (id, handle, name) VALUES (${id}, ${handle}, 'Northwind')`;
  const people: Person[] = [];
  for (const [name, role] of [
    ["Priya", "member"],
    ["Alex", "member"],
    ["Sam", "admin"]
  ] as const) {
    const userId = `usr_portal_${++counter}`;
    const person: Person = {
      id: userId,
      companyId: id,
      clerkUserId: `clerk_${userId}`,
      email: `${userId}@patchy.local`,
      name,
      role,
      machineTokenId: `tok_${userId}`
    };
    yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES (${person.id}, ${person.clerkUserId}, ${id}, ${person.email}, ${name}, ${role})`;
    yield* sql`INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
      VALUES (${person.machineTokenId}, ${person.id}, 'Portal test machine',
        ${`hash:${person.machineTokenId}`}, now(), now() + interval '90 days', now())`;
    people.push(person);
  }
  return { id, handle, owner: people[0]!, member: people[1]!, admin: people[2]! };
});
const actor = (person: Person): Patches.Actor => ({
  userId: person.id,
  admin: person.role === "admin"
});
const manifest = {
  manifestVersion: MANIFEST_VERSION,
  release: CURRENT_RELEASE,
  tier: 0 as const,
  tables: {},
  files: {},
  uses: {}
};
const publish = Effect.fn("PortalPagesTest.publish")(function* (
  person: Person,
  name: string,
  overrides: Partial<Patches.RecordInput> = {}
) {
  const ordinal = ++counter;
  const patchId = overrides.patchId ?? `p${String(ordinal).padStart(11, "0")}`;
  const input: Patches.RecordInput = {
    intent: "create",
    patchId,
    companyId: person.companyId,
    ownerUserId: person.id,
    machineTokenId: person.machineTokenId,
    versionId: `ver_portal_${ordinal}`,
    objectKey: `patches/${patchId}/versions/${ordinal}.html`,
    contentHash: `sha256:${ordinal}`,
    fileSize: 1,
    filename: "patch.html",
    title: "A useful office tool",
    description: "Find the right person. Includes the whole company.",
    repoOrg: null,
    repoName: null,
    cliVersion: null,
    gitBranch: null,
    gitCommitSha: null,
    sourceIp: null,
    userAgent: null,
    manifest: { ...manifest, name },
    wireVersion: WIRE_VERSION,
    publishKey: `portal-publish-${ordinal}`,
    payloadDigest: `portal-payload-${ordinal}`,
    publicBaseUrl: PUBLIC_BASE_URL,
    warnings: [],
    ...overrides
  };
  const patches = yield* Patches.Patches;
  yield* patches.preflight(input);
  yield* patches.prepareObject(input.objectKey);
  return yield* patches.record(input);
});
const readPatch = Effect.fn("PortalPagesTest.readPatch")(function* (
  person: Person,
  patchId: string
) {
  const rows = yield* (yield* Patches.Patches).read({
    companyId: person.companyId,
    userId: person.id,
    canOpen: () => true,
    state: "all",
    patchRef: patchId
  });
  assert.strictEqual(rows.length, 1);
  return rows[0]!;
});
const request = Effect.fn("PortalPagesTest.request")(function* (
  path: string,
  person: Person | null,
  fields?: Record<string, string>,
  headers: Record<string, string> = {}
) {
  const client = yield* HttpClient.HttpClient;
  const cookie =
    person === null
      ? ""
      : signedInCookies(
          signSession({
            sub: person.clerkUserId,
            email: person.email,
            name: person.name
          })
        );
  const input =
    fields === undefined
      ? HttpClientRequest.get(path)
      : HttpClientRequest.post(path).pipe(
          HttpClientRequest.bodyText(
            new URLSearchParams(fields).toString(),
            "application/x-www-form-urlencoded"
          )
        );
  return yield* client.execute(input.pipe(HttpClientRequest.setHeaders({ cookie, ...headers })));
});
const post = (path: string, person: Person, fields: Record<string, string>) =>
  request(path, person, fields, { origin: PUBLIC_BASE_URL });
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const heading = (html: string) => text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
const links = (html: string) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: match[1]!,
    text: text(match[2]!)
  }));
const forms = (html: string) =>
  [...html.matchAll(/<form\b[^>]*action="([^"]*)"[^>]*>/g)].map((match) => match[1]!);
const hidden = (html: string, name: string) =>
  html.match(
    new RegExp(`<input\\b(?=[^>]*\\bname="${name}")(?=[^>]*\\bvalue="([^"]*)")[^>]*>`)
  )?.[1];
const cardPath = (name: string) => `/patches/${name}`;
const cardLinks = (html: string) =>
  links(html.match(/<aside\b[^>]*>([\s\S]*?)<\/aside>/)?.[1] ?? "").filter(
    (link) =>
      /^\/patches\/[^/?]+(?:\?all=1)?$/.test(link.href) &&
      !/^(Show|Hide) retired and deleted$/.test(link.text)
  );
const assertStale = (html: string, action: string) => {
  assert.include(
    text(html),
    `This patch changed while you had this page open: ${action} by Sam 2 minutes ago. Nothing was done.`
  );
  assert.notInclude(text(html), "revision");
};

it.layer(layer)("portal pages on a socket", (it) => {
  it.effect("shows member, owner and admin views of one card and its retained versions", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "office-map");
      for (let version = 2; version <= 5; version++) {
        yield* TestClock.adjust(DAY);
        yield* publish(workspace.owner, patch.name, { intent: "update", patchId: patch.patchId });
      }
      for (const person of [workspace.member, workspace.owner, workspace.admin]) {
        const response = yield* request(`${cardPath(patch.name)}?all=1`, person);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        const html = yield* response.text;
        assert.strictEqual(heading(html), patch.name);
        assert.include(text(html), "A useful office tool");
        assert.include(text(html), "Find the right person. Includes the whole company.");
        assert.include(text(html), "Description edited by Priya");
        assert.include(text(html), "Current version");
        assert.include(text(html), "v5");
        assert.include(text(html), "by Priya");
        assert.include(text(html), "Anyone at Northwind who signs in. Not the public.");
        assert.include(text(html), "Nothing else reads this patch");
        assert.isTrue(
          links(html).some(
            (link) => link.href === `/${workspace.handle}/${patch.name}` && link.text === "Open"
          )
        );
        assert.include(html, `${PUBLIC_BASE_URL}/${workspace.handle}/${patch.name}`);
        const controls = forms(html).filter((path) => path.startsWith(cardPath(patch.name)));
        if (person === workspace.member) {
          assert.deepStrictEqual(controls, []);
          assert.notInclude(text(html), "Manage");
          assert.notInclude(html, `${cardPath(patch.name)}/reassign`);
        } else {
          for (const action of ["description", "scope", "rollback"])
            assert.include(controls, `${cardPath(patch.name)}/${action}?all=1`);
          for (const action of ["retire", "delete", "versions"])
            assert.isTrue(
              links(html).some((link) => link.href === `${cardPath(patch.name)}/${action}?all=1`)
            );
          assert.include(text(html), "All 5 versions");
          assert.deepStrictEqual(
            [...html.matchAll(/name="versionNumber"\s+value="(\d+)"/g)].map((match) => match[1]),
            ["4", "3", "2"]
          );
          assert.strictEqual(hidden(html, "expectedScope"), "company");
          assert.isDefined(hidden(html, "expectedDescriptionUpdatedAt"));
          assert.isDefined(hidden(html, "expectedCurrentVersionId"));
        }
        if (person === workspace.admin) {
          assert.include(
            text(html),
            "You can do everything an owner can from here, except publish."
          );
          assert.include(html, `${cardPath(patch.name)}/reassign?all=1`);
        }
        const versions = yield* request(`${cardPath(patch.name)}/versions?all=1`, person);
        assert.strictEqual(versions.status, 200);
        const history = yield* versions.text;
        for (const version of [5, 4, 3, 2, 1])
          assert.match(history, new RegExp(`>\\s*v${version}\\s*<`));
        assert.include(text(history), "Priya");
        if (person === workspace.member)
          assert.isFalse(forms(history).some((path) => path.includes("/rollback")));
        else assert.include(forms(history), `${cardPath(patch.name)}/rollback?all=1`);
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
          assert.include(text(html), state === "retired" ? "Retired by Sam" : "Deleted by Sam");
          assert.include(
            text(html),
            state === "retired" ? "Off the shelf" : "Gone for good in 28 days"
          );
          assert.isFalse(links(html).some((link) => link.text === "Open"));
          assert.notInclude(html, `${cardPath(patch.name)}/scope`);
          assert.notInclude(html, `${cardPath(patch.name)}/rollback`);
          assert.notInclude(html, `${cardPath(patch.name)}/retire`);
          const controls = forms(html).filter((path) => path.startsWith(cardPath(patch.name)));
          if (person === workspace.member) {
            assert.deepStrictEqual(controls, []);
            assert.deepStrictEqual(
              [...html.matchAll(/<dt>(.*?)<\/dt>/g)].map((match) => text(match[1]!)),
              ["State"]
            );
          } else {
            assert.include(controls, `${cardPath(patch.name)}/restore`);
            assert.strictEqual(hidden(html, "expectedState"), state);
            if (state === "retired") {
              assert.include(controls, `${cardPath(patch.name)}/description`);
              assert.include(html, `${cardPath(patch.name)}/delete`);
            } else assert.notInclude(html, `${cardPath(patch.name)}/description`);
          }
          if (person === workspace.admin) assert.include(html, `${cardPath(patch.name)}/reassign`);
        }
      }
    })
  );

  it.effect("distinguishes an empty company from a company with only off patches", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const empty = yield* request("/", workspace.owner);
      assert.strictEqual(empty.status, 200);
      const emptyHtml = yield* empty.text;
      assert.include(text(emptyHtml), "No patches yet");
      assert.match(text(emptyHtml), /publish/i);
      const patch = yield* publish(workspace.owner, "shelved-tool");
      yield* (yield* Patches.Patches).retire(patch.patchId, actor(workspace.owner));
      const offOnly = yield* (yield* request("/", workspace.owner)).text;
      assert.notInclude(text(offOnly), "No patches yet");
      assert.include(text(offOnly), "Show retired and deleted");
      assert.deepStrictEqual(cardLinks(offOnly), []);
      const all = yield* (yield* request("/?all=1", workspace.owner)).text;
      assert.include(text(all), "Retired and deleted");
      assert.include(
        cardLinks(all).map((link) => link.href),
        `${cardPath(patch.name)}?all=1`
      );
    })
  );

  it.effect(
    "groups sorted live and off rows, selects Yours first, and marks deactivated owners",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        yield* publish(workspace.owner, "zulu-mine");
        yield* publish(workspace.admin, "bravo-company");
        yield* publish(workspace.owner, "alpha-mine");
        yield* publish(workspace.admin, "charlie-deactivated");
        const retired = yield* publish(workspace.owner, "delta-retired");
        const deleted = yield* publish(workspace.admin, "echo-deleted");
        yield* service.retire(retired.patchId, actor(workspace.owner));
        yield* service.delete(deleted.patchId, actor(workspace.admin));
        yield* TestClock.adjust(3 * DAY);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${workspace.admin.id}`;
        const live = yield* (yield* request("/", workspace.owner)).text;
        assert.strictEqual(heading(live), "alpha-mine");
        assert.deepStrictEqual(
          cardLinks(live).map((link) => link.href),
          [
            "/patches/alpha-mine",
            "/patches/zulu-mine",
            "/patches/bravo-company",
            "/patches/charlie-deactivated"
          ]
        );
        assert.include(text(live), "Yours");
        assert.include(text(live), "Company");
        const all = yield* (yield* request("/?all=1", workspace.owner)).text;
        assert.deepStrictEqual(
          cardLinks(all).map((link) => link.href),
          [
            "/patches/alpha-mine?all=1",
            "/patches/zulu-mine?all=1",
            "/patches/bravo-company?all=1",
            "/patches/charlie-deactivated?all=1",
            "/patches/delta-retired?all=1",
            "/patches/echo-deleted?all=1"
          ]
        );
        assert.include(
          cardLinks(all).find((link) => link.href.includes("delta-retired"))!.text,
          "retired"
        );
        assert.include(
          cardLinks(all).find((link) => link.href.includes("echo-deleted"))!.text,
          "deleted"
        );
        assert.include(
          cardLinks(all).find((link) => link.href.includes("echo-deleted"))!.text,
          "gone in 27 days"
        );
        assert.include(
          cardLinks(all).find((link) => link.href.includes("charlie-deactivated"))!.text,
          "owner deactivated"
        );
        assert.strictEqual(
          heading(yield* (yield* request("/", workspace.member)).text),
          "alpha-mine"
        );
        const inactive = yield* (yield* request("/patches/charlie-deactivated", workspace.owner))
          .text;
        assert.include(text(inactive), "Sam (deactivated)");
        yield* sql`UPDATE users SET role = 'admin' WHERE id = ${workspace.owner.id}`;
        const managed = yield* (yield* request("/patches/charlie-deactivated", workspace.owner))
          .text;
        assert.include(text(managed), "Nobody can publish to this patch");
      })
  );

  it.effect("shows only a distinct secondary title and cuts only index descriptions", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      for (const [name, title, shown] of [
        ["distinct-title", "A different headline", true],
        ["literal-title", "literal-title", false],
        ["office-map", "Office Map", false],
        ["empty-title", "", false]
      ] as const) {
        const patch = yield* publish(workspace.owner, name, { title });
        const html = yield* (yield* request(cardPath(patch.name), workspace.owner)).text;
        assert.strictEqual(heading(html), name);
        const secondary = text(html.split(/<\/h1>/)[1] ?? "")
          .split("Find the right person.")[0]!
          .trim();
        assert.strictEqual(secondary, shown ? title : "");
      }
      for (const [name, description, first] of [
        ["period-cut", "Find a desk. Keep the second sentence on the card.", "Find a desk"],
        ["semicolon-cut", "Choose lunch; keep this detail on the card.", "Choose lunch"],
        ["dash-cut", "Book a room – keep this detail on the card.", "Book a room"],
        ["earliest-cut", "Plan the day; next clause. Last clause – still later", "Plan the day"],
        ["length-cut", "a".repeat(81), `${"a".repeat(79)}…`]
      ] as const) {
        const patch = yield* publish(workspace.owner, name, { description });
        const html = yield* (yield* request(cardPath(patch.name), workspace.owner)).text;
        const line = cardLinks(html).find((link) => link.href === cardPath(name))!.text;
        assert.include(line, first);
        assert.notInclude(line, description);
        assert.include(text(html.split(/<\/h1>/)[1] ?? ""), description);
      }
      const blank = yield* publish(workspace.owner, "blank-description", { description: "" });
      const html = yield* (yield* request(cardPath(blank.name), workspace.member)).text;
      assert.include(text(html), "No description");
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
      const response = yield* post(`${cardPath(patch.name)}/description?all=1`, workspace.owner, {
        description: "  Find\n a desk <quickly>  ",
        expectedDescriptionUpdatedAt: before.patch.descriptionUpdatedAt ?? ""
      });
      assert.strictEqual(response.status, 303);
      assert.strictEqual(response.headers.location, `${cardPath(patch.name)}?all=1`);
      const saved = yield* readPatch(workspace.owner, patch.patchId);
      assert.strictEqual(saved.patch.description, "Find a desk <quickly>");
      assert.strictEqual(saved.currentVersion, 1);
      assert.strictEqual(saved.patch.descriptionUpdatedBy, workspace.owner.id);
      const html = yield* (yield* request(response.headers.location!, workspace.owner)).text;
      assert.include(html, "Find a desk &lt;quickly&gt;");
      const noop = yield* post(`${cardPath(patch.name)}/description`, workspace.owner, {
        description: "Find a desk <quickly>",
        expectedDescriptionUpdatedAt: saved.patch.descriptionUpdatedAt ?? ""
      });
      assert.strictEqual(noop.status, 303);
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), saved);
    })
  );

  it.effect("changes who can open a patch without publishing a version", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "scope-save");
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const response = yield* post(`${cardPath(patch.name)}/scope?all=1`, workspace.admin, {
        scope: "public",
        expectedScope: "company"
      });
      assert.strictEqual(response.status, 303);
      assert.strictEqual(response.headers.location, `${cardPath(patch.name)}?all=1`);
      const saved = yield* readPatch(workspace.owner, patch.patchId);
      assert.strictEqual(saved.patch.scope, "public");
      assert.strictEqual(saved.patch.currentVersionId, before.patch.currentVersionId);
      assert.strictEqual(saved.patch.description, before.patch.description);
      assert.include(
        text(yield* (yield* request(cardPath(patch.name), workspace.member)).text),
        "Anyone on the internet. No sign-in."
      );
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
        const response = yield* post(`${cardPath(patch.name)}/rollback?all=1`, workspace.owner, {
          versionNumber: "1",
          expectedCurrentVersionId: before.patch.currentVersionId ?? ""
        });
        assert.strictEqual(response.status, 303);
        assert.strictEqual(response.headers.location, `${cardPath(patch.name)}?all=1`);
        const saved = yield* readPatch(workspace.owner, patch.patchId);
        assert.strictEqual(saved.currentVersion, 1);
        assert.strictEqual(saved.patch.currentVersionId, patch.versionId);
        assert.strictEqual(saved.patch.description, before.patch.description);
        assert.strictEqual(saved.patch.descriptionUpdatedAt, before.patch.descriptionUpdatedAt);
        assert.deepStrictEqual(saved.inventory, before.inventory);
      })
  );

  it.effect("restores retired and deleted patches at the same address", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      for (const state of ["retired", "deleted"] as const) {
        const patch = yield* publish(workspace.owner, `restore-${state}`);
        if (state === "retired") yield* service.retire(patch.patchId, actor(workspace.owner));
        else yield* service.delete(patch.patchId, actor(workspace.owner));
        const before = yield* readPatch(workspace.owner, patch.patchId);
        const response = yield* post(`${cardPath(patch.name)}/restore?all=1`, workspace.admin, {
          expectedState: state
        });
        assert.strictEqual(response.status, 303);
        assert.strictEqual(response.headers.location, `${cardPath(patch.name)}?all=1`);
        const saved = yield* readPatch(workspace.owner, patch.patchId);
        assert.strictEqual(saved.patch.state, "live");
        assert.strictEqual(saved.patch.name, patch.name);
        assert.strictEqual(saved.patch.currentVersionId, before.patch.currentVersionId);
        assert.strictEqual(saved.patch.description, before.patch.description);
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
          fields = { scope: "company", expectedScope: "company" };
          yield* service.setScope(patch.patchId, actor(workspace.admin), "public");
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
        const response = yield* post(
          `${cardPath(patch.name)}/${action}?all=1`,
          workspace.owner,
          fields
        );
        assert.strictEqual(response.status, 409);
        const html = yield* response.text;
        assert.strictEqual(heading(html), patch.name);
        assertStale(html, changed);
        const expectedName = {
          description: "expectedDescriptionUpdatedAt",
          scope: "expectedScope",
          rollback: "expectedCurrentVersionId",
          restore: "expectedState"
        }[action];
        const expectedValue = {
          description: before.patch.descriptionUpdatedAt ?? "",
          scope: before.patch.scope,
          rollback: before.patch.currentVersionId ?? "",
          restore: before.patch.state
        }[action];
        assert.strictEqual(hidden(html, expectedName), expectedValue);
        assert.include(forms(html), `${cardPath(patch.name)}/${action}?all=1`);
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
      const response = yield* post(`${cardPath(patch.name)}/restore`, workspace.owner, {
        expectedState: hidden(form, "expectedState")!
      });
      assert.strictEqual(response.status, 409);
      assertStale(yield* response.text, "restored");
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
    })
  );

  it.effect("refuses every member action before stale checks and keeps the card read-only", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const patch = yield* publish(workspace.owner, "member-refused");
      for (const [action, fields] of [
        ["description", { description: "Intrusion", expectedDescriptionUpdatedAt: "" }],
        ["scope", { scope: "public", expectedScope: "public" }],
        ["rollback", { versionNumber: "999", expectedCurrentVersionId: "stale" }],
        ["restore", { expectedState: "deleted" }]
      ] as const) {
        if (action === "restore") yield* service.retire(patch.patchId, actor(workspace.owner));
        const before = yield* readPatch(workspace.owner, patch.patchId);
        const response = yield* post(`${cardPath(patch.name)}/${action}`, workspace.member, fields);
        assert.strictEqual(response.status, 403);
        const html = yield* response.text;
        assert.strictEqual(heading(html), patch.name);
        assert.include(text(html), "Only the owner or an admin can do that. Nothing was done.");
        assert.isFalse(forms(html).some((path) => path.startsWith(cardPath(patch.name))));
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
      }
    })
  );

  it.effect(
    "redisplays an invalid submitted description safely and accepts the Unicode bound",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const patch = yield* publish(workspace.owner, "description-invalid");
        const before = yield* readPatch(workspace.owner, patch.patchId);
        const invalid = `<script>${"x".repeat(501)}</script>`;
        const response = yield* post(`${cardPath(patch.name)}/description`, workspace.owner, {
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
          /<textarea\b[^>]*aria-describedby="description-hint description-error"[^>]*aria-invalid="true"/
        );
        assert.match(html, /<p\b[^>]*id="description-error"[^>]*>[^<]*500[^<]*<\/p>/);
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
        const valid = "\u{10400}".repeat(500);
        assert.strictEqual(
          (yield* post(`${cardPath(patch.name)}/description`, workspace.owner, {
            description: valid,
            expectedDescriptionUpdatedAt: patch.descriptionUpdatedAt ?? ""
          })).status,
          303
        );
        assert.strictEqual(
          (yield* readPatch(workspace.owner, patch.patchId)).patch.description,
          valid
        );
      })
  );

  it.effect("rejects a rollback version outside PostgreSQL's integer range on the card", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "rollback-invalid");
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const response = yield* post(`${cardPath(patch.name)}/rollback`, workspace.owner, {
        versionNumber: "2147483648",
        expectedCurrentVersionId: patch.versionId
      });
      assert.strictEqual(response.status, 422);
      const html = yield* response.text;
      assert.include(
        links(html).map((link) => link.href),
        "/company"
      );
      assert.strictEqual(heading(html), patch.name);
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
    })
  );

  it.effect("refuses scope and rollback on an off card without drawing those forms", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const patch = yield* publish(workspace.owner, "retired-act");
      yield* service.retire(patch.patchId, actor(workspace.admin));
      yield* service.setDescription(patch.patchId, actor(workspace.admin), "Edited after retire");
      const before = yield* readPatch(workspace.owner, patch.patchId);
      for (const [action, fields] of [
        ["scope", { scope: "public", expectedScope: "company" }],
        ["rollback", { versionNumber: "1", expectedCurrentVersionId: patch.versionId }]
      ] as const) {
        const response = yield* post(`${cardPath(patch.name)}/${action}`, workspace.owner, fields);
        assert.strictEqual(response.status, 409);
        const html = yield* response.text;
        assert.strictEqual(heading(html), patch.name);
        assert.notInclude(html, `${cardPath(patch.name)}/${action}`);
        const notice = text(
          html.match(/<div\b[^>]*role="alert"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ""
        );
        assert.include(notice, "description changed by Sam");
        assert.match(notice, /\bretired\b/);
        assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
      }
    })
  );

  it.effect("sends an inline restore with newly off sources to a separate warning page", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const sources = [];
      for (const state of ["retired", "deleted", "gone", "older"] as const) {
        sources.push(
          yield* publish(workspace.owner, `source-${state}`, {
            filename: null,
            manifest: {
              ...manifest,
              name: `source-${state}`,
              tier: 1,
              tables: {
                notes: {
                  description: "Notes keyed by id",
                  columns: { body: { kind: "text" } },
                  indexes: {},
                  shared: true
                }
              }
            }
          })
        );
      }
      const [retired, deleted, gone, older] = sources;
      const declaration = (patchId: string) => ({
        kind: "sharedTable" as const,
        patchId,
        table: "notes",
        id: sharedTableId(patchId, "notes"),
        revision: 1
      });
      const consumer = yield* publish(workspace.owner, "reads-sources", {
        manifest: {
          ...manifest,
          name: "reads-sources",
          uses: { older: declaration(older!.patchId) }
        }
      });
      yield* publish(workspace.owner, consumer.name, {
        intent: "update",
        patchId: consumer.patchId,
        manifest: {
          ...manifest,
          name: consumer.name,
          uses: {
            retired: declaration(retired!.patchId),
            deleted: declaration(deleted!.patchId),
            gone: declaration(gone!.patchId)
          }
        }
      });
      yield* service.retire(consumer.patchId, actor(workspace.owner));
      const drawn = yield* (yield* request(`${cardPath(consumer.name)}?all=1`, workspace.owner))
        .text;
      assert.include(forms(drawn), `${cardPath(consumer.name)}/restore?all=1`);
      yield* service.retire(retired!.patchId, actor(workspace.owner));
      yield* service.retire(older!.patchId, actor(workspace.owner));
      yield* service.delete(deleted!.patchId, actor(workspace.owner));
      yield* service.delete(gone!.patchId, actor(workspace.owner));
      yield* TestClock.adjust(30 * DAY);
      yield* service.purgeDeleted(gone!.patchId);
      const before = yield* readPatch(workspace.owner, consumer.patchId);
      const response = yield* post(`${cardPath(consumer.name)}/restore?all=1`, workspace.owner, {
        expectedState: "retired"
      });
      assert.strictEqual(response.status, 409);
      const html = yield* response.text;
      assert.notStrictEqual(heading(html), consumer.name);
      assert.include(text(html), retired!.name);
      assert.include(text(html), deleted!.name);
      assert.include(text(html), gone!.patchId);
      for (const state of ["retired", "deleted", "gone"]) assert.include(text(html), state);
      assert.include(text(html), "notes");
      assert.notInclude(html, older!.name);
      assert.include(
        links(html).map((link) => link.href),
        `${cardPath(consumer.name)}/restore?all=1`
      );
      assert.isFalse(forms(html).some((path) => path.includes("/restore")));
      assert.deepStrictEqual(yield* readPatch(workspace.owner, consumer.patchId), before);
      const fresh = yield* (yield* request(`${cardPath(consumer.name)}?all=1`, workspace.owner))
        .text;
      assert.notInclude(forms(fresh), `${cardPath(consumer.name)}/restore?all=1`);
      assert.include(
        links(fresh).map((link) => link.href),
        `${cardPath(consumer.name)}/restore?all=1`
      );
    })
  );

  it.effect("requires a browser session and same-origin forms before making any change", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "guarded-tool");
      for (const path of ["/", cardPath(patch.name), `${cardPath(patch.name)}/versions`]) {
        const response = yield* request(path, null, undefined, {
          authorization: "Bearer patchy-dev-token"
        });
        assert.strictEqual(response.status, 401);
        assert.include(text(yield* response.text), "Sign in");
      }
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const fields = {
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

  it.effect("keeps deferred action pages in the signed-in app shell", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "deferred-pages");
      for (const action of ["retire", "delete", "restore", "reassign"]) {
        const response = yield* request(`${cardPath(patch.name)}/${action}`, workspace.owner);
        assert.strictEqual(response.status, 404);
        assert.include(
          links(yield* response.text).map((link) => link.href),
          "/company"
        );
      }
      assert.strictEqual(
        (yield* request(`${cardPath("a".repeat(33))}/retire`, workspace.owner)).status,
        414
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
          scope: "public",
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
          for (const suffix of ["", "/versions"]) {
            const response = yield* request(`${cardPath(name)}${suffix}`, workspace.member);
            assert.strictEqual(response.status, 404);
            const html = yield* response.text;
            assert.include(
              links(html).map((link) => link.href),
              "/company"
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
        for (const suffix of ["", "/versions"]) {
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
      })
  );
});
