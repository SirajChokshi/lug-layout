import { IMMUTABLE_CACHE, NO_STORE, problem, withCors } from "./http.ts";
import type { CatalogRelease } from "@brr/schema/catalog-api";

const SQLITE_CONTENT_TYPE = "application/vnd.sqlite3";

export type ByteRange =
  | { readonly kind: "whole" }
  | { readonly kind: "slice"; readonly offset: number; readonly length: number }
  | { readonly kind: "unsatisfiable" };

const singleRange = /^bytes=(\d*)-(\d*)$/;

export function parseRange(header: string | null, size: number): ByteRange {
  if (header === null) return { kind: "whole" };
  const match = singleRange.exec(header.trim());
  if (match === null) return { kind: "whole" };
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return { kind: "whole" };
  if (first === "") {
    const suffix = Math.min(Number(last), size);
    if (suffix === 0) return { kind: "unsatisfiable" };
    return { kind: "slice", offset: size - suffix, length: suffix };
  }
  const offset = Number(first);
  if (offset >= size) return { kind: "unsatisfiable" };
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < offset) return { kind: "whole" };
  return { kind: "slice", offset, length: end - offset + 1 };
}

export function sqliteCacheKey(url: string): Request {
  return new Request(url, { method: "GET" });
}

export function rangeNotSatisfiable(release: CatalogRelease): Response {
  const headers = withCors(
    new Headers({ "content-range": `bytes */${release.bytes}`, "cache-control": NO_STORE }),
  );
  return new Response(null, { status: 416, headers });
}

export async function sqliteFromStorage(
  bucket: R2Bucket,
  release: CatalogRelease,
  request: Request,
  range: Exclude<ByteRange, { kind: "unsatisfiable" }>,
): Promise<Response> {
  const object = await bucket.get(release.object_key, {
    onlyIf: request.headers,
    ...(range.kind === "slice" ? { range: { offset: range.offset, length: range.length } } : {}),
  });
  if (object === null) return problem(404, "release file is missing from storage", NO_STORE);
  const headers = withCors(new Headers());
  object.writeHttpMetadata(headers);
  headers.set("content-type", SQLITE_CONTENT_TYPE);
  headers.set("cache-control", IMMUTABLE_CACHE);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("x-catalog-release", release.id);
  headers.set("x-content-sha256", release.sha256);
  headers.set("content-disposition", `attachment; filename="brr-catalog-${release.id}.sqlite"`);
  if (!("body" in object)) {
    return new Response(null, {
      status: failsWritePrecondition(request, object) ? 412 : 304,
      headers,
    });
  }
  if (range.kind === "whole") {
    headers.set("content-length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  }
  headers.set(
    "content-range",
    `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
  );
  headers.set("content-length", String(range.length));
  return new Response(object.body, { status: 206, headers });
}

function failsWritePrecondition(request: Request, object: R2Object): boolean {
  const ifMatch = request.headers.get("if-match");
  if (ifMatch !== null) {
    const accepted = ifMatch
      .split(",")
      .map((candidate) => candidate.trim().replace(/^W\//, ""))
      .some((candidate) => candidate === "*" || candidate === object.httpEtag);
    if (!accepted) return true;
  }
  const ifUnmodifiedSince = request.headers.get("if-unmodified-since");
  if (ifUnmodifiedSince !== null) {
    const since = Date.parse(ifUnmodifiedSince);
    if (!Number.isNaN(since) && object.uploaded.getTime() > since + 999) return true;
  }
  return false;
}
