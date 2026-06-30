import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 65,
        functions: 85,
        branches: 75,
        statements: 65,
      },
    },
  },
});
