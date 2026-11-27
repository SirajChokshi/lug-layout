import { issueText, type Issue } from "@brr/schema/decode";
import type { ErrorResponse } from "@brr/schema/layout-api";
import type * as v from "valibot";

export const NO_STORE = "no-store";
export const IMMUTABLE_PRIVATE = "private, max-age=31536000, immutable";
export const RATE_LIMIT_RETRY_SECONDS = 60;
const MS_PER_SECOND = 1000;

const corsHeaders: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, If-None-Match",
  "access-control-expose-headers": "ETag, Retry-After, Location",
  "access-control-max-age": "86400",
};

export function withCors(headers: Headers): Headers {
  for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
  return headers;
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: withCors(new Headers()) });
}

export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

export function json(
  body: unknown,
  status: number,
  extra: Readonly<Record<string, string>> = {},
): Response {
  const headers = withCors(
    new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": NO_STORE }),
  );
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

export function problem(
  status: number,
  message: string,
  extra: Readonly<Record<string, string>> = {},
): Response {
  const body: v.InferInput<typeof ErrorResponse> = { error: message };
  return json(body, status, extra);
}

export function issuesProblem(status: number, issues: ReadonlyArray<Issue>): Response {
  return problem(status, issueText(issues));
}

export function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: withCors(new Headers({ "cache-control": NO_STORE })),
  });
}

export function tooManyRequests(message: string, retryAfter: number): Response {
  return problem(429, message, { "retry-after": String(Math.max(1, retryAfter)) });
}

export function retryAfterSeconds(retryAt: number, now: number): number {
  return Math.ceil((retryAt - now) / MS_PER_SECOND);
}

export function unauthorized(message: string): Response {
  return problem(401, message, { "www-authenticate": 'Bearer realm="brick-railroad"' });
}

export function versionEtag(sha256: string): string {
  return `"${sha256}"`;
}

export function matchesEtag(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//u, ""))
    .some((candidate) => candidate === etag);
}

export function contentAddressed(
  body: ReadableStream | null,
  sha256: string,
  contentType: string,
  bytes: number,
): Response {
  const headers = withCors(
    new Headers({
      "content-type": contentType,
      "content-length": String(bytes),
      "cache-control": IMMUTABLE_PRIVATE,
      etag: versionEtag(sha256),
    }),
  );
  return new Response(body, { status: 200, headers });
}

export function notModified(sha256: string): Response {
  const headers = withCors(
    new Headers({ etag: versionEtag(sha256), "cache-control": IMMUTABLE_PRIVATE }),
  );
  return new Response(null, { status: 304, headers });
}

export function withoutBody(response: Response): Response {
  return new Response(null, { status: response.status, headers: response.headers });
}
