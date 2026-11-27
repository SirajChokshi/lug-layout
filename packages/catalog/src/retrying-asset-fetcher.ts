import { inject, injectable } from "inversify";
import { retried } from "./asset-retry.ts";
import type { IAssetFetcher } from "./part-bundle.ts";
import { RETRIED_ASSET_FETCHER } from "./tokens.ts";

@injectable()
export class RetryingAssetFetcher implements IAssetFetcher {
  constructor(@inject(RETRIED_ASSET_FETCHER) private readonly fetcher: IAssetFetcher) {}

  bytes(path: string): Promise<ArrayBuffer> {
    return retried(() => this.fetcher.bytes(path));
  }

  text(path: string): Promise<string> {
    return retried(() => this.fetcher.text(path));
  }
}
