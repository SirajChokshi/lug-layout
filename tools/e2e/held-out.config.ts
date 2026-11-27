import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/held-out/**/*.harness.ts", "src/show-world/**/*.harness.ts"],
    reporters: ["verbose"],
    execArgv: ["--max-old-space-size=16384"],
  },
});
