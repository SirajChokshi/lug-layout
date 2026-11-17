import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const assetBundleRoot = fileURLToPath(new URL("../../tools/asset-pipeline/dist", import.meta.url));
const BUNDLE_PATH = /^\/bundle\/[^/]+\/(?<file>[^/]+)$/u;
const CONTENT_ADDRESSED_FILE = /\.[0-9a-f]{16}\.(?:glb|json|wasm)$/u;
const ABSOLUTE_HTTP_URL = /^https?:\/\//u;
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

function servesRemoteBundle(env: Record<string, string>): boolean {
  const remote = ABSOLUTE_HTTP_URL.test(env["VITE_BUNDLE_BASE_URL"] ?? "");
  if (process.env["VERCEL"] && !remote) {
    throw new Error("Vercel builds load the part bundle from R2: set VITE_BUNDLE_BASE_URL");
  }
  if (remote && !env["VITE_BUNDLE_MANIFEST_FILE"]) {
    throw new Error(
      "VITE_BUNDLE_MANIFEST_FILE must name the published manifest: node tools/asset-pipeline/src/cli.ts await-served",
    );
  }
  return remote;
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), bundleCacheHeaders],
  publicDir: servesRemoteBundle(loadEnv(mode, appRoot, "VITE_")) ? false : assetBundleRoot,
  build: { target: "es2022" },
}));
