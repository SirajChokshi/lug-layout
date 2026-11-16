import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";

const assetBundleRoot = fileURLToPath(new URL("../../tools/asset-pipeline/dist", import.meta.url));
const BUNDLE_PATH = /^\/bundle\/[^/]+\/(?<file>[^/]+)$/u;
const CONTENT_ADDRESSED_FILE = /\.[0-9a-f]{16}\.(?:glb|json)$/u;
const MANIFEST_FILE = "manifest.json";
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

function bundleCacheControl(pathname: string): string | undefined {
  const file = BUNDLE_PATH.exec(pathname)?.groups?.["file"];
  if (file === undefined) return undefined;
  if (file === MANIFEST_FILE) return REVALIDATE;
  return CONTENT_ADDRESSED_FILE.test(file) ? IMMUTABLE : undefined;
}

const applyBundleCacheControl: Connect.NextHandleFunction = (request, response, next) => {
  const cacheControl = bundleCacheControl(new URL(request.url ?? "/", "http://localhost").pathname);
  if (cacheControl !== undefined) response.setHeader("Cache-Control", cacheControl);
  next();
};

const bundleCacheHeaders: Plugin = {
  name: "brr-bundle-cache-headers",
  configurePreviewServer(server) {
    server.middlewares.use(applyBundleCacheControl);
  },
};

export default defineConfig({
  plugins: [react(), bundleCacheHeaders],
  publicDir: assetBundleRoot,
  build: { target: "es2022" },
});
