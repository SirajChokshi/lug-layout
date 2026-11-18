import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  withPlaceholderMesh,
  type IAssetFetcher,
} from "@brr/catalog";
import {
  INSTANCE_MATRIX_FLOATS,
  SCENE_BACKEND,
  type ChunkInstances,
  type ChunkTier,
  type ISceneBackend,
  type NeededMeshListener,
  type PartMeshUpdate,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { mainThreadModules } from "../src/client.module.ts";
import { MergedParts } from "../src/edit/merged-parts.ts";
import { meshesSettled, NO_MESHES } from "../src/edit/mesh-progress.ts";
import { PartMeshStream, type PartMeshProgress } from "../src/edit/part-mesh-stream.ts";
import { ColorTable, ldrawColors } from "../src/scene/viewer-scene.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const LOD = "standard";
const CHUNKS = 401;
const CHUNK_ROW = 20;
const CHUNK_LDU = 640;
const INSTANCES_PER_CHUNK = 48;
const INSTANCE_ROW = 8;
const INSTANCE_STEP_LDU = 80;
const TILTED_PART_EVERY = 5;
const VOXELIZED_EVERY = 3;
const PART_STRIDE = 13;
const INSTANCE_STRIDE = 7;
const VIEW_WIDTH_PX = 1600;
const VIEW_HEIGHT_PX = 900;
const EYE_X_LDU = 6_400;
const EYE_Z_LDU = 6_400;
const CLOSE_EYE_Y_LDU = 400;
const DISTANT_EYE_Y_LDU = 40_000;
const TIER_CHANGES = 600;
const CAMERA_MOVES = 200;
const IDLE_VIEWS = 20_000;
const SETTLE_POLL_MS = 20;
const GC_SETTLE_MS = 50;
const UPRIGHT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const TILTED = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0];
const TIERS: ReadonlyArray<ChunkTier> = ["near", "mid", "far"];

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class CountingListener implements NeededMeshListener {
  calls = 0;
  edges = 0;
  private readonly detailed: Uint16Array;
  private readonly far: Uint16Array;

  constructor(
    private readonly stream: NeededMeshListener,
    parts: number,
  ) {
    this.detailed = new Uint16Array(parts);
    this.far = new Uint16Array(parts);
  }

  hold(detailedIndices: Uint32Array, farIndices: Uint32Array): void {
    this.calls++;
    this.step(this.detailed, detailedIndices, 1);
    this.step(this.far, farIndices, 1);
    this.stream.hold(detailedIndices, farIndices);
  }

  release(detailedIndices: Uint32Array, farIndices: Uint32Array): void {
    this.calls++;
    this.step(this.detailed, detailedIndices, -1);
    this.step(this.far, farIndices, -1);
    this.stream.release(detailedIndices, farIndices);
  }

  private step(counts: Uint16Array, indices: Uint32Array, step: number): void {
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i] ?? 0;
      const before = counts[index] ?? 0;
      counts[index] = before + step;
      if (before === 0 || before + step === 0) this.edges++;
    }
  }
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

interface Row {
  readonly name: string;
  readonly calls: number;
  readonly meanUs: number;
  readonly listenerCalls: number;
  readonly edges: number;
  readonly gcs: number;
  readonly heapGrowthKb: number;
}

const rows: Row[] = [];

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectGarbage(): void {
  const gc: unknown = Reflect.get(globalThis, "gc");
  if (typeof gc === "function") gc();
}

async function probe(
  name: string,
  listener: CountingListener,
  calls: number,
  warmup: number,
  call: (i: number) => void,
): Promise<void> {
  for (let i = 0; i < warmup; i++) call(i);
  collectGarbage();
  await pause(GC_SETTLE_MS);
  const callsBefore = listener.calls;
  const edgesBefore = listener.edges;
  const heapBefore = process.memoryUsage().heapUsed;
  const gcBefore = collections;
  const start = performance.now();
  for (let i = 0; i < calls; i++) call(i);
  const elapsedMs = performance.now() - start;
  const heapAfter = process.memoryUsage().heapUsed;
  await pause(GC_SETTLE_MS);
  rows.push({
    name,
    calls,
    meanUs: (elapsedMs / calls) * 1000,
    listenerCalls: listener.calls - callsBefore,
    edges: listener.edges - edgesBefore,
    gcs: collections - gcBefore,
    heapGrowthKb: (heapAfter - heapBefore) / 1024,
  });
}

function syntheticChunk(chunk: number, parts: number): ChunkInstances {
  const matrices = new Float32Array(INSTANCES_PER_CHUNK * INSTANCE_MATRIX_FLOATS);
  const partIndex = new Uint16Array(INSTANCES_PER_CHUNK);
  const voxelized = new Uint8Array(INSTANCES_PER_CHUNK);
  for (let i = 0; i < INSTANCES_PER_CHUNK; i++) {
    const o = i * INSTANCE_MATRIX_FLOATS;
    const part = (chunk * PART_STRIDE + i * INSTANCE_STRIDE) % parts;
    matrices.set(part % TILTED_PART_EVERY === 0 ? TILTED : UPRIGHT, o);
    matrices[o + 3] = (i % INSTANCE_ROW) * INSTANCE_STEP_LDU;
    matrices[o + 11] = Math.floor(i / INSTANCE_ROW) * INSTANCE_STEP_LDU;
    partIndex[i] = part;
    voxelized[i] = i % VOXELIZED_EVERY === 0 ? 1 : 0;
  }
  return {
    originX: (chunk % CHUNK_ROW) * CHUNK_LDU,
    originZ: Math.floor(chunk / CHUNK_ROW) * CHUNK_LDU,
    count: INSTANCES_PER_CHUNK,
    partIndex,
    colorIndex: new Uint16Array(INSTANCES_PER_CHUNK),
    matrices,
    voxelized,
    studs: {
      count: 0,
      primitiveIndex: new Uint8Array(0),
      colorIndex: new Uint16Array(0),
      matrices: new Float32Array(0),
    },
  };
}

function lookFrom(eyeY: number): void {
  backend.setView(EYE_X_LDU, eyeY, EYE_Z_LDU, EYE_X_LDU, 0, EYE_Z_LDU + 1);
}

const container = new Container();
container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
const loader = container.get(PART_BUNDLE_LOADER);
const backend: ISceneBackend = container.get(SCENE_BACKEND);
const index = await loader.loadIndex(LOD);
const shapes = await Promise.all(index.catalogParts.map((part) => loader.loadPartShape(LOD, part)));
const palette = new MergedParts(shapes.map(withPlaceholderMesh));
const streamed: { progress: PartMeshProgress } = {
  progress: { detailedPartMeshes: NO_MESHES, farPartMeshes: NO_MESHES },
};
const stream = new PartMeshStream(loader, backend, palette, LOD, (latest) => {
  streamed.progress = latest;
});
for (const shape of shapes) stream.register(palette.indexOf(shape.id), shape.meshFile);
const listener = new CountingListener(stream, palette.parts.length);
backend.setNeededMeshListener(listener);
const colorSource = { colors: index.colors, parts: [] };
const colors = new ColorTable(colorSource);
colors.indexOfCode(index.colors[0]?.code ?? 0);
backend.setPalette({
  detailed: { parts: palette.parts, studPrimitives: await loader.loadStudPrimitives(LOD) },
  colorsSrgb: colors.toSrgb(),
  colorsAlpha: colors.toAlpha(),
  ldrawColors: ldrawColors(colorSource),
});
backend.resize(VIEW_WIDTH_PX, VIEW_HEIGHT_PX);
lookFrom(CLOSE_EYE_Y_LDU);
backend.setFarStuds(await loader.loadStudPrimitives("far"));
stream.useFarFiles(await loader.loadPartFiles("far"));
backend.forceTier("near");
const setStart = performance.now();
for (let chunk = 0; chunk < CHUNKS; chunk++) {
  backend.setChunk(chunk, syntheticChunk(chunk, palette.parts.length));
}
const setMs = performance.now() - setStart;

const streamStart = performance.now();
await probe("(i) first forced change near → mid (cold: starts far fetches)", listener, 1, 0, () =>
  backend.forceTier("mid"),
);
while (!meshesSettled({ ...streamed.progress, farModelMeshes: NO_MESHES })) {
  await pause(SETTLE_POLL_MS);
}
const streamMs = performance.now() - streamStart;

async function withListenerDetached(run: () => Promise<void>): Promise<void> {
  backend.setNeededMeshListener(null);
  await run();
  backend.setNeededMeshListener(listener);
}

const forcedTierChange = (i: number): void => backend.forceTier(TIERS[i % TIERS.length] ?? null);
const cameraMove = (i: number): void => lookFrom(i % 2 === 0 ? DISTANT_EYE_Y_LDU : CLOSE_EYE_Y_LDU);

await withListenerDetached(async () => {
  await probe(
    "(ii) forced tier change, listener detached (the tier work alone)",
    listener,
    TIER_CHANGES,
    TIER_CHANGES,
    forcedTierChange,
  );
  backend.forceTier("mid");
});
await probe(
  "(ii) forced tier change, everything loaded",
  listener,
  TIER_CHANGES,
  TIER_CHANGES,
  forcedTierChange,
);
backend.forceTier(null);
await withListenerDetached(() =>
  probe(
    "(ii) camera move across tiers, listener detached (the view work alone)",
    listener,
    CAMERA_MOVES,
    CAMERA_MOVES,
    cameraMove,
  ),
);
await probe(
  "(ii) camera move across tiers, everything loaded",
  listener,
  CAMERA_MOVES,
  CAMERA_MOVES,
  cameraMove,
);

const farFiles = await loader.loadPartFiles("far");
const farUpdates: PartMeshUpdate[] = [];
for (let p = 0; p < palette.parts.length; p++) {
  const part = palette.parts[p];
  const file = part ? farFiles.get(part.id) : undefined;
  if (!part || file === undefined) continue;
  farUpdates.push({
    index: p,
    level: "far",
    part: { ...part, mesh: await loader.loadPartMesh("far", file, "low") },
  });
}
await probe(
  "(iii) far-arrival rebuild storm, setPartMeshes with every far mesh",
  listener,
  1,
  0,
  () => backend.setPartMeshes(farUpdates),
);

backend.forceTier("mid");
const uprightDetailedUpdates: PartMeshUpdate[] = palette.parts.flatMap((part, partIndex) =>
  partIndex % TILTED_PART_EVERY === 0 ? [] : [{ index: partIndex, level: "detailed", part }],
);
await probe(
  "(v) detailed-arrival storm at mid for upright parts whose far meshes are in",
  listener,
  1,
  0,
  () => backend.setPartMeshes(uprightDetailedUpdates),
);

await probe(
  "(iv) setView with an unchanged view, tiers stable",
  listener,
  IDLE_VIEWS,
  IDLE_VIEWS,
  () => lookFrom(CLOSE_EYE_Y_LDU),
);

observer.disconnect();
const header = [
  `cpu: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}, node ${process.version}, gc exposed: ${typeof Reflect.get(globalThis, "gc") === "function"}`,
  `scene: ${CHUNKS} chunks x ${INSTANCES_PER_CHUNK} instances of ${palette.parts.length} palette parts; set at near in ${setMs.toFixed(0)} ms; streamed every mesh from the first forced change near → mid in ${streamMs.toFixed(0)} ms`,
];
const table = [
  "| Probe | Calls | Mean µs | Listener calls | Hold edges | GCs | Heap growth KiB |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...rows.map(
    (row) =>
      `| ${row.name} | ${row.calls} | ${row.meanUs.toFixed(2)} | ${row.listenerCalls} | ${row.edges} | ${row.gcs} | ${row.heapGrowthKb.toFixed(1)} |`,
  ),
];
process.stdout.write(`${[...header, "", ...table].join("\n")}\n`);
