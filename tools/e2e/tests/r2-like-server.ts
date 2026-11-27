import type { BrowserContext } from "@playwright/test";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_BUCKET = new URL("../../asset-pipeline/dist/", import.meta.url);
const BUCKET_PATH = /^\/(?:bundle|library-connectors|shadow-library)\//u;
const HTTP_OK = 200;
const HTTP_TEMPORARY_REDIRECT = 307;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const RETRY_AFTER_S = "1";
const OPAQUE_FAILURE = "net::ERR_FAILED";
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".glb": "model/gltf-binary",
  ".json": "application/json",
  ".png": "image/png",
  ".wasm": "application/wasm",
};

export interface Throttle {
  readonly startsAt: (path: string, served: number) => boolean;
  readonly lockoutMs: number;
}

function corsFor(request: IncomingMessage): Record<string, string> {
  return request.headers.origin === undefined ? {} : { "Access-Control-Allow-Origin": "*" };
}

async function serveFile(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://bucket").pathname);
  const file = new URL(`.${pathname}`, BUNDLE_BUCKET);
  const found = BUCKET_PATH.test(pathname)
    ? await stat(file).then(
        (info) => (info.isFile() ? info : null),
        () => null,
      )
    : null;
  if (found === null) {
    response.writeHead(HTTP_NOT_FOUND, corsFor(request)).end();
    return;
  }
  response.writeHead(HTTP_OK, {
    ...corsFor(request),
    "Content-Length": found.size,
    "Content-Type": CONTENT_TYPES[extname(pathname)] ?? "application/octet-stream",
  });
  createReadStream(fileURLToPath(file)).pipe(response);
}

export class R2LikeServer {
  private served = 0;
  private readonly refusals: string[] = [];
  private opaqueFailures = 0;
  private lockedUntilMs = 0;
  private throttled = false;

  private constructor(
    private readonly throttle: Throttle | null,
    private readonly close: () => Promise<void>,
  ) {}

  static async serve(
    context: BrowserContext,
    pageOrigin: string,
    throttle: Throttle | null = null,
  ): Promise<R2LikeServer> {
    const server = createServer((request, response) => bucket.answer(request, response));
    const bucket = new R2LikeServer(throttle, () => {
      server.closeAllConnections();
      return new Promise((closed) => server.close(() => closed()));
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    context.on("requestfailed", (request) => {
      if (request.url().startsWith(origin) && request.failure()?.errorText === OPAQUE_FAILURE) {
        bucket.opaqueFailures += 1;
      }
    });
    await context.route(
      (url) => url.origin === pageOrigin && BUCKET_PATH.test(url.pathname),
      (route) => {
        const { pathname, search } = new URL(route.request().url());
        return route.fulfill({
          status: HTTP_TEMPORARY_REDIRECT,
          headers: { Location: `${origin}${pathname}${search}` },
        });
      },
    );
    return bucket;
  }

  refused(): ReadonlyArray<string> {
    return this.refusals;
  }

  failedOpaquely(): number {
    return this.opaqueFailures;
  }

  stop(): Promise<void> {
    return this.close();
  }

  private answer(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? "/", "http://bucket").pathname;
    if (this.throttle !== null && !this.throttled && this.throttle.startsAt(path, this.served)) {
      this.throttled = true;
      this.lockedUntilMs = performance.now() + this.throttle.lockoutMs;
    }
    if (performance.now() < this.lockedUntilMs) {
      this.refusals.push(path);
      response
        .writeHead(HTTP_TOO_MANY_REQUESTS, { "Retry-After": RETRY_AFTER_S })
        .end("rate limited");
      return;
    }
    this.served += 1;
    void serveFile(request, response);
  }
}
