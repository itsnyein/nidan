import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/main.ts" },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  dts: false,
  minify: false,
  // Only the CLI is bundled; runtime dependencies are resolved from node_modules at run time.
  external: ["commander", "ts-morph"],
  banner: { js: "#!/usr/bin/env node" },
});
