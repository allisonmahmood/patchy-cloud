/**
 * Bearer parsing for the `Authorization` header, as the `Authorization`
 * middleware and the hosting server's protected-route guard read it: the scheme is case-insensitive, at least
 * one space or tab separates it from the credential, trailing whitespace is
 * tolerated, and anything else on the line makes the header invalid. A
 * missing header and an invalid one are told apart here and nowhere else —
 * on the wire both are the same 401.
 */

export type Credential =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "bearer"; readonly token: string };

const SCHEME = "bearer";

export function parse(header: string | undefined): Credential {
  if (header === undefined) return { kind: "missing" };

  if (header.length <= SCHEME.length) return { kind: "invalid" };
  for (let index = 0; index < SCHEME.length; index += 1) {
    if ((header.charCodeAt(index) | 32) !== SCHEME.charCodeAt(index)) {
      return { kind: "invalid" };
    }
  }

  let cursor = SCHEME.length;
  if (!isWhitespace(header.charCodeAt(cursor))) return { kind: "invalid" };
  while (cursor < header.length && isWhitespace(header.charCodeAt(cursor))) cursor += 1;

  const tokenStart = cursor;
  while (cursor < header.length && !isWhitespace(header.charCodeAt(cursor))) cursor += 1;
  if (cursor === tokenStart) return { kind: "invalid" };

  const token = header.slice(tokenStart, cursor);
  while (cursor < header.length && isWhitespace(header.charCodeAt(cursor))) cursor += 1;
  return cursor === header.length ? { kind: "bearer", token } : { kind: "invalid" };
}

function isWhitespace(charCode: number): boolean {
  return charCode === 0x20 || charCode === 0x09;
}
