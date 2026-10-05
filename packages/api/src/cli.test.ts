import { describe, expect, it } from "vitest";
import { formatPatchyCli, parsePatchyCli } from "./cli.js";

describe("the Patchy-Cli header", () => {
  it("parses what the CLI formats", () => {
    const cli = { cliVersion: "0.12.3", cliCommand: "publish", agent: "claude-code" } as const;
    expect(parsePatchyCli(formatPatchyCli(cli))).toEqual(cli);
  });

  it("drops each field that is outside its pattern or list", () => {
    expect(parsePatchyCli("0.0.1 teleport claude-code")).toEqual({
      cliVersion: "0.0.1",
      agent: "claude-code"
    });
    expect(parsePatchyCli("01.0.1 publish my-agent")).toEqual({ cliCommand: "publish" });
    expect(parsePatchyCli("0.0.1-beta publish unknown")).toEqual({
      cliCommand: "publish",
      agent: "unknown"
    });
  });

  it("records nothing from a missing header or any other shape", () => {
    for (const header of [
      undefined,
      "",
      "0.0.1 publish",
      "0.0.1 publish codex extra",
      "0.0.1  publish codex",
      "0.0.1 publish codex, 0.0.1 publish codex"
    ])
      expect(parsePatchyCli(header)).toEqual({});
  });
});
