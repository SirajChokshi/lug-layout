import {
  MAX_THEME_ID_DIGITS,
  RELEASE_ID_PATTERN,
  SearchParams,
  SetNumber,
  ThemePageParams,
} from "@brr/schema/catalog-api";
import { decode, issueText } from "@brr/schema/decode";

export type Route =
  | { readonly kind: "current" }
  | { readonly kind: "current-redirect"; readonly rest: string }
  | { readonly kind: "release"; readonly release: string }
  | {
      readonly kind: "search";
      readonly release: string;
      readonly params: SearchParams;
    }
  | { readonly kind: "inventory"; readonly release: string; readonly setNum: string }
  | { readonly kind: "theme-roots"; readonly release: string }
  | {
      readonly kind: "theme";
      readonly release: string;
      readonly themeId: number;
      readonly params: ThemePageParams;
    }
  | { readonly kind: "sqlite"; readonly release: string };

export type RouteResult =
  | { readonly kind: "route"; readonly route: Route }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "not-found" };

const releaseSegment = `(${RELEASE_ID_PATTERN})`;
const currentPath = /^\/v1\/catalogs\/current$/;
const currentRedirectPath = /^\/v1\/catalogs\/current(\/.+)$/;
const releasePath = new RegExp(`^/v1/catalogs/${releaseSegment}$`);
const searchPath = new RegExp(`^/v1/catalogs/${releaseSegment}/search$`);
const inventoryPath = new RegExp(`^/v1/catalogs/${releaseSegment}/sets/([^/]+)/inventory$`);
const themeRootsPath = new RegExp(`^/v1/catalogs/${releaseSegment}/themes$`);
const themePath = new RegExp(
  `^/v1/catalogs/${releaseSegment}/themes/([0-9]{1,${MAX_THEME_ID_DIGITS}})$`,
);
const sqlitePath = new RegExp(`^/v1/catalogs/${releaseSegment}/catalog\\.sqlite$`);

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
        q: route.params.q.join(" "),
        kind: route.params.kind.join(","),
        limit: String(route.params.limit),
      });
      return `${releaseHref(origin, route.release)}/search?${params.toString()}`;
    }
    case "inventory":
      return inventoryHref(origin, route.release, route.setNum);
    case "theme-roots":
      return `${releaseHref(origin, route.release)}/themes`;
    case "theme": {
      const params = new URLSearchParams({
        limit: String(route.params.limit),
        offset: String(route.params.offset),
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

function parseSearch(release: string, params: URLSearchParams): RouteResult {
  const parsed = decode(SearchParams, Object.fromEntries(params), "query");
  if (!parsed.ok) return invalid(issueText(parsed.issues));
  return found({ kind: "search", release, params: parsed.value });
}

function parseInventory(release: string, encodedSetNum: string): RouteResult {
  let setNum: string;
  try {
    setNum = decodeURIComponent(encodedSetNum);
  } catch {
    return invalid("set number is not valid percent-encoding");
  }
  const parsed = decode(SetNumber, setNum, "set number");
  if (!parsed.ok) return invalid(issueText(parsed.issues));
  return found({ kind: "inventory", release, setNum: parsed.value });
}

function parseTheme(release: string, themeId: number, params: URLSearchParams): RouteResult {
  const parsed = decode(ThemePageParams, Object.fromEntries(params), "query");
  if (!parsed.ok) return invalid(issueText(parsed.issues));
  return found({ kind: "theme", release, themeId, params: parsed.value });
}
