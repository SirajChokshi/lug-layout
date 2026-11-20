import { ContainerModule } from "inversify";
import { HttpCatalogApi } from "./catalog-api-client.ts";
import { HttpAssetFetcher, HttpPartBundleLoader } from "./http-part-bundle-loader.ts";
import { HttpLibraryPartCatalog } from "./library-part-catalog.ts";
import { ASSET_FETCHER, CATALOG_API, LIBRARY_PART_CATALOG, PART_BUNDLE_LOADER } from "./tokens.ts";

export const catalogModule = new ContainerModule(({ bind }) => {
  bind(ASSET_FETCHER).to(HttpAssetFetcher).inSingletonScope();
  bind(PART_BUNDLE_LOADER).to(HttpPartBundleLoader).inSingletonScope();
  bind(CATALOG_API).to(HttpCatalogApi).inSingletonScope();
  bind(LIBRARY_PART_CATALOG).to(HttpLibraryPartCatalog).inSingletonScope();
});
