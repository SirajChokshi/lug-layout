import { ContainerModule } from "inversify";
import { HttpCatalogApi } from "./catalog-api-client.ts";
import { HttpAssetFetcher, HttpPartBundleLoader } from "./http-part-bundle-loader.ts";
import { ASSET_FETCHER, CATALOG_API, PART_BUNDLE_LOADER } from "./tokens.ts";

export const catalogModule = new ContainerModule(({ bind }) => {
  bind(ASSET_FETCHER).to(HttpAssetFetcher).inSingletonScope();
  bind(PART_BUNDLE_LOADER).to(HttpPartBundleLoader).inSingletonScope();
  bind(CATALOG_API).to(HttpCatalogApi).inSingletonScope();
});
