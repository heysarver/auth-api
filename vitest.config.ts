import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/test-*.ts",
        "src/index.ts", // Main entry point (server startup)
        "src/lib/auth.ts", // Better Auth config (complex to test in isolation)
        "src/lib/auth-secure.ts", // Alternative auth config
        "**/*.d.ts",
        "**/node_modules/**",
        "**/dist/**",
      ],
      thresholds: {
        lines: 95,
        functions: 90,
        branches: 80,
        statements: 95,
      },
    },
    // Increase timeout for integration tests
    testTimeout: 10000,
    hookTimeout: 10000,
    // Run tests in sequence to avoid database conflicts
    pool: "forks",
    singleFork: true,
  },
});
