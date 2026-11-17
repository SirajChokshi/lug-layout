import type {
  BundleSearchResponse,
  CatalogRelease,
  ReleaseResponse,
  SearchResponse,
} from "@brr/schema/catalog-api";
import type * as v from "valibot";
import { BundleSearchDirectory, type BundleReader } from "./bundle-search.ts";
import {
  searchCatalog,
  setInventory,
  themePage,
  themeRoots,
  type CatalogReader,
} from "./catalog-queries.ts";
import {
  CLIENT_ERROR_CACHE,
  NO_STORE,
  POINTER_CACHE,
  immutableBundleJson,
  immutableJson,
  json,
  matchesEtag,
  notModified,
  preflight,
  problem,
  versionEtag,
  tooManyRequests,
  withCors,
  withoutBody,
} from "./http.ts";
import { ReleaseDirectory } from "./releases.ts";
import { canonicalUrl, parseRoute, releaseHref, sqliteHref, type Route } from "./routes.ts";
import {
  parseRange,
  rangeNotSatisfiable,
  sqliteCacheKey,
  sqliteFromStorage,
} from "./sqlite-download.ts";

export interface CatalogEnv {
  readonly CATALOG_DB: D1Database;
  readonly CATALOG_RELEASES: R2Bucket;
  readonly QUERY_RATE_LIMIT: RateLimit;
  readonly FILE_RATE_LIMIT: RateLimit;
  readonly PART_BUNDLES: BundleReader;
}

export const DATA_ATTRIBUTION = "Catalog data from Rebrickable (https://rebrickable.com)";

export interface EdgeContext {
  waitUntil(promise: Promise<unknown>): void;
}

type VersionedRoute = Exclude<
  Route,
  { kind: "current" } | { kind: "current-redirect" } | { kind: "bundle-search" }
>;

const releases = new ReleaseDirectory();
const bundleIndexes = new BundleSearchDirectory();

export async function handleRequest(
  request: Request,
  env: CatalogEnv,
  context: EdgeContext,
  edgeCache: Cache,
): Promise<Response> {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = problem(405, "only GET, HEAD and OPTIONS are supported", NO_STORE);
    response.headers.set("allow", "GET, HEAD, OPTIONS");
    return response;
  }
  const response = await respond(request, env, context, edgeCache);
  return request.method === "HEAD" ? withoutBody(response) : response;
}

async function respond(
  request: Request,
  env: CatalogEnv,
  context: EdgeContext,
  edgeCache: Cache,
): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseRoute(url);
  switch (parsed.kind) {
    case "not-found":
      return problem(404, "no such endpoint", CLIENT_ERROR_CACHE);
    case "invalid":
      return problem(400, parsed.message, CLIENT_ERROR_CACHE);
    case "route":
      break;
    default: {
      const exhaustive: never = parsed;
      throw new Error(`unhandled route result ${String(exhaustive)}`);
    }
  }
  const route = parsed.route;
  if (route.kind === "bundle-search") {
    return respondBundleSearch(route, request, url, env, context, edgeCache);
  }
  const db = env.CATALOG_DB.withSession("first-unconstrained");
  if (route.kind === "current" || route.kind === "current-redirect") {
    return respondCurrent(route, url, db);
  }
  if (route.kind === "sqlite") {
    return respondSqlite(route.release, request, url, env, context, edgeCache, db);
  }
  if (matchesEtag(request, versionEtag(route.release))) return notModified(route.release);
  const cacheKey = new Request(canonicalUrl(url.origin, route), { method: "GET" });
  const cached = await edgeCache.match(cacheKey);
  if (cached !== undefined) return tagged(cached, "HIT");
  if (!(await allowed(env.QUERY_RATE_LIMIT, request))) return tooManyRequests();
  const release = await releases.find(db, route.release, Date.now());
  if (release === undefined) return unknownRelease(route.release);
  const fresh = await respondVersioned(route, release, url.origin, db);
  context.waitUntil(edgeCache.put(cacheKey, fresh.clone()));
  return tagged(fresh, "MISS");
}

async function respondBundleSearch(
  route: Extract<Route, { kind: "bundle-search" }>,
  request: Request,
  url: URL,
  env: CatalogEnv,
  context: EdgeContext,
  edgeCache: Cache,
): Promise<Response> {
  if (matchesEtag(request, versionEtag(route.manifest))) return notModified(route.manifest);
  const cacheKey = new Request(canonicalUrl(url.origin, route), { method: "GET" });
  const cached = await edgeCache.match(cacheKey);
  if (cached !== undefined) return tagged(cached, "HIT");
  if (!(await allowed(env.QUERY_RATE_LIMIT, request))) return tooManyRequests();
  const loaded = await bundleIndexes.find(env.PART_BUNDLES, route.manifest);
  switch (loaded.kind) {
    case "missing":
      return problem(404, `part bundle manifest ${route.manifest} is not published`, NO_STORE);
    case "unreadable":
      return problem(
        502,
        `part bundle manifest ${route.manifest} does not decode: ${loaded.message}`,
        NO_STORE,
      );
    case "found":
      break;
    default: {
      const exhaustive: never = loaded;
      throw new Error(`unhandled bundle index ${String(exhaustive)}`);
    }
  }
  const { q, limit } = route.params;
  const body: v.InferInput<typeof BundleSearchResponse> = {
    manifest: route.manifest,
    query: q.join(" "),
    results: [...loaded.index.search(q, limit)],
  };
  const fresh = immutableBundleJson(body, route.manifest);
  context.waitUntil(edgeCache.put(cacheKey, fresh.clone()));
  return tagged(fresh, "MISS");
}

async function respondSqlite(
  releaseId: string,
  request: Request,
  url: URL,
  env: CatalogEnv,
  context: EdgeContext,
  edgeCache: Cache,
  db: CatalogReader,
): Promise<Response> {
  const cacheUrl = sqliteHref(url.origin, releaseId);
  const cached = await edgeCache.match(new Request(cacheUrl, { headers: request.headers }));
  if (cached !== undefined) return tagged(cached, "HIT");
  if (!(await allowed(env.FILE_RATE_LIMIT, request))) return tooManyRequests();
  const release = await releases.find(db, releaseId, Date.now());
  if (release === undefined) return unknownRelease(releaseId);
  const range = parseRange(request.headers.get("range"), release.bytes);
  if (range.kind === "unsatisfiable") return rangeNotSatisfiable(release);
  const fresh = await sqliteFromStorage(env.CATALOG_RELEASES, release, request, range);
  if (fresh.status !== 200 || fresh.body === null) return tagged(fresh, "MISS");
  const [client, stored] = fresh.body.tee();
  context.waitUntil(edgeCache.put(sqliteCacheKey(cacheUrl), new Response(stored, fresh)));
  return tagged(new Response(client, fresh), "MISS");
}

async function respondCurrent(
  route: Extract<Route, { kind: "current" } | { kind: "current-redirect" }>,
  url: URL,
  db: CatalogReader,
): Promise<Response> {
  const current = await releases.findCurrent(db, Date.now());
  if (current === undefined) return problem(503, "no catalog release is loaded", NO_STORE);
  if (route.kind === "current") {
    return json(releaseBody(url.origin, current), 200, POINTER_CACHE, {
      "x-catalog-release": current.id,
    });
  }
  const headers = withCors(
    new Headers({
      location: `${releaseHref(url.origin, current.id)}${route.rest}${url.search}`,
      "cache-control": POINTER_CACHE,
      "x-catalog-release": current.id,
    }),
  );
  return new Response(null, { status: 307, headers });
}

async function respondVersioned(
  route: Exclude<VersionedRoute, { kind: "sqlite" }>,
  release: CatalogRelease,
  origin: string,
  db: CatalogReader,
): Promise<Response> {
  switch (route.kind) {
    case "release":
      return immutableJson(releaseBody(origin, release), release.id, {
        durationMs: 0,
        rowsRead: 0,
      });
    case "search": {
      const { q, kind, limit } = route.params;
      const { value, cost } = await searchCatalog(db, origin, release.id, q, kind, limit);
      const body: v.InferInput<typeof SearchResponse> = {
        release: release.id,
        query: q.join(" "),
        results: value,
      };
      return immutableJson(body, release.id, cost);
    }
    case "inventory": {
      const { value, cost } = await setInventory(db, origin, release.id, route.setNum);
      if (value === undefined) return problem(404, `no set ${route.setNum}`, CLIENT_ERROR_CACHE);
      return immutableJson(value, release.id, cost);
    }
    case "theme-roots": {
      const { value, cost } = await themeRoots(db, origin, release.id);
      return immutableJson(value, release.id, cost);
    }
    case "theme": {
      const { limit, offset } = route.params;
      const { value, cost } = await themePage(db, origin, release.id, route.themeId, limit, offset);
      if (value === undefined) return problem(404, `no theme ${route.themeId}`, CLIENT_ERROR_CACHE);
      return immutableJson(value, release.id, cost);
    }
    default: {
      const exhaustive: never = route;
      throw new Error(`unhandled versioned route ${String(exhaustive)}`);
    }
  }
}

async function allowed(limiter: RateLimit, request: Request): Promise<boolean> {
  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  const outcome = await limiter.limit({ key: client });
  return outcome.success;
}

function unknownRelease(id: string): Response {
  return problem(404, `catalog release ${id} is not loaded; see /v1/catalogs/current`, NO_STORE);
}

function tagged(response: Response, cache: "HIT" | "MISS"): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("x-cache", cache);
  if (cache === "HIT") {
    copy.headers.delete("server-timing");
    copy.headers.delete("x-d1-rows-read");
  }
  return copy;
}

function releaseBody(
  origin: string,
  release: CatalogRelease,
): v.InferInput<typeof ReleaseResponse> {
  const self = releaseHref(origin, release.id);
  return {
    release: {
      id: release.id,
      sha256: release.sha256,
      bytes: release.bytes,
      source: release.source,
      loadedAt: release.loaded_at,
      counts: release.counts,
      attribution: DATA_ATTRIBUTION,
      links: {
        self,
        search: `${self}/search`,
        themes: `${self}/themes`,
        sqlite: sqliteHref(origin, release.id),
      },
    },
  };
}
