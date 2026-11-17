import type { BundleLod, BundleThumbnail } from "@brr/schema/bundle";

export function thumbnailUrls(
  bundleBaseUrl: string,
  lod: BundleLod,
  thumbnails: ReadonlyArray<BundleThumbnail>,
): ReadonlyMap<string, string> {
  const base = bundleBaseUrl.replace(/\/$/u, "");
  return new Map(thumbnails.map(({ item, file }) => [item, `${base}/${lod}/${file}`]));
}
