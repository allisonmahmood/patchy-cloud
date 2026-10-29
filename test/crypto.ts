// @effect-diagnostics nodeBuiltinImport:off -- tests compute Patchy's formats independently of Cryptography.
/**
 * Patchy's id, token and digest formats, computed with node:crypto and synchronously, for test
 * fixtures and expectations. Production code takes `Cryptography` from its environment instead;
 * these are its formats written out a second time, so a test that compares the two checks both.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const randomId = (length: number) =>
  Array.from({ length }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");

export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const contentHash = (value: string) => `sha256:${sha256(value)}`;
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const newPatchId = () => randomId(12);
export const newInternalId = (prefix = "id") => `${prefix}_${randomId(24)}`;
