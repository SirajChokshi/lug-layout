import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const assetBundleRoot = fileURLToPath(new URL("../../tools/asset-pipeline/dist", import.meta.url));
const libraryBakeRoot = fileURLToPath(new URL("../../.cache/library-bake", import.meta.url));
const LIBRARY_BAKE_PATH = /^\/library-bake\/(?<file>(?:[\w.-]+\/)?[\w.-]+)$/u;
const HTTP_NOT_FOUND = 404;
const BUNDLE_PATH = /^\/bundle\/[^/]+\/(?<file>.+)$/u;
const CONTENT_ADDRESSED_FILE = /\.[0-9a-f]{16}\.(?:glb|json|wasm|png)$/u;
const ABSOLUTE_HTTP_URL = /^https?:\/\//u;
const ldrawLibraryConfig = new URL("../../infra/cloudflare/ldraw-library.json", import.meta.url);
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

const serveLibraryBake: Connect.NextHandleFunction = (request, response, next) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = LIBRARY_BAKE_PATH.exec(pathname)?.groups?.["file"];
  if (file === undefined || file.split("/").some((segment) => segment.startsWith("."))) {
    next();
    return;
  }
  readFile(join(libraryBakeRoot, file)).then(
    (bytes) => {
      response.setHeader("Cache-Control", IMMUTABLE);
      response.end(bytes);
    },
    () => {
      response.statusCode = HTTP_NOT_FOUND;
      response.end();
    },
  );
};

const libraryBakeFiles: Plugin = {
  name: "brr-library-bake-files",
  configureServer(server) {
    server.middlewares.use(serveLibraryBake);
  },
  configurePreviewServer(server) {
    server.middlewares.use(serveLibraryBake);
  },
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
      "VITE_BUNDLE_MANIFEST_FILE must name a published manifest for when current/latest.json can't be read: manifest_file in infra/cloudflare/bundle-fallback.json",
    );
  }
  return remote;
}

function ldrawLibraryPublished(): boolean {
  const config = JSON.parse(readFileSync(ldrawLibraryConfig, "utf8")) as {
    readonly public_base_url?: string | null;
  };
  return typeof config.public_base_url === "string" && config.public_base_url !== "";
}

function requireRemoteLdrawLibrary(env: Record<string, string>): void {
  if (!process.env["VERCEL"] || !ldrawLibraryPublished()) return;
  if (!ABSOLUTE_HTTP_URL.test(env["VITE_LDRAW_LIBRARY_BASE_URL"] ?? "")) {
    throw new Error(
      "ldraw-library.json has a public_base_url, so Vercel builds read LDraw library files from R2: set VITE_LDRAW_LIBRARY_BASE_URL (docs/ldraw-library.md)",
    );
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, appRoot, "VITE_");
  requireRemoteLdrawLibrary(env);
  const remote = servesRemoteBundle(env);
  return {
    plugins: remote
      ? [react(), bundleCacheHeaders]
      : [react(), bundleCacheHeaders, libraryBakeFiles],
    publicDir: remote ? false : assetBundleRoot,
    build: { target: "es2022" },
  };
});
