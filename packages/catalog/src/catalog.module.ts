import { ContainerModule } from "inversify";
import { HttpCatalogApi } from "./catalog-api-client.ts";
import { DEFAULT_FETCH_POOL_POLICY } from "./fetch-pool.ts";
import { HttpAssetFetcher, HttpPartBundleLoader } from "./http-part-bundle-loader.ts";
import { HttpLibraryPartCatalog } from "./library-part-catalog.ts";
import {
  CATALOG_API,
  FETCH_POOL_POLICY,
  LIBRARY_PART_CATALOG,
  NETWORK_ASSET_FETCHER,
  PART_BUNDLE_LOADER,
} from "./tokens.ts";

export const catalogModule = new ContainerModule(({ bind }) => {
  bind(FETCH_POOL_POLICY).toConstantValue(DEFAULT_FETCH_POOL_POLICY);
  bind(NETWORK_ASSET_FETCHER).to(HttpAssetFetcher).inSingletonScope();
  bind(PART_BUNDLE_LOADER).to(HttpPartBundleLoader).inSingletonScope();
  bind(CATALOG_API).to(HttpCatalogApi).inSingletonScope();
  bind(LIBRARY_PART_CATALOG).to(HttpLibraryPartCatalog).inSingletonScope();
});
