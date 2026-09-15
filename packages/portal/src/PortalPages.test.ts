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
const publishSource = Effect.fn("PortalPagesTest.publishSource")(function* (
  person: Person,
  name: string
) {
  return yield* publish(person, name, {
    filename: null,
    manifest: {
      ...manifest,
      name,
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
  });
});
const sourceDeclaration = (patchId: string) => ({
  kind: "sharedTable" as const,
  patchId,
  table: "notes",
  id: sharedTableId(patchId, "notes"),
  revision: 1
});
const publishDependant = Effect.fn("PortalPagesTest.publishDependant")(function* (
  person: Person,
  name: string,
  sourceId: string
) {
  return yield* publish(person, name, {
    manifest: { ...manifest, name, uses: { source: sourceDeclaration(sourceId) } }
  });
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
type FormFields = Record<string, string | readonly string[]>;
const request = Effect.fn("PortalPagesTest.request")(function* (
  path: string,
  person: Person | null,
  fields?: FormFields,
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
            new URLSearchParams(
              Object.entries(fields).flatMap(([name, value]) =>
                typeof value === "string" ? [[name, value]] : value.map((item) => [name, item])
              )
            ).toString(),
            "application/x-www-form-urlencoded"
          )
        );
  return yield* client.execute(input.pipe(HttpClientRequest.setHeaders({ cookie, ...headers })));
});
const post = (path: string, person: Person, fields: FormFields) =>
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
const inputs = (html: string, name: string, type: string) =>
  [...html.matchAll(/<input\b[^>]*>/g)]
    .map((match) => match[0])
    .filter(
      (input) =>
        input.includes(`name="${name}"`) &&
        (input.includes(`type="${type}"`) || (type === "text" && !/\btype=/.test(input)))
    );
const radioValues = (html: string) =>
  inputs(html, "user", "radio").map((input) => input.match(/\bvalue="([^"]*)"/)?.[1]);
const inputValues = (html: string, name: string, type: string) =>
  inputs(html, name, type)
    .filter((input) => !/\bdisabled\b/.test(input))
    .map((input) => input.match(/\bvalue="([^"]*)"/)?.[1]);
const userPath = (person: Person, action: "deactivate" | "reactivate") =>
  `/company/users/${person.id}/${action}`;
const readUser = Effect.fn("PortalPagesTest.readUser")(function* (person: Person) {
  const user = yield* (yield* Users.Users).findByClerkId(person.clerkUserId);
  assert.isNotNull(user);
  return user!;
});
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

  for (const action of ["retire", "delete"] as const) {
    it.effect(
      `${action} lets owners and admins confirm without acknowledgement when nothing depends on it`,
      () =>
        Effect.gen(function* () {
          const workspace = yield* company();
          for (const person of [workspace.owner, workspace.admin]) {
            const patch = yield* publish(workspace.owner, `${action}-${person.role}`);
            const path = `${cardPath(patch.name)}/${action}?all=1`;
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
            assert.deepStrictEqual(inputs(html, "ack", "checkbox"), []);
            assert.include(
              links(html).map((link) => link.href),
              `${cardPath(patch.name)}?all=1`
            );
            assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
            const response = yield* post(path, person, {
              expectedState: action === "retire" ? "live" : "not-deleted",
              ...(action === "delete" ? { confirm: patch.name } : {})
            });
            assert.strictEqual(response.status, 303);
            assert.strictEqual(response.headers.location, `${cardPath(patch.name)}?all=1`);
            const saved = yield* readPatch(workspace.owner, patch.patchId);
            assert.strictEqual(saved.patch.state, action === "retire" ? "retired" : "deleted");
            assert.strictEqual(saved.patch.lastChangedBy, person.id);
            assert.strictEqual(
              saved.patch[action === "retire" ? "retiredBy" : "deletedBy"],
              person.id
            );
            assert.strictEqual(saved.patch.currentVersionId, before.patch.currentVersionId);
            const card = yield* (yield* request(`${cardPath(patch.name)}?all=1`, workspace.member))
              .text;
            assert.include(
              text(card),
              `${action === "retire" ? "Retired" : "Deleted"} by ${person.name}`
            );
          }
        })
    );

    it.effect(`${action} recomputes dependants after GET and requires exactly ack=1`, () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const source = yield* publishSource(workspace.owner, `${action}-source`);
        const first = yield* publishDependant(workspace.member, `${action}-first`, source.patchId);
        const path = `${cardPath(source.name)}/${action}?all=1`;
        const page = yield* request(path, workspace.owner);
        assert.strictEqual(page.status, 200);
        const html = yield* page.text;
        assert.include(text(html), first.name);
        assert.include(text(html), workspace.member.name);
        assert.strictEqual(inputs(html, "ack", "checkbox").length, 1);
        const later = yield* publishDependant(workspace.owner, `${action}-later`, source.patchId);
        const before = yield* readPatch(workspace.owner, source.patchId);
        const fields = {
          expectedState: action === "retire" ? "live" : "not-deleted",
          ...(action === "delete" ? { confirm: source.name } : {})
        };
        for (const acknowledgement of [{}, { ack: "on" }]) {
          const refused = yield* post(path, workspace.owner, { ...fields, ...acknowledgement });
          assert.strictEqual(refused.status, 409);
          const fresh = yield* refused.text;
          assert.include(text(fresh), first.name);
          assert.include(text(fresh), later.name);
          assert.include(forms(fresh), path);
          assert.strictEqual(inputs(fresh, "ack", "checkbox").length, 1);
          assert.deepStrictEqual(yield* readPatch(workspace.owner, source.patchId), before);
        }
        const accepted = yield* post(path, workspace.admin, { ...fields, ack: "1" });
        assert.strictEqual(accepted.status, 303);
        assert.strictEqual(accepted.headers.location, `${cardPath(source.name)}?all=1`);
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

    it.effect(`refuses a stale ${action} confirmation with the fresh state and actor`, () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const patch = yield* publish(workspace.owner, `stale-${action}-confirmation`);
        const path = `${cardPath(patch.name)}/${action}?all=1`;
        const page = yield* request(path, workspace.owner);
        assert.strictEqual(page.status, 200);
        const fields = {
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
          const fields = {
            expectedState: hidden(yield* page.text, "expectedState")!,
            confirm: source.name
          };
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
            assert.strictEqual(inputs(html, "ack", "checkbox").length, 1);
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
        const path = `${cardPath(source.name)}/delete?all=1`;
        const page = yield* request(path, workspace.owner);
        assert.strictEqual(page.status, 200);
        const html = yield* page.text;
        assert.notInclude(text(html), dependant.name);
        assert.deepStrictEqual(inputs(html, "ack", "checkbox"), []);
        assert.match(text(html), /30.day/);
        assert.include(text(html), "7 Feb 2026");
        const response = yield* post(path, workspace.owner, {
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
      const path = `${cardPath(patch.name)}/delete?all=1`;
      const response = yield* post(path, workspace.owner, {
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
              yield* post(path, person, fields)
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
            const page = yield* request(`${cardPath(patch.name)}/restore?all=1`, viewer);
            assert.strictEqual(page.status, 303);
            assert.strictEqual(page.headers.location, `${cardPath(patch.name)}?all=1`);
          }
          const response = yield* post(`${cardPath(patch.name)}/restore?all=1`, person, {
            expectedState: state
          });
          assert.strictEqual(response.status, 303);
          assert.strictEqual(response.headers.location, `${cardPath(patch.name)}?all=1`);
          const saved = yield* readPatch(workspace.owner, patch.patchId);
          assert.strictEqual(saved.patch.state, "live");
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
      const redirect = yield* request(`${cardPath(patch.name)}/restore?all=1`, workspace.owner);
      assert.strictEqual(redirect.status, 303);
      assert.strictEqual(redirect.headers.location, `${cardPath(patch.name)}?all=1`);
      const response = yield* post(`${cardPath(patch.name)}/restore`, workspace.owner, {
        expectedState: hidden(form, "expectedState")!
      });
      assert.strictEqual(response.status, 409);
      assertStale(yield* response.text, "restored");
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
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

  it.effect(
    "recomputes current-version off sources for restore GET and POST before acknowledgement",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        const sources = [];
        for (const state of ["retired", "deleted", "gone", "older"] as const)
          sources.push(yield* publishSource(workspace.owner, `source-${state}`));
        const [retired, deleted, gone, older] = sources;
        const consumer = yield* publishDependant(workspace.owner, "reads-sources", older!.patchId);
        yield* publish(workspace.owner, consumer.name, {
          intent: "update",
          patchId: consumer.patchId,
          manifest: {
            ...manifest,
            name: consumer.name,
            uses: {
              retired: sourceDeclaration(retired!.patchId),
              deleted: sourceDeclaration(deleted!.patchId),
              gone: sourceDeclaration(gone!.patchId)
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
        for (const [state, person] of [
          ["retired", workspace.owner],
          ["deleted", workspace.admin]
        ] as const) {
          if (state === "deleted") yield* service.delete(consumer.patchId, actor(workspace.owner));
          const path = `${cardPath(consumer.name)}/restore?all=1`;
          const before = yield* readPatch(workspace.owner, consumer.patchId);
          const refused = yield* post(path, person, { expectedState: state });
          assert.strictEqual(refused.status, 409);
          const refusedHtml = yield* refused.text;
          for (const viewer of [workspace.owner, workspace.admin]) {
            const page = yield* request(path, viewer);
            assert.strictEqual(page.status, 200);
            for (const html of [yield* page.text, refusedHtml]) {
              assert.include(text(html), retired!.name);
              assert.include(text(html), deleted!.name);
              assert.include(text(html), gone!.patchId);
              for (const sourceState of ["retired", "deleted", "gone"])
                assert.include(text(html), sourceState);
              assert.include(text(html), "notes");
              assert.notInclude(html, older!.name);
              assert.include(forms(html), path);
              assert.strictEqual(hidden(html, "expectedState"), state);
              assert.strictEqual(inputs(html, "ack", "checkbox").length, 1);
              assert.include(
                links(html).map((link) => link.href),
                `${cardPath(consumer.name)}?all=1`
              );
            }
          }
          assert.deepStrictEqual(yield* readPatch(workspace.owner, consumer.patchId), before);
          const fresh = yield* (yield* request(`${cardPath(consumer.name)}?all=1`, workspace.owner))
            .text;
          assert.notInclude(forms(fresh), path);
          assert.include(
            links(fresh).map((link) => link.href),
            path
          );
          const restored = yield* post(path, person, { expectedState: state, ack: "1" });
          assert.strictEqual(restored.status, 303);
          assert.strictEqual(restored.headers.location, `${cardPath(consumer.name)}?all=1`);
          const saved = yield* readPatch(workspace.owner, consumer.patchId);
          assert.strictEqual(saved.patch.state, "live");
          assert.strictEqual(saved.patch.lastChangedBy, person.id);
          assert.strictEqual(saved.patch.currentVersionId, before.patch.currentVersionId);
        }
      })
  );

  it.effect(
    "filters reassignment to active company members and redisplays invalid targets without changing ownership",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const foreign = yield* company();
        const users = yield* Users.Users;
        const patch = yield* publish(workspace.owner, "reassign-picker");
        const path = `${cardPath(patch.name)}/reassign`;
        const page = yield* request(`${path}?all=1`, workspace.admin);
        assert.strictEqual(page.status, 200);
        const html = yield* page.text;
        assert.sameMembers(radioValues(html), [
          workspace.owner.id,
          workspace.member.id,
          workspace.admin.id
        ]);
        assert.notInclude(html, foreign.owner.email);
        assert.match(html, /<form\b[^>]*method="get"/i);
        assert.match(html, /<form\b[^>]*method="post"/i);
        assert.strictEqual(inputs(html, "q", "search").length, 1);
        assert.strictEqual(hidden(html, "all"), "1");
        assert.strictEqual(hidden(html, "expectedOwnerUserId"), workspace.owner.id);
        const matching = yield* request(`${path}?q=aLeX&all=1`, workspace.admin);
        assert.strictEqual(matching.status, 200);
        assert.deepStrictEqual(radioValues(yield* matching.text), [workspace.member.id]);
        const emailMatch = yield* request(
          `${path}?q=${encodeURIComponent(workspace.owner.email)}`,
          workspace.admin
        );
        assert.deepStrictEqual(radioValues(yield* emailMatch.text), [workspace.owner.id]);
        const noMatch = yield* request(`${path}?q=nobody-has-this-name&all=1`, workspace.admin);
        assert.strictEqual(noMatch.status, 200);
        const empty = yield* noMatch.text;
        assert.deepStrictEqual(radioValues(empty), []);
        assert.strictEqual(hidden(empty, "q"), "nobody-has-this-name");
        assert.match(empty, /<button\b(?=[^>]*type="submit")(?=[^>]*\bdisabled)[^>]*>/);
        yield* users.deactivate({ companyId: workspace.id, userId: workspace.member.id });
        const before = yield* readPatch(workspace.owner, patch.patchId);
        for (const target of [workspace.member.id, foreign.owner.id, "usr_missing"]) {
          const refused = yield* post(`${path}?q=Alex&all=1`, workspace.admin, {
            expectedOwnerUserId: workspace.owner.id,
            user: target
          });
          assert.strictEqual(refused.status, 409);
          const fresh = yield* refused.text;
          assert.notStrictEqual(heading(fresh), patch.name);
          assert.strictEqual(hidden(fresh, "q"), "");
          assert.sameMembers(radioValues(fresh), [workspace.owner.id, workspace.admin.id]);
          assert.notMatch(fresh, /<button\b[^>]*\bdisabled/);
          assert.include(forms(fresh), `${path}?all=1`);
          assert.include(
            links(fresh).map((link) => link.href),
            `${cardPath(patch.name)}?all=1`
          );
          assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
        }
        const active = yield* request(path, workspace.admin);
        assert.sameMembers(radioValues(yield* active.text), [
          workspace.owner.id,
          workspace.admin.id
        ]);
        const recovered = yield* post(`${path}?all=1`, workspace.admin, {
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

  it.effect(
    "reassigns repeatedly in every lifecycle state and treats the current owner as a stamp-preserving no-op",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const service = yield* Patches.Patches;
        for (const state of ["live", "retired", "deleted"] as const) {
          const patch = yield* publish(workspace.owner, `reassign-${state}`);
          if (state === "retired") yield* service.retire(patch.patchId, actor(workspace.owner));
          if (state === "deleted") yield* service.delete(patch.patchId, actor(workspace.owner));
          const original = yield* readPatch(workspace.owner, patch.patchId);
          const path = `${cardPath(patch.name)}/reassign?all=1`;
          let currentOwner = workspace.owner.id;
          for (const next of [workspace.member, workspace.owner, workspace.admin]) {
            const card = yield* (yield* request(`${cardPath(patch.name)}?all=1`, workspace.admin))
              .text;
            assert.include(
              links(card).map((link) => link.href),
              path
            );
            const page = yield* request(path, workspace.admin);
            assert.strictEqual(page.status, 200);
            const html = yield* page.text;
            assert.strictEqual(hidden(html, "expectedOwnerUserId"), currentOwner);
            assert.include(radioValues(html), next.id);
            yield* TestClock.adjust(1_000);
            const response = yield* post(path, workspace.admin, {
              expectedOwnerUserId: currentOwner,
              user: next.id
            });
            assert.strictEqual(response.status, 303);
            assert.strictEqual(response.headers.location, `${cardPath(patch.name)}?all=1`);
            const saved = yield* readPatch(workspace.owner, patch.patchId);
            assert.strictEqual(saved.owner.id, next.id);
            assert.strictEqual(saved.patch.ownerUserId, next.id);
            assert.strictEqual(saved.patch.reassignedBy, workspace.admin.id);
            assert.strictEqual(saved.patch.lastChangedBy, workspace.admin.id);
            assert.strictEqual(saved.patch.state, state);
            assert.strictEqual(saved.patch.retiredAt, original.patch.retiredAt);
            assert.strictEqual(saved.patch.deletedAt, original.patch.deletedAt);
            assert.strictEqual(saved.patch.purgeAt, original.patch.purgeAt);
            assert.strictEqual(saved.patch.currentVersionId, original.patch.currentVersionId);
            currentOwner = next.id;
          }
          const beforeNoop = yield* readPatch(workspace.owner, patch.patchId);
          yield* TestClock.adjust(DAY);
          const noop = yield* post(path, workspace.admin, {
            expectedOwnerUserId: currentOwner,
            user: currentOwner
          });
          assert.strictEqual(noop.status, 303);
          assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), beforeNoop);
        }
      })
  );

  it.effect("refuses reassignment against an old owner and returns the fresh card and actor", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const patch = yield* publish(workspace.owner, "stale-reassign");
      const path = `${cardPath(patch.name)}/reassign?all=1`;
      const page = yield* request(path, workspace.admin);
      assert.strictEqual(page.status, 200);
      const expectedOwner = hidden(yield* page.text, "expectedOwnerUserId")!;
      yield* service.reassign(patch.patchId, actor(workspace.admin), workspace.member.id);
      yield* TestClock.adjust(2 * 60 * 1_000);
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const response = yield* post(path, workspace.admin, {
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
          for (const suffix of ["", "/versions", "/retire", "/delete", "/restore", "/reassign"]) {
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
        for (const suffix of ["", "/versions", "/retire", "/delete", "/restore", "/reassign"]) {
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
      })
  );
});

it.layer(layer)("user lifecycle pages on a socket", (it) => {
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
        for (const label of ["Keep their patches live", "Retire selected", "Retire all"])
          assert.include(text(html), label);
        assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
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
        assert.strictEqual(response.headers.location, "/company");
        assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);
        assert.strictEqual((yield* readPatch(workspace.admin, source.patchId)).patch.state, "live");
        assert.strictEqual((yield* readPatch(workspace.admin, reader.patchId)).patch.state, "live");
        const card = yield* (yield* request(cardPath(source.name), workspace.member)).text;
        assert.include(text(card), "Priya (deactivated)");
        assert.strictEqual((yield* request("/", workspace.owner)).status, 403);
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
        const preview = yield* post(path, workspace.admin, {
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

        const committed = yield* post(path, workspace.admin, {
          choice: "confirm",
          patch: selection
        });
        assert.strictEqual(committed.status, 303);
        assert.strictEqual(committed.headers.location, "/company");
        assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);
        for (const patchId of selection) {
          const saved = yield* readPatch(workspace.admin, patchId);
          assert.strictEqual(saved.patch.state, "retired");
          assert.strictEqual(saved.patch.retiredBy, workspace.admin.id);
          assert.strictEqual(saved.patch.lastChangedBy, workspace.admin.id);
          const card = yield* (yield* request(cardPath(saved.patch.name), workspace.member)).text;
          assert.include(text(card), "Retired by Sam");
        }
      })
  );

  it.effect(
    "recomputes outside dependants including the same owner before accepting acknowledgement",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const source = yield* publishSource(workspace.owner, "outside-source");
        const own = yield* publishDependant(workspace.owner, "outside-own-reader", source.patchId);
        const path = userPath(workspace.owner, "deactivate");
        const preview = yield* post(path, workspace.admin, {
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
        for (const acknowledgement of [{}, { ack: "on" }]) {
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
      })
  );

  it.effect("refuses foreign, reassigned and retired patches in an exact confirmation", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const first = yield* publish(workspace.owner, "stale-selection-first");
      const second = yield* publish(workspace.owner, "stale-selection-second");
      const path = userPath(workspace.owner, "deactivate");
      const preview = yield* post(path, workspace.admin, { choice: "all" });
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
        for (const label of ["Keep them retired", "Restore selected", "Restore all"])
          assert.include(text(html), label);
        const empty = yield* post(path, workspace.admin, { choice: "selected" });
        assert.strictEqual(empty.status, 422);
        assert.isNotNull((yield* readUser(workspace.owner)).deactivatedAt);

        const preview = yield* post(path, workspace.admin, { choice: "all" });
        assert.strictEqual(preview.status, 200);
        const confirmation = yield* preview.text;
        assert.sameMembers(inputValues(confirmation, "patch", "hidden"), [
          own.patchId,
          admin.patchId
        ]);
        assert.deepStrictEqual(inputs(confirmation, "ack", "checkbox"), []);
        const committed = yield* post(path, workspace.admin, {
          choice: "confirm",
          patch: [own.patchId, admin.patchId]
        });
        assert.strictEqual(committed.status, 303);
        assert.strictEqual(committed.headers.location, "/company");
        assert.isNull((yield* readUser(workspace.owner)).deactivatedAt);
        for (const patch of [own, admin]) {
          const saved = yield* readPatch(workspace.admin, patch.patchId);
          assert.strictEqual(saved.patch.state, "live");
          assert.strictEqual(saved.patch.lastChangedBy, workspace.admin.id);
          const card = yield* (yield* request(cardPath(patch.name), workspace.member)).text;
          assert.notInclude(text(card), "Priya (deactivated)");
        }
        const stillDeleted = yield* readPatch(workspace.admin, deleted.patchId);
        assert.deepStrictEqual(stillDeleted.patch, beforeDeleted.patch);
        assert.isFalse(stillDeleted.owner.deactivated);
        assert.deepStrictEqual(yield* readPatch(workspace.admin, moved.patchId), beforeMoved);
      })
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
      const preview = yield* post(path, workspace.admin, { choice: "selected", patch: selection });
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

  it.effect("warns about current-version off sources and recomputes them before restoring", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const service = yield* Patches.Patches;
      const retired = yield* publishSource(workspace.member, "return-source-retired");
      const deleted = yield* publishSource(workspace.member, "return-source-deleted");
      const gone = yield* publishSource(workspace.member, "return-source-gone");
      const older = yield* publishSource(workspace.member, "return-source-older");
      const live = yield* publishSource(workspace.member, "return-source-live");
      const reader = yield* publishDependant(
        workspace.owner,
        "return-broken-reader",
        older.patchId
      );
      yield* publish(workspace.owner, reader.name, {
        intent: "update",
        patchId: reader.patchId,
        manifest: {
          ...manifest,
          name: reader.name,
          uses: {
            retired: sourceDeclaration(retired.patchId),
            deleted: sourceDeclaration(deleted.patchId),
            gone: sourceDeclaration(gone.patchId),
            live: sourceDeclaration(live.patchId)
          }
        }
      });
      yield* service.retire(reader.patchId, actor(workspace.owner));
      yield* service.retire(retired.patchId, actor(workspace.member));
      yield* service.retire(older.patchId, actor(workspace.member));
      yield* service.delete(deleted.patchId, actor(workspace.member));
      yield* service.delete(gone.patchId, actor(workspace.member));
      yield* TestClock.adjust(30 * DAY);
      yield* service.purgeDeleted(gone.patchId);
      yield* (yield* Users.Users).deactivate({
        companyId: workspace.id,
        userId: workspace.owner.id
      });
      const path = userPath(workspace.owner, "reactivate");
      const preview = yield* post(path, workspace.admin, {
        choice: "selected",
        patch: [reader.patchId]
      });
      assert.strictEqual(preview.status, 200);
      const html = yield* preview.text;
      for (const name of [reader.name, retired.name, deleted.name, gone.patchId])
        assert.include(text(html), name);
      for (const state of ["retired", "deleted", "gone"]) assert.include(text(html), state);
      assert.include(text(html), "notes");
      assert.notInclude(text(html), older.name);
      assert.notInclude(text(html), live.name);
      assert.strictEqual(inputs(html, "ack", "checkbox").length, 1);

      yield* service.retire(live.patchId, actor(workspace.member));
      const refused = yield* post(path, workspace.admin, {
        choice: "confirm",
        patch: [reader.patchId]
      });
      assert.strictEqual(refused.status, 409);
      assert.include(text(yield* refused.text), live.name);
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
        (yield* readPatch(workspace.admin, retired.patchId)).patch.state,
        "retired"
      );
      assert.strictEqual(
        (yield* readPatch(workspace.admin, deleted.patchId)).patch.state,
        "deleted"
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
      })
  );
});

it.layer(services)("user lifecycle transaction failure on a socket", (it) => {
  it.effect("rolls back the user and first retirement when the second retirement fails", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const first = yield* publish(workspace.owner, "atomic-first");
      const second = yield* publish(workspace.owner, "atomic-second");
      const patches = yield* Patches.Patches;
      const beforeUser = yield* readUser(workspace.owner);
      const beforeFirst = yield* readPatch(workspace.admin, first.patchId);
      const beforeSecond = yield* readPatch(workspace.admin, second.patchId);
      let firstRetired: string | undefined;
      let reachedSecondRetirement = false;
      const failSecondRetire = Layer.succeed(Patches.Patches, {
        ...patches,
        retire: Effect.fn("PortalPagesTest.failSecondRetire")(function* (
          patchId: string,
          acting: Patches.Actor,
          force?: boolean
        ) {
          if (firstRetired !== undefined) {
            const rows = yield* patches.read({
              companyId: workspace.id,
              userId: workspace.admin.id,
              canOpen: () => true,
              state: "all",
              patchRef: firstRetired
            });
            assert.strictEqual(rows[0]?.patch.state, "retired");
            reachedSecondRetirement = true;
            return yield* new Patches.PatchUnavailable({ patchId });
          }
          const retired = yield* patches.retire(patchId, acting, force);
          firstRetired = patchId;
          return retired;
        })
      });
      const failingServer = HttpRouter.serve(routes, {
        disableLogger: true,
        disableListenLog: true
      }).pipe(
        Layer.provide(failSecondRetire),
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
      assert.isTrue(reachedSecondRetirement);
      assert.deepStrictEqual(yield* readUser(workspace.owner), beforeUser);
      assert.deepStrictEqual(yield* readPatch(workspace.admin, first.patchId), beforeFirst);
      assert.deepStrictEqual(yield* readPatch(workspace.admin, second.patchId), beforeSecond);
    })
  );
});
