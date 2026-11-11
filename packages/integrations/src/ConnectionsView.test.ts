import { describe, expect, it } from "vitest";
import * as View from "./ConnectionsView.js";

// Fifteen integrations, most of which Patchy does not ship: the index has to read the same for them.
const labels: Record<string, string> = {
  airtable: "Airtable",
  bamboohr: "BambooHR",
  bigquery: "BigQuery",
  github: "GitHub",
  greenhouse: "Greenhouse",
  hubspot: "HubSpot",
  intercom: "Intercom",
  jira: "Jira",
  linear: "Linear",
  postgres: "Postgres",
  posthog: "PostHog",
  salesforce: "Salesforce",
  snowflake: "Snowflake",
  stripe: "Stripe",
  zendesk: "Zendesk"
};
const writable: View.Attention = {
  tone: "danger",
  title: "This key can now write",
  text: "Records is Read-write, so Patchy paused it.",
  paused: true,
  fixes: [
    { href: "/settings/integrations/conn_x/reconnect", label: "Resume", primary: true, post: true },
    { href: "/settings/integrations/conn_x/rotate", label: "Replace key…" }
  ]
};
const leftover: View.Attention = {
  tone: "warning",
  title: "The old key is still active in Pidgeon",
  text: "Test tries again."
};
const thirty: ReadonlyArray<View.Row> = [
  ["airtable/ops-base", "Ops team's vendor tracker", 0, false],
  ["bamboohr/people", "Employee directory and time off", 3],
  ["bigquery/ads", "Ad spend across channels", 0, false],
  ["bigquery/events", "Raw event export, partitioned by day", 2],
  ["github/org", "Repositories, pull requests and releases", 4],
  ["greenhouse/hiring", "Candidates and interview stages", 1],
  ["hubspot/marketing", "Contacts, lists and campaigns", 3],
  ["intercom/conversations", "Customer conversations and tags", 2],
  ["jira/engineering", "Issues across engineering projects", 5],
  ["linear/product", "Product team issues and cycles", 0, false],
  ["posthog/main-app", "Product analytics for the customer app", 7],
  ["posthog/marketing-site", "Visits and signups on the marketing site", 3],
  ["posthog/mobile", "iOS and Android app events", 2],
  ["postgres/analytics-replica", "Nightly copy of product tables for reporting", 5],
  ["postgres/inventory", "Stock levels per warehouse location", 3],
  ["postgres/legacy-crm", "Old CRM export, kept for the migration", 0, true, "disconnected"],
  ["postgres/logistics", "Carrier shipments and tracking events", 4],
  ["postgres/orders", "Order service, read replica", 6],
  ["postgres/payroll", "Payroll summaries for finance", 1],
  ["postgres/staging-mirror", "Staging copy for trying reports safely", 0, false],
  ["postgres/support-db", "Ticket metadata mirrored from support", 2],
  ["postgres/warehouse", "Billing and accounts replica, refreshed hourly", 14],
  ["salesforce/emea", "EMEA sales org", 2, true, "connected", leftover],
  [
    "salesforce/main",
    "Sales org: accounts, opportunities, pipeline",
    6,
    true,
    "disconnected",
    writable
  ],
  ["snowflake/finance", "Finance marts: revenue, costs, forecasts", 4],
  ["snowflake/ops", "Operations KPIs", 2],
  ["snowflake/product", "Product usage marts", 3],
  ["stripe/payments", "US payments account", 3],
  ["stripe/payments-eu", "EU payments account", 1],
  ["zendesk/support", "Tickets and satisfaction scores", 3]
].map(([name, description, used, declared = true, status = "connected", attention], index) => {
  const [key, handle] = String(name).split("/") as [string, string];
  return {
    id: `conn_${index}`,
    integration: { key, label: labels[key]!, mark: key.slice(0, 2) },
    handle,
    description: String(description),
    source: `${handle}.example.com`,
    status: status as View.Row["status"],
    ...(attention === undefined ? {} : { attention: attention as View.Attention }),
    usedBy: Array.from({ length: Number(used) }, (_, patch) => `${handle}-patch-${patch}`),
    // Declared with no live user: one retired patch still declares it.
    olderVersions: 0,
    retired: Number(used) === 0 && declared ? 1 : 0,
    deleted: 0,
    disabled: 0,
    declaredBy: Number(used) === 0 && declared ? [`${handle}-old`] : [],
    declared: Boolean(declared) || Number(used) > 0
  };
});
const offers: ReadonlyArray<View.Offer> = [
  {
    integration: { key: "postgres", label: "Postgres", mark: "Pg" },
    line: "Your own database, read-only"
  },
  {
    integration: { key: "posthog", label: "PostHog", mark: "PH" },
    line: "Events and people from a project"
  },
  {
    integration: { key: "attio", label: "Attio", mark: { logo: "attio" } },
    line: "CRM records, lists and members"
  }
];
const NOW = Date.UTC(2026, 9, 13, 12);

const index = (
  rows: ReadonlyArray<View.Row>,
  options: { readonly admin?: boolean; readonly filters?: Partial<View.Filters> } = {}
) =>
  View.renderIndex({
    admin: options.admin ?? true,
    admins: ["Dana", "Jordan"],
    rows,
    ...(options.admin === false
      ? {}
      : { lastCalls: new Map([["conn_10", "2026-10-13T11:59:00.000Z"]]) }),
    offers,
    rotate: () => "Replace key",
    filters: { ...View.noFilters, ...options.filters },
    now: NOW
  }).body;
/** The connection names the table lists, in order. */
const listed = (html: string) =>
  [
    ...html.matchAll(/<a class="row-link" href="\/settings\/integrations\/conn_\d+">([^<]+)<\/a>/g)
  ].map(([, name]) => name);
/** One row of the table by its connection's name. */
const rowOf = (html: string, name: string) =>
  html
    .split("<tr>")
    .slice(1)
    .find((item) => item.includes(`>${name}</a>`))!;

describe("the connections index", () => {
  it("offers its views, its integrations and search only from nine connections", () => {
    expect(index(thirty.slice(0, 8))).not.toContain('class="toolbar"');
    const nine = index(thirty.slice(0, 9));
    expect(nine).toContain('<div class="toolbar">');
    expect(nine).toContain('aria-label="Search connections"');
    // Each integration is a link that narrows the list, keeping the view and search.
    expect(nine).toContain('<nav class="seg" aria-label="Integration">');
    expect(nine).toContain('href="/settings/integrations?source=bigquery"');
    expect(index(thirty, { filters: { q: "pay", view: "attention" } })).toContain(
      'href="/settings/integrations?q=pay&amp;source=stripe&amp;view=attention"'
    );
  });

  it("lists thirty connections across fifteen integrations in one table, each by its mark and name", () => {
    const html = index(thirty);
    expect(listed(html)).toHaveLength(30);
    expect(listed(html)[0]).toBe("airtable/ops-base");
    expect(html).toContain("30 connections");
    expect(rowOf(html, "postgres/warehouse")).toContain(
      '<span class="im" aria-hidden="true">po</span>'
    );
    // A link's source filter narrows the table and shows as a chip that clears it.
    const posthog = index(thirty, { filters: { source: "posthog" } });
    expect(listed(posthog)).toEqual([
      "posthog/main-app",
      "posthog/marketing-site",
      "posthog/mobile"
    ]);
    expect(posthog).toContain('<nav class="seg" aria-label="Integration">');
    expect(posthog).toContain('href="/settings/integrations?source=posthog" aria-current="page"');
    expect(posthog).toContain("Showing 3 of 30.");
    expect(posthog).toContain('<a href="/settings/integrations">Clear filters</a>');
  });

  it("combines search over names and descriptions with the source and view", () => {
    expect(listed(index(thirty, { filters: { q: "payments" } }))).toEqual([
      "stripe/payments",
      "stripe/payments-eu"
    ]);
    expect(listed(index(thirty, { filters: { q: "replica" } }))).toEqual([
      "postgres/analytics-replica",
      "postgres/orders",
      "postgres/warehouse"
    ]);
    // Needs attention is an integration's reason; Paused is an admin's stop.
    expect(listed(index(thirty, { filters: { view: "attention" } }))).toEqual([
      "salesforce/emea",
      "salesforce/main"
    ]);
    expect(listed(index(thirty, { filters: { view: "paused" } }))).toEqual(["postgres/legacy-crm"]);
    expect(listed(index(thirty, { filters: { view: "attention", source: "salesforce" } }))).toEqual(
      ["salesforce/emea", "salesforce/main"]
    );
    expect(listed(index(thirty, { filters: { view: "unused" } }))).toEqual([
      "airtable/ops-base",
      "bigquery/ads",
      "linear/product",
      "postgres/staging-mirror"
    ]);
    const none = index(thirty, { filters: { q: "nothing matches", view: "unused" } });
    expect(none).toContain("No connections match these filters");
    expect(none).toContain("Showing 0 of 30.");
    expect(none).toContain('<input type="hidden" name="view" value="unused">');
    // The view links keep the search and source.
    expect(index(thirty, { filters: { q: "pay", source: "stripe" } })).toContain(
      'href="/settings/integrations?q=pay&amp;source=stripe&amp;view=attention"'
    );
  });

  it("applies a link's filters below nine connections without showing the controls", () => {
    const html = index(thirty.slice(0, 4), { filters: { source: "bigquery" } });
    expect(html).not.toContain('class="toolbar"');
    expect(listed(html)).toEqual(["bigquery/ads", "bigquery/events"]);
    expect(html).toContain("Showing 2 of 4.");
  });

  it("names healthy rows quietly, badges a pause or a reason, and says who uses each connection", () => {
    const html = index(thirty);
    expect(rowOf(html, "postgres/warehouse")).toContain(
      '<span class="dot dot-success">Connected</span>'
    );
    expect(rowOf(html, "postgres/warehouse")).toContain("warehouse-patch-0 and 13 more");
    expect(rowOf(html, "greenhouse/hiring")).toContain("hiring-patch-0");
    expect(rowOf(html, "postgres/legacy-crm")).toContain('<span class="badge">Paused</span>');
    expect(rowOf(html, "postgres/legacy-crm")).toContain(
      'None live <span class="meta">· 1 retired</span>'
    );
    // A reason that paused it is the one word; a warning beside a working connection is its own.
    expect(rowOf(html, "salesforce/main")).toContain(
      '<span class="badge badge-danger">Needs attention</span>'
    );
    expect(rowOf(html, "salesforce/main")).not.toContain(">Paused<");
    expect(rowOf(html, "salesforce/emea")).toContain(
      '<span class="badge badge-warning">Needs attention</span>'
    );
    expect(rowOf(html, "linear/product")).toContain('<span class="meta">None</span>');
    expect(rowOf(html, "posthog/main-app")).toContain("1 minute ago");
    expect(rowOf(html, "linear/product")).toContain(">Never<");
  });

  it("gives an admin each row's menu, with Pause for a connected one and Resume for a paused one", () => {
    const html = index(thirty);
    const warehouse = rowOf(html, "postgres/warehouse");
    expect(warehouse).toContain('action="/settings/integrations/conn_21/test"');
    expect(warehouse).toContain('href="/settings/integrations/conn_21/rotate"');
    expect(warehouse).toContain('href="/settings/integrations/conn_21/disconnect"');
    expect(warehouse).toContain(">Pause…<");
    const paused = rowOf(html, "postgres/legacy-crm");
    expect(paused).toContain('action="/settings/integrations/conn_15/reconnect"');
    expect(paused).toContain(">Resume<");
  });

  it("shows members the table without Last call, menus, Unused or Connect an integration, and whom to ask", () => {
    const html = index(thirty, { admin: false, filters: { view: "unused" } });
    expect(listed(html)).toHaveLength(30);
    for (const hidden of ["Last call", "Unused", "Connect an integration", 'class="menu"'])
      expect(html).not.toContain(hidden);
    expect(html).toContain("Needs attention<span");
    expect(html).toContain(
      "Only super admins connect integrations. Super admins: Dana and Jordan."
    );
    // Asking opens Tell Patchy's composer, Request picked, rather than an email: in place with
    // script, at its own address without.
    expect(html).toContain(
      '<a class="btn" href="/feedback/new?kind=request">Ask for an integration</a>'
    );
    expect(html).not.toContain("mailto:");
  });

  it("counts every connection an offered integration already has, connected or not", () => {
    const html = View.renderCatalogue({ admin: true, admins: [], rows: thirty, offers }).body;
    expect(html).toContain("Your own database, read-only · 9 connected");
    expect(html).toContain("Events and people from a project · 3 connected");
  });

  it("lists one row per offered integration with Connect, then a row to ask for another", () => {
    const html = View.renderCatalogue({ admin: true, admins: [], rows: [], offers }).body;
    expect(html).toContain('<h1 class="title">Connect an integration</h1>');
    expect(html).toContain('href="/settings/integrations/connect/postgres"');
    expect(html).toContain('aria-label="Connect Postgres"');
    expect(html).toContain("Something else");
    expect(html).toContain(
      'href="/feedback/new?kind=request" aria-label="Ask for an integration">Ask</a>'
    );
    // Each row leads with its integration's mark: its logo where Patchy knows it, else its letters.
    expect(html).toMatch(
      /<span class="im im-logo" aria-hidden="true"><svg viewBox="0 0 37 30"[^>]*>[^]*?<\/svg><\/span><div class="row-main"><span class="row-name"><a class="row-link" href="\/settings\/integrations\/connect\/attio">Attio/
    );
    expect(html).toContain('<span class="im" aria-hidden="true">Pg</span>');
    expect(html).toContain('<span class="im im-dashed" aria-hidden="true">+</span>');
    const member = View.renderCatalogue({ admin: false, admins: ["Dana"], rows: [], offers }).body;
    expect(member).not.toContain("connect/postgres");
    expect(member).toContain("Only super admins connect integrations. Super admins: Dana.");
    expect(member).toContain("Something else");
  });

  it("is the catalogue for an empty company, the same rows for admins and, without Connect, members", () => {
    const admin = index([]);
    expect(admin).toContain("Nothing is connected yet");
    expect(admin).toContain('href="/settings/integrations/connect/postgres"');
    expect(admin).not.toContain('class="table"');
    const member = index([], { admin: false });
    expect(member).toContain(
      "Only super admins connect integrations. Super admins: Dana and Jordan."
    );
    expect(member).not.toContain("connect/postgres");
    expect(member).toContain("Tell us what you'd connect");
  });

  it("escapes names, descriptions and the search it echoes", () => {
    const html = index(thirty, { filters: { q: '"><script>' } });
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;"');
    expect(html).not.toContain("<script>");
    expect(index([{ ...thirty[0]!, description: '<img src=x onerror="alert(1)">' }])).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
    );
  });
});

const connection = (extra: Partial<View.Connection> = {}): View.Connection => ({
  id: "conn_x",
  integration: { key: "attio", label: "Attio", mark: "At" },
  handle: "crm",
  description: "Deals and companies",
  status: "connected",
  blockGuests: false,
  testedAt: "2026-10-13T09:00:00.000Z",
  addedBy: "Dana",
  facts: [["Workspace", "Northwind"]],
  credential: { label: "Access token", detail: "Stored · …a1b2" },
  usedBy: ["deal-desk"],
  olderVersions: 0,
  retired: 0,
  deleted: 0,
  disabled: 0,
  declaredBy: [],
  declared: true,
  ...extra
});
const actions: View.Actions = { refresh: "Refresh workspace", rotate: "Replace key" };
const page = (
  input: Partial<Parameters<typeof View.renderConnection>[0]> & { readonly tab?: View.Tab } = {}
) =>
  View.renderConnection({
    connection: connection(),
    tab: "overview",
    reads: {
      summary: "2 objects and 1 list, 9 attributes.",
      items: ["companies", "deals"],
      more: 0,
      revision: 3,
      foundAt: "2026-10-13T10:00:00.000Z"
    },
    actions,
    calls: { list: [], names: { people: new Map(), versions: new Map() }, logged: "Never values." },
    admin: true,
    admins: ["Dana"],
    now: NOW,
    ...input
  }).body;

describe("a connection's page", () => {
  it("gives admins Test, a menu and the Overview, Calls and Settings tabs", () => {
    const html = page();
    expect(html).toContain('<h1 class="title">attio/crm</h1>');
    expect(html).toContain('action="/settings/integrations/conn_x/test"');
    expect(html).toContain('<nav class="tabs" aria-label="attio/crm">');
    for (const href of ["/settings/integrations/conn_x", "/settings/integrations/conn_x/calls"])
      expect(html).toContain(`href="${href}"`);
    expect(html).toContain('href="/settings/integrations/conn_x/settings"');
    // ⋯ holds Refresh, Replace key, Copy name and Pause.
    expect(html).toContain('action="/settings/integrations/conn_x/refresh"');
    expect(html).toContain(">Replace key…<");
    expect(html).toContain('data-copy="attio/crm"');
    expect(html).toContain('href="/settings/integrations/conn_x/disconnect"');
  });

  it("gives members Overview alone, without actions, saying who can change it", () => {
    const html = page({ admin: false, tab: "settings" });
    expect(html).not.toContain('class="tabs"');
    expect(html).not.toContain("/test");
    expect(html).not.toContain('class="menu"');
    expect(html).toContain("What patches can read");
    expect(html).toContain("Only super admins can change it. Super admins: Dana.");
  });

  it("says what patches can read beside its facts, and the add line while connected", () => {
    const html = page();
    expect(html).toContain("2 objects and 1 list, 9 attributes. Found 2 hours ago (revision 3).");
    expect(html).toContain('<span class="row-name">companies</span>');
    expect(html).toContain("<dt>Workspace</dt><dd>Northwind</dd>");
    expect(html).toContain('href="/patches/deal-desk"');
    expect(html).toContain("patchy add attio/crm");
    expect(page({ connection: connection({ status: "disconnected" }) })).not.toContain(
      "patchy add attio/crm"
    );
  });

  it("holds one notice: a reason with its fixes, else that it's paused with Resume", () => {
    const attention = page({
      connection: connection({ status: "disconnected", attention: writable })
    });
    expect(attention).toContain('<p class="notice-title">This key can now write</p>');
    expect(attention).toContain('action="/settings/integrations/conn_x/reconnect"');
    expect(attention).toContain('href="/settings/integrations/conn_x/rotate"');
    expect(attention).toContain('<span class="badge badge-danger">Needs attention</span>');
    expect(attention).not.toContain('<span class="badge">Paused</span>');
    expect(attention.match(/class="notice /g)).toHaveLength(1);
    const paused = page({ connection: connection({ status: "disconnected" }) });
    expect(paused).toContain('<p class="notice-title">Paused</p>');
    expect(paused).toContain('<span class="badge">Paused</span>');
    // A member reads the reason without its fixes.
    const member = page({ admin: false, connection: connection({ attention: writable }) });
    expect(member).toContain("This key can now write");
    expect(member).not.toContain("/reconnect");
    // A refusal from the last action takes the notice's place.
    const refused = page({
      connection: connection({ attention: writable }),
      notice: { message: "The key was refused.", code: "attio_key_unknown", status: 422 }
    });
    expect(refused).toContain("The key was refused.");
    expect(refused).not.toContain("This key can now write");
  });

  it("lists the latest calls on Calls, each opening to its details", () => {
    const html = page({ tab: "calls" });
    expect(html).toContain("No calls yet");
    // A log that can't be read says so in the table's place, keeping the page's one notice.
    const unread = page({
      tab: "calls",
      connection: connection({ status: "disconnected", attention: writable }),
      calls: { list: "unavailable", names: { people: new Map(), versions: new Map() }, logged: "" }
    });
    expect(unread).toContain("Calls could not be loaded");
    expect(unread.match(/class="notice /g)).toHaveLength(1);
  });

  it("holds the description, credentials, guests and the danger zone on Settings", () => {
    const html = page({ tab: "settings" });
    expect(html).toContain('action="/settings/integrations/conn_x/description"');
    expect(html).toContain('value="Deals and companies"');
    expect(html).toContain("Access token");
    expect(html).toContain("Stored · …a1b2");
    expect(html).toContain('href="/settings/integrations/conn_x/rotate"');
    expect(html).toContain('action="/settings/integrations/conn_x/block-guests"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Stop using it");
    expect(html).toContain(">Pause…<");
    // Declared, Disconnect names the patch and what to do instead of a button.
    expect(html).toContain("Used by deal-desk. Remove it from that patch before disconnecting.");
    expect(html).not.toContain("conn_x/delete");
    const unused = page({
      tab: "settings",
      connection: connection({
        usedBy: [],
        declared: false,
        blockGuests: true,
        status: "disconnected"
      })
    });
    expect(unused).toContain('href="/settings/integrations/conn_x/delete"');
    expect(unused).toContain('action="/settings/integrations/conn_x/allow-guests"');
    expect(unused).toContain('action="/settings/integrations/conn_x/reconnect"');
  });

  it("keeps a refused description and says why under its field", () => {
    const html = page({
      tab: "settings",
      description: "Too\nlong",
      notice: {
        message: "One line only.",
        code: "invalid_connection_description",
        status: 422,
        field: "description"
      }
    });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("One line only. (invalid_connection_description)");
    expect(html).not.toContain('class="notice ');
  });
});

describe("why a declared connection can't be disconnected", () => {
  const usage = {
    usedBy: [],
    olderVersions: 0,
    retired: 0,
    deleted: 0,
    disabled: 0,
    declaredBy: [],
    declared: true
  };
  it("names the live patches to remove it from, then every other that declares it", () => {
    expect(View.declaredBy({ ...usage, usedBy: ["new-business"] })).toBe(
      "Used by new-business. Remove it from that patch before disconnecting."
    );
    expect(View.declaredBy({ ...usage, usedBy: ["a", "b", "c", "d", "e"] })).toBe(
      "Used by a, b, c, d and e. Remove it from those patches before disconnecting."
    );
    expect(View.declaredBy({ ...usage, usedBy: ["a"], declaredBy: ["old-board"] })).toBe(
      "Used by a. Remove it from that patch before disconnecting. Stored versions of old-board declare it too."
    );
  });
  it("names the patches whose stored versions still declare it, and says to pause it instead", () => {
    expect(View.declaredBy({ ...usage, retired: 1, declaredBy: ["old-ledger"] })).toBe(
      "Stored versions of old-ledger still declare it, so it can be disconnected only once none does. Pause it instead."
    );
    // Every one is named, however many.
    expect(
      View.declaredBy({ ...usage, retired: 4, declaredBy: ["r-a", "r-b", "r-c", "r-d"] })
    ).toContain("Stored versions of r-a, r-b, r-c and r-d still declare it");
    expect(View.declaredBy(usage)).toBe(
      "A stored patch version declares it, so it can be disconnected only once none does. Pause it instead."
    );
  });
});

describe("dialogs over a connection's Settings", () => {
  it("asks before pausing, naming the patches that lose access, with Cancel in focus", () => {
    const html = View.renderDialog({ connection: connection(), action: "disconnect", actions });
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Pause attio/crm?");
    expect(html).toContain('action="/settings/integrations/conn_x/disconnect"');
    expect(html).toContain('href="/patches/deal-desk"');
    expect(html).toMatch(/href="\/settings\/integrations\/conn_x\/settings"[^>]*autofocus/);
    expect(html).toContain("Pause attio/crm</button>");
  });

  it("asks before disconnecting, in the integration's words where it has them", () => {
    const html = View.renderDialog({
      connection: connection({ usedBy: [], declared: false }),
      action: "delete",
      actions,
      consequences: { delete: "Revokes Patchy's key in Pidgeon." }
    });
    expect(html).toContain("Disconnect attio/crm?");
    expect(html).toContain("Revokes Patchy's key in Pidgeon.");
    expect(html).toContain("btn-danger-solid");
  });

  it("draws a credentials form with its fields and a refusal above its actions", () => {
    const html = View.renderDialog({
      connection: connection(),
      action: "rotate",
      actions,
      form: {
        title: "Replace the key for attio/crm",
        consequence: "Patchy checks it.",
        fields: "<p>fields</p>"
      },
      notice: { message: "Attio couldn't be reached.", code: "source_unavailable", status: 502 }
    });
    expect(html).toContain("Replace the key for attio/crm");
    expect(html).toContain("<p>fields</p>");
    expect(html).toContain("Attio couldn't be reached.");
    expect(html).toContain("Test and replace key</button>");
  });
});

describe("an admin's pause beside an integration's own reason", () => {
  const login: View.Attention = {
    tone: "danger",
    title: "The mail server refused the password",
    text: "Patchy stopped logging in."
  };
  it("shows both, and counts it under Paused as well as Needs attention", () => {
    const both = connection({ status: "disconnected", attention: login });
    const html = page({ connection: both });
    expect(html).toContain('<span class="badge badge-danger">Needs attention</span>');
    expect(html).toContain('<span class="badge">Paused</span>');
    const rows = [{ ...thirty[0]!, status: "disconnected" as const, attention: login }];
    const listed = (view: View.View) =>
      View.renderIndex({
        admin: true,
        admins: [],
        rows,
        offers,
        rotate: () => "Replace key",
        filters: { ...View.noFilters, view },
        now: NOW
      }).body;
    expect(listed("paused")).toContain(">airtable/ops-base</a>");
    expect(listed("attention")).toContain(">airtable/ops-base</a>");
  });
  it("hides the add line while a reason stops its calls, and keeps it beside a warning", () => {
    expect(page({ connection: connection({ attention: login }) })).not.toContain(
      "patchy add attio/crm"
    );
    expect(page({ connection: connection({ attention: leftover }) })).toContain(
      "patchy add attio/crm"
    );
  });
});

describe("a dialog's focus", () => {
  it("starts on Cancel in a destructive dialog, and on a refusal not about a field", () => {
    const refused = View.renderDialog({
      connection: connection(),
      action: "disconnect",
      actions,
      notice: { message: "The service is unavailable.", code: "service_unavailable", status: 503 }
    });
    expect(refused).toContain('<div tabindex="-1" autofocus>');
    expect(refused.match(/autofocus/g)).toHaveLength(1);
    const asking = View.renderDialog({ connection: connection(), action: "disconnect", actions });
    expect(asking).toMatch(/href="\/settings\/integrations\/conn_x\/settings" autofocus>Cancel/);
  });
});

describe("a receipt beside what still holds", () => {
  it("keeps an integration's reason after a completed action, beside its receipt", () => {
    const html = page({
      connection: connection({ attention: leftover }),
      notice: { message: "Key replaced." }
    });
    expect(html).toContain('<p class="receipt" role="status">');
    expect(html).toContain("The old key is still active in Pidgeon");
  });
});
