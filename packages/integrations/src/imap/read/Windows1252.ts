/**
 * windows-1252 as the WHATWG Encoding standard reads it: what browsers read every label it maps
 * there as, `latin1`, `iso-8859-1` and `us-ascii` among them, and how they read `&#128;` through
 * `&#159;`. Bytes 0x80 to 0x9F are its punctuation and letters, not C1 controls; the five it
 * leaves undefined stay C1 controls.
 *
 * Patchy decodes it here rather than through `TextDecoder`, which on Node 22.22 reads 0x80 to 0x9F
 * as C1 controls, so the same mail would read differently by runtime.
 */

/** The characters bytes 0x80 to 0x9F stand for, where they aren't C1 controls. */
export const WINDOWS_1252: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x2c6,
  0x89: 0x2030,
  0x8a: 0x160,
  0x8b: 0x2039,
  0x8c: 0x152,
  0x8e: 0x17d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x2dc,
  0x99: 0x2122,
  0x9a: 0x161,
  0x9b: 0x203a,
  0x9c: 0x153,
  0x9e: 0x17e,
  0x9f: 0x178
};

const C1 = /[\u{80}-\u{9F}]/gu;

/** Bytes as windows-1252 text: each byte its own code point, except 0x80 to 0x9F by the table. */
export const decodeWindows1252 = (bytes: Uint8Array): string =>
  // Buffer's `latin1` is ISO-8859-1, one code point per byte, on every runtime.
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("latin1")
    .replace(C1, (control) => {
      const mapped = WINDOWS_1252[control.charCodeAt(0)];
      return mapped === undefined ? control : String.fromCharCode(mapped);
    });
