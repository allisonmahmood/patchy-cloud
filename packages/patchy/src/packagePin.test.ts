import { expect, it } from "vitest";
import { patchPackagePin } from "./packagePin.js";

it("changes only the effective literal, preserving CRLF, Unicode, escapes and formatting", () => {
  const source =
    String.raw`{"description":"😀 patchy old-release", "devDependencies" : { "p\u0061tchy" : "old\u002drelease" }, "scripts":{"patchy":"old-release"}}` +
    "\r\n";
  expect(patchPackagePin(source, "old-release", '"new-release"')).toEqual({
    contents: source.replace(String.raw`"old\u002drelease"`, '"new-release"'),
    previousLiteral: String.raw`"old\u002drelease"`
  });
});

it("selects the last duplicate at both levels, matching JSON.parse", () => {
  const source = String.raw`{"devDependencies":{"patchy":"ignored"},"devDependencies":{"patchy":"also ignored","p\u0061tchy":"old-release"}}`;
  expect(patchPackagePin(source, "old-release", '"new-release"')).toEqual({
    contents: source.replace('"old-release"', '"new-release"'),
    previousLiteral: '"old-release"'
  });
  expect(patchPackagePin(source, "ignored", '"new-release"')).toBeUndefined();
});

it("restores the exact original literal without rewriting newer author edits", () => {
  const original = String.raw`{"devDependencies":{"patchy":"old\u002drelease"}}`;
  const forward = patchPackagePin(original, "old-release", '"new-release"')!;
  const authored =
    '{\n\t"scripts":{"dev":"author-command"},"devDependencies":{"patchy":"new-release"}\n}\n';
  expect(patchPackagePin(authored, "new-release", forward.previousLiteral)?.contents).toBe(
    authored.replace('"new-release"', String.raw`"old\u002drelease"`)
  );
});

it("treats prototype names and misleading nested paths as unrelated JSON data", () => {
  const source =
    '{"__proto__":{"devDependencies":{"patchy":"wrong"}},"constructor":"keep","devDependencies":{"patchy":"old-release"}}';
  expect(patchPackagePin(source, "old-release", '"new-release"')?.contents).toBe(
    source.replace('"old-release"', '"new-release"')
  );
});

it.each([
  '{"devDependencies":{"patchy":"old-release"}',
  '{"devDependencies":{"patchy":"old-release",}}',
  '{/* author comment */"devDependencies":{"patchy":"old-release"}}',
  '{"devDependencies":{"patchy":"author-release"}}',
  '{"devDependencies":{"patchy":"old-release","patchy":null}}',
  '{"devDependencies":{"patchy":"old-release"},"devDependencies":{}}',
  '{"devDependencies":{"patchy":"old-release"},"devDependencies":[]}',
  '{"nested":{"devDependencies":{"patchy":"old-release"}}}',
  "null"
])("leaves invalid or changed JSON untouched: %s", (source) => {
  expect(patchPackagePin(source, "old-release", '"new-release"')).toBeUndefined();
});
