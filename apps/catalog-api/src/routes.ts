import { RELEASE_ID_HEX_LENGTH } from "./release-schema.ts";

export const SEARCH_KINDS = ["set", "module", "part"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_LIMIT = { default: 20, max: 50 } as const;
export const THEME_PAGE_LIMIT = { default: 50, max: 100 } as const;
export const THEME_MAX_OFFSET = 10_000;
export const MAX_QUERY_TOKENS = 8;
export const MAX_TOKEN_LENGTH = 40;

export type Route =
  | { readonly kind: "current" }
  | { readonly kind: "current-redirect"; readonly rest: string }
  | { readonly kind: "release"; readonly release: string }
  | {
      readonly kind: "search";
      readonly release: string;
      readonly tokens: ReadonlyArray<string>;
      readonly kinds: ReadonlyArray<SearchKind>;
      readonly limit: number;
    }
  | { readonly kind: "inventory"; readonly release: string; readonly setNum: string }
  | { readonly kind: "theme-roots"; readonly release: string }
  | {
      readonly kind: "theme";
      readonly release: string;
      readonly themeId: number;
      readonly limit: number;
      readonly offset: number;
    }
  | { readonly kind: "sqlite"; readonly release: string };

export type RouteResult =
  | { readonly kind: "route"; readonly route: Route }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "not-found" };

const releaseSegment = `([0-9a-f]{${RELEASE_ID_HEX_LENGTH}})`;
const currentPath = /^\/v1\/catalogs\/current$/;
const currentRedirectPath = /^\/v1\/catalogs\/current(\/.+)$/;
const releasePath = new RegExp(`^/v1/catalogs/${releaseSegment}$`);
const searchPath = new RegExp(`^/v1/catalogs/${releaseSegment}/search$`);
const inventoryPath = new RegExp(`^/v1/catalogs/${releaseSegment}/sets/([^/]+)/inventory$`);
const themeRootsPath = new RegExp(`^/v1/catalogs/${releaseSegment}/themes$`);
const themePath = new RegExp(`^/v1/catalogs/${releaseSegment}/themes/([0-9]{1,9})$`);
const sqlitePath = new RegExp(`^/v1/catalogs/${releaseSegment}/catalog\\.sqlite$`);
const setNumPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const queryToken = /[\p{L}\p{N}]+/gu;

const found = (route: Route): RouteResult => ({ kind: "route", route });
const invalid = (message: string): RouteResult => ({ kind: "invalid", message });

export function parseRoute(url: URL): RouteResult {
  const path = url.pathname;
  if (currentPath.test(path)) return found({ kind: "current" });
  const redirect = currentRedirectPath.exec(path);
  if (redirect?.[1] !== undefined) return found({ kind: "current-redirect", rest: redirect[1] });
  const release = releasePath.exec(path);
  if (release?.[1] !== undefined) return found({ kind: "release", release: release[1] });
  const search = searchPath.exec(path);
  if (search?.[1] !== undefined) return parseSearch(search[1], url.searchParams);
  const inventory = inventoryPath.exec(path);
  if (inventory?.[1] !== undefined && inventory[2] !== undefined) {
    return parseInventory(inventory[1], inventory[2]);
  }
  const roots = themeRootsPath.exec(path);
  if (roots?.[1] !== undefined) return found({ kind: "theme-roots", release: roots[1] });
  const theme = themePath.exec(path);
  if (theme?.[1] !== undefined && theme[2] !== undefined) {
    return parseTheme(theme[1], Number(theme[2]), url.searchParams);
  }
  const sqlite = sqlitePath.exec(path);
  if (sqlite?.[1] !== undefined) return found({ kind: "sqlite", release: sqlite[1] });
  return { kind: "not-found" };
}

export function canonicalUrl(origin: string, route: Route): string {
  switch (route.kind) {
    case "current":
      return `${origin}/v1/catalogs/current`;
    case "current-redirect":
      return `${origin}/v1/catalogs/current${route.rest}`;
    case "release":
      return releaseHref(origin, route.release);
    case "search": {
      const params = new URLSearchParams({
        q: route.tokens.join(" "),
        kind: route.kinds.join(","),
        limit: String(route.limit),
      });
      return `${releaseHref(origin, route.release)}/search?${params.toString()}`;
    }
    case "inventory":
      return inventoryHref(origin, route.release, route.setNum);
    case "theme-roots":
      return `${releaseHref(origin, route.release)}/themes`;
    case "theme": {
      const params = new URLSearchParams({
        limit: String(route.limit),
        offset: String(route.offset),
      });
      return `${themeHref(origin, route.release, route.themeId)}?${params.toString()}`;
    }
    case "sqlite":
      return sqliteHref(origin, route.release);
    default: {
      const exhaustive: never = route;
      throw new Error(`unhandled route ${String(exhaustive)}`);
    }
  }
}

export function releaseHref(origin: string, release: string): string {
  return `${origin}/v1/catalogs/${release}`;
}

export function inventoryHref(origin: string, release: string, setNum: string): string {
  return `${releaseHref(origin, release)}/sets/${encodeURIComponent(setNum)}/inventory`;
}

export function themeHref(origin: string, release: string, themeId: number): string {
  return `${releaseHref(origin, release)}/themes/${themeId}`;
}

export function sqliteHref(origin: string, release: string): string {
  return `${releaseHref(origin, release)}/catalog.sqlite`;
}

export function searchTokens(query: string): ReadonlyArray<string> {
  return query.normalize("NFKC").toLowerCase().match(queryToken) ?? [];
}

function parseSearch(release: string, params: URLSearchParams): RouteResult {
  const tokens = searchTokens(params.get("q") ?? "");
  if (tokens.length === 0) return invalid("q must contain at least one letter or digit");
  if (tokens.length > MAX_QUERY_TOKENS) return invalid(`q has more than ${MAX_QUERY_TOKENS} words`);
  if (tokens.some((token) => token.length > MAX_TOKEN_LENGTH)) {
    return invalid(`q has a word longer than ${MAX_TOKEN_LENGTH} characters`);
  }
  const kinds = parseKinds(params.get("kind"));
  if (kinds === undefined)
    return invalid(`kind must be a comma list of ${SEARCH_KINDS.join(", ")}`);
  const limit = parseBoundedInteger(params.get("limit"), SEARCH_LIMIT.default, 1, SEARCH_LIMIT.max);
  if (limit === undefined) return invalid(`limit must be an integer from 1 to ${SEARCH_LIMIT.max}`);
  return found({ kind: "search", release, tokens, kinds, limit });
}

function parseInventory(release: string, encodedSetNum: string): RouteResult {
  let setNum: string;
  try {
    setNum = decodeURIComponent(encodedSetNum);
  } catch {
    return invalid("set number is not valid percent-encoding");
  }
  if (!setNumPattern.test(setNum)) return invalid("set number has unexpected characters");
  return found({ kind: "inventory", release, setNum });
}

function parseTheme(release: string, themeId: number, params: URLSearchParams): RouteResult {
  const limit = parseBoundedInteger(
    params.get("limit"),
    THEME_PAGE_LIMIT.default,
    1,
    THEME_PAGE_LIMIT.max,
  );
  if (limit === undefined) {
    return invalid(`limit must be an integer from 1 to ${THEME_PAGE_LIMIT.max}`);
  }
  const offset = parseBoundedInteger(params.get("offset"), 0, 0, THEME_MAX_OFFSET);
  if (offset === undefined)
    return invalid(`offset must be an integer from 0 to ${THEME_MAX_OFFSET}`);
  return found({ kind: "theme", release, themeId, limit, offset });
}

function parseKinds(value: string | null): ReadonlyArray<SearchKind> | undefined {
  if (value === null || value === "") return SEARCH_KINDS;
  const requested = new Set(value.split(",").map((kind) => kind.trim()));
  const kinds = SEARCH_KINDS.filter((kind) => requested.has(kind));
  return kinds.length === requested.size ? kinds : undefined;
}

function parseBoundedInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (value === null || value === "") return fallback;
  if (!/^[0-9]{1,6}$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
}
