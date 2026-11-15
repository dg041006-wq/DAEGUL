import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/stayscene_test",
      DEMO_WEBHOOK_SECRET: "test-demo-secret",
      SESSION_SECRET: "test-session-secret-test-session-secret",
      ANTHROPIC_API_KEY: "",
      NODE_ENV: "test",
    },
  },
});
