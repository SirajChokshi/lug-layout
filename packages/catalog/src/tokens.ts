import type { ServiceIdentifier } from "inversify";
import type { IAssetFetcher, IPartBundleLoader } from "./part-bundle.ts";

export const BUNDLE_BASE_URL: ServiceIdentifier<string> = Symbol.for("brr.catalog.BundleBaseUrl");
export const ASSET_FETCHER: ServiceIdentifier<IAssetFetcher> = Symbol.for(
  "brr.catalog.AssetFetcher",
);
export const PART_BUNDLE_LOADER: ServiceIdentifier<IPartBundleLoader> = Symbol.for(
  "brr.catalog.PartBundleLoader",
);
