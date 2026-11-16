import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { bundleCacheHeaders } from "./bundle-cache-headers.ts";

const assetBundleRoot = fileURLToPath(new URL("../../tools/asset-pipeline/dist", import.meta.url));

export default defineConfig({
  plugins: [react(), bundleCacheHeaders()],
  publicDir: assetBundleRoot,
  build: { target: "es2022" },
});
