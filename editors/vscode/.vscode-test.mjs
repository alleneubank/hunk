import { defineConfig } from "@vscode/test-cli";

// The extension host is Node and CommonJS, so tests run against `out/`, not `src/`.
// A real workspace folder is opened because later units run export against a fixture repo.
export default defineConfig({
  files: "out/test/**/*.test.js",
  workspaceFolder: "./fixtures/workspace",
  mocha: { timeout: 20_000 },
});
