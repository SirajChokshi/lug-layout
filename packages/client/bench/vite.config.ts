import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist/bench",
    target: "node22",
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      input: ["bench/large-layout.bench.ts", "bench/layout-memory.bench.ts"],
    },
  },
  ssr: { noExternal: [/^@brr\//] },
});
