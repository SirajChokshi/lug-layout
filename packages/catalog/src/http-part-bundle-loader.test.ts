import { Container } from "inversify";
import { afterEach, expect, it, vi } from "vitest";
import { AssetResponseError } from "./asset-response-error.ts";
import { AssetStalledError } from "./asset-stalled-error.ts";
import { catalogModule } from "./catalog.module.ts";
import { DEFAULT_LINK_SILENCE_LIMIT_MS } from "./http-part-bundle-loader.ts";
import type { ILinkProgressShare } from "./link-progress.ts";
import type { IAssetFetcher } from "./part-bundle.ts";
import {
  ASSET_FETCHER,
  BUNDLE_BASE_URL,
  BUNDLE_MANIFEST_FILE,
  FETCH_POOL_POLICY,
  LINK_PROGRESS_SHARE,
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
  vi.useRealTimers();
});

it("tells an HTTP error status apart from a request that got no response", async () => {
  const container = new Container();
  await container.load(catalogModule);
  container.bind(BUNDLE_BASE_URL).toConstantValue("https://bucket.test/");
  container.bind(LINK_PROGRESS_SHARE).toConstantValue(new Peers());
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

const BUCKET = "https://bucket.test/";
const SILENCE_LIMIT_MS = DEFAULT_LINK_SILENCE_LIMIT_MS;
const encoder = new TextEncoder();

class Peers implements ILinkProgressShare {
  shared = 0;
  private listener: () => void = () => undefined;

  share(): void {
    this.shared += 1;
  }

  listen(listener: () => void): void {
    this.listener = listener;
  }

  deliverShare(): void {
    this.listener();
  }
}

async function networkFetcher(): Promise<{ network: IAssetFetcher; peers: Peers }> {
  const peers = new Peers();
  const container = new Container();
  await container.load(catalogModule);
  container.bind(BUNDLE_BASE_URL).toConstantValue(BUCKET);
  container.bind(LINK_PROGRESS_SHARE).toConstantValue(peers);
  return { network: container.get(NETWORK_ASSET_FETCHER), peers };
}

function watched<T>(loading: Promise<T>): { settled: () => boolean } {
  let done = false;
  loading.then(
    () => (done = true),
    () => (done = true),
  );
  return { settled: () => done };
}

function respondWith(parts: ReadonlyArray<Uint8Array>): void {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      ),
  );
}

function pacedBody(chunks: ReadonlyArray<string>, everyMs: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      chunks.forEach((chunk, i) => {
        setTimeout(
          () => {
            controller.enqueue(encoder.encode(chunk));
            if (i === chunks.length - 1) controller.close();
          },
          everyMs * (i + 1),
        );
      });
    },
  });
}

it("fails a request that gets no answer for 45 s with an error naming the file, and not before", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { network } = await networkFetcher();
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => hangs(init));
  const loading = network.bytes(POINTER);
  const watch = watched(loading);

  await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS - 1);
  expect(watch.settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  await expect(loading).rejects.toBeInstanceOf(AssetStalledError);
  await expect(loading).rejects.not.toBeInstanceOf(AssetResponseError);
  await expect(loading).rejects.toMatchObject({
    url: `${BUCKET}${POINTER}`,
    silenceLimitMs: SILENCE_LIMIT_MS,
    message: `GET ${BUCKET}${POINTER} sent nothing for 45 s`,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("fails a response that goes silent partway through its body 45 s after the last chunk", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { network } = await networkFetcher();
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(encoder.encode('{"manifestFile"')), 10_000);
        init.signal?.addEventListener("abort", () =>
          controller.error(new DOMException("aborted", "AbortError")),
        );
      },
    });
    return new Response(body);
  });
  const loading = network.text(POINTER);
  const watch = watched(loading);

  await vi.advanceTimersByTimeAsync(10_000 + SILENCE_LIMIT_MS - 1);
  expect(watch.settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  await expect(loading).rejects.toBeInstanceOf(AssetStalledError);
  await expect(loading).rejects.toMatchObject({
    url: `${BUCKET}${POINTER}`,
    silenceLimitMs: SILENCE_LIMIT_MS,
    message: `GET ${BUCKET}${POINTER} sent nothing for 45 s`,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a response that sends something every 44.999 s, headers included, however long it takes in all", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { network } = await networkFetcher();
  const chunks = ["slow ", "but ", "steady ", "bytes"];
  const pace = SILENCE_LIMIT_MS - 1;
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((answer) =>
        setTimeout(() => answer(new Response(pacedBody(chunks, pace))), pace),
      ),
  );
  const loading = network.text(POINTER);

  await vi.advanceTimersByTimeAsync((chunks.length + 1) * SILENCE_LIMIT_MS);

  await expect(loading).resolves.toBe(chunks.join(""));
  expect(vi.getTimerCount()).toBe(0);
});

function hangs(init: RequestInit): Promise<Response> {
  return new Promise((_answer, refuse) => {
    init.signal?.addEventListener("abort", () => refuse(new DOMException("aborted", "AbortError")));
  });
}

const WAITING = "standard/waiting.glb";
const FLOWING = "standard/flowing.glb";

it("keeps a request queued behind another response for as long as that response keeps arriving", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { network } = await networkFetcher();
  const flowing = ["one ", "two ", "three ", "four ", "five ", "six ", "seven ", "eight ", "nine"];
  const chunkEveryMs = 10_000;
  const queuedAnswerMs = (flowing.length + 1) * chunkEveryMs;
  vi.stubGlobal("fetch", (url: string) =>
    url.endsWith(FLOWING)
      ? Promise.resolve(new Response(pacedBody(flowing, chunkEveryMs)))
      : new Promise<Response>((answer) =>
          setTimeout(() => answer(new Response("queued")), queuedAnswerMs),
        ),
  );
  const first = network.text(FLOWING);
  const queued = network.text(WAITING);

  await vi.advanceTimersByTimeAsync(queuedAnswerMs);

  await expect(first).resolves.toBe(flowing.join(""));
  await expect(queued).resolves.toBe("queued");
  expect(vi.getTimerCount()).toBe(0);
});

it("fails a response the server hangs while other responses keep arriving, once nothing has arrived for 45 s", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { network } = await networkFetcher();
  const flowing = ["a", "b", "c", "d", "e"];
  const chunkEveryMs = 20_000;
  const lastChunkMs = flowing.length * chunkEveryMs;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    url.endsWith(FLOWING)
      ? Promise.resolve(new Response(pacedBody(flowing, chunkEveryMs)))
      : hangs(init),
  );
  const hung = network.bytes(WAITING);
  const watch = watched(hung);
  const other = network.text(FLOWING);

  await vi.advanceTimersByTimeAsync(lastChunkMs + SILENCE_LIMIT_MS - 1);
  await expect(other).resolves.toBe(flowing.join(""));
  expect(watch.settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  await expect(hung).rejects.toBeInstanceOf(AssetStalledError);
  await expect(hung).rejects.toMatchObject({ url: `${BUCKET}${WAITING}` });
  expect(vi.getTimerCount()).toBe(0);
});

it("fails every request still waiting once nothing has arrived from the server for 45 s", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { network } = await networkFetcher();
  const lastByteMs = 5_000;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    if (!url.endsWith(FLOWING)) return hangs(init);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(encoder.encode("partial")), lastByteMs);
        init.signal?.addEventListener("abort", () =>
          controller.error(new DOMException("aborted", "AbortError")),
        );
      },
    });
    return Promise.resolve(new Response(body));
  });
  const neverAnswered = network.bytes(WAITING);
  const cutOff = network.bytes(FLOWING);
  const watches = [watched(neverAnswered), watched(cutOff)];

  await vi.advanceTimersByTimeAsync(lastByteMs + SILENCE_LIMIT_MS - 1);
  expect(watches.map((watch) => watch.settled())).toEqual([false, false]);
  await vi.advanceTimersByTimeAsync(1);

  await expect(neverAnswered).rejects.toMatchObject({ url: `${BUCKET}${WAITING}` });
  await expect(cutOff).rejects.toMatchObject({ url: `${BUCKET}${FLOWING}` });
  await expect(neverAnswered).rejects.toBeInstanceOf(AssetStalledError);
  await expect(cutOff).rejects.toBeInstanceOf(AssetStalledError);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a request waiting while a peer shares progress, and fails it 45 s after the last share", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { network, peers } = await networkFetcher();
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => hangs(init));
  const waiting = network.bytes(WAITING);
  const watch = watched(waiting);
  const sharedAtMs = 20_000;
  await vi.advanceTimersByTimeAsync(sharedAtMs);
  peers.deliverShare();

  await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS - 1);
  expect(watch.settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  await expect(waiting).rejects.toBeInstanceOf(AssetStalledError);
  expect(vi.getTimerCount()).toBe(0);
});

it("reads exactly what was sent and leaves no timer behind, however the request ends", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { network } = await networkFetcher();
  const sent = encoder.encode("añb€c");
  const split = [sent.slice(0, 2), sent.slice(2, 5), sent.slice(5)];
  respondWith(split);
  expect(new Uint8Array(await network.bytes(POINTER))).toEqual(sent);
  respondWith(split);
  expect(await network.text(POINTER)).toBe("añb€c");
  vi.stubGlobal("fetch", async () => new Response(null));
  expect((await network.bytes(POINTER)).byteLength).toBe(0);
  expect(await network.text(POINTER)).toBe("");
  vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
  await expect(network.text(POINTER)).rejects.toBeInstanceOf(AssetResponseError);
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await expect(network.bytes(POINTER)).rejects.toThrow("Failed to fetch");

  expect(vi.getTimerCount()).toBe(0);
});
