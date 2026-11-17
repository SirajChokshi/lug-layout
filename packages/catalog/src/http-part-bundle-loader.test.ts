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

class BucketFetcher implements IAssetFetcher {
  readonly requested: string[] = [];

  constructor(private readonly objects: Readonly<Record<string, string>>) {}

  async bytes(path: string): Promise<ArrayBuffer> {
    this.requested.push(path);
    throw new Error(`GET ${path} failed with 404`);
  }

  async text(path: string): Promise<string> {
    this.requested.push(path);
    const object = this.objects[path];
    if (object === undefined) throw new Error(`GET ${path} failed with 404`);
    return object;
  }
}

const POINTER = "current/latest.json";
const FALLBACK = "manifest.3cd92e805bfe8274.json";

it.each([
  {
    name: "the manifest current/latest.json names",
    objects: { [POINTER]: '{"manifestFile":"manifest.bbbbbbbbbbbbbbbb.json"}' },
    requested: [POINTER, "standard/manifest.bbbbbbbbbbbbbbbb.json"],
    error: "the manifest current/latest.json names, standard/manifest.bbbbbbbbbbbbbbbb.json",
  },
  {
    name: "the configured fallback after current/latest.json answers 404 twice",
    objects: {},
    requested: [POINTER, POINTER, `standard/${FALLBACK}`],
    error: `current/latest.json could not be read and the fallback manifest, standard/${FALLBACK}`,
  },
  {
    name: "the configured fallback after current/latest.json is unreadable twice",
    objects: { [POINTER]: "<!doctype html>" },
    requested: [POINTER, POINTER, `standard/${FALLBACK}`],
    error: `current/latest.json could not be read and the fallback manifest, standard/${FALLBACK}`,
  },
])("loads $name and never manifest.json", async ({ objects, requested, error }) => {
  const container = new Container();
  await container.load(catalogModule);
  container.bind(BUNDLE_MANIFEST_FILE).toConstantValue(FALLBACK);
  const fetcher = new BucketFetcher(objects);
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);

  await expect(container.get(PART_BUNDLE_LOADER).loadManifest("standard")).rejects.toThrow(
    `The part bundle is unreachable: ${error}, failed`,
  );
  expect(fetcher.requested).toEqual(requested);
  expect(fetcher.requested).not.toContain("standard/manifest.json");
});

it("fetches the manifest again after a failed load instead of replaying the failure", async () => {
  const container = new Container();
  await container.load(catalogModule);
  container.bind(BUNDLE_MANIFEST_FILE).toConstantValue("manifest.json");
  const fetcher = new FailingFetcher();
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  const loader = container.get(PART_BUNDLE_LOADER);

  await expect(loader.loadManifest("standard")).rejects.toThrow("attempt 3");
  await expect(loader.loadManifest("standard")).rejects.toThrow("attempt 4");
  expect(fetcher.requested).toEqual([
    POINTER,
    POINTER,
    "standard/manifest.json",
    "standard/manifest.json",
  ]);
});
