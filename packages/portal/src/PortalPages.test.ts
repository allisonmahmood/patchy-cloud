import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { TestClock } from "effect/testing";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  CURRENT_RELEASE,
  MANIFEST_VERSION,
  WIRE_VERSION,
  sharedTableId,
  sharedStoreId,
  type HandlerDescriptors
} from "@patchy/api";
import { Analytics } from "@patchy/analytics";
import { Limits } from "@patchy/limits";
import { DeviceLogins, MachineTokens, RequireSession, Session, SetupLinks } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { contentHash, sha256 } from "../../../test/crypto.js";
import * as Testing from "@patchy/company-database/testing";
import { ConnectionStore } from "@patchy/integrations";
import { ConnectionStoreDev } from "@patchy/integrations/dev";
import { Patches } from "@patchy/patches";
import { Tables } from "@patchy/primitives";
import * as PortalPages from "./PortalPages.js";
import { InvocationLog, Prewarm, RuntimeLog, Wakes } from "@patchy/runtime";
import { NodeCryptography } from "@patchy/core";

const DAY = 24 * 60 * 60 * 1_000;
const events: Analytics.AnalyticsEvent[] = [];
const recordingAnalytics = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
);
/** The lifecycle events reported about one patch, in order, without its publishes. */
const reported = (patchId: string) =>
  events.filter(
    (event) =>
      event.name !== "patch.created" &&
      event.name !== "patch.updated" &&
      "patchId" in event.properties &&
      event.properties.patchId === patchId
  );
const routes = Layer.merge(
  PortalPages.layer,
  HttpRouter.use((router) => router.add("GET", "/", RequireSession.withViewer(PortalPages.index)))
);
/** A company's user lifecycle events, as `[name, principal, user]`. */
const lifecycleEvents = (companyId: string) =>
  events.flatMap((event) =>
    event.companyId === companyId &&
    (event.name === "user.deactivated" || event.name === "user.reactivated")
      ? [[event.name, event.principalId, event.properties.userId]]
      : []
  );
const services = Layer.mergeAll(
  Patches.layer,
  Session.layer,
  Companies.layer,
  Users.layer,
  InvocationLog.layer,
  MachineTokens.layer,
  Limits.layer
).pipe(
  Layer.provideMerge(recordingAnalytics),
  Layer.provideMerge(
    ConnectionStoreDev.layer([
      {
        connection: {
          id: "con_warehouse",
          companyId: "cmp_portal_log",
          integration: "postgres",
          handle: "warehouse",
          description: "The sales warehouse",
          mode: "company",
          status: "connected",
          display: { host: "db.example.com", port: 5432, database: "sales", role: "reader" },
          credentialRevision: 1,
          metadataRevision: 1,
          lastTestedAt: null,
          lastDiscoveredAt: null,
          createdBy: "usr_portal_log"
        } satisfies ConnectionStore.Connection,
        snapshots: []
      }
    ])
  ),
  Layer.provideMerge(Tables.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(Testing.resourceChangesLayer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv()))),
  Layer.provideMerge(Wakes.layer)
);
const layer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(services),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })),
  Layer.provideMerge(NodeCryptography.layer)
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
const company = Effect.fn("PortalPagesTest.company")(function* (companyId?: string) {
  yield* TestClock.setTime(1_767_225_600_000);
  const sql = yield* SqlClient.SqlClient;
  const id = companyId ?? `cmp_portal_${++counter}`;
  const handle = companyId === undefined ? `portal-${counter}` : `portal-${companyId.slice(11)}`;
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
    contentHash: contentHash(String(ordinal)),
    fileSize: 1,
    filename: "patch.html",
    // Lists and the card show the title; a title equal to the name keeps most cases about the name.
    title: name,
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
  if (input.server) yield* patches.prepareObject(input.server.objectKey);
  return yield* patches.record(input);
});
const publishSource = Effect.fn("PortalPagesTest.publishSource")(function* (
  person: Person,
  name: string,
  kind: "table" | "store" = "table"
) {
  return yield* publish(person, name, {
    filename: null,
    manifest: {
      ...manifest,
      name,
      tier: 1,
      tables:
        kind === "table"
          ? {
              notes: {
                description: "Notes keyed by id",
                columns: { body: { kind: "text" } },
                indexes: {},
                shared: true
              }
            }
          : {},
      files:
        kind === "store"
          ? { photos: { description: "Photos keyed by file name.", shared: true } }
          : {}
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
  sourceId: string,
  kind: "table" | "store" = "table"
) {
  return yield* publish(person, name, {
    manifest: {
      ...manifest,
      name,
      tier: 2,
      uses: {
        source:
          kind === "table"
            ? sourceDeclaration(sourceId)
            : {
                kind: "sharedStore",
                patchId: sourceId,
                store: "photos",
                id: sharedStoreId(sourceId, "photos"),
                revision: 1
              }
      }
    }
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
const sessionCookie = (person: Person, sid = "sess_offline") =>
  signedInCookies(
    signSession({ sub: person.clerkUserId, email: person.email, name: person.name, sid })
  );
/** A confirmation posted without, then with, the acknowledgement box ticked. */
const acknowledgements: ReadonlyArray<FormFields> = [{}, { ack: "on" }];
const request = Effect.fn("PortalPagesTest.request")(function* (
  path: string,
  person: Person | null,
  fields?: FormFields,
  headers: Record<string, string> = {}
) {
  const client = yield* HttpClient.HttpClient;
  const { sid, ...rest } = headers;
  const cookie = person === null ? "" : sessionCookie(person, sid);
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
  return yield* client.execute(input.pipe(HttpClientRequest.setHeaders({ cookie, ...rest })));
});
const post = (path: string, person: Person, fields: FormFields) =>
  request(path, person, fields, { origin: PUBLIC_BASE_URL });
/** The receipt a form's redirect leaves, as the page it lands on shows it, once. */
const receiptAfter = Effect.fn("PortalPagesTest.receiptAfter")(function* (
  response: HttpClientResponse.HttpClientResponse,
  person: Person
) {
  const page = yield* request(response.headers.location!, person, undefined, {
    cookie: `${sessionCookie(person)}; ${Cookies.toCookieHeader(response.cookies)}`
  });
  const html = yield* page.text;
  return text(html.match(/<p class="note note-ok app-receipt"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
});
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
/** The hidden fields of the first POST form on the page that submits to `action`. */
const formFields = (html: string, action: string): FormFields =>
  Object.fromEntries(
    [
      ...(
        html.match(
          new RegExp(
            `<form\\b(?=[^>]*method="post")[^>]*action="${action}"[^>]*>([\\s\\S]*?)</form>`
          )
        )?.[1] ?? ""
      ).matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)
    ].map((match) => [match[1]!, match[2]!])
  );
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
/** The setup line a page shows, as its copy line's text. */
const lineOf = (html: string) =>
  text(html.match(/<code aria-label="Setup line, select to copy">([^<]*)<\/code>/)?.[1] ?? "");
/** The guide's steps as `[state, title]`, in order. */
const steps = (html: string) =>
  [
    ...html.matchAll(
      /<li class="step(?: step-(done|current))?"[^>]*>[\s\S]*?<h2 class="step-title">([\s\S]*?)<\/h2>/g
    )
  ].map((match) => [match[1] ?? "upcoming", text(match[2]!)]);
/** The patch names one kind of Home link points at, in order: `tile-link` (Your usual), `home-tool` (Tools) or `home-page` (Pages). */
const shelf = (html: string, kind: "tile-link" | "home-tool" | "home-page") =>
  [
    ...html.matchAll(
      new RegExp(`<a class="(?:tile-row tile-row-plain )?${kind}" href="/[^/"]+/([a-z0-9-]+)"`, "g")
    )
  ].map((match) => match[1]!);
/** The Pages shelf's names marked new to the viewer. */
const unread = (html: string) =>
  [
    ...html.matchAll(
      /<a class="tile-row tile-row-plain home-page" href="\/[^/"]+\/([a-z0-9-]+)">([\s\S]*?)<\/a>/g
    )
  ]
    .filter((match) => match[2]!.includes("whats-new-dot"))
    .map((match) => match[1]!);
/** The patch titles in All patches' table, in order; fixtures title a patch by its name. */
const listed = (html: string) =>
  [
    ...(html.match(/<tbody>([\s\S]*)<\/tbody>/)?.[1] ?? "").matchAll(
      /<strong>([a-z0-9-]+)<\/strong><\/a>/g
    )
  ].map((match) => match[1]!);
/** The labels in one row's action menu, by its id: a patch's id, on Home after its shelf's. */
const menuItems = (html: string, id: string) =>
  text(html.match(new RegExp(`<div class="menu" id="menu-${id}"[\\s\\S]*?</div>`))?.[0] ?? "");
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
        // The title leads; the name the address uses sits under it.
        assert.strictEqual(heading(html), "A useful office tool");
        assert.include(html, `</h1><p class="supporting-text"><code>${patch.name}</code></p>`);
        assert.include(text(html), "Find the right person. Includes the whole company.");
        assert.include(text(html), "Description edited by Priya");
        assert.include(text(html), "v5");
        assert.include(text(html), "by Priya");
        assert.isTrue(
          links(html).some(
            (link) => link.href === `/${workspace.handle}/${patch.name}` && link.text === "Open"
          )
        );
        assert.include(html, `${PUBLIC_BASE_URL}/${workspace.handle}/${patch.name}`);
        // Overview holds no forms; the tabs say where they are.
        assert.deepStrictEqual(
          forms(html).filter((path) => path.startsWith(cardPath(patch.name))),
          []
        );
        const tabs = links(html)
          .filter((link) => link.href.startsWith(cardPath(patch.name)))
          .map((link) => link.text);
        const settings = yield* request(`${cardPath(patch.name)}/settings`, person);
        if (person === workspace.member) {
          assert.deepStrictEqual(tabs, ["Overview", "Versions 5"]);
          assert.strictEqual(settings.status, 403);
          assert.include(
            text(yield* settings.text),
            "Only the owner or an admin can change this patch's settings."
          );
        } else {
          assert.deepStrictEqual(tabs, ["Overview", "Log", "Versions 5", "Settings"]);
          assert.strictEqual(settings.status, 200);
          const manage = yield* settings.text;
          const controls = forms(manage).filter((path) => path.startsWith(cardPath(patch.name)));
          for (const action of ["description", "scope"])
            assert.include(controls, `${cardPath(patch.name)}/${action}`);
          for (const action of ["retire", "delete"])
            assert.isTrue(
              links(manage).some((link) => link.href === `${cardPath(patch.name)}/${action}`)
            );
          assert.strictEqual(hidden(manage, "expectedScope"), "company");
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
        if (person === workspace.member)
          assert.isFalse(forms(history).some((path) => path.includes("/rollback")));
        else {
          assert.include(forms(history), `${cardPath(patch.name)}/rollback`);
          assert.deepStrictEqual(
            [...history.matchAll(/name="versionNumber"\s+value="(\d+)"/g)].map((match) => match[1]),
            ["4", "3", "2", "1"]
          );
          assert.isDefined(hidden(history, "expectedCurrentVersionId"));
        }
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
            // Restore leads the card; the rest of managing is under Settings.
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

  it.effect("lays Final step over Home until the person connects their agent", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      const fresh = yield* request("/", workspace.owner);
      assert.strictEqual(fresh.status, 200);
      const html = yield* fresh.text;
      // Home is still Home, inert and blurred behind the panel.
      assert.strictEqual(heading(html), "Nothing here yet");
      assert.include(html, '<div class="app" inert>');
      assert.include(
        html,
        '<section class="modal-panel final-step" role="dialog" aria-modal="true" aria-labelledby="final-step-heading" data-guide-modal>'
      );
      assert.include(
        html,
        '<h1 class="page-heading" id="final-step-heading" tabindex="-1">Final step</h1>'
      );
      assert.deepStrictEqual(steps(html), [
        ["current", "Give your agent this line"],
        ["upcoming", "Confirm it’s you"]
      ]);
      // The line carries the person's setup link, kept across reloads.
      const setup = lineOf(html);
      assert.match(
        setup,
        new RegExp(`^Set up Patchy using ${PUBLIC_BASE_URL}/llms\\.txt\\?s=[a-z2-7]{26}$`)
      );
      assert.include(html, `data-copy="${setup}"`);
      assert.strictEqual(lineOf(yield* (yield* request("/", workspace.owner)).text), setup);
      assert.include(html, '<script defer src="/assets/guide.js"></script>');
      assert.include(html, '<form class="final-step-later" method="post" action="/guide/later">');
      // Home's own way back stays while nothing is connected.
      assert.include(html, '<a class="tile-row tile-row-placeholder" href="/guide">');

      // Later is for this sign-in only, and only from this account's page.
      const cross = yield* request("/guide/later", workspace.owner, { user: workspace.owner.id });
      assert.strictEqual(cross.status, 403);
      const stale = yield* post("/guide/later", workspace.owner, { user: workspace.member.id });
      assert.strictEqual(stale.status, 409);
      assert.include(yield* (yield* request("/", workspace.owner)).text, "data-guide-modal");
      const later = yield* post("/guide/later", workspace.owner, { user: workspace.owner.id });
      assert.strictEqual(later.status, 303);
      assert.strictEqual(later.headers.location, "/");
      assert.notInclude(yield* (yield* request("/", workspace.owner)).text, "data-guide-modal");
      const next = yield* (yield* request("/", workspace.owner, undefined, { sid: "sess_2" })).text;
      assert.include(next, "data-guide-modal");

      // Someone with a live machine token sees Home alone, without the way back.
      const member = yield* (yield* request("/", workspace.member)).text;
      assert.notInclude(member, "data-guide-modal");
      assert.notInclude(member, '<div class="app" inert>');
      assert.notInclude(member, 'class="tile-row tile-row-placeholder"');
    })
  );

  it.effect(
    "shows the panel for the first week or the first three sign-ins, whichever is longer",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE machine_tokens SET revoked_at = now()
        WHERE user_id IN (${workspace.owner.id}, ${workspace.member.id})`;
        yield* sql`UPDATE users SET created_at = now() - interval '8 days'
        WHERE id IN (${workspace.owner.id}, ${workspace.member.id})`;
        const shown = (person: Person, sid: string) =>
          request("/", person, undefined, { sid }).pipe(
            Effect.flatMap((response) => response.text),
            Effect.map((html) => html.includes("data-guide-modal"))
          );
        assert.deepStrictEqual(
          [
            yield* shown(workspace.owner, "s1"),
            yield* shown(workspace.owner, "s2"),
            yield* shown(workspace.owner, "s3"),
            yield* shown(workspace.owner, "s4"),
            yield* shown(workspace.owner, "s1"),
            yield* shown(workspace.owner, "s5")
          ],
          [true, true, true, false, true, false]
        );
        // Inside the first week every sign-in shows it, a fifth included, and Later sticks for the
        // sign-in that pressed it alone.
        yield* sql`UPDATE users SET created_at = now() WHERE id = ${workspace.owner.id}`;
        assert.isTrue(yield* shown(workspace.owner, "s6"));
        const later = yield* request(
          "/guide/later",
          workspace.owner,
          { user: workspace.owner.id },
          { origin: PUBLIC_BASE_URL, sid: "s6" }
        );
        assert.strictEqual(later.status, 303);
        assert.isFalse(yield* shown(workspace.owner, "s6"));
        assert.isTrue(yield* shown(workspace.owner, "s7"));
        // A connected person's sign-ins count too, so revoking every key later never reopens it.
        yield* sql`UPDATE machine_tokens SET revoked_at = NULL WHERE user_id = ${workspace.member.id}`;
        for (const sid of ["m1", "m2", "m3", "m4"]) yield* shown(workspace.member, sid);
        yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.member.id}`;
        assert.isFalse(yield* shown(workspace.member, "m5"));
      })
  );

  it.effect("counts two new sign-ins arriving at once as two, not both third", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      yield* sql`UPDATE users SET created_at = now() - interval '8 days' WHERE id = ${workspace.owner.id}`;
      const shown = (sid: string) =>
        request("/", workspace.owner, undefined, { sid }).pipe(
          Effect.flatMap((response) => response.text),
          Effect.map((html) => html.includes("data-guide-modal"))
        );
      yield* shown("c1");
      yield* shown("c2");
      const both = yield* Effect.all([shown("c3"), shown("c4")], { concurrency: 2 });
      assert.sameMembers(both, [true, false]);
    })
  );

  it.effect("follows a person's setup on /guide and /guide/steps from Patchy's records", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      const page = yield* (yield* request("/guide", workspace.owner)).text;
      assert.strictEqual(heading(page), "Final step");
      assert.notInclude(page, "data-guide-modal");
      assert.notInclude(page, "/guide/later");
      const state = (html: string) => html.match(/data-state="([a-z]+)"/)?.[1];
      assert.strictEqual(
        state(yield* (yield* request("/guide/steps", workspace.owner)).text),
        "waiting"
      );

      // Connected: /guide sends them Home, and the steps say they're set. The key was made just
      // before the test clock's now, so what the member publishes next counts as since then.
      yield* sql`UPDATE machine_tokens SET created_at = to_timestamp(${1_767_225_600 - 3600})
        WHERE user_id = ${workspace.member.id}`;
      const guide = yield* request("/guide", workspace.member);
      assert.strictEqual(guide.status, 303);
      assert.strictEqual(guide.headers.location, "/");
      const connected = yield* (yield* request("/guide/steps", workspace.member)).text;
      assert.strictEqual(state(connected), "connected");
      assert.include(text(connected), "You’re set");
      assert.deepStrictEqual(steps(connected), [
        ["done", "Give your agent this line"],
        ["done", "Confirm it’s you"]
      ]);

      // The first publication after connecting is the live note, a welcome page by its name.
      yield* publish(workspace.member, "welcome");
      const live = yield* (yield* request("/guide/steps", workspace.member)).text;
      assert.strictEqual(state(live), "live");
      assert.include(text(live), "Your welcome page is live");
      const watch = yield* (yield* request("/guide/steps?mode=watch", workspace.member)).text;
      assert.strictEqual(state(watch), "live");
      assert.notInclude(watch, 'class="steps"');
      // Home's watch puts in Home's one-line note, not the panel's.
      assert.include(watch, 'class="note note-ok note-inline"');
      assert.include(text(watch), "Your welcome page is live");
    })
  );

  it.effect("follows the setup line's link through the agent's fetch, login and key", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      const value = lineOf(yield* (yield* request("/", workspace.owner)).text).split("?s=")[1]!;
      assert.lengthOf(
        events.filter(
          (event) => event.name === "setup.line_shown" && event.principalId === workspace.owner.id
        ),
        1
      );
      const state = Effect.gen(function* () {
        const html = yield* (yield* request("/guide/steps", workspace.owner)).text;
        return [html.match(/data-state="([a-z_-]+)"/)?.[1], text(html)] as const;
      });
      assert.strictEqual((yield* state)[0], "waiting");
      yield* SetupLinks.pickUp(value);
      const [picked, pickedText] = yield* state;
      assert.strictEqual(picked, "picked_up");
      assert.include(pickedText, "Your agent opened the line.");
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "laptop", setupLink: value });
      const [pending, pendingText] = yield* state;
      assert.strictEqual(pending, "login_pending");
      // The login's own confirmation, right in the panel, still asking for the code check.
      assert.include(pendingText, "A computer wants to publish as you");
      assert.include(pendingText, `Does your agent show ${login.userCode} ?`);
      const fragment = yield* request("/guide/steps", workspace.owner);
      // The fragment carries a confirmation, so nothing may frame it, and the script reloads
      // rather than swap in a fragment for whichever account signed in since.
      assert.include(fragment.headers["content-security-policy"] ?? "", "frame-ancestors 'none'");
      const form = yield* fragment.text;
      assert.include(form, `data-viewer="${workspace.owner.id}"`);
      assert.include(form, `<input type="hidden" name="setup" value="${value}">`);
      // Not me answers even when the name was cleared.
      assert.include(
        form,
        '<button class="btn" type="submit" name="action" value="deny" formnovalidate>Not me</button>'
      );
      yield* logins.confirm({
        userCode: login.userCode,
        userId: workspace.owner.id,
        machineName: "Laptop"
      });
      assert.strictEqual((yield* state)[0], "confirming");
      yield* logins.poll(login.deviceCode);
      assert.strictEqual((yield* state)[0], "connected");

      // A second login with a fresh line contests it; Get a new line starts over.
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.admin.id}`;
      const first = lineOf(yield* (yield* request("/guide", workspace.admin)).text);
      const link = first.split("?s=")[1]!;
      yield* logins.start({ machineNameHint: "laptop", setupLink: link });
      yield* logins.start({ machineNameHint: "elsewhere", setupLink: link });
      const contested = yield* (yield* request("/guide/steps", workspace.admin)).text;
      assert.include(contested, 'data-state="fallback-contested"');
      assert.include(text(contested), "Two computers used this line");
      assert.strictEqual(
        (yield* request("/guide/new-line", workspace.admin, { user: workspace.admin.id })).status,
        403
      );
      assert.strictEqual(
        (yield* post("/guide/new-line", workspace.admin, { user: workspace.owner.id })).status,
        409
      );
      const renewed = yield* post("/guide/new-line", workspace.admin, { user: workspace.admin.id });
      assert.strictEqual(renewed.status, 303);
      assert.strictEqual(renewed.headers.location, "/guide");
      const next = lineOf(yield* (yield* request("/guide", workspace.admin)).text);
      assert.notStrictEqual(next, first);
      assert.include(
        yield* (yield* request("/guide/steps", workspace.admin)).text,
        'data-state="waiting"'
      );

      // A login left unanswered shows as expired once it runs out, with no poll or start after.
      yield* logins.start({ machineNameHint: "laptop", setupLink: next.split("?s=")[1]! });
      assert.include(
        yield* (yield* request("/guide/steps", workspace.admin)).text,
        'data-state="login_pending"'
      );
      yield* TestClock.adjust("11 minutes");
      assert.include(
        yield* (yield* request("/guide/steps", workspace.admin)).text,
        'data-state="fallback-expired"'
      );
    }).pipe(Effect.provide(DeviceLogins.layer))
  );

  it.effect("names the first patch on Home for a day, in one line", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      yield* publish(workspace.admin, "crm");
      const mine = yield* publish(workspace.member, "lead-tracker", { title: "Lead <tracker>" });
      const shipped = yield* (yield* request("/", workspace.member)).text;
      assert.include(shipped, "Lead &lt;tracker&gt; is live");
      assert.notInclude(text(shipped), "Your first patch is live");
      assert.isTrue(
        links(shipped).some(
          (link) => link.href === `/${workspace.handle}/lead-tracker` && link.text === "Open"
        )
      );
      assert.include(shipped, 'aria-label="Copy link to Lead &lt;tracker&gt;"');
      assert.notInclude(
        text(yield* (yield* request(cardPath(mine.name), workspace.member)).text),
        "is live"
      );
      yield* TestClock.adjust(DAY);
      assert.notInclude(text(yield* (yield* request("/", workspace.member)).text), "is live");
    })
  );

  it.effect("tells an owner whose only patches are off that nothing is live", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "shelved-tool");
      yield* (yield* Patches.Patches).retire(patch.patchId, actor(workspace.owner));
      const offOnly = yield* (yield* request("/", workspace.owner)).text;
      assert.strictEqual(heading(offOnly), "Nothing is live");
      assert.isTrue(links(offOnly).some((link) => link.href === "/patches?show=off"));
      assert.deepStrictEqual(shelf(offOnly, "tile-link"), []);
      // A colleague who owns nothing sees the same, with the way to what is off.
      const member = yield* (yield* request("/", workspace.member)).text;
      assert.strictEqual(heading(member), "Nothing is live");
      assert.isTrue(links(member).some((link) => link.href === "/patches?show=off"));
    })
  );

  it.effect("serves the copy script that reveals copy buttons", () =>
    Effect.gen(function* () {
      const response = yield* request("/assets/copy.js", null);
      assert.strictEqual(response.status, 200);
      assert.include(response.headers["content-type"] ?? "", "text/javascript");
      assert.include(yield* response.text, "button[data-copy]");
    })
  );

  it.effect("fills Your usual from the viewer's own opens of the last 30 days alone", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const alpha = yield* publish(workspace.admin, "alpha");
      const bravo = yield* publish(workspace.admin, "bravo");
      const charlie = yield* publish(workspace.admin, "charlie");
      const delta = yield* publish(workspace.admin, "delta");
      const echo = yield* publish(workspace.admin, "echo");
      for (let visit = 0; visit < 3; visit++) yield* patches.recordVisit(echo.patchId);
      yield* patches.recordVisit(delta.patchId);
      const open = (person: Person, patch: Patches.Recorded, times = 1) =>
        Effect.forEach(Array.from({ length: times }), () =>
          patches.recordOpen(person.id, patch.patchId, patch.versionId)
        );

      // No opens: the company's most visited, by name after visits.
      const popular = yield* (yield* request("/", workspace.member)).text;
      assert.strictEqual(heading(popular), "Home");
      assert.include(text(popular), "Popular at Northwind");
      assert.deepStrictEqual(shelf(popular, "tile-link"), ["echo", "delta", "alpha", "bravo"]);

      // Opened 31 days ago, it has left; once they open anything, the company's picks give way.
      yield* open(workspace.member, charlie, 5);
      yield* TestClock.adjust(31 * DAY);
      yield* open(workspace.member, bravo);
      // Another member's opens never move this one's shelf.
      yield* open(workspace.owner, alpha, 9);
      const usual = yield* (yield* request("/", workspace.member)).text;
      assert.include(text(usual), "Your usual");
      assert.deepStrictEqual(shelf(usual, "tile-link"), ["bravo"]);
      assert.notInclude(text(usual), "Popular at Northwind");
      assert.notInclude(text(usual), "Opened");

      // A rename keeps the opens; retiring takes the patch off every shelf.
      yield* publish(workspace.admin, "bravo-two", { intent: "update", patchId: bravo.patchId });
      yield* patches.retire(echo.patchId, actor(workspace.admin));
      const after = yield* (yield* request("/", workspace.member)).text;
      assert.deepStrictEqual(shelf(after, "tile-link").slice(0, 1), ["bravo-two"]);
      assert.notInclude(shelf(after, "tile-link"), "echo");
      assert.notInclude(shelf(after, "home-page"), "echo");
    })
  );

  it.effect(
    "puts the viewer's own tools first and moves a patch between shelves with its tier",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const patches = yield* Patches.Patches;
        const theirs = yield* publishSource(workspace.admin, "busy-tool");
        for (let visit = 0; visit < 5; visit++) yield* patches.recordVisit(theirs.patchId);
        const mine = yield* publishSource(workspace.owner, "quiet-tool");
        const page = yield* publish(workspace.owner, "grows-up");
        const before = yield* (yield* request("/", workspace.owner)).text;
        assert.deepStrictEqual(shelf(before, "home-tool"), [mine.name, theirs.name]);
        assert.deepStrictEqual(shelf(before, "home-page"), [page.name]);
        // A republish at tier 1 makes the page a tool.
        yield* publish(workspace.owner, page.name, {
          intent: "update",
          patchId: page.patchId,
          filename: null,
          manifest: { ...manifest, name: page.name, tier: 1 }
        });
        const after = yield* (yield* request("/", workspace.owner)).text;
        assert.deepStrictEqual(shelf(after, "home-tool"), [page.name, mine.name, theirs.name]);
        assert.deepStrictEqual(shelf(after, "home-page"), []);
      })
  );

  it.effect("marks a colleague's company page new until the viewer opens it", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const fresh = yield* publish(workspace.admin, "weekly-recap");
      const shared = yield* publish(workspace.admin, "press-kit", { scope: "public" });
      const mine = yield* publish(workspace.member, "my-notes");
      const old = yield* publish(workspace.admin, "old-brief");
      yield* TestClock.adjust(8 * DAY);
      yield* publish(workspace.admin, fresh.name, { intent: "update", patchId: fresh.patchId });
      yield* publish(workspace.admin, shared.name, { intent: "update", patchId: shared.patchId });
      yield* publish(workspace.member, mine.name, { intent: "update", patchId: mine.patchId });
      const html = yield* (yield* request("/", workspace.member)).text;
      assert.deepStrictEqual(unread(html), [fresh.name]);
      assert.include(shelf(html, "home-page"), old.name);

      // Opening the current version clears it; rolling back to an older one doesn't make it new.
      const current = yield* readPatch(workspace.admin, fresh.patchId);
      yield* patches.recordOpen(
        workspace.member.id,
        fresh.patchId,
        current.patch.currentVersionId!
      );
      assert.deepStrictEqual(unread(yield* (yield* request("/", workspace.member)).text), []);
      yield* TestClock.adjust(60_000);
      yield* patches.rollback(fresh.patchId, actor(workspace.admin), 1);
      assert.deepStrictEqual(unread(yield* (yield* request("/", workspace.member)).text), []);
    })
  );

  it.effect("searches Home past the shelf limits and hands a miss to the agent", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      for (let index = 0; index < 14; index++)
        yield* publishSource(workspace.admin, `report-tool-${index}`);
      yield* publish(workspace.owner, "rota", { description: "Who covers the December reports." });
      yield* publish(workspace.owner, "lunch", { title: "Team lunch REPORT" });
      const found = yield* (yield* request("/?q=report", workspace.member)).text;
      assert.strictEqual(heading(found), "Home");
      // The sidebar's search keeps what was searched.
      assert.include(found, 'id="app-search" type="search" name="q" value="report"');
      assert.include(text(found), "16 matches for “report”");
      assert.strictEqual(shelf(found, "home-tool").length, 12);
      assert.isTrue(
        links(found).some(
          (link) =>
            link.href === "/patches?show=tools&amp;q=report" &&
            link.text === "All 14 matching tools"
        )
      );
      assert.sameMembers(shelf(found, "home-page"), ["rota", "lunch"]);
      assert.include(found, "<mark>report</mark>");
      assert.deepStrictEqual(shelf(found, "tile-link"), []);
      const byOwner = yield* (yield* request("/?q=priya", workspace.member)).text;
      assert.sameMembers(shelf(byOwner, "home-page"), ["rota", "lunch"]);

      const miss = yield* (yield* request("/?q=%3Cb%3Efreelancer", workspace.member)).text;
      assert.include(miss, "Nothing at Northwind matches “&lt;b&gt;freelancer”");
      assert.notInclude(miss, "<b>freelancer");
      assert.include(miss, 'data-copy="Build us a Patchy tool for &lt;b&gt;freelancer"');
      // A connected viewer isn't sent to the setup panel.
      assert.isFalse(links(miss).some((link) => link.href === "/guide"));
      assert.isTrue(
        links(miss).some((link) => link.href === "/patches?show=off&amp;q=%3Cb%3Efreelancer")
      );
      // Old links to the index still land.
      assert.strictEqual((yield* request("/?all=1", workspace.member)).status, 200);
    })
  );

  it.effect("marks where each search result matched, by name, description, title or owner", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      yield* publish(workspace.owner, "rota", { description: "Who covers the December reports." });
      yield* publish(workspace.owner, "lunch", { title: "Team lunch REPORT" });
      yield* publish(workspace.owner, "desk-map", {
        description: "Find a desk. Book the quiet room for writing reports too."
      });
      yield* publish(workspace.admin, "budget", { description: "Spend by month." });
      const found = yield* (yield* request("/?q=report", workspace.member)).text;
      const rows = Object.fromEntries(
        [
          ...found.matchAll(
            /<a class="tile-row tile-row-plain home-page" href="\/[^/"]+\/([a-z0-9-]+)">([\s\S]*?)<\/a>/g
          )
        ].map((match) => [match[1]!, match[2]!])
      );
      assert.sameMembers(Object.keys(rows), ["rota", "lunch", "desk-map"]);
      assert.include(rows.rota, "December <mark>report</mark>s");
      assert.include(rows.lunch, "Team lunch <mark>REPORT</mark>");
      assert.include(rows["desk-map"], "…");
      assert.include(rows["desk-map"], "writing <mark>report</mark>s too");
      const byOwner = yield* (yield* request("/?q=sam", workspace.member)).text;
      assert.include(byOwner, "<mark>Sam</mark>");
    })
  );

  it.effect(
    "keeps a search whole when it is cut to 200 characters, and searches with nothing live",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const query = `${"a".repeat(199)}🙂`;
        for (const path of ["/", "/patches"]) {
          const response = yield* request(
            `${path}?q=${encodeURIComponent(query)}`,
            workspace.member
          );
          assert.strictEqual(response.status, 200);
        }
        // An owner whose patches are all off can still search and ask an agent.
        const shelved = yield* publish(workspace.owner, "shelved-tool");
        yield* (yield* Patches.Patches).retire(shelved.patchId, actor(workspace.owner));
        const miss = yield* (yield* request("/?q=freelancer", workspace.owner)).text;
        assert.include(miss, 'data-copy="Build us a Patchy tool for freelancer"');
        assert.isTrue(
          links(miss).some((link) => link.href === "/patches?show=off&amp;q=freelancer")
        );
      })
  );

  it.effect("offers About on every Home shelf's menu, and Settings only to owners and admins", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const page = yield* publish(workspace.owner, "office-map");
      const tool = yield* publishSource(workspace.owner, "desk-booker");
      for (const [person, shown] of [
        [workspace.member, false],
        [workspace.owner, true],
        [workspace.admin, true]
      ] as const) {
        const html = yield* (yield* request("/", person)).text;
        for (const [shelfName, patch] of [
          ["usual", page],
          ["pages", page],
          ["tools", tool]
        ] as const) {
          const menu = menuItems(html, `${shelfName}-${patch.patchId}`);
          assert.include(menu, "Open in a new tab Copy link About this patch", shelfName);
          assert.strictEqual(menu.includes("Settings"), shown, shelfName);
        }
        assert.isTrue(links(html).some((link) => link.href === cardPath(tool.name)));
      }
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
  it.effect("calls a patch by its title wherever it is listed, its name under it on the card", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const description = "Find a desk. Keep the second sentence on the card.";
      const titled = yield* publish(workspace.owner, "office-map", {
        title: "Office <map>",
        description
      });
      const untitled = yield* publish(workspace.owner, "blank-title", {
        title: "",
        description: ""
      });

      const card = yield* (yield* request(cardPath(titled.name), workspace.member)).text;
      assert.strictEqual(heading(card), "Office &lt;map&gt;");
      assert.include(card, '</h1><p class="supporting-text"><code>office-map</code></p>');
      assert.include(text(card.split(/<\/h1>/)[1] ?? ""), description);
      const bare = yield* (yield* request(cardPath(untitled.name), workspace.member)).text;
      assert.strictEqual(heading(bare), "blank-title");
      assert.notInclude(bare, "</h1><p");
      assert.include(text(bare), "No description");

      // Home's tiles, rows and menus, and All patches, all say the title; Home cuts the description.
      const home = yield* (yield* request("/", workspace.member)).text;
      assert.include(home, '<span class="tile-name">Office &lt;map&gt;</span>');
      assert.include(menuItems(home, `pages-${titled.patchId}`), "Office &lt;map&gt;");
      assert.include(text(home), "Office &lt;map&gt; Find a desk");
      assert.notInclude(text(home), "Keep the second sentence");
      const all = yield* (yield* request("/patches", workspace.member)).text;
      assert.include(
        all,
        `<a href="/${workspace.handle}/office-map"><strong>Office &lt;map&gt;</strong></a>`
      );
      assert.include(all, "<strong>blank-title</strong>");

      // Search finds the name behind a title, and says so.
      const byTitle = yield* (yield* request("/?q=MAP", workspace.member)).text;
      assert.include(byTitle, "Office &lt;<mark>map</mark>&gt;");
      const byName = yield* (yield* request("/?q=office-m", workspace.member)).text;
      assert.deepStrictEqual(shelf(byName, "home-page"), ["office-map"]);
      assert.include(byName, '<span class="tile-meta"><mark>office-m</mark>ap</span>');
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

  it.effect("asks before a patch goes public, then shares it without publishing a version", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "scope-save", { title: "Scope <save>" });
      const before = yield* readPatch(workspace.owner, patch.patchId);
      const scopePath = `${cardPath(patch.name)}/scope`;
      const fields = { expectedPatchId: patch.patchId, scope: "public", expectedScope: "company" };

      // Saving public, even posted straight at the route, only asks.
      const asked = yield* post(scopePath, workspace.admin, fields);
      assert.strictEqual(asked.status, 200);
      const confirm = yield* asked.text;
      assert.strictEqual(heading(confirm), "Make Scope &lt;save&gt; public?");
      assert.include(text(confirm), "Anyone with the link can open it without signing in.");
      assert.include(confirm, 'aria-label="Make Scope &lt;save&gt; public">Make public</button>');
      assert.deepStrictEqual(formFields(confirm, scopePath), { ...fields, confirm: "public" });
      assert.isTrue(
        links(confirm).some(
          (link) => link.href === `${cardPath(patch.name)}/settings` && link.text === "Cancel"
        )
      );
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
      assert.deepStrictEqual(reported(patch.patchId), []);

      // A member can't answer it.
      const refused = yield* post(scopePath, workspace.member, formFields(confirm, scopePath));
      assert.strictEqual(refused.status, 403);
      assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);

      const response = yield* post(scopePath, workspace.admin, formFields(confirm, scopePath));
      assert.strictEqual(response.status, 303);
      assert.strictEqual(response.headers.location, `${cardPath(patch.name)}/settings`);
      assert.strictEqual(
        yield* receiptAfter(response, workspace.admin),
        "Scope &lt;save&gt; is open to anyone on the internet"
      );
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
      const stale = yield* post(scopePath, workspace.admin, formFields(confirm, scopePath));
      assert.strictEqual(stale.status, 409);
      assert.include(text(yield* stale.text), "This patch changed while you had this page open");
      const back = yield* post(scopePath, workspace.owner, {
        expectedPatchId: patch.patchId,
        scope: "company",
        expectedScope: "public"
      });
      assert.strictEqual(back.status, 303);
      assert.strictEqual(
        yield* receiptAfter(back, workspace.owner),
        "Scope &lt;save&gt; is open to people at Northwind"
      );
      assert.strictEqual((yield* readPatch(workspace.owner, patch.patchId)).patch.scope, "company");
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
            assert.deepStrictEqual(inputs(html, "ack", "checkbox"), []);
            assert.include(
              links(html).map((link) => link.href),
              `${cardPath(patch.name)}`
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
            assert.include(text(html), first.name);
            assert.include(text(html), kind === "table" ? "notes" : "photos");
            const card = yield* (yield* request(cardPath(source.name), workspace.owner)).text;
            assert.include(text(card), first.name);
            assert.include(text(card), kind === "table" ? "notes" : "photos");
            assert.include(text(html), workspace.member.name);
            assert.strictEqual(inputs(html, "ack", "checkbox").length, 1);
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
              assert.strictEqual(inputs(fresh, "ack", "checkbox").length, 1);
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
        // Each form's page: its card tab, or its confirmation page.
        const formPage = {
          description: `${cardPath(original.name)}/settings`,
          scope: `${cardPath(original.name)}/settings`,
          rollback: `${cardPath(original.name)}/versions`,
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
      const page = yield* (yield* request(`${cardPath(original.name)}/settings`, workspace.owner))
        .text;
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
          const fields = {
            expectedPatchId: source.patchId,
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
        assert.include(forms(html), `${cardPath(patch.name)}/${action}`);
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
        /<textarea\b[^>]*aria-describedby="description-hint description-error"[^>]*aria-invalid="true"/
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
        const response = yield* post(`${cardPath(patch.name)}/${action}`, workspace.owner, {
          expectedPatchId: patch.patchId,
          ...fields
        });
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
            assert.include(text(html), `${gone.patchId} / notes : gone`);
            assert.include(forms(html), path);
            assert.strictEqual(hidden(html, "expectedPatchId"), consumer.patchId);
            assert.strictEqual(hidden(html, "expectedState"), state);
            assert.strictEqual(inputs(html, "ack", "checkbox").length, 1);
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
    "filters reassignment to active company members and redisplays invalid targets without changing ownership",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const foreign = yield* company();
        const users = yield* Users.Users;
        const patch = yield* publish(workspace.owner, "reassign-picker");
        const path = `${cardPath(patch.name)}/reassign`;
        const page = yield* request(`${path}`, workspace.admin);
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
        // One search on the page itself; the sidebar carries its own.
        assert.strictEqual(inputs(html.slice(html.indexOf("<main")), "q", "search").length, 1);
        assert.strictEqual(hidden(html, "expectedOwnerUserId"), workspace.owner.id);
        const matching = yield* request(`${path}?q=aLeX`, workspace.admin);
        assert.strictEqual(matching.status, 200);
        assert.deepStrictEqual(radioValues(yield* matching.text), [workspace.member.id]);
        const emailMatch = yield* request(
          `${path}?q=${encodeURIComponent(workspace.owner.email)}`,
          workspace.admin
        );
        assert.deepStrictEqual(radioValues(yield* emailMatch.text), [workspace.owner.id]);
        const noMatch = yield* request(`${path}?q=nobody-has-this-name`, workspace.admin);
        assert.strictEqual(noMatch.status, 200);
        const empty = yield* noMatch.text;
        assert.deepStrictEqual(radioValues(empty), []);
        assert.strictEqual(
          hidden(empty.slice(empty.indexOf("<main")), "q"),
          "nobody-has-this-name"
        );
        assert.match(empty, /<button\b(?=[^>]*type="submit")(?=[^>]*\bdisabled)[^>]*>/);
        yield* users.deactivate({ companyId: workspace.id, userId: workspace.member.id });
        const before = yield* readPatch(workspace.owner, patch.patchId);
        for (const target of [workspace.member.id, foreign.owner.id, "usr_missing"]) {
          const refused = yield* post(`${path}?q=Alex`, workspace.admin, {
            expectedPatchId: patch.patchId,
            expectedOwnerUserId: workspace.owner.id,
            user: target
          });
          assert.strictEqual(refused.status, 409);
          const fresh = yield* refused.text;
          assert.notStrictEqual(heading(fresh), patch.name);
          assert.strictEqual(hidden(fresh, "q"), "");
          assert.sameMembers(radioValues(fresh), [workspace.owner.id, workspace.admin.id]);
          assert.notMatch(fresh, /<button\b[^>]*\bdisabled/);
          assert.include(forms(fresh), `${path}`);
          assert.include(
            links(fresh).map((link) => link.href),
            `${cardPath(patch.name)}`
          );
          assert.deepStrictEqual(yield* readPatch(workspace.owner, patch.patchId), before);
        }
        const active = yield* request(path, workspace.admin);
        assert.sameMembers(radioValues(yield* active.text), [
          workspace.owner.id,
          workspace.admin.id
        ]);
        const recovered = yield* post(`${path}`, workspace.admin, {
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
        assert.include(radioValues(html), next.id);
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
            "/company"
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
});

interface Seed {
  readonly companyId: string;
  readonly patchId: string;
  readonly versionId: string;
}
/** Writes one settled invocation the way Runtime does, starting now; returns its id. */
const invoke = Effect.fn("PortalPagesTest.invoke")(function* (
  seed: Seed,
  viewer: Person,
  input: {
    readonly handler: string;
    readonly kind: "query" | "mutation" | "action";
    /** The worker agent the viewer called through; absent for a page's call. */
    readonly agent?: { readonly name: string };
    readonly outcome?: Exclude<InvocationLog.Outcome, "pending">;
    readonly outcomeCode?: string | null;
    readonly parentId?: string;
    readonly durationMs?: number;
    readonly attempts?: number;
    readonly logLines?: InvocationLog.Finish["logLines"];
    readonly replyDelivered?: boolean;
    /** Runs between admission and settlement, such as the calls the invocation makes. */
    readonly inside?: (
      id: string
    ) => Effect.Effect<
      void,
      SqlError,
      RuntimeLog.RuntimeLog | InvocationLog.InvocationLog | SqlClient.SqlClient
    >;
  }
) {
  const log = yield* InvocationLog.InvocationLog;
  const id = `inv_portal_${++counter}`;
  const startedAt = yield* Clock.currentTimeMillis;
  yield* log.begin({
    id,
    companyId: seed.companyId,
    patchId: seed.patchId,
    versionId: seed.versionId,
    handler: input.handler,
    kind: input.kind,
    initiatingViewerId: viewer.id,
    agent: input.agent ?? null,
    parentId: input.parentId ?? null,
    correlationId: `correlation-${id}`,
    startedAt,
    deadline: startedAt + 60_000,
    argsBytes: 2
  });
  if (input.inside)
    yield* input
      .inside(id)
      .pipe(Effect.provide(RuntimeLog.layer), Effect.provide(NodeCryptography.layer));
  yield* log.finish({
    id,
    outcome: input.outcome ?? "success",
    outcomeCode: input.outcomeCode ?? null,
    settledAt: startedAt + (input.durationMs ?? 30),
    durationMs: input.durationMs ?? 30,
    guestMs: 0,
    dbMs: 0,
    callbacks: 0,
    resultBytes: 0,
    attempts: input.attempts ?? 1,
    logLines: input.logLines ?? [],
    replyDelivered: input.replyDelivered ?? true
  });
  yield* TestClock.adjust(1_000);
  return id;
});
/** One logged operation row inside an invocation, a second after the last step. */
const operation = Effect.fn("PortalPagesTest.operation")(function* (
  seed: Seed,
  invocationId: string,
  input: {
    readonly op: string;
    readonly resource: string;
    readonly as: Person | "patch";
    readonly agent?: { readonly name: string };
    readonly outcome: "success" | "failure";
    readonly outcomeCode?: string;
    readonly rowCount: number | null;
  }
) {
  yield* TestClock.adjust(1_000);
  const log = yield* RuntimeLog.RuntimeLog;
  const correlationId = `correlation-call-${++counter}`;
  const principal = input.as === "patch" ? "patch" : input.as.id;
  yield* log.begin({
    companyId: seed.companyId,
    patchId: seed.patchId,
    versionId: seed.versionId,
    userId: principal === "patch" ? null : principal,
    effectivePrincipal: principal,
    invocationId,
    ...(input.agent === undefined
      ? { credentialKind: "session" as const }
      : { credentialKind: "agent" as const, agent: input.agent }),
    op: input.op,
    resource: input.resource,
    connectionId: input.op.startsWith("postgres.") ? "con_warehouse" : null,
    correlationId
  });
  yield* log.finish({
    correlationId,
    outcome: input.outcome,
    outcomeCode: input.outcomeCode ?? null,
    durationMs: 12,
    rowCount: input.rowCount
  });
});
const seedOf = (companyId: string, recorded: Patches.Recorded): Seed => ({
  companyId,
  patchId: recorded.patchId,
  versionId: recorded.versionId
});
const logPath = (name: string, query = "") => `${cardPath(name)}/log${query}`;

it.layer(layer)("all patches on a socket", (it) => {
  it.effect("lists every patch in tabs, searched within the tab and sorted by visits", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const tool = yield* publishSource(workspace.owner, "lead-tracker");
      const page = yield* publish(workspace.owner, "q3-review", {
        description: "Quarterly review of revenue and wins."
      });
      const busy = yield* publish(workspace.member, "kudos", {
        description: "<script>alert(1)</script> Shout-outs."
      });
      const retired = yield* publish(workspace.owner, "old-crm");
      const deleted = yield* publish(workspace.member, "lunch-poll");
      yield* patches.retire(retired.patchId, actor(workspace.owner));
      yield* patches.delete(deleted.patchId, actor(workspace.member));
      for (let visit = 0; visit < 3; visit++) yield* patches.recordVisit(busy.patchId);
      yield* patches.recordVisit(tool.patchId);

      const all = yield* (yield* request("/patches", workspace.owner)).text;
      assert.strictEqual(heading(all), "All patches");
      assert.deepStrictEqual(listed(all), [busy.name, tool.name, page.name]);
      assert.include(text(all), "All 3 Tools 1 Pages 2 Yours 2 Retired and deleted 2");
      assert.notInclude(all, "<script>alert(1)</script>");
      assert.include(all, "&lt;script&gt;alert(1)&lt;/script&gt; Shout-outs");
      assert.include(all, `<script defer src="/assets/copy.js"></script>`);

      const tools = yield* (yield* request("/patches?show=tools", workspace.owner)).text;
      assert.deepStrictEqual(listed(tools), [tool.name]);
      const pages = yield* (yield* request("/patches?show=pages&q=REVENUE", workspace.owner)).text;
      assert.deepStrictEqual(listed(pages), [page.name]);
      assert.include(text(pages), "1 match for “REVENUE”");
      assert.include(pages, 'name="show" value="pages"');
      assert.isTrue(links(pages).some((link) => link.href === "/patches?show=tools&amp;q=REVENUE"));
      const byOwner = yield* (yield* request("/patches?q=alex", workspace.owner)).text;
      assert.deepStrictEqual(listed(byOwner), [busy.name]);
      const yours = yield* (yield* request("/patches?show=yours", workspace.owner)).text;
      assert.deepStrictEqual(listed(yours), [tool.name, page.name]);

      const off = yield* (yield* request("/patches?show=off", workspace.owner)).text;
      assert.deepStrictEqual(listed(off), [deleted.name, retired.name]);
      assert.include(text(off), "Deleted · gone in 30 days");
      assert.include(text(off), "Retired by Priya");
      const nothing = yield* (yield* request("/patches?q=zebra", workspace.owner)).text;
      assert.include(text(nothing), "No patches match “zebra”.");
    })
  );

  it.effect("opens a live patch from its name and offers each viewer only their acts", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "office-map");
      const shelved = yield* publish(workspace.owner, "old-map");
      yield* (yield* Patches.Patches).retire(shelved.patchId, actor(workspace.owner));
      const menus = new Map<Person, string>();
      for (const person of [workspace.member, workspace.owner, workspace.admin])
        menus.set(
          person,
          menuItems(yield* (yield* request("/patches", person)).text, patch.patchId)
        );
      const opening = "office-map Open in a new tab Copy link About this patch";
      assert.strictEqual(menus.get(workspace.member), opening);
      assert.strictEqual(menus.get(workspace.owner), `${opening} Settings Retire… Delete…`);
      assert.strictEqual(
        menus.get(workspace.admin),
        `${opening} Settings Reassign… Retire… Delete…`
      );
      // Each item says whose it is, its visible label first.
      const named = yield* (yield* request("/patches", workspace.admin)).text;
      for (const label of [
        "Open in a new tab",
        "Copy link",
        "About this patch",
        "Settings",
        "Delete…"
      ])
        assert.include(named, `aria-label="${label}, office-map"`);
      const html = yield* (yield* request("/patches", workspace.admin)).text;
      assert.include(html, `data-copy="${PUBLIC_BASE_URL}/${workspace.handle}/office-map"`);
      assert.include(html, `<a href="/${workspace.handle}/office-map"><strong>office-map</strong>`);
      // The viewer's own patches say so in Owner, without a badge.
      const mine = yield* (yield* request("/patches", workspace.owner)).text;
      assert.include(mine, "<span>You</span>");
      assert.notInclude(mine, '<span class="tag">You</span>');
      // An off patch can't be opened, so its name goes to its card.
      const off = yield* (yield* request("/patches?show=off", workspace.owner)).text;
      assert.include(off, `<a href="${cardPath(shelved.name)}"><strong>old-map</strong>`);
      assert.strictEqual(
        menuItems(off, shelved.patchId),
        "old-map About this patch Settings Restore Delete…"
      );
    })
  );

  it.effect("shows Needs attention only to a patch's owner and admins, until recovery ends", () =>
    Effect.gen(function* () {
      // company() sets the clock, so both exist before it moves.
      const outsider = yield* company();
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const sql = yield* SqlClient.SqlClient;
      const deleted = yield* publish(workspace.owner, "lunch-poll");
      const theirs = yield* publish(workspace.admin, "admin-poll");
      const orphan = yield* publish(workspace.member, "asset-library");
      const shelved = yield* publish(workspace.member, "old-crm");
      yield* patches.delete(deleted.patchId, actor(workspace.owner));
      yield* patches.delete(theirs.patchId, actor(workspace.admin));
      yield* patches.retire(shelved.patchId, actor(workspace.member));
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${workspace.member.id}`;
      yield* TestClock.adjust(24 * DAY);

      // An owner sees their own deletion, never a colleague's or an orphan.
      const owner = yield* (yield* request("/patches?show=attention", workspace.owner)).text;
      assert.deepStrictEqual(listed(owner), [deleted.name]);
      assert.include(text(owner), "Gone for good in 6 days");
      assert.include(forms(owner), `${cardPath(deleted.name)}/restore`);
      assert.include(
        text(yield* (yield* request("/patches", workspace.owner)).text),
        "Needs attention 1"
      );
      // An admin sees every deactivated owner's patch, in any state, and every deletion.
      const admin = yield* (yield* request("/patches?show=attention", workspace.admin)).text;
      assert.deepStrictEqual(listed(admin), [theirs.name, orphan.name, deleted.name, shelved.name]);
      assert.include(text(admin), "Its owner is deactivated");
      assert.isTrue(links(admin).some((link) => link.href === `${cardPath(orphan.name)}/reassign`));
      assert.isTrue(
        links(admin).some((link) => link.href === `${cardPath(shelved.name)}/reassign`)
      );
      assert.include(
        text(yield* (yield* request("/patches", workspace.admin)).text),
        "Needs attention 4"
      );
      // Reassigning a deletion moves who sees it.
      yield* patches.reassign(deleted.patchId, actor(workspace.admin), workspace.admin.id);
      assert.notInclude(
        text(yield* (yield* request("/patches", workspace.owner)).text),
        "Needs attention"
      );

      const theirsOnly = yield* (yield* request("/patches?show=attention", outsider.member)).text;
      assert.include(text(theirsOnly), "Nothing needs your attention.");

      yield* TestClock.adjust(7 * DAY);
      const ended = yield* (yield* request("/patches?show=off", workspace.admin)).text;
      assert.include(text(ended), "Recovery ended");
      assert.notInclude(menuItems(ended, theirs.patchId), "Restore");
      assert.include(menuItems(ended, theirs.patchId), "Reassign…");
    })
  );
});

/** A tier 2 patch, as tier 2 publishes: a server artifact beside the page. */
const publishTier2 = Effect.fn("PortalPagesTest.publishTier2")(function* (
  person: Person,
  name: string
) {
  const ordinal = ++counter;
  return yield* publish(person, name, {
    filename: null,
    manifest: { ...manifest, name, tier: 2, handlers: {} },
    server: {
      objectKey: `patches/tier2-${ordinal}/server.js`,
      sha256: sha256(String(ordinal)),
      bytes: 0
    }
  });
});

it.layer(layer)("patch health on a socket", (it) => {
  it.effect("tells owners and admins which tier 2 patches failed in the last day", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const failing = yield* publishTier2(workspace.owner, "client-health");
      const fine = yield* publishTier2(workspace.owner, "web-analytics");
      const page = yield* publish(workspace.owner, "weekly-recap");
      const old = seedOf(workspace.id, failing);
      yield* invoke(old, workspace.member, {
        handler: "accounts.burn",
        kind: "action",
        outcome: "failure"
      });
      yield* TestClock.adjust(2 * DAY);
      for (let index = 0; index < 3; index++)
        yield* invoke(seedOf(workspace.id, failing), workspace.member, {
          handler: "accounts.burn",
          kind: "action",
          outcome: "handler_error",
          outcomeCode: "warehouse_timeout"
        });
      yield* invoke(seedOf(workspace.id, fine), workspace.member, {
        handler: "visits.load",
        kind: "action"
      });

      // The owner's Home names the failing tool, counting only the last day, with its failed log.
      const home = yield* (yield* request("/", workspace.owner)).text;
      assert.include(text(home), "One of your tools is failing");
      assert.include(text(home), "client-health : 3 calls failed in the last day");
      assert.isTrue(
        links(home).some((link) => link.href === "/patches/client-health/log?outcome=failed")
      );
      // The tool's title opens the tool, as everywhere on Home; the count opens its failures.
      assert.isTrue(
        links(home).some(
          (link) => link.href.endsWith("/client-health") && link.text === "client-health"
        )
      );
      for (const person of [workspace.member, workspace.admin])
        assert.notInclude(text(yield* (yield* request("/", person)).text), "is failing");

      // All patches: failures beside the tier 2 rows the viewer manages, and a reason to look.
      // None recorded is blank, never OK; a row with no calls to count has a dash.
      const health = (html: string, name: string) =>
        html.match(
          new RegExp(
            `<tr>(?:(?!</tr>)[\\s\\S])*<strong>${name}</strong>(?:(?!</tr>)[\\s\\S])*<td>((?:(?!</td>)[\\s\\S])*)</td><td class="portal-list-actions">`
          )
        )?.[1];
      for (const person of [workspace.owner, workspace.admin]) {
        const all = yield* (yield* request("/patches", person)).text;
        assert.include(text(all), "Health");
        assert.strictEqual(
          health(all, failing.name),
          `<a href="/patches/client-health/log?outcome=failed">3 failed in the last day</a>`
        );
        assert.strictEqual(health(all, fine.name), "");
        assert.strictEqual(health(all, page.name), '<span class="supporting-text">—</span>');
        assert.notInclude(all, '<span class="pill pill-done">OK</span>');
        const attention = yield* (yield* request("/patches?show=attention", person)).text;
        assert.deepStrictEqual(listed(attention), [failing.name]);
        assert.include(text(attention), "3 calls failed in the last day");
      }
      const member = yield* (yield* request("/patches", workspace.member)).text;
      assert.notInclude(member, '<th scope="col">Health</th>');
      assert.notInclude(text(member), "3 failed");
      assert.notInclude(text(member), "Needs attention");
      assert.include(listed(member), page.name);
    })
  );
});

/** A tier 2 patch whose agent area has a tool of each kind, beside a page handler. */
const agentHandlers: HandlerDescriptors = {
  "agent.moveDeal": {
    kind: "mutation",
    description: "Move one deal to another stage.",
    agentTool: true,
    args: { deal: { kind: "text" } },
    result: { kind: "boolean" }
  },
  "agent.findDeals": {
    kind: "query",
    description: "Search the pipeline for <b>open</b> deals.",
    agentTool: true,
    args: {},
    result: { kind: "json" }
  },
  "agent.exportDeals": {
    kind: "action",
    description: "Export the board as CSV.",
    readOnly: true,
    agentTool: true,
    args: {},
    result: { kind: "text" }
  },
  "agent.addNote": {
    kind: "action",
    description: "Add a note to a deal's timeline.",
    agentTool: true,
    args: {},
    result: { kind: "boolean" }
  },
  "deals.update": { kind: "mutation", args: {}, result: { kind: "boolean" } }
};
const publishAgentArea = Effect.fn("PortalPagesTest.publishAgentArea")(function* (
  person: Person,
  name: string,
  handlers: HandlerDescriptors = agentHandlers,
  overrides: Partial<Patches.RecordInput> = {}
) {
  const ordinal = ++counter;
  return yield* publish(person, name, {
    filename: null,
    manifest: { ...manifest, name, tier: 2, handlers },
    server: {
      objectKey: `patches/agents-${ordinal}/server.js`,
      sha256: sha256(String(ordinal)),
      bytes: 0
    },
    ...overrides
  });
});
const agentPanel = (html: string) => html.match(/<aside class="side-panel"[\s\S]*?<\/aside>/)?.[0];
/** The panel's tools as `name kind`, in order. */
const agentTools = (html: string) =>
  [
    ...(agentPanel(html) ?? "").matchAll(/<summary><code>([^<]*)<\/code><span class="tag">(\w+)/g)
  ].map((match) => `${match[1]} ${match[2]}`);

it.layer(layer)("what agents can do on a socket", (it) => {
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
        assert.include(html, '<div class="card-split"><article class="portal-card">');
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
          "What agents can do As the person who connected them. addNote Changes Add a note to a deal's timeline."
        );
        assert.include(panel, "Search the pipeline for &lt;b&gt;open&lt;/b&gt; deals.");
        assert.deepStrictEqual(links(panel), [
          { href: "/machines?agent=claude#connect-an-agent", text: "Connect your agent" }
        ]);
        assert.notInclude(panel, "note-warn");
      }
      // Only beside the Overview.
      const versions = yield* (yield* request(`${cardPath(patch.name)}/versions`, workspace.member))
        .text;
      assert.isUndefined(agentPanel(versions));
      assert.notInclude(versions, `<div class="card-split">`);

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
        "Agent access is off at Northwind No agent can use these yet. Only admins can turn it on. At Northwind that’s Sam."
      );
      assert.deepStrictEqual(links(member ?? ""), []);
      assert.strictEqual(agentTools(member ?? "").length, 4);
      const admin = agentPanel(yield* (yield* request(cardPath(patch.name), workspace.admin)).text);
      assert.include(text(admin ?? ""), "At Northwind that’s you.");
      assert.deepStrictEqual(links(admin ?? ""), [
        { href: "/company/agent-access", text: "Turn it on at Company" }
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
      const tier0 = yield* publish(workspace.owner, "kickoff-brief");
      // The current version decides: rolled back to one without tools, the panel goes.
      const rolled = yield* publishAgentArea(workspace.owner, "rolled-back", {});
      yield* publishAgentArea(workspace.owner, rolled.name, agentHandlers, {
        intent: "update",
        patchId: rolled.patchId
      });
      yield* (yield* Patches.Patches).rollback(rolled.patchId, actor(workspace.owner), 1);
      const retired = yield* publishAgentArea(workspace.owner, "retired-tools");
      yield* (yield* Patches.Patches).retire(retired.patchId, actor(workspace.owner));

      for (const name of [pageOnly.name, tier0.name, rolled.name, retired.name]) {
        const html = yield* (yield* request(cardPath(name), workspace.admin)).text;
        assert.isUndefined(agentPanel(html), name);
        assert.notInclude(html, `<div class="card-split">`, name);
        assert.notInclude(text(html), "What agents can do", name);
      }
    })
  );
});

it.layer(layer)("patch log on a socket", (it) => {
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
      assert.include(page, "This is an attribution record, not an access audit.");
      assert.include(page, "Log lines are written by the patch itself.");
      assert.notInclude(page, "secret.export");
      assert.include(page, "Alex v1 leads.import action Failed handler_failed 2.4 s");
      const tree = text(html.match(/<details open>([\s\S]*?)<\/details>/)?.[1] ?? "");
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
        const section = text(
          html.match(/<section[^>]*activity-heading[\s\S]*?<\/section>/)?.[0] ?? ""
        );
        assert.strictEqual(
          section,
          [
            "Recent activity",
            "Sam · Busy Tool v1 · pipeline.summary (query) Succeeded 1 Jan 00:00 UTC · 30 ms",
            "Priya · Busy Tool v1 · deals.moveStage (mutation) Refused write_conflict 1 Jan 00:00 UTC · 30 ms · 3 attempts",
            "Alex · Busy Tool v1 · leads.export (action) Succeeded 1 Jan 00:00 UTC · 1.8 s · reply not delivered",
            "See the full log"
          ].join(" ")
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
      assert.include(text(log), `${shown} v1 agent.logCalls action Succeeded`);
      assert.include(text(log), "Alex v1 calls.add mutation Succeeded");
      assert.include(
        text(log),
        `customers.list (connection call) · as ${shown} Succeeded 12 ms · 2 rows`
      );
      // The person filter is unchanged: the agent's work is its person's.
      assert.deepStrictEqual(
        [
          ...(log.match(/<select[^>]*name="person"[\s\S]*?<\/select>/)?.[0] ?? "").matchAll(
            /<option value="[^"]+">([^<]*)<\/option>/g
          )
        ].map((match) => match[1]),
        ["Alex"]
      );

      const card = yield* (yield* request(cardPath(patch.name), workspace.owner)).text;
      assert.notInclude(card, "<Code>");
      const activity = text(
        card.match(/<section[^>]*activity-heading[\s\S]*?<\/section>/)?.[0] ?? ""
      );
      assert.include(activity, `${shown} · Call Log v1 · agent.logCalls (action) Succeeded`);
      assert.include(activity, "Alex · Call Log v1 · calls.add (mutation) Succeeded");
    })
  );

  it.effect("pages by cursor, filters, and says when nothing is logged or matches", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "paged-tool");
      const empty = yield* (yield* request(logPath(patch.name), workspace.owner)).text;
      assert.include(text(empty), "Nothing logged yet.");
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
        [...html.matchAll(/<td><code>(step\.\d+)<\/code><\/td>/g)].map((match) => match[1]);
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
      const nothing = yield* (yield* request(
        logPath(patch.name, `?outcome=failed&person=${workspace.owner.id}`),
        workspace.owner
      )).text;
      assert.include(text(nothing), "No entries match these filters.");
      assert.strictEqual(
        links(nothing).find((link) => link.text === "Clear filters")?.href,
        logPath(patch.name)
      );
    })
  );
});

it.layer(layer)("user lifecycle pages on a socket", (it) => {
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
            const preview = yield* post(path, workspace.admin, { choice: "all" });
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
        assert.deepStrictEqual(committedKeys, []);
        assert.deepStrictEqual(selection.flatMap(reported), []);
        assert.deepStrictEqual(lifecycleEvents(workspace.id), []);

        const committed = yield* post(path, workspace.admin, {
          choice: "confirm",
          patch: selection
        });
        assert.strictEqual(committed.status, 303);
        assert.strictEqual(committed.headers.location, "/company");
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
        assert.deepStrictEqual(
          links(html).filter((link) => link.text.startsWith("Back to")),
          [{ href: "/company", text: "Back to Company" }]
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
        assert.strictEqual(committed.headers.location, "/company");
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
      const preview = yield* post(path, workspace.admin, {
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
      assert.include(text(refusedHtml), `${source.name} / notes : retired`);
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
        deactivate: Effect.fn("PortalPagesTest.failDeactivation")(
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

/** Each prewarm a page asked for, in order; a host beside the fleet would start each. */
const prewarms: Array<Parameters<Prewarm.Prewarm["Service"]["prewarm"]>[0]> = [];
const prewarmLayer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(services),
  Layer.provideMerge(
    Layer.succeed(Prewarm.Prewarm)({
      prewarm: (request) =>
        Effect.sync(() => {
          prewarms.push(request);
        })
    })
  ),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
);

it.layer(prewarmLayer)("prewarms on a socket", (it) => {
  it.effect("readies the viewer's likeliest live tier 2 tools from Home and All patches", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const quiet = yield* publishTier2(workspace.owner, "quiet-tool");
      const popular = yield* publishTier2(workspace.owner, "popular-tool");
      const theirs = yield* publishTier2(workspace.owner, "their-tool");
      const retired = yield* publishTier2(workspace.owner, "old-tool");
      yield* patches.retire(retired.patchId, actor(workspace.owner));
      yield* publish(workspace.owner, "weekly-recap");
      for (let visit = 0; visit < 3; visit++) yield* patches.recordVisit(popular.patchId);
      // Their own opens come first, then everyone's visits; pages and retired tools never.
      yield* patches.recordOpen(workspace.member.id, theirs.patchId, theirs.versionId);
      const expected = {
        companyId: workspace.id,
        viewerId: workspace.member.id,
        candidates: [theirs, popular, quiet].map(({ patchId, versionId }) => ({
          patchId,
          versionId
        }))
      };
      prewarms.length = 0;
      yield* (yield* request("/", workspace.member)).text;
      yield* (yield* request("/patches", workspace.member)).text;
      assert.deepStrictEqual(prewarms, [expected, expected]);

      // A company without a live tier 2 tool has nothing to ready.
      const other = yield* company();
      yield* publish(other.owner, "just-a-page");
      yield* (yield* request("/", other.member)).text;
      assert.strictEqual(prewarms.length, 2);
    })
  );
});
