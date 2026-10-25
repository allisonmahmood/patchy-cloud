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
  ["salesforce/emea", "EMEA sales org", 2],
  ["salesforce/main", "Sales org: accounts, opportunities, pipeline", 6, true, "disconnected"],
  ["snowflake/finance", "Finance marts: revenue, costs, forecasts", 4],
  ["snowflake/ops", "Operations KPIs", 2],
  ["snowflake/product", "Product usage marts", 3],
  ["stripe/payments", "US payments account", 3],
  ["stripe/payments-eu", "EU payments account", 1],
  ["zendesk/support", "Tickets and satisfaction scores", 3]
].map(([name, description, used, declared = true, status = "connected"], index) => {
  const [key, handle] = String(name).split("/") as [string, string];
  return {
    id: `conn_${index}`,
    integration: { key, label: labels[key]! },
    handle,
    description: String(description),
    source: `${handle}.example.com`,
    status: status as View.Row["status"],
    usedBy: Array.from({ length: Number(used) }, (_, patch) => `${handle}-patch-${patch}`),
    // Declared with no live user: one retired patch still declares it.
    olderVersions: 0,
    retired: Number(used) === 0 && declared ? 1 : 0,
    deleted: 0,
    disabled: 0,
    declared: Boolean(declared) || Number(used) > 0
  };
});
const offers: ReadonlyArray<View.Offer> = [
  {
    integration: { key: "postgres", label: "Postgres" },
    reads: "A database reachable over TLS.",
    mode: "Company-wide · read-only"
  }
];
const NOW = Date.UTC(2026, 9, 13, 12);

const index = (
  rows: ReadonlyArray<View.Row>,
  options: { readonly admin?: boolean; readonly filters?: Partial<View.Filters> } = {}
) =>
  View.renderIndex({
    admin: options.admin ?? true,
    company: "Northwind",
    admins: ["Dana", "Jordan"],
    rows,
    lastCalls:
      options.admin === false ? undefined : new Map([["conn_10", "2026-10-13T11:59:00.000Z"]]),
    offers,
    filters: { ...View.noFilters, ...options.filters },
    now: NOW
  });
/** The connection names the table lists, in order. */
const listed = (html: string) =>
  [...html.matchAll(/<tr><td><a href="[^"]+"><strong>([^<]+)<\/strong>/g)].map(([, name]) => name);

describe("the connections index", () => {
  it("offers controls only from nine connections", () => {
    expect(index(thirty.slice(0, 8))).not.toContain("connections-filters");
    expect(index(thirty.slice(0, 9))).toContain('<form class="connections-filters"');
  });

  it("lists thirty connections across fifteen integrations in one table, filterable by source", () => {
    const html = index(thirty);
    expect(listed(html)).toHaveLength(30);
    expect(listed(html)[0]).toBe("airtable/ops-base");
    expect(html).toContain("30 connections from 15 integrations");
    expect([...html.matchAll(/<option value="([^"]+)"/g)].map(([, key]) => key)).toEqual(
      Object.keys(labels)
    );
    expect(html).toContain("PostHog (3)");
    const posthog = index(thirty, { filters: { source: "posthog" } });
    expect(listed(posthog)).toEqual([
      "posthog/main-app",
      "posthog/marketing-site",
      "posthog/mobile"
    ]);
    expect(posthog).toContain('<option value="posthog" selected>');
    expect(posthog).toContain("Showing 3 of 30.");
    expect(posthog).toContain('<a href="/company/connections">Clear filters</a>');
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
    expect(listed(index(thirty, { filters: { view: "attention" } }))).toEqual([
      "postgres/legacy-crm",
      "salesforce/main"
    ]);
    expect(listed(index(thirty, { filters: { view: "attention", source: "postgres" } }))).toEqual([
      "postgres/legacy-crm"
    ]);
    expect(listed(index(thirty, { filters: { view: "unused" } }))).toEqual([
      "airtable/ops-base",
      "bigquery/ads",
      "linear/product",
      "postgres/staging-mirror"
    ]);
    const none = index(thirty, { filters: { q: "nothing matches", view: "unused" } });
    expect(none).toContain("No connections match these filters.");
    expect(none).toContain("Showing 0 of 30.");
    expect(none).toContain('<input type="hidden" name="view" value="unused">');
    // The view links keep the search and source.
    expect(index(thirty, { filters: { q: "pay", source: "stripe" } })).toContain(
      'href="/company/connections?q=pay&amp;source=stripe&amp;view=attention"'
    );
  });

  it("applies a link's filters below nine connections without showing the controls", () => {
    const html = index(thirty.slice(0, 4), { filters: { source: "bigquery" } });
    expect(html).not.toContain("connections-filters");
    expect(listed(html)).toEqual(["bigquery/ads", "bigquery/events"]);
    expect(html).toContain("Showing 2 of 4.");
  });

  it("names healthy rows quietly, pills problems and says who uses each connection", () => {
    const html = index(thirty);
    const row = (name: string) =>
      html
        .split("<tr><td>")
        .slice(1)
        .find((item) => item.includes(`${name}<`))!;
    expect(row("postgres/warehouse")).toContain('<span class="supporting-text">Connected</span>');
    expect(row("postgres/warehouse")).toContain("<td>14 patches</td>");
    expect(row("greenhouse/hiring")).toContain("<td>1 patch</td>");
    expect(row("postgres/legacy-crm")).toContain('<span class="pill">Disconnected</span>');
    expect(row("postgres/legacy-crm")).toContain(
      'None live <span class="supporting-text">· 1 retired</span>'
    );
    expect(row("linear/product")).toContain('<span class="supporting-text">None</span>');
    expect(row("posthog/main-app")).toContain("1 minute ago");
    expect(row("linear/product")).toContain(">Never<");
    expect(html).toContain("2 connections need attention");
    expect(html).toContain("is disconnected; 6 patches can't read it.");
  });

  it("shows members the table without Last call, the attention notice, Unused or Connect an integration", () => {
    const html = index(thirty, { admin: false, filters: { view: "unused" } });
    expect(listed(html)).toHaveLength(30);
    for (const hidden of ["Last call", "need attention", "Unused", "Connect an integration"])
      expect(html).not.toContain(hidden);
    expect(html).toContain("Needs attention 2");
  });

  it("counts every connection an offered integration already has, connected or not", () => {
    expect(View.renderCatalogue({ admin: true, rows: thirty, offers })).toContain(
      '<span class="supporting-text">· 9 connections</span>'
    );
  });

  it("starts an empty company from the catalogue for admins and tells members whom to ask", () => {
    const admin = index([]);
    expect(admin).toContain('<h2 class="section-heading">Connect an integration</h2>');
    expect(admin).toContain('href="/company/connections/connect/postgres">Connect Postgres</a>');
    const member = index([], { admin: false });
    expect(member).toContain("At Northwind that's Dana and Jordan.");
    expect(member).toContain("What Patchy can connect");
    expect(member).not.toContain('<a class="btn');
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
