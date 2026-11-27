import {
  ASSET_FETCHER,
  AssetResponseError,
  NETWORK_ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
} from "@brr/catalog";
import { BUNDLE_POINTER_FILE } from "@brr/schema/bundle-pointer";
import { ASSET_CACHE, INDEXED_DB } from "@brr/storage";
import { IDBFactory } from "fake-indexeddb";
import { Container } from "inversify";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";

const utf8 = new TextEncoder();
const HTTP_UNAVAILABLE = 503;
const HTTP_NOT_FOUND = 404;

function addressed(stem: string, extension: string, body: string): readonly [string, string] {
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return [`${stem}.${digest}.${extension}`, body];
}

const [GLB, GLB_BODY] = addressed("standard/3001", "glb", "glTF part bytes");
const [MANIFEST, MANIFEST_BODY] = addressed("standard/manifest", "json", '{"manifest":"x"}');
const FILES: ReadonlyArray<readonly [string, string]> = [
  [GLB, GLB_BODY],
  [MANIFEST, MANIFEST_BODY],
];
const FALLBACK_MANIFEST = "manifest.0000000000000000.json";

class FakeNetwork implements IAssetFetcher {
  readonly requests: string[] = [];
  readonly files: Map<string, string | number>;

  constructor(
    files: ReadonlyArray<readonly [string, string | number]>,
    private readonly online = true,
  ) {
    this.files = new Map(files);
  }

  private body(path: string): string {
    this.requests.push(path);
    if (!this.online) throw new TypeError("Failed to fetch");
    const body = this.files.get(path) ?? HTTP_NOT_FOUND;
    if (typeof body === "number") throw new AssetResponseError(path, body);
    return body;
  }

  async bytes(path: string): Promise<ArrayBuffer> {
    return utf8.encode(this.body(path)).buffer;
  }

  async text(path: string): Promise<string> {
    return this.body(path);
  }
}

function browserOffline(): void {
  vi.stubGlobal("navigator", { onLine: false });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function session(network: FakeNetwork, indexedDb?: IDBFactory) {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      bundleManifestFile: FALLBACK_MANIFEST,
      disclaimer: "unused",
    }),
  );
  container.rebind(NETWORK_ASSET_FETCHER).toConstantValue(network);
  if (indexedDb !== undefined) container.rebind(INDEXED_DB).toConstantValue(indexedDb);
  return {
    fetcher: container.get(ASSET_FETCHER),
    loader: container.get(PART_BUNDLE_LOADER),
    cache: container.get(ASSET_CACHE),
  };
}

function pointerTo(manifestFile: string): readonly [string, string] {
  return [BUNDLE_POINTER_FILE, JSON.stringify({ manifestFile })];
}

function decoded(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(bytes);
}

describe("caching asset fetcher", () => {
  it("serves content-addressed files from IndexedDB once fetched, also offline in a later session", async () => {
    const indexedDb = new IDBFactory();
    const network = new FakeNetwork(FILES);
    const { fetcher } = session(network, indexedDb);
    for (let visit = 0; visit < 2; visit++) {
      expect(decoded(await fetcher.bytes(GLB))).toBe(GLB_BODY);
      expect(await fetcher.text(MANIFEST)).toBe(MANIFEST_BODY);
    }
    expect(network.requests).toEqual([GLB, MANIFEST]);

    const offline = new FakeNetwork(FILES, false);
    const later = session(offline, indexedDb).fetcher;
    expect(decoded(await later.bytes(GLB))).toBe(GLB_BODY);
    expect(await later.text(MANIFEST)).toBe(MANIFEST_BODY);
    expect(offline.requests).toEqual([]);
  });

  it("follows the pointer the network names while online, and reloads offline from the manifest it last named, but not after an HTTP error", async () => {
    const indexedDb = new IDBFactory();
    const offline = new FakeNetwork([], false);
    for (const named of ["manifest.aaaaaaaaaaaaaaaa.json", "manifest.bbbbbbbbbbbbbbbb.json"]) {
      const online = session(new FakeNetwork([pointerTo(named)]), indexedDb);
      expect(await online.loader.loadManifestFile()).toBe(named);
      await online.cache.get(BUNDLE_POINTER_FILE);
      expect(await session(offline, indexedDb).loader.loadManifestFile()).toBe(named);
    }
    const unavailable = new FakeNetwork([[BUNDLE_POINTER_FILE, HTTP_UNAVAILABLE]]);
    expect(await session(unavailable, indexedDb).loader.loadManifestFile()).toBe(FALLBACK_MANIFEST);
    expect(await session(offline, new IDBFactory()).loader.loadManifestFile()).toBe(
      FALLBACK_MANIFEST,
    );
  });

  it("never keeps a failed response or a body that doesn't match its content address", async () => {
    const indexedDb = new IDBFactory();
    const network = new FakeNetwork([[GLB, "a proxy's error page"]]);
    const first = session(network, indexedDb);
    await expect(first.fetcher.bytes(MANIFEST)).rejects.toThrow(`${HTTP_NOT_FOUND}`);
    expect(decoded(await first.fetcher.bytes(GLB))).toBe("a proxy's error page");
    expect(await first.cache.get(GLB)).toBeUndefined();
    await first.cache.put(MANIFEST, utf8.encode("bytes written behind the cache's back"));

    browserOffline();
    const offline = session(new FakeNetwork([], false), indexedDb).fetcher;
    await expect(offline.bytes(GLB)).rejects.toThrow("Failed to fetch");
    await expect(offline.bytes(MANIFEST)).rejects.toThrow("Failed to fetch");

    const repaired = new FakeNetwork(FILES);
    const later = session(repaired, indexedDb);
    expect(await later.fetcher.text(MANIFEST)).toBe(MANIFEST_BODY);
    expect(repaired.requests).toEqual([MANIFEST]);
  });

  const refusingIndexedDb = {
    open(): IDBOpenDBRequest {
      throw new DOMException("The user denied permission to access the database.", "SecurityError");
    },
  } as unknown as IDBFactory;

  it.each([
    ["has no IndexedDB", undefined],
    ["refuses to open IndexedDB", refusingIndexedDb],
  ])("reads from the network when the browser %s", async (_, indexedDb) => {
    const network = new FakeNetwork(FILES);
    const { fetcher } = session(network, indexedDb);
    expect(decoded(await fetcher.bytes(GLB))).toBe(GLB_BODY);
    expect(decoded(await fetcher.bytes(GLB))).toBe(GLB_BODY);
    expect(network.requests).toEqual([GLB, GLB]);
  });
});
