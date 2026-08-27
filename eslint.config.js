import js from "@eslint/js";
import tseslint from "typescript-eslint";

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
    rules: {
      "no-control-regex": "off",
      "no-console": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Read environment variables in a package entrypoint or packages/config."
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
              regex: "^@patchy/(?!core$)",
              message: "The CLI may depend only on @patchy/core."
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
    files: [
      // Test modules and Vitest global setup are executable composition roots.
      "**/*.test.{ts,mts,cts,tsx}",
      "test/postgres.ts",
      "apps/server/src/start.ts",
      "packages/cli/src/index.ts",
      "packages/db/src/migrate.ts",
      "packages/config/**/*.ts"
    ],
    rules: {
      "no-console": "off",
      "no-restricted-properties": "off"
    }
  }
);
