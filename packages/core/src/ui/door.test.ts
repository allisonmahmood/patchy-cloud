import { describe, expect, it } from "vitest";
import { canList, doorCard, doorPage, meet, verificationCode } from "./index.js";

describe("the door", () => {
  it("draws the brand, then the template's kicker and title, then its body and foot", () => {
    const html = doorCard(
      doorPage({
        kicker: "Device login",
        title: "A <b>title</b>",
        body: "<p>Body</p>",
        foot: "Foot"
      }),
      { data: { notice: 'x"y' } }
    );
    const order = ['class="brand"', 'class="kicker"', "<h1", 'class="door-body"', "door-foot"].map(
      (part) => html.indexOf(part)
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('<main class="auth-card" data-notice="x&quot;y">');
    expect(html).toContain("A &lt;b&gt;title&lt;/b&gt;");
  });

  it("escapes what a stranger names and keeps every sign in words", () => {
    expect(verificationCode("AB<C-D")).toBe('<p class="code-display">AB&lt;C-D</p>');
    const strip = meet(
      { mark: "", name: "<img src=x>", meta: "agent.example" },
      "wants to act as",
      { mark: "", name: "Ada" }
    );
    expect(strip).not.toContain("<img");
    expect(strip).toContain('<span class="sr-only">wants to act as</span>');
    const list = canList([
      { can: true, text: "It can read" },
      { can: false, text: "It can’t publish" }
    ]);
    expect(list).toContain('<li class="can-yes">');
    expect(list).toContain('<li class="can-no">');
    expect(list.match(/aria-hidden="true"/g)).toHaveLength(2);
  });
});
