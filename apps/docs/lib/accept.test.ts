import { expect, it } from "vitest";
import { prefersMarkdown } from "./accept.js";

it("answers HTML to browsers and to requests that ask for nothing in particular", () => {
  expect(prefersMarkdown(null)).toBe(false);
  expect(prefersMarkdown("")).toBe(false);
  expect(prefersMarkdown("*/*")).toBe(false);
  expect(prefersMarkdown("text/*")).toBe(false);
  // Chromium's and Firefox's headers for a page load.
  expect(
    prefersMarkdown(
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"
    )
  ).toBe(false);
  expect(prefersMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(
    false
  );
});

it("answers Markdown to a request that names it at least as highly as HTML", () => {
  expect(prefersMarkdown("text/markdown")).toBe(true);
  expect(prefersMarkdown("Text/Markdown; charset=utf-8")).toBe(true);
  expect(prefersMarkdown("text/markdown, text/html;q=0.9, */*;q=0.8")).toBe(true);
  expect(prefersMarkdown("text/markdown, text/html, */*")).toBe(true);
  expect(prefersMarkdown("text/markdown;q=0.5, text/html")).toBe(false);
  expect(prefersMarkdown("text/markdown;q=0, */*")).toBe(false);
});

it("rates each representation by the most specific range that matches it", () => {
  // `text/*` doesn't lift HTML past its own explicit refusal.
  expect(prefersMarkdown("text/html;q=0, text/*;q=1, text/markdown;q=0.8")).toBe(true);
  expect(prefersMarkdown("text/html;q=0, */*")).toBe(true);
  // Neither representation is `text/plain`, so the default answers it.
  expect(prefersMarkdown("text/plain")).toBe(false);
});
