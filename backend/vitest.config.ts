import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: [
      "tests/**/*.test.ts",
      "harness/**/*.test.ts",
      "backend/tests/**/*.test.ts",
      "backend/harness/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/deploy-verify/**",
      "**/hobbyiq-backend-zip-contents/**",
      "**/backend/tests/pricing/**",
      "**/*.test.js",
    ],
    env: {
      NODE_ENV: "test",
    },
  },
});
