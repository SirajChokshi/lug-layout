import { defineConfig } from "vitest/config";

export const nodePreset = defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});

export const domPreset = defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
