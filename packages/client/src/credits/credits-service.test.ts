import { ASSET_FETCHER, BUNDLE_LODS, type IAssetFetcher } from "@brr/catalog";
import { BundleIndex, ConnectorIndexFile } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { CREDITS } from "../tokens.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

async function bundleJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, bundleRoot), "utf8"));
}

it("credits the license and every attribution line of each level of detail's connectivity package, on the page and in the exported text", async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const credits = container.get(CREDITS);
  const view = await credits.load();
  const text = credits.exportText(view);
  for (const lod of BUNDLE_LODS) {
    const manifestPath = `${lod}/manifest.json`;
    const manifest = decodedOrThrow(
      decode(BundleIndex, await bundleJson(manifestPath)),
      manifestPath,
    );
    const indexPath = `${lod}/${manifest.connectivity.file}`;
    const connectivity = decodedOrThrow(
      decode(ConnectorIndexFile, await bundleJson(indexPath)),
      indexPath,
    );
    expect(connectivity.attribution).not.toEqual([]);
    expect(view.dataPackages).toContainEqual(
      expect.objectContaining({
        licenses: connectivity.licenses,
        attribution: connectivity.attribution,
      }),
    );
    for (const line of [...connectivity.licenses, ...connectivity.attribution]) {
      expect(text).toContain(line);
    }
  }
});
