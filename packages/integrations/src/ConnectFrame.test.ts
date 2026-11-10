import { describe, expect, it } from "vitest";
import * as ConnectFrame from "./ConnectFrame.js";
import * as AttioPage from "./attio/Page.js";
import * as ImapPage from "./imap/Page.js";
import * as PidgeonPage from "./pidgeon/Page.js";
import * as PostgresPage from "./postgres/Page.js";
import * as PostHogPage from "./posthog/Page.js";

const pages = [PostgresPage, PostHogPage, AttioPage, PidgeonPage, ImapPage] as const;
const draw = (
  page: (typeof pages)[number],
  options: Partial<Omit<Parameters<typeof ConnectFrame.render>[0], "integration" | "spec">> = {}
) =>
  ConnectFrame.render({
    integration: page.integration,
    spec: page.connect,
    submitted: {},
    back: "/settings/integrations/connect",
    ...options
  }).body;
/** Where each part first appears, which must be in task order. */
const inOrder = (html: string, parts: ReadonlyArray<string>) => {
  const at = parts.map((part) => html.indexOf(part));
  expect(at.every((index) => index > -1)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
};

describe("the connect frame", () => {
  it("draws every integration in the same order, marking nothing done", () => {
    for (const page of pages) {
      const html = draw(page);
      inOrder(html, [
        '<a class="ph-parent" href="/settings/integrations/connect">',
        `<h1 class="title">Connect ${page.integration.label}</h1>`,
        '<span class="flow-number">1</span>',
        '<span class="flow-number">2</span>',
        "Name it",
        `<label class="field-prefix" for="connection-handle">${page.integration.key}/</label>`,
        "Once connected",
        '<ul class="can">',
        "Guests of those patches too, unless you block guests",
        '<button class="btn btn-primary" type="submit">Test and connect</button>',
        ">Cancel</a>"
      ]);
      expect(html).not.toContain("step-done");
      expect(html).toContain(`action="/settings/integrations/connect/${page.integration.key}"`);
    }
  });

  it("says builders' agents read live only where the integration's dev binding does", () => {
    expect(draw(PostgresPage)).not.toContain("Builders' agents read it while they build");
    for (const page of [PostHogPage, AttioPage, PidgeonPage, ImapPage])
      expect(draw(page)).toContain("Builders' agents read it while they build");
  });

  it("locks Pidgeon's address, access and name until its script checks the key", () => {
    const html = draw(PidgeonPage, { submitted: { attempt: "pageattempt1" } });
    expect(html.match(/<fieldset class="flow-section" disabled>/g)).toHaveLength(3);
    expect(html).toContain('<script defer src="/assets/pidgeon-connect.js"></script>');
    expect(html).toContain('value="pageattempt1"');
    for (const page of [PostgresPage, PostHogPage, AttioPage, ImapPage])
      expect(draw(page)).not.toContain("disabled>");
  });

  it("puts a field's refusal under it in focus, keeping what was typed but never the secret", () => {
    const html = draw(ImapPage, {
      submitted: { host: "mail.example.test", username: "ada", password: "hunter2", handle: "in" },
      notice: {
        message: "The server wasn't found.",
        code: "imap_host_not_found",
        status: 422,
        field: "host"
      }
    });
    expect(html).toMatch(
      /id="connection-host"[^>]*aria-invalid="true"[^>]*value="mail\.example\.test"[^>]*autofocus/
    );
    expect(html).toContain('<p class="field-error" id="connection-host-error">');
    expect(html).toContain('value="ada"');
    expect(html).toContain('value="in"');
    expect(html).not.toContain("hunter2");
    expect(html).not.toContain('class="notice ');
  });

  it("puts any other refusal right above Test and connect, in focus", () => {
    const html = draw(PostgresPage, {
      notice: { message: "The database didn't answer.", code: "source_unavailable", status: 503 }
    });
    inOrder(html, [
      "Once connected",
      '<div tabindex="-1" autofocus>',
      "The database didn",
      "Test and connect"
    ]);
    expect(html.match(/autofocus/g)).toHaveLength(1);
  });

  it("goes back to Integrations itself while it lists the integrations", () => {
    const html = draw(AttioPage, { back: "/settings/integrations" });
    expect(html).toContain('<a class="ph-parent" href="/settings/integrations">');
    expect(html).toMatch(/href="\/settings\/integrations">Cancel<\/a>/);
  });

  it("names the handle that was typed, and lays paired fields on one row", () => {
    expect(draw(PostHogPage, { submitted: { handle: "revenue" } })).toContain(
      "Patches use it as posthog/revenue."
    );
    expect(draw(PostHogPage)).toContain("Patches use it as posthog/product.");
    expect(draw(ImapPage)).toMatch(
      /<div class="field-row">.*id="connection-host".*id="connection-port".*<\/div>/s
    );
    // Scope tables are compact.
    expect(draw(AttioPage)).toContain('<table class="table table-compact"');
  });

  it("keeps a refusal about Pidgeon's locked parts at its field, with a summary in focus", () => {
    const html = draw(PidgeonPage, {
      submitted: { attempt: "pageattempt1", address: "new", local_part: "-x" },
      notice: {
        message: "Name the new address with letters.",
        code: "invalid_credentials",
        status: 422,
        field: "address"
      }
    });
    inOrder(html, [
      "Once connected",
      '<div tabindex="-1" autofocus data-relock>',
      "Name the new address with letters. Paste the admin key again",
      "Test and connect"
    ]);
    expect(html).toContain('data-kept-local-part="-x"');
    expect(html).toContain('<p class="field-error" id="pidgeon-address-error">');
    expect(html.match(/autofocus/g)).toHaveLength(1);
    // A taken name keeps its error and association under the handle, without focus while locked.
    const taken = draw(PidgeonPage, {
      submitted: { attempt: "pageattempt1", handle: "desk" },
      notice: {
        message: "That name is taken.",
        code: "connection_handle_taken",
        status: 409,
        field: "handle"
      }
    });
    expect(taken).toMatch(
      /id="connection-handle" aria-describedby="connection-handle-hint connection-handle-error" aria-invalid="true"/
    );
    expect(taken.match(/autofocus/g)).toHaveLength(1);
    expect(taken).toContain("data-relock");
  });
});
