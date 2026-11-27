import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/show-world/**/*.harness.ts"],
    reporters: ["verbose"],
    pool: "forks",
    execArgv: ["--max-old-space-size=24576"],
  },
});
