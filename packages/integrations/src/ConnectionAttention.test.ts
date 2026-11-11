import { describe, expect, it } from "vitest";
import { attention } from "./ConnectionAttention.js";
import * as ConnectionStore from "./ConnectionStore.js";

const shared = {
  companyId: "cmp_attention",
  description: "",
  mode: "company" as const,
  blockGuests: false,
  credentialRevision: 1,
  metadataRevision: 1,
  lastTestedAt: null,
  lastDiscoveredAt: null,
  createdBy: "usr_admin"
};
const postgres = (
  id: string,
  status: "connected" | "disconnected"
): ConnectionStore.Connection => ({
  ...shared,
  id,
  handle: id,
  status,
  integration: "postgres",
  display: { host: "db.example.com", port: 5432, database: "sales", role: "reader" }
});
const imap = (
  id: string,
  paused: boolean,
  host = "imap.example.com"
): ConnectionStore.Connection => ({
  ...shared,
  id,
  handle: id,
  status: "connected",
  integration: "imap",
  display: {
    host,
    port: 993,
    security: "tls",
    username: "invoices@example.com",
    ...(paused
      ? {
          paused: { at: "2026-11-07T10:00:00.000Z", reply: "AUTHENTICATIONFAILED", during: "call" }
        }
      : {})
  }
});
const used = (count: number): ConnectionStore.Usage => ({
  ...ConnectionStore.unused,
  usedBy: Array.from({ length: count }, (_, index) => `patch-${index}`),
  declared: count > 0
});

const attio = (id: string): ConnectionStore.Connection => ({
  ...shared,
  id,
  handle: id,
  status: "disconnected",
  integration: "attio",
  display: {
    workspace: { id: "ws_1", name: "Brightline", slug: "brightline" },
    keyHint: "a1b2",
    scopes: [],
    writable: {
      scopes: ["record_permission:read-write"],
      by: "usr_admin",
      at: "2026-11-06T10:00:00.000Z",
      during: "test"
    }
  }
});

const pidgeon = (
  id: string,
  display: { readonly test: boolean; readonly retired?: boolean }
): ConnectionStore.Connection => ({
  ...shared,
  id,
  handle: id,
  status: "connected",
  integration: "pidgeon",
  display: {
    email: `${id}@example.com`,
    identityId: `idn_${id}`,
    sendPolicy: "reply_only",
    access: "send",
    test: display.test,
    key: { id: `key_${id}`, name: `Patchy ${id}`, madeAt: "2026-11-01T10:00:00.000Z" },
    ...(display.retired === true ? { retired: [{ id: "key_old", name: "Patchy old" }] } : {})
  }
});

describe("what needs an admin among a company's connections", () => {
  it("names a stopped connection with what it stops and its fix, and leaves choices alone", () => {
    const found = attention(
      [
        postgres("warehouse", "connected"),
        postgres("orders", "disconnected"),
        postgres("legacy", "disconnected"),
        imap("support", false),
        imap("invoices", true),
        attio("partners")
      ],
      new Map([
        ["orders", used(2)],
        ["invoices", used(1)],
        ["warehouse", used(3)]
      ])
    );
    expect(found).toEqual([
      {
        id: "partners",
        name: "attio/partners",
        mark: { logo: "attio" },
        problem: "Disconnected: this key can now write",
        fix: { label: "Reconnect…", href: "/settings/integrations/partners" }
      },
      {
        id: "invoices",
        name: "imap/invoices",
        mark: { icon: "mail" },
        problem: "Paused: the mail server refused the password",
        detail: "1 patch can't read it",
        fix: { label: "Replace password…", href: "/settings/integrations/invoices/rotate" }
      },
      {
        id: "orders",
        name: "postgres/orders",
        mark: { logo: "postgres" },
        problem: "Disconnected",
        detail: "2 patches can't read it",
        fix: { label: "Reconnect…", href: "/settings/integrations/orders" }
      }
    ]);
  });

  it("marks a mailbox on Gmail's server with Gmail's logo, and any other with the envelope", () => {
    expect(
      attention([imap("studio", true, "imap.gmail.com"), imap("support", true)], new Map()).map(
        ({ name, mark }) => [name, mark]
      )
    ).toEqual([
      ["imap/studio", { logo: "gmail" }],
      ["imap/support", { icon: "mail" }]
    ]);
  });

  it("names Pidgeon's leftover key, and a test key only while live patches use it", () => {
    expect(
      attention(
        [
          pidgeon("billing", { test: false, retired: true }),
          pidgeon("hello", { test: true }),
          pidgeon("sandbox", { test: true })
        ],
        new Map([["hello", used(2)]])
      )
    ).toEqual([
      {
        id: "billing",
        name: "pidgeon/billing",
        mark: { logo: "pidgeon" },
        problem: "The old key is still active in Pidgeon",
        fix: { label: "Test again…", href: "/settings/integrations/billing" }
      },
      {
        id: "hello",
        name: "pidgeon/hello",
        mark: { logo: "pidgeon" },
        problem: "Test key: mail stays in Pidgeon",
        detail: "2 patches use it",
        fix: { label: "Replace key…", href: "/settings/integrations/hello/rotate" }
      }
    ]);
  });
});
