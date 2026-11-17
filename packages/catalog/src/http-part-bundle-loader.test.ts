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

class PointerFetcher implements IAssetFetcher {
  readonly requested: string[] = [];

  constructor(private readonly pointer: string | undefined) {}

  async bytes(path: string): Promise<ArrayBuffer> {
    this.requested.push(path);
    throw new Error(`GET ${path} failed with 404`);
  }

  async text(path: string): Promise<string> {
    this.requested.push(path);
    if (path === "current/latest.json" && this.pointer !== undefined) return this.pointer;
    throw new Error(`GET ${path} failed with 404`);
  }
}

it.each([
  {
    pointer: '{"manifestFile":"manifest.3cd92e805bfe8274.json"}',
    manifest: "standard/manifest.3cd92e805bfe8274.json",
  },
  { pointer: undefined, manifest: "standard/manifest.json" },
  { pointer: "<!doctype html>", manifest: "standard/manifest.json" },
])(
  "loads the manifest current/latest.json names, or manifest.json without one ($manifest)",
  async ({ pointer, manifest }) => {
    const container = new Container();
    await container.load(catalogModule);
    container.bind(BUNDLE_MANIFEST_FILE).toConstantValue(null);
    const fetcher = new PointerFetcher(pointer);
    container.rebind(ASSET_FETCHER).toConstantValue(fetcher);

    await expect(container.get(PART_BUNDLE_LOADER).loadManifest("standard")).rejects.toThrow(
      manifest,
    );
    expect(fetcher.requested).toEqual(["current/latest.json", manifest]);
  },
);

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
