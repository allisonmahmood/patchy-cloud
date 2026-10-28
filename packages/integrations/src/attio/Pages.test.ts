import { assert, it } from "@effect/vitest";
import { ContractLimits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import * as AttioDouble from "../test/attio.js";
import * as PidgeonTest from "../test/pidgeon.js";
import { createCompany, events, follow, post, read, send, services } from "../test/pages.js";
import * as Page from "./Page.js";

/**
 * The Attio pages over a scripted Attio: one submit connects, refusals sit under the key, and the
 * connection page opens with what discovery skipped and left out, then each object and list.
 */

const { readKey } = AttioDouble;
const keys = new Map<string, AttioDouble.Key>([[readKey.token, readKey]]);
const attio = AttioDouble.make((request) => AttioDouble.workspace(...keys.values())(request));
const connectPath = "/company/connections/connect/attio";
const fields = (key: string, handle = "crm") => ({
  handle,
  description: "Our sales CRM",
  key
});

it.layer(services(PidgeonTest.canned().layer, attio.layer))("Attio connection pages", (it) => {
  it.effect("connects in one submit, with the walkthrough and no script of its own", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("attio-page");
      const page = yield* read(connectPath, owner.user);
      assert.strictEqual(page.status, 200);
      for (const part of [
        '<h1 class="page-heading">Connect Attio</h1>',
        "reads your workspace for up to a minute; nothing is saved until both finish",
        "Make a read-only access token in Attio",
        '<table class="table attio-scopes">',
        "<tr><td>List configuration</td><td><strong>Read</strong></td></tr>",
        "<tr><td>Anything else</td><td>Read or off</td></tr>",
        "<p><strong>Never Read-write.</strong></p>",
        '<label class="field-prefix" for="connection-handle">attio/</label>',
        'id="connection-key" type="password" name="key"',
        "Attio's own member permissions don't carry over.",
        "Agents read your CRM while building",
        '<button class="btn btn-primary" type="submit">Test and connect</button>'
      ])
        assert.include(page.html, part);
      assert.notMatch(page.html, /<script(?![^>]*\bsrc=)/);
      assert.notInclude(page.html, "attio-connect");
      const catalogue = yield* read("/company/connections/connect", owner.user);
      assert.include(catalogue.html, "A workspace's objects, lists and members, read-only.");
      assert.include(catalogue.html, `href="${connectPath}"`);
    })
  );

  it.effect("refuses a key that can write under its field, keeping all but the key", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("attio-refused");
      const token = "w".repeat(64);
      keys.set(token, { ...readKey, token, scopes: [...readKey.scopes, "note:read-write"] });
      const response = yield* send(connectPath, post(owner.user, fields(token)));
      assert.strictEqual(response.status, 422);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, 'id="connection-key-error" role="alert"');
      assert.include(html, "Notes is Read-write");
      assert.include(html, 'value="crm"');
      assert.include(html, 'value="Our sales CRM"');
      assert.notInclude(html, token);
    })
  );

  it.effect(
    "shows the workspace with what was skipped and left out first, then each object and list",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("attio-connected");
        const connected = yield* send(connectPath, post(owner.user, fields(readKey.token))).pipe(
          // Options run out at once, so the page names every select and status as skipped.
          Effect.provideService(ContractLimits.overrides, {
            "attio.discovery.optionDeadline": 0
          })
        );
        const page = yield* follow(connected, owner.user);
        assert.strictEqual(page.status, 200);
        const at = (part: string) => {
          const index = page.html.indexOf(part);
          assert.isAbove(index, -1, part);
          return index;
        };
        for (const part of [
          "Attio connected and its workspace discovered.",
          "<dt>Workspace</dt><dd>Acme (acme)</dd>",
          `<dt>Key</dt><dd>…${readKey.token.slice(-4)}</dd>`,
          "<dt>Key reads</dt><dd>Records, Object configuration, List entries, List configuration, User management, ",
          "3 objects and 1 list, 13 attributes.",
          "<code>companies.legacy_score</code>",
          "No API slug: the object <strong>Workspace hidden</strong>, the list <strong>Untitled</strong>",
          "A type Patchy doesn't read: <code>deals.forecast</code>",
          "Its parent object isn't read: the list <code>orphans</code>",
          '<code>deals</code> Deals <span class="count">· 6 attributes</span> <span class="tag">1 left out</span> <span class="tag">2 options skipped</span>',
          '<code>pipeline</code> Pipeline <span class="supporting-text">of deals</span>',
          "<td>record reference → companies</td>",
          "<td>email address · many</td>",
          '<div class="attio-attributes"><table class="table">'
        ])
          at(part);
        // Skipped options and exclusions come before the objects and lists.
        assert.isBelow(at("Options skipped on 3 attributes"), at("Left out: 5"));
        assert.isBelow(at("Left out: 5"), at('<h3>Objects <span class="count">3</span></h3>'));
        assert.isBelow(
          at('<h3>Objects <span class="count">3</span></h3>'),
          at('<h3>Lists <span class="count">1</span></h3>')
        );
        assert.deepInclude(
          events.flatMap((event) =>
            event.companyId === owner.company.id && event.name === "connection.connected"
              ? [event.properties.integration]
              : []
          ),
          "attio"
        );
      })
  );

  it.effect(
    "names a key Refresh found writable, whose Refresh it was and the way back, until Reconnect",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("attio-writable");
        const token = "x".repeat(64);
        keys.set(token, { ...readKey, token });
        const connected = yield* send(connectPath, post(owner.user, fields(token)));
        const path = connected.headers.get("location")!.split("?")[0]!;
        keys.set(token, { ...readKey, token, scopes: [...readKey.scopes, "note:read-write"] });
        const refused = yield* send(`${path}/refresh`, post(owner.user));
        const html = yield* Effect.promise(() => refused.text());
        for (const part of [
          "This key can change your workspace: Notes is Read-write.",
          "Disconnected: this key can now write",
          `${owner.user.name}'s Refresh, just now, found Notes set to Read-write on this key, so Patchy stopped using it.`,
          `<form method="post" action="${path}/reconnect"><button class="btn btn-primary" type="submit">Reconnect</button></form>`,
          `<a class="btn" href="${path}/rotate">Replace key…</a>`,
          "; Notes is Read-write</dd>"
        ])
          assert.include(html, part);
        keys.set(token, { ...readKey, token });
        const reconnected = yield* follow(
          yield* send(`${path}/reconnect`, post(owner.user)),
          owner.user
        );
        assert.include(reconnected.html, "Key checked and the connection reconnected.");
        assert.notInclude(reconnected.html, "this key can now write");
      })
  );

  it.effect("refuses Replace key from another workspace, naming both", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("attio-replace");
      const connected = yield* send(connectPath, post(owner.user, fields(readKey.token)));
      const path = connected.headers.get("location")!.split("?")[0]!;
      const confirm = yield* read(`${path}/rotate`, owner.user);
      assert.include(confirm.html, "Replace the key for attio/crm");
      assert.include(confirm.html, "The key must read Acme (acme).");
      const token = "g".repeat(64);
      keys.set(token, {
        ...readKey,
        token,
        workspace: { ...AttioDouble.acme, id: "ws-globex", name: "Globex", slug: "globex" }
      });
      const refused = yield* send(`${path}/rotate`, post(owner.user, { key: token }));
      const html = yield* Effect.promise(() => refused.text());
      assert.include(html, 'id="connection-key-error" role="alert"');
      assert.include(html, "This key reads the workspace Globex, not Acme.");
      assert.notInclude(html, token);
    })
  );
});

it("names an attribute left out of an object only on that object, though a list shares its slug", () => {
  const container = { id: "x", slug: "deals", name: "Deals", attributes: [] };
  const { detail } = Page.reads({
    version: 1,
    workspace: { id: "ws", name: "Acme", slug: "acme" },
    scopes: [],
    objects: [container],
    lists: [{ ...container, id: "y", parents: [{ id: "x", slug: "deals" }] }],
    excluded: [
      {
        kind: "attribute",
        in: { kind: "object", slug: "deals" },
        name: "old_stage",
        reason: "archived"
      },
      {
        kind: "attribute",
        in: { kind: "list", slug: "deals" },
        name: "old_owner",
        reason: "archived"
      }
    ]
  });
  assert.strictEqual(detail.match(/1 left out/g)?.length, 2);
  assert.include(
    detail,
    "2 archived attributes: <code>deals.old_stage</code>, <code>deals.old_owner</code> (list)"
  );
  // Each row names only its own.
  assert.match(
    detail,
    /Left out: <code>old_stage<\/code>[^<]*<\/p><\/details><\/li><\/ul><h3>Lists/
  );
});

it("folds long groups and long attribute tables, so a large workspace stays scannable", () => {
  const container = (index: number, attributes: number) => ({
    id: `obj-${index}`,
    slug: `object_${index}`,
    name: `Object ${index}`,
    attributes: Array.from({ length: attributes }, (_, n) => ({
      id: `att-${index}-${n}`,
      slug: `field_${n}`,
      title: `Field ${n}`,
      type: "text" as const,
      multiselect: false
    }))
  });
  const { summary, detail } = Page.reads({
    version: 1,
    workspace: { id: "ws", name: "Acme", slug: "acme" },
    scopes: [],
    objects: [
      container(0, 120),
      ...Array.from({ length: 11 }, (_, index) => container(index + 1, 3))
    ],
    lists: [],
    excluded: []
  });
  assert.strictEqual(summary, "12 objects and 0 lists, 153 attributes.");
  assert.include(detail, "<summary>2 more objects</summary>");
  assert.include(detail, "And 20 more, in the context agents get.");
  assert.notInclude(detail, "<h3>Lists");
  assert.notInclude(detail, "Options skipped");
});
