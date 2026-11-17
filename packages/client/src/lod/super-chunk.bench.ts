import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import { SUPER_CHUNK_LDU, STUD_LDU } from "@brr/math";
import type { ISceneBackend, WorldBox } from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { PerformanceObserver } from "node:perf_hooks";
import { afterAll, beforeAll, test } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { modelFrameShift } from "../edit/placeable.ts";
import { placedVoxels, type PlacedVoxels } from "./placed-voxels.ts";
import { SuperChunkLod, type ChunkResidency, type VoxelPlacement } from "./super-chunk-lod.ts";
import {
  SUPER_CHUNK_MESH_LEVELS,
  SuperChunkMesher,
  type VoxelStamp,
} from "./super-chunk-mesher.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const SETS = ["10264-1", "2150-1", "10190-1", "10133-1"];
const MODULE_PITCH_LDU = 1280;
const WORLD_SIDE = 45;
const FOCAL_PX = 1236;
const PROBE_FRAMES = 100_000;
const NO_DEADLINE = Number.POSITIVE_INFINITY;
const EYE_HEIGHT_LDU = 3000;
const CLOCK_CHECK_MASK = 0xffff;

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class MeshCountingBackend {
  meshes = 0;
  setSuperChunk(): void {
    this.meshes++;
  }
  setSuperChunkVisible(): void {}
  deleteSuperChunk(): void {}
  studPitchesPx(distancesLdu: Float64Array, count: number, out: Float64Array): void {
    for (let i = 0; i < count; i++) {
      out[i] = (STUD_LDU * FOCAL_PX) / Math.max(distancesLdu[i] ?? 0, 1);
    }
  }
}

class InstantResidency implements ChunkResidency {
  loadSuperChunk(): boolean {
    return true;
  }
  unloadSuperChunk(): void {}
}

let models: PlacedVoxels[] = [];
let superChunkStamps: VoxelStamp[] = [];
let world: SuperChunkLod | null = null;
const probe: string[] = [];

function placement(voxels: PlacedVoxels, x: number, z: number, rot: number): VoxelPlacement {
  const box: WorldBox = {
    minX: x - MODULE_PITCH_LDU / 2,
    minY: 0,
    minZ: z - MODULE_PITCH_LDU / 2,
    maxX: x + MODULE_PITCH_LDU / 2,
    maxY: 400,
    maxZ: z + MODULE_PITCH_LDU / 2,
  };
  return { box, voxels, x, z, yPlates: 0, rot };
}

function gcCounter(): { readonly count: () => number; readonly stop: () => void } {
  let collections = 0;
  const observer = new PerformanceObserver((list) => {
    collections += list.getEntries().length;
  });
  observer.observe({ entryTypes: ["gc"] });
  return { count: () => collections, stop: () => observer.disconnect() };
}

async function settleGc(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeAll(async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const loader = container.get(PART_BUNDLE_LOADER);
  models = [];
  for (const name of SETS) {
    const far = await loader.loadModel("far", name);
    const { lattice, cells } = far.model;
    if (!far.farMesh || !lattice || !cells) throw new Error(`${name} has no far mesh or lattice`);
    models.push(
      placedVoxels(far.farMesh.voxels, modelFrameShift(lattice, cells, cells.restY), (c) => c),
    );
  }
  superChunkStamps = [];
  const perSide = SUPER_CHUNK_LDU / MODULE_PITCH_LDU;
  for (let i = 0; i < perSide * perSide; i++) {
    const voxels = models[i % models.length];
    if (!voxels) continue;
    const x = (i % perSide) * MODULE_PITCH_LDU + MODULE_PITCH_LDU / 2;
    const z = Math.floor(i / perSide) * MODULE_PITCH_LDU + MODULE_PITCH_LDU / 2;
    superChunkStamps.push({ voxels, x, z, yPlates: 0, rot: 0 });
  }

  const backend = new MeshCountingBackend();
  const lod = new SuperChunkLod(backend as unknown as ISceneBackend, new InstantResidency());
  for (let i = 0; i < WORLD_SIDE * WORLD_SIDE; i++) {
    const voxels = models[i % models.length];
    if (!voxels) continue;
    const x = (i % WORLD_SIDE) * MODULE_PITCH_LDU + MODULE_PITCH_LDU / 2;
    const z = Math.floor(i / WORLD_SIDE) * MODULE_PITCH_LDU + MODULE_PITCH_LDU / 2;
    lod.add(placement(voxels, x, z, i % 4));
  }
  lod.update(0, EYE_HEIGHT_LDU, 0, NO_DEADLINE);
  while (lod.work(NO_DEADLINE)) lod.update(0, EYE_HEIGHT_LDU, 0, NO_DEADLINE);
  world = lod;

  const gc = gcCounter();
  await settleGc();
  const before = gc.count();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  for (let f = 0; f < PROBE_FRAMES; f++) lod.update(0, EYE_HEIGHT_LDU, 0, NO_DEADLINE);
  const elapsed = performance.now() - start;
  const heapAfter = process.memoryUsage().heapUsed;
  await settleGc();
  const updateGcs = gc.count() - before;
  const floorBefore = gc.count();
  const floorStart = performance.now();
  let spins = 0;
  while ((spins & CLOCK_CHECK_MASK) !== 0 || performance.now() - floorStart < elapsed) spins++;
  await settleGc();
  probe.push(
    `SuperChunkLod.update, ${WORLD_SIDE * WORLD_SIDE} models in ${lod.stats.superChunks} super-chunks, ` +
      `${PROBE_FRAMES} settled frames: ${((elapsed * 1000) / PROBE_FRAMES).toFixed(2)} µs/frame, ` +
      `${updateGcs} GCs, heap ${((heapAfter - heapBefore) / 1024).toFixed(1)} KiB; ` +
      `an empty loop for the same ${elapsed.toFixed(0)} ms (${spins} spins) saw ${gc.count() - floorBefore} GCs`,
  );
  gc.stop();
});

afterAll(() => {
  process.stdout.write(`allocation probe\n${probe.join("\n")}\n`);
});

test("super-chunk mesh build, one super-chunk of 16 OMR models", async ({ bench }) => {
  const levels = [];
  for (let level = 0; level < SUPER_CHUNK_MESH_LEVELS; level++) {
    levels.push(
      bench(`level ${level} (${1 << level}x cells)`, () => {
        const mesher = new SuperChunkMesher();
        mesher.begin(0, 0, superChunkStamps, level);
        mesher.step(NO_DEADLINE);
        mesher.finish();
      }),
    );
  }
  await bench.compare(...levels);
});

test("per-frame super-chunk LOD update, 2,025 models settled", async ({ bench }) => {
  const lod = world;
  if (!lod) throw new Error("the 2,025-model world was not built");
  await bench("update", () => {
    lod.update(0, EYE_HEIGHT_LDU, 0, NO_DEADLINE);
  }).run();
});
