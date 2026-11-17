import type { ErrorResponse } from "@brr/schema/catalog-api";
import type * as v from "valibot";

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const POINTER_CACHE = "public, max-age=60";
export const CLIENT_ERROR_CACHE = "public, max-age=300";
export const NO_STORE = "no-store";
export const RATE_LIMIT_RETRY_SECONDS = 60;

export interface D1Cost {
  readonly durationMs: number;
  readonly rowsRead: number;
}

const corsHeaders: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "If-None-Match, Range",
  "access-control-expose-headers":
    "ETag, Content-Range, Accept-Ranges, Server-Timing, X-Catalog-Release, X-Cache, X-D1-Rows-Read",
  "access-control-max-age": "86400",
};

export function withCors(headers: Headers): Headers {
  for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
  return headers;
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: withCors(new Headers()) });
}

export function releaseEtag(releaseId: string): string {
  return `"${releaseId}"`;
}

export function json(
  body: unknown,
  status: number,
  cacheControl: string,
  extra: Readonly<Record<string, string>> = {},
): Response {
  const headers = withCors(
    new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    }),
  );
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

export function problem(status: number, message: string, cacheControl: string): Response {
  const body: v.InferInput<typeof ErrorResponse> = { error: message };
  return json(body, status, cacheControl);
}

export function tooManyRequests(): Response {
  const body: v.InferInput<typeof ErrorResponse> = { error: "rate limit exceeded" };
  return json(body, 429, NO_STORE, {
    "retry-after": String(RATE_LIMIT_RETRY_SECONDS),
  });
}

export function immutableJson(body: unknown, releaseId: string, cost: D1Cost): Response {
  return json(body, 200, IMMUTABLE_CACHE, {
    etag: releaseEtag(releaseId),
    "x-catalog-release": releaseId,
    "server-timing": `d1;dur=${cost.durationMs.toFixed(3)}`,
    "x-d1-rows-read": String(cost.rowsRead),
  });
}

export function notModified(releaseId: string): Response {
  const headers = withCors(
    new Headers({ etag: releaseEtag(releaseId), "cache-control": IMMUTABLE_CACHE }),
  );
  return new Response(null, { status: 304, headers });
}

export function matchesEtag(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === etag);
}

export function withoutBody(response: Response): Response {
  return new Response(null, { status: response.status, headers: response.headers });
}
