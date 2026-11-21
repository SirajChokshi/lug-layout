import { LibraryPartsFile, type BundleColor, type BundleLod } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { inject, injectable } from "inversify";
import type { IAssetFetcher, IPartBundleLoader } from "./part-bundle.ts";
import { ASSET_FETCHER, PART_BUNDLE_LOADER } from "./tokens.ts";

const LIBRARY_PARTS_LOD: BundleLod = "standard";

export interface LibraryPartList {
  readonly file: LibraryPartsFile;
  readonly colors: ReadonlyArray<BundleColor>;
}

export interface ILibraryPartCatalog {
  load(): Promise<LibraryPartList | null>;
}

@injectable()
export class HttpLibraryPartCatalog implements ILibraryPartCatalog {
  private loading: Promise<LibraryPartList | null> | null = null;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: Pick<IPartBundleLoader, "loadIndex">,
    @inject(ASSET_FETCHER) private readonly fetcher: Pick<IAssetFetcher, "text">,
  ) {}

  load(): Promise<LibraryPartList | null> {
    if (this.loading === null) {
      const loading = this.fetch();
      this.loading = loading;
      loading.catch(() => {
        if (this.loading === loading) this.loading = null;
      });
    }
    return this.loading;
  }

  private async fetch(): Promise<LibraryPartList | null> {
    const index = await this.loader.loadIndex(LIBRARY_PARTS_LOD);
    if (index.libraryParts === undefined) return null;
    const path = `${LIBRARY_PARTS_LOD}/${index.libraryParts.file}`;
    const file = decodedOrThrow(
      decode(LibraryPartsFile, JSON.parse(await this.fetcher.text(path))),
      path,
    );
    return { file, colors: index.colors };
  }
}
