import type { ServiceIdentifier } from "inversify";
import type { ICatalogApi } from "./catalog-api-client.ts";
import type { FetchPoolPolicy } from "./fetch-pool.ts";
import type { ILibraryPartCatalog } from "./library-part-catalog.ts";
import type { ILinkProgress, ILinkProgressShare } from "./link-progress/link-progress.ts";
import type { IAssetFetcher, IPartBundleLoader } from "./part-bundle.ts";

export const BUNDLE_BASE_URL: ServiceIdentifier<string> = Symbol.for("brr.catalog.BundleBaseUrl");
export const BUNDLE_MANIFEST_FILE: ServiceIdentifier<string> = Symbol.for(
  "brr.catalog.BundleManifestFile",
);
export const ASSET_FETCHER: ServiceIdentifier<IAssetFetcher> = Symbol.for(
  "brr.catalog.AssetFetcher",
);
export const NETWORK_ASSET_FETCHER: ServiceIdentifier<IAssetFetcher> = Symbol.for(
  "brr.catalog.NetworkAssetFetcher",
);
export const PART_BUNDLE_LOADER: ServiceIdentifier<IPartBundleLoader> = Symbol.for(
  "brr.catalog.PartBundleLoader",
);
export const CATALOG_API_BASE_URL: ServiceIdentifier<string> = Symbol.for(
  "brr.catalog.CatalogApiBaseUrl",
);
export const CATALOG_API: ServiceIdentifier<ICatalogApi> = Symbol.for("brr.catalog.CatalogApi");
export const LIBRARY_PART_CATALOG: ServiceIdentifier<ILibraryPartCatalog> = Symbol.for(
  "brr.catalog.LibraryPartCatalog",
);
export const FETCH_POOL_POLICY: ServiceIdentifier<FetchPoolPolicy> = Symbol.for(
  "brr.catalog.FetchPoolPolicy",
);
export const LINK_SILENCE_LIMIT_MS: ServiceIdentifier<number> = Symbol.for(
  "brr.catalog.LinkSilenceLimitMs",
);
export const LINK_PROGRESS_SHARE: ServiceIdentifier<ILinkProgressShare> = Symbol.for(
  "brr.catalog.LinkProgressShare",
);
export const LINK_PROGRESS: ServiceIdentifier<ILinkProgress> = Symbol.for(
  "brr.catalog.LinkProgress",
);
