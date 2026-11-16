import { defineConfig } from "vitest/config";

export const nodePreset = defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
