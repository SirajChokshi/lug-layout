import type { ServiceIdentifier } from "inversify";
import type { ICatalogApi } from "./catalog-api-client.ts";
import type { IAssetFetcher, IPartBundleLoader } from "./part-bundle.ts";

export const BUNDLE_BASE_URL: ServiceIdentifier<string> = Symbol.for("brr.catalog.BundleBaseUrl");
export const ASSET_FETCHER: ServiceIdentifier<IAssetFetcher> = Symbol.for(
  "brr.catalog.AssetFetcher",
);
export const PART_BUNDLE_LOADER: ServiceIdentifier<IPartBundleLoader> = Symbol.for(
  "brr.catalog.PartBundleLoader",
);
export const CATALOG_API_BASE_URL: ServiceIdentifier<string> = Symbol.for(
  "brr.catalog.CatalogApiBaseUrl",
);
export const CATALOG_API: ServiceIdentifier<ICatalogApi> = Symbol.for("brr.catalog.CatalogApi");
