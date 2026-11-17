import { Container } from "inversify";
import { expect, it } from "vitest";
import { catalogModule } from "./catalog.module.ts";
import type { IAssetFetcher } from "./part-bundle.ts";
import { ASSET_FETCHER, BUNDLE_MANIFEST_FILE, PART_BUNDLE_LOADER } from "./tokens.ts";

class FailingFetcher implements IAssetFetcher {
  readonly requested: string[] = [];

  async bytes(path: string): Promise<ArrayBuffer> {
    this.requested.push(path);
    throw new TypeError(`Failed to fetch ${path} (attempt ${this.requested.length})`);
  }

  async text(path: string): Promise<string> {
    this.requested.push(path);
    throw new TypeError(`Failed to fetch ${path} (attempt ${this.requested.length})`);
  }
}

it("fetches the manifest again after a failed load instead of replaying the failure", async () => {
  const container = new Container();
  await container.load(catalogModule);
  container.bind(BUNDLE_MANIFEST_FILE).toConstantValue("manifest.json");
  const fetcher = new FailingFetcher();
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  const loader = container.get(PART_BUNDLE_LOADER);

  await expect(loader.loadManifest("standard")).rejects.toThrow("attempt 1");
  await expect(loader.loadManifest("standard")).rejects.toThrow("attempt 2");
  expect(fetcher.requested).toEqual(["standard/manifest.json", "standard/manifest.json"]);
});
