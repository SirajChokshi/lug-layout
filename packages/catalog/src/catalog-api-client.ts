import {
  BundleManifestKey,
  BundleSearchParams,
  BundleSearchResponse,
  ErrorResponse,
  InventoryResponse,
  ReleaseId,
  ReleaseResponse,
  SearchParams,
  SearchResponse,
  SetNumber,
  ThemeId,
  ThemePageParams,
  ThemePageResponse,
  ThemeRootsResponse,
} from "@brr/schema/catalog-api";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { inject, injectable } from "inversify";
import type * as v from "valibot";
import { CATALOG_API_BASE_URL } from "./tokens.ts";

export interface ICatalogApi {
  current(): Promise<ReleaseResponse>;
  search(release: string, params: v.InferInput<typeof SearchParams>): Promise<SearchResponse>;
  inventory(release: string, setNum: string): Promise<InventoryResponse>;
  themes(release: string): Promise<ThemeRootsResponse>;
  theme(
    release: string,
    themeId: number,
    params: v.InferInput<typeof ThemePageParams>,
  ): Promise<ThemePageResponse>;
  searchBundle(
    manifestKey: string,
    params: v.InferInput<typeof BundleSearchParams>,
  ): Promise<BundleSearchResponse>;
}

@injectable()
export class HttpCatalogApi implements ICatalogApi {
  constructor(@inject(CATALOG_API_BASE_URL) private readonly baseUrl: string) {}

  async current(): Promise<ReleaseResponse> {
    return this.get("/v1/catalogs/current", ReleaseResponse);
  }

  async search(
    release: string,
    params: v.InferInput<typeof SearchParams>,
  ): Promise<SearchResponse> {
    decodedOrThrow(decode(SearchParams, params, "query"), "search parameters");
    return this.get(`${releasePath(release)}/search?${query(params)}`, SearchResponse);
  }

  async inventory(release: string, setNum: string): Promise<InventoryResponse> {
    const set = encodeURIComponent(
      decodedOrThrow(decode(SetNumber, setNum, "set number"), "inventory"),
    );
    return this.get(`${releasePath(release)}/sets/${set}/inventory`, InventoryResponse);
  }

  async themes(release: string): Promise<ThemeRootsResponse> {
    return this.get(`${releasePath(release)}/themes`, ThemeRootsResponse);
  }

  async theme(
    release: string,
    themeId: number,
    params: v.InferInput<typeof ThemePageParams>,
  ): Promise<ThemePageResponse> {
    decodedOrThrow(decode(ThemePageParams, params, "query"), "theme page parameters");
    const theme = decodedOrThrow(decode(ThemeId, themeId, "theme id"), "theme");
    const path = `${releasePath(release)}/themes/${theme}?${query(params)}`;
    return this.get(path, ThemePageResponse);
  }

  async searchBundle(
    manifestKey: string,
    params: v.InferInput<typeof BundleSearchParams>,
  ): Promise<BundleSearchResponse> {
    const key = decodedOrThrow(decode(BundleManifestKey, manifestKey, "manifest"), "bundle search");
    decodedOrThrow(decode(BundleSearchParams, params, "query"), "bundle search parameters");
    return this.get(`/v1/bundles/${key}/search?${query(params)}`, BundleSearchResponse);
  }

  private async get<Schema extends v.GenericSchema>(
    path: string,
    schema: Schema,
  ): Promise<v.InferOutput<Schema>> {
    const url = `${this.baseUrl.replace(/\/$/u, "")}${path}`;
    const response = await fetch(url);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GET ${url} failed with ${response.status}: ${errorMessage(text)}`);
    }
    return decodedOrThrow(decode(schema, JSON.parse(text)), url);
  }
}

function errorMessage(text: string): string {
  try {
    const body = decode(ErrorResponse, JSON.parse(text));
    return body.ok ? body.value.error : text;
  } catch {
    return text;
  }
}

function releasePath(release: string): string {
  return `/v1/catalogs/${decodedOrThrow(decode(ReleaseId, release, "release"), "catalog")}`;
}

function query(params: Readonly<Record<string, string | undefined>>): string {
  const defined = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return new URLSearchParams(defined).toString();
}
