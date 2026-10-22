import type { ShopifySnapshot } from "@patchy/api";
import { escapeAttribute } from "@patchy/core";
import type * as Redacted from "effect/Redacted";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";
import * as Source from "./Source.js";

/** PROTOTYPE (#815): what the connections pages say about Shopify. */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "shopify" }>;

export const integration = { key: "shopify", label: "Shopify" } as const;
export const offer = {
  integration,
  reads:
    "Orders, products, stock and sales analytics from a Shopify store. Never customer details.",
  mode: "Company-wide · read-only"
};
export const actions = {
  refresh: "Refresh store facts",
  rotate: "Replace secret",
  retarget: "Change store"
};
export const results = {
  connect: "Shopify connected and the store's facts read.",
  rotate: "Secret replaced. The connection keeps its store and what patches can read.",
  retarget: "Pointed at the new store and its facts read.",
  refresh: "Store facts refreshed, including whether analytics work.",
  reconnect: "Connection tested and reconnected."
};

export const source = (connection: Connection) => connection.display.shop;
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  ["Store", connection.display.shop],
  ["Client ID", connection.display.clientId]
];

const analytics: Record<ShopifySnapshot["analytics"], string> = {
  available: "and sales analytics",
  needs_plan: "but not sales analytics, which need Shopify's Grow plan or higher",
  missing_access: "but not sales analytics: check the app has read_reports",
  unknown: "and sales analytics, which couldn't be checked"
};
export const reads = (snapshot: ShopifySnapshot) => ({
  summary: `${snapshot.shop.name}: orders, products, stock and locations, ${analytics[snapshot.analytics]}. Never customer details.`,
  items: [`${snapshot.shop.plan} plan`, snapshot.shop.currency, snapshot.shop.timezone],
  more: 0
});

export const connectIntro =
  "About ten minutes, in Shopify's Dev Dashboard. Nothing is saved until Patchy has tested the app and read the store.";

export const walkthrough: View.Walkthrough = {
  before: [
    {
      title: "Create an app for your store",
      text: "As the store owner, open Shopify's Dev Dashboard at dev.shopify.com, create an app, and give its version exactly read_orders, read_products, read_inventory, read_locations and read_reports."
    },
    {
      title: "Release it and install it on the store",
      text: "Release the version, install the app on your store, then copy the client ID and client secret from the app's Settings."
    }
  ],
  current: "Paste them here",
  after: [
    {
      title: "Use it in a patch",
      text: "Ask your agent to add it to a patch by its name, such as shopify/store."
    }
  ]
};

const privacy = `<div class="note"><strong class="note-title">No customer details</strong><p>Patches read orders, products, stock and sales, never customers' names, emails, phone numbers or addresses beyond country and region. Product and location names are your own text and come through as typed.</p></div>`;
const access = `<div class="note"><strong class="note-title">Company-wide access</strong><p>Every member can read the store's orders, products, stock and sales through any patch that declares it. Shopify staff permissions don't carry over.</p></div>`;
const building = `<div class="note note-warn"><strong class="note-title">Agents read real data while building</strong><p>While someone builds a patch that uses this connection, their agent reads the real store through Patchy, as them. Nothing is written, and every read appears in recent calls.</p></div>`;

type Submitted = Readonly<Record<string, string | undefined>>;

const shopField = (submitted: Submitted, refusal: View.Notice | undefined) => {
  const note = View.fieldNote(
    "connection-shop",
    "shop",
    "The store's address in Shopify: your-store.myshopify.com.",
    refusal
  );
  return `<label class="field-label" for="connection-shop">Store</label><input class="field" id="connection-shop" name="shop" value="${escapeAttribute(submitted.shop ?? "")}" required placeholder="your-store.myshopify.com" autocomplete="off" autocapitalize="none" spellcheck="false"${note.attributes}>${note.note}`;
};
const clientIdField = (submitted: Submitted, refusal: View.Notice | undefined) => {
  const note = View.fieldNote(
    "connection-client-id",
    "client",
    "From the app's Settings in the Dev Dashboard.",
    refusal
  );
  return `<label class="field-label" for="connection-client-id">Client ID</label><input class="field" id="connection-client-id" name="client" value="${escapeAttribute(submitted.client ?? "")}" required autocomplete="off" spellcheck="false"${note.attributes}>${note.note}`;
};
const secretField = (refusal: View.Notice | undefined) => {
  const note = View.fieldNote(
    "connection-secret",
    "secret",
    "Patchy encrypts it and never shows it again.",
    refusal
  );
  return `<label class="field-label" for="connection-secret">Client secret</label><input class="field" id="connection-secret" type="password" name="secret" required autocomplete="new-password" spellcheck="false"${note.attributes}>${note.note}`;
};

export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["invalid_credentials", "secret"],
  ["shopify_credentials_rejected", "secret"],
  ["shopify_wrong_scopes", "client"]
]);

export const connectFields = (submitted: Submitted, refusal?: View.Notice) => {
  const handle = View.fieldNote(
    "connection-handle",
    "handle",
    "3–32 lowercase letters, digits or hyphens. Patches declare it by this name, which can't be changed later.",
    refusal
  );
  const description = View.fieldNote(
    "connection-description",
    "description",
    "One line telling builders what this store is.",
    refusal
  );
  return `<label class="field-label" for="connection-handle">Name</label><div class="field field-group"><label class="field-prefix" for="connection-handle">shopify/</label><input id="connection-handle" name="handle" value="${escapeAttribute(submitted.handle ?? "")}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false"${handle.attributes}></div>${handle.note}<label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(submitted.description ?? "")}"${description.attributes}>${description.note}${shopField(submitted, refusal)}${clientIdField(submitted, refusal)}${secretField(refusal)}${privacy}${access}${building}`;
};

export const rotate = {
  title: (name: string) => `Replace the secret for ${name}`,
  consequence:
    "Patchy tests the new secret against the same store before saving it. Shopify lets the old and new secrets overlap: replace it here first, then revoke the old one in the Dev Dashboard.",
  fields: (_submitted: Submitted, refusal?: View.Notice) => secretField(refusal)
};
export const retarget = {
  title: (name: string) => `Change the store of ${name}`,
  consequence: "Patchy tests the app against the new store and reads its facts before switching.",
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    `${shopField(submitted, refusal)}${clientIdField(submitted, refusal)}${secretField(refusal)}`
};

const refused = (field: View.Field, message: string): View.Notice => ({
  message,
  code: "invalid_credentials",
  status: 422,
  field
});

export const credentials = (
  form: Submitted,
  current?: ConnectionStore.Connection
): Redacted.Redacted<string> | View.Notice => {
  // Replacing the secret keeps the store and the app; changing the store asks for all three.
  const kept =
    current?.integration === "shopify" && form.shop === undefined ? current.display : undefined;
  const shop = (kept?.shop ?? form.shop ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const clientId = (kept?.clientId ?? form.client ?? "").trim();
  const secret = (form.secret ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/.test(shop))
    return refused(
      "shop",
      "Enter the store's myshopify.com address, such as your-store.myshopify.com."
    );
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientId))
    return refused("client", "Paste the app's client ID from its Settings.");
  if (secret === "") return refused("secret", "Paste the app's client secret.");
  return Source.credentials({ shop, clientId, clientSecret: secret });
};
