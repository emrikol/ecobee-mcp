import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: [
        // Interface-only files (no executable code)
        "src/plugins/types.ts",
        "src/credentials/provider.ts",
        // Integration-test-only files (see v8 ignore comments in each for details)
        "src/index.ts", // Express server lifecycle, auth middleware, sessions
        "src/server.ts", // MCP server factory wiring
        "src/resources/index.ts", // MCP resource handlers
        "src/tools/index.ts", // Tool registration barrel
      ],
    },
  },
});
