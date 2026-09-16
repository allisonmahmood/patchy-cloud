import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "node_modules/oxlint/bin/oxlint");

interface Diagnostic {
  filename: string;
  code?: string;
  message: string;
  labels?: Array<{ span: { line: number } }>;
}

interface LintOutput {
  diagnostics: Diagnostic[];
  number_of_files: number;
}

// Run the production config against a disposable project so both file overrides
// and native type resolution are exercised without introducing broken repo files.
describe("Oxlint workspace policy", () => {
  let directory: string;

  const write = (name: string, source: string) => {
    const filename = path.join(directory, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, source);
  };

  const lint = (config = ".oxlintrc.json") => {
    const result = spawnSync(
      process.execPath,
      [cli, "--type-aware", "-c", config, "--format", "json", "."],
      { cwd: directory, encoding: "utf8", timeout: 30_000 }
    );
    expect(result.error).toBeUndefined();
    return result;
  };

  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "patchy-oxlint-"));
    cpSync(path.join(root, ".oxlintrc.json"), path.join(directory, ".oxlintrc.json"));
    cpSync(path.join(root, "eslint/plugin.js"), path.join(directory, "eslint/plugin.js"), {
      recursive: true
    });
    cpSync(path.join(root, "eslint/rules"), path.join(directory, "eslint/rules"), {
      recursive: true
    });
    symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
    write("package.json", '{"type":"module"}');
    write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2023",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
          types: [],
          paths: { shared: ["./shared.ts"] }
        },
        include: ["**/*.ts", "**/*.mts", "**/*.cts", "**/*.tsx"]
      })
    );
  });

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("keeps typed checks, source conventions, file exceptions and exclusions", () => {
    for (const extension of ["ts", "mts", "cts", "tsx"]) {
      write(`bad/promise.${extension}`, "Promise.resolve(1); export {};");
      write(`good/promise.${extension}`, "void Promise.resolve(1); export {};");
    }
    write("shared.ts", "export const work = async () => 1;");
    write("bad/alias.ts", 'import { work } from "shared"; work();');
    write(
      "bad/handlers.ts",
      "export const work = async () => 1;\nwork().then(value => value);\n[work()];\n(async () => 1)();"
    );
    write(
      "good/handlers.ts",
      "export const work = async () => 1;\nawait work();\nvoid work();\nwork().catch(() => {});\nwork().then(value => value, () => {});"
    );
    write("bad/any.ts", "export const value: any = 1;");
    write("bad/directive.ts", "// @ts-expect-error\nexport const value = 1;");
    write(
      "good/directive.ts",
      "// @ts-expect-error -- This fixture checks directive descriptions.\nexport const value = 1;"
    );
    write("types.ts", "export interface Entry { value: number }");
    write("bad/unused.ts", 'import type { Entry } from "../types.js"; export {};');
    write(
      "good/unused.ts",
      '// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Native declaration emit needs this name.\nimport type { Entry } from "../types.js"; export {};'
    );
    write(
      "good/type-use.ts",
      'import type { Entry } from "../types.js"; export type Result = Entry;'
    );
    write(
      "bad/caught.ts",
      'try { throw new Error("first"); } catch (cause) { throw new Error("second"); }'
    );
    write(
      "good/caught.ts",
      'try { throw new Error("first"); } catch (cause) { throw new Error("second", { cause }); }'
    );
    write("bad/octal.ts", "export const value = 0123;");
    write("bad/conventions.ts", 'import { Effect } from "effect"; export { Effect };');
    write("bad/runtime.test.ts", '(Effect as typeof Effect)["runSync"](program);');
    write("bad/schema.ts", "export const parse = input => Schema.decodeUnknownSync(Foo)(input);");
    write(
      "good/schema.test.ts",
      "export const parse = input => Schema.decodeUnknownSync(Foo)(input);"
    );
    write("packages/patchy/src/bad.ts", 'import "@patchy/auth";');
    write("packages/patchy/src/reexport.ts", 'export * from "@patchy/auth";');
    write(
      "packages/patchy/src/type-import.ts",
      'import type { Entry } from "@patchy/auth"; export type Result = Entry;'
    );
    write("packages/patchy/src/subpath.ts", 'import "@patchy/api/private";');
    write("packages/patchy/src/parent.ts", 'import "../../other.js";');
    write("packages/patchy/src/good.ts", 'import "@patchy/api"; import "../package.json";');
    write("packages/patchy/src/good.test.ts", 'import "@patchy/auth";');
    write("packages/patchy/src/devResources.ts", 'import "@patchy/runtime/dev";');
    write("packages/patchy/src/devServer.ts", 'import "@patchy/auth";');
    write("bad/environment.ts", 'console.log(process.env["HOME"]);');
    write("apps/server/src/start.ts", 'console.log("allowed");');
    write("test/clerk.ts", 'console.log(process.env["HOME"]);');
    write(
      "good/suppression.ts",
      "// eslint-disable-next-line no-empty-pattern\nexport const read = ({}) => 1;"
    );
    for (const name of [
      "dist/broken.ts",
      "nested/dist/broken.ts",
      "coverage/broken.ts",
      ".turbo/broken.ts",
      ".claude/broken.ts",
      ".local/broken.ts",
      "ignored.js",
      "nested/ignored.mjs"
    ])
      write(name, "this is deliberately malformed @@@");

    const result = lint();
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout) as LintOutput;
    const codes = (filename: string) =>
      output.diagnostics.filter((d) => d.filename === filename).map((d) => d.code);
    for (const extension of ["ts", "mts", "cts", "tsx"]) {
      expect(codes(`bad/promise.${extension}`)).toContain("typescript(no-floating-promises)");
    }
    expect(codes("bad/alias.ts")).toContain("typescript(no-floating-promises)");
    expect(
      codes("bad/handlers.ts").filter((code) => code === "typescript(no-floating-promises)")
    ).toHaveLength(3);
    expect(codes("bad/any.ts")).toContain("typescript(no-explicit-any)");
    expect(codes("bad/directive.ts")).toContain("typescript(ban-ts-comment)");
    expect(codes("bad/unused.ts")).toContain("eslint(no-unused-vars)");
    expect(codes("bad/caught.ts")).toContain("eslint(preserve-caught-error)");
    expect(
      output.diagnostics.some((d) => d.filename === "bad/octal.ts" && d.message.includes("octal"))
    ).toBe(true);
    expect(codes("bad/conventions.ts")).toContain("patchy(namespace-service-imports)");
    expect(codes("bad/runtime.test.ts")).toContain("patchy(no-manual-effect-runtime-in-tests)");
    expect(codes("bad/schema.ts")).toContain("patchy(no-inline-schema-compile)");
    for (const name of [
      "bad.ts",
      "parent.ts",
      "devServer.ts",
      "reexport.ts",
      "type-import.ts",
      "subpath.ts"
    ]) {
      expect(codes(`packages/patchy/src/${name}`), name).toContain("patchy(no-restricted-imports)");
    }
    expect(codes("bad/environment.ts")).toEqual(
      expect.arrayContaining(["eslint(no-console)", "eslint(no-restricted-properties)"])
    );
    expect(
      output.diagnostics.filter(
        (d) =>
          !d.filename.startsWith("bad/") &&
          ![
            "packages/patchy/src/bad.ts",
            "packages/patchy/src/parent.ts",
            "packages/patchy/src/devServer.ts",
            "packages/patchy/src/reexport.ts",
            "packages/patchy/src/type-import.ts",
            "packages/patchy/src/subpath.ts"
          ].includes(d.filename)
      )
    ).toEqual([]);
  }, 15_000);

  it("fails when a configured plugin or rule cannot load", () => {
    const config = JSON.parse(readFileSync(path.join(directory, ".oxlintrc.json"), "utf8"));
    write("bad-plugin.json", JSON.stringify({ ...config, jsPlugins: ["./missing-plugin.js"] }));
    const missingPlugin = lint("bad-plugin.json");
    expect(missingPlugin.status).toBe(1);
    expect(missingPlugin.stdout).toContain("Failed to load JS plugin");
    write(
      "bad-rule.json",
      JSON.stringify({ ...config, rules: { "patchy/missing-rule": "error" } })
    );
    const missingRule = lint("bad-rule.json");
    expect(missingRule.status).toBe(1);
    expect(missingRule.stdout).toContain("missing-rule");
  }, 15_000);
});
