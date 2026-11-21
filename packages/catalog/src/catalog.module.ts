import { ContainerModule } from "inversify";
import { HttpCatalogApi } from "./catalog-api-client.ts";
import { HttpAssetFetcher, HttpPartBundleLoader } from "./http-part-bundle-loader.ts";
import { CATALOG_API, NETWORK_ASSET_FETCHER, PART_BUNDLE_LOADER } from "./tokens.ts";

export const catalogModule = new ContainerModule(({ bind }) => {
  bind(NETWORK_ASSET_FETCHER).to(HttpAssetFetcher).inSingletonScope();
  bind(PART_BUNDLE_LOADER).to(HttpPartBundleLoader).inSingletonScope();
  bind(CATALOG_API).to(HttpCatalogApi).inSingletonScope();
});
