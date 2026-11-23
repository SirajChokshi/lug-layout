import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist/bench",
    target: "node22",
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      input: [
        "bench/large-layout.bench.ts",
        "bench/layout-memory.bench.ts",
        "bench/needed-meshes.bench.ts",
        "bench/editor-frame-loop.bench.ts",
        "bench/plan-sync.bench.ts",
        "bench/fill-tool.bench.ts",
        "bench/pointer-moves.bench.ts",
        "bench/road-scale.bench.ts",
      ],
    },
  },
  ssr: { noExternal: [/^@brr\//] },
});
