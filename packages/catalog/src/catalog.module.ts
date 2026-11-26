import { ContainerModule, type Bind } from "inversify";
import { HttpCatalogApi } from "./catalog-api-client.ts";
import { DEFAULT_FETCH_POOL_POLICY } from "./fetch-pool.ts";
import {
  DEFAULT_LINK_SILENCE_LIMIT_MS,
  HttpAssetFetcher,
  HttpPartBundleLoader,
} from "./http-part-bundle-loader.ts";
import { HttpLibraryPartCatalog } from "./library-part-catalog.ts";
import { LinkProgress } from "./link-progress.ts";
import {
  LINK_PROGRESS,
  LINK_SHARE,
  LINK_SILENCE_LIMIT_MS,
  CATALOG_API,
  FETCH_POOL_POLICY,
  LIBRARY_PART_CATALOG,
  NETWORK_ASSET_FETCHER,
  PART_BUNDLE_LOADER,
} from "./tokens.ts";

export function bindLinkProgress(bind: Bind): void {
  bind(LINK_PROGRESS)
    .toDynamicValue((context) => new LinkProgress(context.get(LINK_SHARE)))
    .inSingletonScope();
}

export const catalogModule = new ContainerModule(({ bind }) => {
  bind(FETCH_POOL_POLICY).toConstantValue(DEFAULT_FETCH_POOL_POLICY);
  bind(LINK_SILENCE_LIMIT_MS).toConstantValue(DEFAULT_LINK_SILENCE_LIMIT_MS);
  bindLinkProgress(bind);
  bind(NETWORK_ASSET_FETCHER).to(HttpAssetFetcher).inSingletonScope();
  bind(PART_BUNDLE_LOADER).to(HttpPartBundleLoader).inSingletonScope();
  bind(CATALOG_API).to(HttpCatalogApi).inSingletonScope();
  bind(LIBRARY_PART_CATALOG).to(HttpLibraryPartCatalog).inSingletonScope();
});
