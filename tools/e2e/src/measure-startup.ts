import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { chromium, type BrowserContext, type CDPSession } from "playwright-core";

const DEFAULT_CHROME = "/usr/local/bin/google-chrome";
const NSS_NICKNAME = "brr-measure-startup";
const VIEWPORT = { width: 1600, height: 900 } as const;
const READY_TIMEOUT_MS = 900_000;
const SETTLED = ["ready", "error"];
const MS_PER_S = 1000;
const BITS_PER_BYTE = 8;
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
const CONTENT_ADDRESSED = /\.[0-9a-f]{16}\.(?:glb|json|wasm|png|webp)$/u;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".glb": "model/gltf-binary",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".webp": "image/webp",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

interface NetworkProfile {
  readonly downloadMbps: number;
  readonly uploadMbps: number;
  readonly latencyMs: number;
}

const PROFILES: Readonly<Record<string, NetworkProfile | null>> = {
  none: null,
  desktop: { downloadMbps: 10, uploadMbps: 10, latencyMs: 40 },
  slow4g: { downloadMbps: 1.6, uploadMbps: 0.75, latencyMs: 150 },
};

type Compression = "json" | "all" | "none";

interface RequestTally {
  requests: number;
  encodedBytes: number;
  decodedBytes: number;
  fromCache: number;
}

interface RunResult {
  readonly profile: string;
  readonly cache: "cold" | "warm";
  readonly status: string;
  readonly readyMs: number;
  readonly bundle: RequestTally;
  readonly app: RequestTally;
  readonly byKind: Readonly<Record<string, RequestTally>>;
}

const { values } = parseArgs({
  options: {
    app: { type: "string", default: "apps/web/dist" },
    bundle: { type: "string", default: "tools/asset-pipeline/dist/bundle" },
    "app-port": { type: "string", default: "4180" },
    "bundle-port": { type: "string", default: "4443" },
    profiles: { type: "string", default: "none,desktop" },
    compress: { type: "string", default: "json" },
    query: { type: "string", default: "?api=webgl2" },
    out: { type: "string" },
    chrome: { type: "string" },
    serve: { type: "boolean", default: false },
  },
});

function compression(value: string | undefined): Compression {
  if (value === "json" || value === "all" || value === "none") return value;
  throw new Error(`--compress must be json, all or none, not ${String(value)}`);
}

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
}

function inside(root: string, urlPath: string): string | null {
  const path = normalize(join(root, decodeURIComponent(urlPath.split("?")[0] ?? "/")));
  return path.startsWith(root) ? path : null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function shouldCompress(mode: Compression, type: string): boolean {
  switch (mode) {
    case "all":
      return true;
    case "json":
      return type === "application/json";
    case "none":
      return false;
    default: {
      const unhandled: never = mode;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

interface Certificate {
  readonly key: Buffer;
  readonly cert: Buffer;
}

function selfSignedCert(): Certificate {
  const dir = mkdtempSync(join(tmpdir(), "measure-startup-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  trustForCaching(cert);
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function certutil(args: ReadonlyArray<string>): boolean {
  try {
    execFileSync("certutil", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function trustForCaching(cert: string): void {
  const nssDb = join(homedir(), ".pki", "nssdb");
  const db = `sql:${nssDb}`;
  mkdirSync(nssDb, { recursive: true });
  if (!isFile(join(nssDb, "cert9.db"))) certutil(["-d", db, "-N", "--empty-password"]);
  certutil(["-d", db, "-D", "-n", NSS_NICKNAME]);
  if (!certutil(["-d", db, "-A", "-t", "P,,", "-n", NSS_NICKNAME, "-i", cert])) {
    process.stderr.write(
      "certutil could not trust the bundle certificate, so Chrome will not cache bundle responses\n",
    );
  }
}

function serveBundle(
  root: string,
  port: number,
  mode: Compression,
  certificate: Certificate,
): Promise<() => void> {
  const server = createSecureServer({
    key: certificate.key,
    cert: certificate.cert,
    allowHTTP1: true,
  });
  server.on("request", (request: Http2ServerRequest, response: Http2ServerResponse) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    const path = inside(root, request.url);
    if (path === null || !isFile(path)) {
      response.writeHead(404).end();
      return;
    }
    const type = contentType(path);
    const body = readFileSync(path);
    const gzip =
      shouldCompress(mode, type) && String(request.headers["accept-encoding"]).includes("gzip");
    response.setHeader("Content-Type", type);
    response.setHeader("Cache-Control", CONTENT_ADDRESSED.test(path) ? IMMUTABLE : REVALIDATE);
    if (gzip) response.setHeader("Content-Encoding", "gzip");
    response.writeHead(200).end(gzip ? gzipSync(body) : body);
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(() => server.close())));
}

function serveApp(root: string, port: number): Promise<() => void> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = inside(root, request.url ?? "/");
    const file = path !== null && isFile(path) ? path : join(root, "index.html");
    const type = contentType(file);
    const body = readFileSync(file);
    const gzip = String(request.headers["accept-encoding"]).includes("gzip");
    response.setHeader("Content-Type", type);
    if (gzip) response.setHeader("Content-Encoding", "gzip");
    response.writeHead(200).end(gzip ? gzipSync(body) : body);
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(() => server.close())));
}

function emptyTally(): RequestTally {
  return { requests: 0, encodedBytes: 0, decodedBytes: 0, fromCache: 0 };
}

function kindOf(url: string): string {
  const name = new URL(url).pathname.split("/").pop() ?? "";
  if (name.startsWith("manifest")) return "manifest";
  return extname(name).slice(1) || "other";
}

function bytesPerSecond(mbps: number): number {
  return (mbps * 1_000_000) / BITS_PER_BYTE;
}

async function throttle(cdp: CDPSession, profile: NetworkProfile | null): Promise<void> {
  if (profile === null) return;
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: profile.latencyMs,
    downloadThroughput: bytesPerSecond(profile.downloadMbps),
    uploadThroughput: bytesPerSecond(profile.uploadMbps),
  });
}

async function run(
  context: BrowserContext,
  appUrl: string,
  bundleOrigin: string,
  profileName: string,
  cache: "cold" | "warm",
): Promise<RunResult> {
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await throttle(cdp, PROFILES[profileName] ?? null);
  const urls = new Map<string, string>();
  const bundle = emptyTally();
  const app = emptyTally();
  const byKind: Record<string, RequestTally> = {};
  cdp.on("Network.requestWillBeSent", (event) => urls.set(event.requestId, event.request.url));
  const cached = new Set<string>();
  cdp.on("Network.requestServedFromCache", (event) => cached.add(event.requestId));
  cdp.on("Network.responseReceived", (event) => {
    if (event.response.fromDiskCache) cached.add(event.requestId);
  });
  cdp.on("Network.dataReceived", (event) => {
    const url = urls.get(event.requestId);
    if (url === undefined) return;
    const tally = url.startsWith(bundleOrigin) ? bundle : app;
    tally.decodedBytes += event.dataLength;
    if (url.startsWith(bundleOrigin)) {
      const kind = (byKind[kindOf(url)] ??= emptyTally());
      kind.decodedBytes += event.dataLength;
    }
  });
  cdp.on("Network.loadingFinished", (event) => {
    const url = urls.get(event.requestId);
    if (url === undefined) return;
    const tally = url.startsWith(bundleOrigin) ? bundle : app;
    tally.requests += 1;
    tally.encodedBytes += event.encodedDataLength;
    if (cached.has(event.requestId)) tally.fromCache += 1;
    if (url.startsWith(bundleOrigin)) {
      const kind = (byKind[kindOf(url)] ??= emptyTally());
      kind.requests += 1;
      kind.encodedBytes += event.encodedDataLength;
      if (cached.has(event.requestId)) kind.fromCache += 1;
    }
  });
  await page.goto(appUrl, { waitUntil: "commit" });
  const handle = await page.waitForFunction(
    (settled) => {
      const status = document.querySelector(".editor")?.getAttribute("data-status");
      return status !== null && status !== undefined && settled.includes(status)
        ? { status, at: performance.now() }
        : null;
    },
    SETTLED,
    { timeout: READY_TIMEOUT_MS, polling: 50 },
  );
  const { status, at } = (await handle.jsonValue()) ?? { status: "unknown", at: 0 };
  await page.close();
  return { profile: profileName, cache, status, readyMs: Math.round(at), bundle, app, byKind };
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(2);
}

function report(results: ReadonlyArray<RunResult>): string {
  const rows = results.map(
    (r) =>
      `| ${r.profile} | ${r.cache} | ${r.status} | ${(r.readyMs / MS_PER_S).toFixed(1)} | ${r.bundle.requests} | ${r.bundle.fromCache} | ${megabytes(r.bundle.encodedBytes)} | ${megabytes(r.bundle.decodedBytes)} | ${r.app.requests} | ${megabytes(r.app.encodedBytes)} |`,
  );
  return [
    "| network | cache | status | ready (s) | bundle requests | from cache | bundle MB transferred | bundle MB decoded | app requests | app MB transferred |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

async function main(): Promise<void> {
  const appRoot = resolve(values.app ?? "apps/web/dist");
  const bundleRoot = resolve(values.bundle ?? "tools/asset-pipeline/dist/bundle");
  const appPort = Number(values["app-port"]);
  const bundlePort = Number(values["bundle-port"]);
  const bundleOrigin = `https://127.0.0.1:${bundlePort}/`;
  const certificate = selfSignedCert();
  const stopBundle = await serveBundle(
    bundleRoot,
    bundlePort,
    compression(values.compress),
    certificate,
  );
  const stopApp = await serveApp(appRoot, appPort);
  if (values.serve) {
    process.stdout.write(
      `serving http://127.0.0.1:${appPort}/ with the bundle at ${bundleOrigin}\n`,
    );
    return;
  }
  const results: RunResult[] = [];
  try {
    for (const profile of (values.profiles ?? "none").split(",")) {
      if (!(profile in PROFILES)) throw new Error(`unknown profile ${profile}`);
      const context = await chromium.launchPersistentContext(
        mkdtempSync(join(tmpdir(), "measure-startup-profile-")),
        {
          executablePath: values.chrome ?? process.env["CHROME"] ?? DEFAULT_CHROME,
          args: [
            "--ignore-gpu-blocklist",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
          ],
          viewport: VIEWPORT,
          deviceScaleFactor: 1,
        },
      );
      const appUrl = `http://127.0.0.1:${appPort}/${values.query ?? ""}`;
      results.push(await run(context, appUrl, bundleOrigin, profile, "cold"));
      results.push(await run(context, appUrl, bundleOrigin, profile, "warm"));
      await context.close();
    }
  } finally {
    stopApp();
    stopBundle();
  }
  const table = report(results);
  process.stdout.write(`${table}\n`);
  if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 2));
}

await main();
