import type { BundleColor, BundleLod, LibraryPartsFile } from "@brr/schema/bundle";
import { inject, injectable } from "inversify";
import type { IPartBundleLoader } from "./part-bundle.ts";
import { PART_BUNDLE_LOADER } from "./tokens.ts";

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
    @inject(PART_BUNDLE_LOADER)
    private readonly loader: Pick<IPartBundleLoader, "loadIndex" | "loadLibraryParts">,
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
    const [index, file] = await Promise.all([
      this.loader.loadIndex(LIBRARY_PARTS_LOD),
      this.loader.loadLibraryParts(LIBRARY_PARTS_LOD),
    ]);
    return file === null ? null : { file, colors: index.colors };
  }
}
