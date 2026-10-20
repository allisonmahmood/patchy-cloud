import type { PidgeonSnapshot } from "@patchy/api";
import { escapeAttribute } from "@patchy/core";
import type * as Redacted from "effect/Redacted";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";
import * as Source from "./Source.js";

/** PROTOTYPE (Pidgeon): what the connections pages say about an email address on Pidgeon. */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "pidgeon" }>;

export const integration = { key: "pidgeon", label: "Pidgeon email" } as const;
export const offer = {
  integration,
  reads:
    "One email address on Pidgeon: read its threads, and reply, send and triage from it if its key can.",
  mode: "Company-wide · one address"
};
export const actions = {
  refresh: "Refresh labels",
  rotate: "Replace key",
  retarget: "Change address"
};
export const results = {
  connect: "Address connected and its labels read.",
  rotate: "Key replaced. The connection keeps its address.",
  retarget: "Pointed at the new address and its labels read.",
  refresh: "Labels and what the key may do refreshed.",
  reconnect: "Key tested and reconnected."
};

export const source = (connection: Connection) => connection.display.email;
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  ["Address", connection.display.email],
  ["Key", connection.display.keyHint]
];

export const reads = (snapshot: PidgeonSnapshot) => ({
  summary: `${snapshot.address.email}: threads, messages and attachment text${
    snapshot.access === "send"
      ? `, and replies, sends and triage from it (${
          snapshot.address.sendPolicy === "reply_only"
            ? "replies only: it can't start a conversation"
            : snapshot.address.sendPolicy === "list"
              ? "only to its allow-list"
              : "to anyone"
        }).`
      : ". Read-only: its key can't send."
  }`,
  items: snapshot.labels.map((label) => label.name),
  more: 0
});

export const connectIntro =
  "About three minutes in Pidgeon. Nothing is saved until Patchy has read what the key can do.";

export const walkthrough: View.Walkthrough = {
  before: [
    {
      title: "Mint a key for one address",
      text: "In Pidgeon, open Developers › API keys and mint a key that reaches only the address patches should use. Give it read, or send if tools should reply and send. Patchy refuses admin keys and keys for several addresses."
    },
    {
      title: "Decide who it may write to",
      text: "Pidgeon's send policy still applies. Reply-only means tools can answer people who wrote in but can't start a conversation with a stranger."
    }
  ],
  current: "Paste the key here",
  after: [
    {
      title: "Use it in a patch",
      text: "Ask your agent to add it to a patch by its name, such as pidgeon/support."
    }
  ]
};

const access = `<div class="note"><strong class="note-title">Company-wide access</strong><p>Every member can read every message to this address through any patch that declares it, including whatever people write in.</p></div>`;
const sending = `<div class="note note-warn"><strong class="note-title">Tools send as this address</strong><p>If the key can send, any patch that declares it can reply, send and change threads as this address, for the person using it. Recent calls name each send's recipients and subject.</p></div>`;
const building = `<div class="note"><strong class="note-title">Agents don't read this mail while building</strong><p>patchy dev answers from invented mail in the repo's fixture, and what it sends stays on the builder's machine.</p></div>`;

const keyField = (refusal: View.Notice | undefined) => {
  const note = View.fieldNote(
    "connection-key",
    "key",
    "Patchy encrypts it and never shows it again.",
    refusal
  );
  return `<label class="field-label" for="connection-key">API key</label><input class="field" id="connection-key" type="password" name="key" required placeholder="pgn_live_…" autocomplete="new-password" spellcheck="false"${note.attributes}>${note.note}`;
};

export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["invalid_credentials", "key"],
  ["pidgeon_key_rejected", "key"],
  ["pidgeon_key_too_broad", "key"],
  ["pidgeon_no_inbox", "key"]
]);

type Submitted = Readonly<Record<string, string | undefined>>;

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
    "One line telling builders what this address is for.",
    refusal
  );
  return `<label class="field-label" for="connection-handle">Name</label><div class="field field-group"><label class="field-prefix" for="connection-handle">pidgeon/</label><input id="connection-handle" name="handle" value="${escapeAttribute(submitted.handle ?? "")}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false"${handle.attributes}></div>${handle.note}<label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(submitted.description ?? "")}"${description.attributes}>${description.note}${keyField(refusal)}${access}${sending}${building}`;
};

export const rotate = {
  title: (name: string) => `Replace the key for ${name}`,
  consequence:
    "Patchy checks the new key reaches the same address before saving it. Revoke the old key in Pidgeon afterwards: revoking it takes effect at once.",
  fields: (_submitted: Submitted, refusal?: View.Notice) => keyField(refusal)
};
export const retarget = {
  title: (name: string) => `Change the address of ${name}`,
  consequence:
    "Paste a key for the new address. Every declaring patch then reads and sends as that address.",
  fields: (_submitted: Submitted, refusal?: View.Notice) => `${keyField(refusal)}${access}`
};

export const credentials = (form: Submitted): Redacted.Redacted<string> | View.Notice => {
  const key = (form.key ?? "").trim();
  if (!/^pgn_[A-Za-z0-9_]{4,200}$/.test(key))
    return {
      message: "Paste a Pidgeon API key: it starts with pgn_.",
      code: "invalid_credentials",
      status: 422,
      field: "key"
    };
  return Source.credentials({ key });
};
