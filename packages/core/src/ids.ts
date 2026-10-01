import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newPatchId(): string {
  return randomId(12);
}

export function newInternalId(prefix = "id"): string {
  return `${prefix}_${randomId(24)}`;
}

function randomId(length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += ALPHABET[randomInt(ALPHABET.length)];
  }
  return value;
}
