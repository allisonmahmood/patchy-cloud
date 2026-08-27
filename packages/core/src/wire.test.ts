import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { describe, expect, it } from "vitest";
import {
  apiRoutes,
  cliJsonOutputs,
  decodeWire,
  MeResponseSchema,
  SelfServiceTokenRequestSchema,
  renderApiReference,
  UploadResponseSchema
} from "./wire.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiReferencePath = path.resolve(packageDir, "../../docs/API.md");

describe("shared wire contracts", () => {
  it("defines every JSON HTTP route and CLI JSON output", () => {
    expect(apiRoutes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /healthz",
      "GET /api/me",
      "POST /api/tokens",
      "POST /api/tokens/self-service",
      "POST /api/tokens/:apiTokenId/revoke",
      "GET /api/drafts/:draftId",
      "GET /api/principals/:principalId/drafts",
      "POST /api/uploads",
      "POST /api/drafts/:draftId/disable",
      "POST /api/drafts/:draftId/pin",
      "POST /api/drafts/:draftId/unpin",
      "DELETE /api/drafts/:draftId"
    ]);
    expect(cliJsonOutputs.map(({ command }) => command)).toEqual([
      "auth set",
      "whoami",
      "status",
      "validate",
      "upload"
    ]);
  });

  it("rejects drift in responses consumed by the CLI", () => {
    expect(() =>
      decodeWire(MeResponseSchema, {
        accountId: "acct_1",
        accountName: "Account",
        apiTokenId: "tok_1",
        apiTokenName: "Token",
        scopes: ["upload"],
        unexpected: true
      })
    ).toThrow();

    expect(decodeWire(SelfServiceTokenRequestSchema, {})).toEqual({});
    expect(() => decodeWire(SelfServiceTokenRequestSchema, { name: "not accepted" })).toThrow();

    expect(() =>
      decodeWire(UploadResponseSchema, {
        ok: true,
        draftId: "abcdefghijkl",
        publicUrl: "https://patchy.test/d/abcdefghijkl",
        versionNumber: "1",
        warnings: []
      })
    ).toThrow();
  });

  it("pins docs/API.md to the schemas", async () => {
    const generated = await format(renderApiReference(), { parser: "markdown" });
    expect(readFileSync(apiReferencePath, "utf8")).toBe(generated);
  });
});
