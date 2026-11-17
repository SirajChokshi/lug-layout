import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "bench/large-layout.bench.ts",
    outDir: "bench/dist",
    target: "node22",
    minify: false,
    emptyOutDir: true,
  },
  ssr: { noExternal: [/^@brr\//] },
});
