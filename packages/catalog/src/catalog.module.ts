import { ContainerModule } from "inversify";
import { HttpAssetFetcher, HttpPartBundleLoader } from "./http-part-bundle-loader.ts";
import { ASSET_FETCHER, PART_BUNDLE_LOADER } from "./tokens.ts";

export const catalogModule = new ContainerModule(({ bind }) => {
  bind(ASSET_FETCHER).to(HttpAssetFetcher).inSingletonScope();
  bind(PART_BUNDLE_LOADER).to(HttpPartBundleLoader).inSingletonScope();
});
