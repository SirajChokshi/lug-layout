import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const assetBundleRoot = fileURLToPath(new URL("../../tools/asset-pipeline/dist", import.meta.url));

export default defineConfig({
  plugins: [react()],
  publicDir: assetBundleRoot,
  build: { target: "es2022" },
});
