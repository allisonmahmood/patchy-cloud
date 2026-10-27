import { describe, expect, it } from "vitest";
import { choiceCards, tileOptions } from "./components.js";

describe("radio groups drawn as tiles and cards", () => {
  it("keeps native radios, each named by its title and described by the rest, with state and data escaped", () => {
    const html = tileOptions("address", [
      {
        value: "id-1",
        name: 'help@acme.example"><script>',
        text: "Acme Help · Replies only",
        mark: '<span class="mono" aria-hidden="true">HE</span>',
        checked: true,
        data: { email: "help@acme.example", policy: "reply_only" }
      },
      {
        value: "id-2",
        name: "alerts@acme.example",
        text: "no inbox, can't be connected",
        mark: "",
        disabled: true
      },
      {
        value: "new",
        name: "New address",
        text: "Replies only to start",
        mark: "",
        placeholder: true
      }
    ]);
    expect(html).toContain('<div class="tile-options">');
    expect(html).toContain(
      '<label class="tile-row tile-option"><input type="radio" name="address" value="id-1" aria-labelledby="address-option-0-name" aria-describedby="address-option-0-text" checked data-email="help@acme.example" data-policy="reply_only">'
    );
    expect(html).toContain(
      '<span class="tile-name" id="address-option-0-name">help@acme.example&quot;&gt;&lt;script&gt;</span>'
    );
    expect(html).toMatch(/value="id-2"[^>]* disabled>/);
    expect(html).toContain(
      '<label class="tile-row tile-option tile-row-placeholder"><input type="radio" name="address" value="new"'
    );
    expect(html).not.toContain("<script>");
  });

  it("draws a choice as a card with its points, checked where chosen", () => {
    const html = choiceCards("access", [
      { value: "read", title: "Read", points: ["Its mail", "Nothing changes"] },
      { value: "send", title: "Read and send", points: ["Also reply & send"], checked: true }
    ]);
    expect(html).toContain('<div class="choice-cards">');
    expect(html).toContain(
      '<label class="choice-card"><input type="radio" name="access" value="send" aria-labelledby="access-card-1-title" aria-describedby="access-card-1-points" checked><span class="choice-card-title" id="access-card-1-title">Read and send</span><span id="access-card-1-points"><span class="choice-card-point">Also reply &amp; send</span></span></label>'
    );
    expect(html.match(/type="radio"/g)).toHaveLength(2);
  });
});
