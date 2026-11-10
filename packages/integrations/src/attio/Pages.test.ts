import { assert, it } from "@effect/vitest";
import { switcherRelay } from "@patchy/core";
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
const connectPath = "/settings/integrations/connect/attio";
const fields = (key: string, handle = "crm") => ({
  handle,
  description: "Our sales CRM",
  key
});

it.layer(services(PidgeonTest.canned().layer, attio.layer))("Attio connection pages", (it) => {
  it.effect("connects in one submit, in the shared frame and no script of its own", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("attio-page");
      const page = yield* read(connectPath, owner.user);
      assert.strictEqual(page.status, 200);
      for (const part of [
        '<h1 class="title">Connect Attio</h1>',
        '<span class="flow-number">1</span>Make a read-only access token',
        "Only workspace admins see Developers.",
        "<td>List configuration</td><td>Read</td>",
        "<td>Anything else</td><td>Read or off, never Read-write</td>",
        "reads your workspace for up to a minute; nothing is saved until both finish",
        'type="password" id="connection-key"',
        '<label class="field-prefix" for="connection-handle">attio/</label>',
        "Every member reads everything this token reads through patches that use it",
        "Builders' agents read it while they build, as themselves",
        "Nothing is written to Attio",
        "Attio's own member permissions don't carry over.",
        '<button class="btn btn-primary" type="submit">Test and connect</button>'
      ])
        assert.include(page.html, part);
      assert.notMatch(page.html.replace(switcherRelay, ""), /<script(?![^>]*\bsrc=)/);
      assert.notInclude(page.html, "attio-connect");
      const catalogue = yield* read("/settings/integrations/connect", owner.user);
      assert.include(catalogue.html, "CRM records, lists and members");
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
      assert.include(html, '<p class="field-error" id="connection-key-error">');
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
          "companies.legacy_score",
          "No API slug: the object Workspace hidden, the list Untitled",
          "A type Patchy doesn't read: deals.forecast",
          "Its parent object isn't read: the list orphans",
          '<code>deals</code> <span class="meta">Deals · 6 attributes · 1 left out · 2 options skipped</span>',
          '<code>pipeline</code> <span class="meta">Pipeline · of deals · ',
          "<td>record reference → companies</td>",
          "<td>email address · many</td>",
          '<table class="table" aria-label="deals fields">'
        ])
          at(part);
        // Skipped options and exclusions come before the objects and lists.
        assert.isBelow(at("Options skipped on 3 attributes"), at("Left out: 5"));
        assert.isBelow(at("Left out: 5"), at('<h2 class="section-title">Objects · 3</h2>'));
        assert.isBelow(
          at('<h2 class="section-title">Objects · 3</h2>'),
          at('<h2 class="section-title">Lists · 1</h2>')
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
        // The refusal is the page's one notice, with the way out it names.
        for (const part of [
          "This key can change your workspace: Notes is Read-write.",
          `<a class="btn btn-sm" href="${path}/rotate">Replace key…</a>`,
          "; Notes is Read-write</dd>"
        ])
          assert.include(html, part);
        // From then on the page says why it needs attention, whose check it was, and both ways back.
        const page = yield* read(path, owner.user);
        for (const part of [
          '<span class="badge badge-danger">Needs attention</span>',
          '<p class="notice-title">This key can now write</p>',
          `${owner.user.name}'s Refresh, just now, found Notes set to Read-write on this key, so Patchy paused the connection.`,
          `<form method="post" action="${path}/reconnect"><button class="btn btn-primary btn-sm" type="submit">Resume</button></form>`,
          `<a class="btn btn-sm" href="${path}/rotate">Replace key…</a>`
        ])
          assert.include(page.html, part);
        assert.notInclude(page.html, '<span class="badge">Paused</span>');
        keys.set(token, { ...readKey, token });
        const reconnected = yield* follow(
          yield* send(`${path}/reconnect`, post(owner.user)),
          owner.user
        );
        assert.include(reconnected.html, "Key checked and resumed.");
        assert.notInclude(reconnected.html, "This key can now write");
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
      assert.include(html, '<p class="field-error" id="connection-key-error">');
      assert.include(html, "This key reads the workspace Globex, not Acme.");
      assert.notInclude(html, token);
    })
  );
});

it("names an attribute left out of an object only on that object, though a list shares its slug", () => {
  const container = {
    id: "x",
    slug: "deals",
    name: "Deals",
    attributes: [
      {
        id: "a",
        slug: "stage",
        title: "Stage",
        type: "status" as const,
        multiselect: false,
        optionsSkipped: true as const
      }
    ]
  };
  const { groups, caveats } = Page.reads({
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
  const [objects, lists] = groups;
  assert.include(objects!.entries[0]!.label, "1 left out");
  assert.include(lists!.entries[0]!.label, "1 left out");
  assert.include(caveats[0]!.lines.join(" "), "deals.stage, deals.stage (list)");
  assert.deepStrictEqual(caveats[1]!.lines, [
    "2 archived attributes: deals.old_stage, deals.old_owner (list)"
  ]);
  // Each row names only its own.
  assert.deepStrictEqual(objects!.entries[0]!.notes, ["Left out: old_stage (archived in Attio)."]);
  assert.deepStrictEqual(lists!.entries[0]!.notes, ["Left out: old_owner (archived in Attio)."]);
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
  const { summary, groups, caveats } = Page.reads({
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
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0]!.entries.length, 10);
  // The rest fold away behind a disclosure, still there to inspect.
  assert.strictEqual(groups[0]!.rest?.label, "2 more objects");
  assert.deepStrictEqual(
    groups[0]!.rest?.entries.map((entry) => entry.name),
    ["object_10", "object_11"]
  );
  assert.strictEqual(groups[0]!.entries[0]!.rows.length, 100);
  assert.deepStrictEqual(groups[0]!.entries[0]!.notes, ["And 20 more, in the context agents get."]);
  assert.deepStrictEqual(caveats, []);
});
