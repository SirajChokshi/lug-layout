import { Container } from "inversify";
import { afterEach, expect, it, vi } from "vitest";
import { AssetResponseError } from "./asset-response-error.ts";
import { catalogModule } from "./catalog.module.ts";
import type { IAssetFetcher } from "./part-bundle.ts";
import {
  ASSET_FETCHER,
  BUNDLE_BASE_URL,
  BUNDLE_MANIFEST_FILE,
  FETCH_POOL_POLICY,
  NETWORK_ASSET_FETCHER,
  PART_BUNDLE_LOADER,
} from "./tokens.ts";

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

class GatedFetcher implements IAssetFetcher {
  readonly started: string[] = [];
  private readonly gates = new Map<string, () => void>();

  bytes(path: string): Promise<ArrayBuffer> {
    return this.gate(path, new ArrayBuffer(0));
  }

  text(path: string): Promise<string> {
    return this.gate(path, "");
  }

  private gate<T>(path: string, value: T): Promise<T> {
    this.started.push(path);
    return new Promise((resolve) => this.gates.set(path, () => resolve(value)));
  }

  open(path: string): void {
    this.gates.get(path)?.();
  }
}

const POINTER = "current/latest.json";

function settled(load: Promise<unknown>): Promise<unknown> {
  return load.catch(() => undefined);
}
const POOL_SLOTS = 16;
const RESERVED_STRUCTURAL_SLOTS = 1;
const MESH_SLOTS = POOL_SLOTS - RESERVED_STRUCTURAL_SLOTS;
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
  container.bind(ASSET_FETCHER).toConstantValue(fetcher);

  await expect(container.get(PART_BUNDLE_LOADER).loadManifest("standard")).rejects.toThrow(
    `The part bundle is unreachable: ${error}, failed`,
  );
  expect(fetcher.requested).toEqual(requested);
  expect(fetcher.requested).not.toContain("standard/manifest.json");
});

it("moves a waiting part mesh load to the end of the queue of its new priority", async () => {
  const container = new Container();
  await container.load(catalogModule);
  container.rebind(FETCH_POOL_POLICY).toConstantValue({
    slots: POOL_SLOTS,
    reservedStructuralSlots: RESERVED_STRUCTURAL_SLOTS,
  });
  container.bind(BUNDLE_MANIFEST_FILE).toConstantValue("manifest.json");
  const fetcher = new GatedFetcher();
  container.bind(ASSET_FETCHER).toConstantValue(fetcher);
  const loader = container.get(PART_BUNDLE_LOADER);
  const load = (file: string, priority: "high" | "low"): Promise<unknown> =>
    loader.loadPartMesh("far", file, priority).catch(() => undefined);
  const inFlight = Array.from({ length: MESH_SLOTS }, (_, i) => `busy-${i}.glb`);
  const loads = inFlight.map((file) => load(file, "high"));
  loads.push(
    load("high-a.glb", "high"),
    load("high-b.glb", "high"),
    load("low-a.glb", "low"),
    load("low-b.glb", "low"),
    load("low-c.glb", "low"),
  );
  await Promise.resolve();

  loader.setPartMeshPriority("far", "low-b.glb", "high");
  loader.setPartMeshPriority("far", "high-a.glb", "low");
  for (const file of inFlight) fetcher.open(`far/${file}`);
  await vi.waitFor(() => expect(fetcher.started).toHaveLength(MESH_SLOTS + 5));

  expect(fetcher.started.slice(MESH_SLOTS)).toEqual([
    "far/high-b.glb",
    "far/low-b.glb",
    "far/low-a.glb",
    "far/low-c.glb",
    "far/high-a.glb",
  ]);
  for (const path of fetcher.started) fetcher.open(path);
  await Promise.all(loads);
});

it("starts a waiting JSON load before the part mesh loads waiting ahead of it", async () => {
  const container = new Container();
  await container.load(catalogModule);
  container
    .rebind(FETCH_POOL_POLICY)
    .toConstantValue({ slots: POOL_SLOTS, reservedStructuralSlots: 0 });
  container.bind(BUNDLE_MANIFEST_FILE).toConstantValue("manifest.json");
  const fetcher = new GatedFetcher();
  container.bind(ASSET_FETCHER).toConstantValue(fetcher);
  const loader = container.get(PART_BUNDLE_LOADER);
  const inFlight = Array.from({ length: POOL_SLOTS }, (_, i) => `busy-${i}.glb`);
  const loads = inFlight.map((file) => settled(loader.loadPartMesh("far", file, "high")));
  loads.push(
    settled(loader.loadPartMesh("far", "high-a.glb", "high")),
    settled(loader.loadPartMesh("far", "low-a.glb", "low")),
    settled(loader.loadIndex("far")),
  );
  await Promise.resolve();

  for (const file of inFlight) fetcher.open(`far/${file}`);
  await vi.waitFor(() => expect(fetcher.started).toHaveLength(POOL_SLOTS + 3));

  expect(fetcher.started.slice(POOL_SLOTS)).toEqual([POINTER, "far/high-a.glb", "far/low-a.glb"]);
  for (const path of fetcher.started) fetcher.open(path);
});

it("fetches the manifest again after a failed load instead of replaying the failure", async () => {
  const container = new Container();
  await container.load(catalogModule);
  container.bind(BUNDLE_MANIFEST_FILE).toConstantValue("manifest.json");
  const fetcher = new FailingFetcher();
  container.bind(ASSET_FETCHER).toConstantValue(fetcher);
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

afterEach(() => {
  vi.unstubAllGlobals();
});

it("tells an HTTP error status apart from a request that got no response", async () => {
  const container = new Container();
  await container.load(catalogModule);
  container.bind(BUNDLE_BASE_URL).toConstantValue("https://bucket.test/");
  const network = container.get(NETWORK_ASSET_FETCHER);
  vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
  const answered = network.text(POINTER);
  await expect(answered).rejects.toBeInstanceOf(AssetResponseError);
  await expect(answered).rejects.toMatchObject({
    status: 503,
    message: `GET https://bucket.test/${POINTER} failed with 503`,
  });
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  const unanswered = network.bytes(POINTER);
  await expect(unanswered).rejects.toThrow("Failed to fetch");
  await expect(unanswered).rejects.not.toBeInstanceOf(AssetResponseError);
});
