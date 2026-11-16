import { IMMUTABLE_CACHE, NO_STORE, problem, withCors } from "./http.ts";
import type { CatalogRelease } from "./releases.ts";

const SQLITE_CONTENT_TYPE = "application/vnd.sqlite3";

export async function sqliteDownload(
  bucket: R2Bucket,
  release: CatalogRelease,
  request: Request,
): Promise<Response> {
  const object = await bucket.get(release.objectKey, {
    onlyIf: request.headers,
    range: request.headers,
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
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  const range = servedRange(object.range, object.size);
  if (range === undefined) {
    headers.set("content-length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  }
  headers.set("content-range", `bytes ${range.start}-${range.end}/${object.size}`);
  headers.set("content-length", String(range.end - range.start + 1));
  return new Response(object.body, { status: 206, headers });
}

function servedRange(
  range: R2Range | undefined,
  size: number,
): { readonly start: number; readonly end: number } | undefined {
  if (range === undefined) return undefined;
  if ("suffix" in range && range.suffix !== undefined) {
    const length = Math.min(range.suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const start = "offset" in range && range.offset !== undefined ? range.offset : 0;
  const length = "length" in range && range.length !== undefined ? range.length : size - start;
  if (start === 0 && length >= size) return undefined;
  return { start, end: Math.min(size, start + length) - 1 };
}
