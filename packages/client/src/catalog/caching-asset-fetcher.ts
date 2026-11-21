import { AssetResponseError, NETWORK_ASSET_FETCHER, type IAssetFetcher } from "@brr/catalog";
import { contentDigestOf } from "@brr/schema/bundle";
import { isContentAddressedPath } from "@brr/schema/bundle-pointer";
import { ASSET_CACHE, contentSha256, type IAssetCache } from "@brr/storage";
import { inject, injectable } from "inversify";

const utf8 = new TextDecoder();

async function matchesAddress(path: string, bytes: Uint8Array): Promise<boolean> {
  const digest = contentDigestOf(path);
  return digest !== null && (await contentSha256(bytes)).startsWith(digest);
}

@injectable()
export class CachingAssetFetcher implements IAssetFetcher {
  constructor(
    @inject(NETWORK_ASSET_FETCHER) private readonly network: IAssetFetcher,
    @inject(ASSET_CACHE) private readonly cache: IAssetCache,
  ) {}

  async bytes(path: string): Promise<ArrayBuffer> {
    return (await this.read(path)).buffer;
  }

  async text(path: string): Promise<string> {
    return utf8.decode(await this.read(path));
  }

  private read(path: string): Promise<Uint8Array<ArrayBuffer>> {
    return isContentAddressedPath(path) ? this.cacheFirst(path) : this.networkFirst(path);
  }

  private async cacheFirst(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const hit = await this.cache.get(path);
    if (hit !== undefined && (await matchesAddress(path, hit))) return hit;
    const bytes = await this.download(path);
    if (await matchesAddress(path, bytes)) void this.cache.put(path, bytes);
    return bytes;
  }

  private async networkFirst(path: string): Promise<Uint8Array<ArrayBuffer>> {
    try {
      const bytes = await this.download(path);
      void this.cache.put(path, bytes);
      return bytes;
    } catch (error) {
      if (error instanceof AssetResponseError) throw error;
      const lastGood = await this.cache.get(path);
      if (lastGood === undefined) throw error;
      return lastGood;
    }
  }

  private async download(path: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await this.network.bytes(path));
  }
}
