import js from "@eslint/js";
import tseslint from "typescript-eslint";
import patchy from "./eslint/plugin.js";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/.turbo/**"]
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
    files: ["packages/cli/src/**/*.{ts,mts,cts,tsx}"],
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
              regex: "(^|/)\\.\\.(/|$)",
              message: "CLI imports may not traverse parent directories."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["apps/server/src/start.ts", "test/postgres.ts"],
    rules: {
      "no-console": "off"
    }
  },
  {
    files: [
      // These test entrypoints clone the host environment before launching child processes.
      "packages/serving/src/render.test.ts",
      "packages/cli/src/cli.test.ts"
    ],
    rules: {
      "no-restricted-properties": "off"
    }
  }
);
