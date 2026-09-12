import js from "@eslint/js";
import tseslint from "typescript-eslint";
import patchy from "./eslint/plugin.js";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Agent worktrees and disposable patch repos are not this workspace's TypeScript projects.
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.turbo/**",
      ".claude/**",
      ".local/**"
    ]
  },
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.lint.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: { patchy },
    rules: {
      "patchy/namespace-service-imports": "error",
      "patchy/no-inline-schema-compile": "error",
      "patchy/no-manual-effect-runtime-in-tests": "error",
      "no-control-regex": "off",
      "no-console": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read the environment through Effect `Config` in the package that owns the setting."
        }
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error"
    }
  },
  {
    files: ["packages/patchy/src/**/*.{ts,mts,cts,tsx}"],
    // Shipped CLI code is wire-only; the three local-runtime composition modules use explicit dev surfaces.
    ignores: ["**/*.test.ts", "packages/patchy/src/dev{Preparation,Resources,Server}.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^@patchy/(?!(api|core)$)",
              message: "The CLI may depend only on @patchy/api and @patchy/core."
            },
            {
              regex: "(?!^\\.\\./package\\.json$)(^|/)\\.\\.(/|$)",
              message:
                "CLI imports may not traverse parent directories except for their own package metadata."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["packages/patchy/src/dev{Preparation,Resources,Server}.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^@patchy/(?!(api|core|company-database/dev|content-store|integrations/dev|primitives|runtime/core|runtime/dev|limits|serving/shell)$)",
              message:
                "The local runtime may compose only explicit local capability surfaces, never production auth or credential wiring."
            },
            {
              regex: "(?!^\\.\\./package\\.json$)(^|/)\\.\\.(/|$)",
              message: "Local runtime imports may not traverse parent directories."
            }
          ]
        }
      ]
    }
  },
  {
    files: [
      "apps/server/src/start.ts",
      "test/postgres.ts",
      "test/clerk.ts",
      "scripts/test-clerk.ts"
    ],
    rules: {
      "no-console": "off"
    }
  },
  {
    files: [
      // Test entrypoints configure the environment for workers and child processes.
      "packages/serving/src/render.test.ts",
      "packages/patchy/src/cli.test.ts",
      "vitest.clerk.config.ts",
      "test/clerk.ts",
      "scripts/test-clerk.ts",
      "playwright.clerk.config.ts",
      "test/browser/fixtures.ts",
      "test/browser/instance.ts",
      "test/browser-tier1/instance.ts",
      "test/browser-tier1/setup.ts"
    ],
    rules: {
      "no-restricted-properties": "off"
    }
  }
);
