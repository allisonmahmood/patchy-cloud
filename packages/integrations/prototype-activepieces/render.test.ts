import { assert, it } from "@effect/vitest";
import * as View from "./CommunityView.js";
import type { Info } from "./Pieces.js";

const resend: Info = {
  key: "resend",
  displayName: "Resend",
  authDescription: "Create an API key.",
  fields: [
    {
      name: "secret_text",
      displayName: "API Key",
      description: "Keep this secret.",
      type: "SECRET_TEXT",
      required: true
    }
  ],
  actions: [{ name: "list_domains", displayName: "List Domains" }]
};
it("renders required masked credentials and action labels from module metadata", () => {
  const html = View.provider({
    info: resend,
    company: "Sales & Support",
    rows: [{ id: "conn_mock", handle: "workspace", status: "connected" }],
    calls: new Map()
  });
  assert.include(html, 'name="credential.secret_text" type="password"');
  assert.include(html, 'aria-describedby="new-secret_text-hint"');
  assert.include(html, 'maxlength="4096" required');
  assert.include(html, 'for="new-secret_text">API Key</label>');
  assert.include(html, "Sales &amp; Support");
  assert.include(html, "/run/list_domains");
  assert.include(html, "List Domains</button>");
  assert.notInclude(html, "send_email");
});
it("escapes module metadata and results instead of rendering connector HTML", () => {
  const malicious = '<img src=x onerror="alert(1)">';
  const info: Info = {
    ...resend,
    displayName: malicious,
    authDescription: malicious,
    fields: [{ ...resend.fields[0]!, displayName: malicious, description: malicious }]
  };
  const html = View.provider({
    info,
    company: malicious,
    rows: [],
    calls: new Map(),
    result: { name: malicious }
  });
  assert.notInclude(html, malicious);
  assert.include(html, "&lt;img");
  assert.notInclude(html, "<script");
});
it("shows API-key versus app-setup requirements before asking for credentials", () => {
  const html = View.catalogue([resend, { ...resend, key: "slack", displayName: "Slack" }]);
  assert.include(html, "API key");
  assert.include(html, "App setup required");
  assert.include(html, "Full access");
  assert.include(html, 'href="/company/connections/community/resend"');
  assert.include(html, 'href="/company/connections/community/slack"');
});
