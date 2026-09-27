import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// jsxImportSource here and in tsconfig.json name the same runtime, so the two cannot disagree.
export default defineConfig({
  plugins: [viteSingleFile()],
  oxc: { jsx: { importSource: "preact" } },
  build: { modulePreload: false },
  server: { host: "127.0.0.1" }
});
