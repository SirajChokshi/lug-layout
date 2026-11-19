import { INHERIT_COLOR, type PartAsset, type PartMesh } from "@brr/catalog";
import { CHUNK_LDU } from "@brr/math";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChunkInstances, NeededMeshListener, PartPalette } from "../scene-backend.ts";
import { ThreeSceneBackend } from "./three-scene-backend.ts";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const TILTED = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0];
const CLOSE_EYE_LDU = 20;
const DISTANT_EYE_LDU = 10_000_000;
const VIEW_EYE_HEIGHT_LDU = 2_000;
const WELL_PAST_SETTLE_MS = 1_000;
const RED = 4;
const NO_STUDS = {
  count: 0,
  primitiveIndex: new Uint8Array(0),
  colorIndex: new Uint16Array(0),
  matrices: new Float32Array(0),
};

function triangle(size: number): PartMesh {
  return {
    positions: Float32Array.of(0, 0, 0, size, 0, 0, 0, size, 0),
    normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1),
    groups: [{ ldrawColor: INHERIT_COLOR, indices: Uint32Array.of(0, 1, 2) }],
  };
}

function part(id: string, size: number): PartAsset {
  return {
    id,
    title: id,
    role: "detail",
    boundsMin: [0, 0, 0],
    boundsMax: [size, size, 0],
    producedColor: undefined,
    producedColors: undefined,
    trackEnds: undefined,
    mesh: triangle(size),
    studPrimitiveIndex: new Uint8Array(0),
    studColors: new Uint16Array(0),
    studMatrices: new Float32Array(0),
    technic: null,
    rolling: null,
  };
}

function chunkOf(partIndex: number): ChunkInstances {
  return {
    originX: 0,
    originZ: 0,
    count: 1,
    partIndex: Uint16Array.of(partIndex),
    colorIndex: Uint16Array.of(0),
    matrices: Float32Array.from(IDENTITY),
    studs: NO_STUDS,
  };
}

function palette(parts: ReadonlyArray<PartAsset>): PartPalette {
  return {
    detailed: { parts, studPrimitives: [] },
    colorsSrgb: Uint8Array.of(200, 0, 0),
    colorsAlpha: Uint8Array.of(255),
    ldrawColors: new Map([[RED, { srgb: 0xc80000, alpha: 255 }]]),
  };
}

interface Instance {
  readonly part: number;
  readonly tilted?: boolean;
  readonly voxelized?: boolean;
}

function chunkWith(instances: ReadonlyArray<Instance>): ChunkInstances {
  return {
    originX: 0,
    originZ: 0,
    count: instances.length,
    partIndex: Uint16Array.from(instances, (instance) => instance.part),
    colorIndex: new Uint16Array(instances.length),
    matrices: Float32Array.from(instances.flatMap((i) => (i.tilted ? TILTED : IDENTITY))),
    voxelized: Uint8Array.from(instances, (instance) => (instance.voxelized ? 1 : 0)),
    studs: NO_STUDS,
  };
}

interface Needs {
  readonly call: "hold" | "release";
  readonly detailed: ReadonlyArray<number>;
  readonly far: ReadonlyArray<number>;
}

class RecordingListener implements NeededMeshListener {
  private calls: Needs[] = [];

  hold(detailedIndices: Uint32Array, farIndices: Uint32Array): void {
    this.calls.push({ call: "hold", detailed: [...detailedIndices], far: [...farIndices] });
  }

  release(detailedIndices: Uint32Array, farIndices: Uint32Array): void {
    this.calls.push({ call: "release", detailed: [...detailedIndices], far: [...farIndices] });
  }

  take(): ReadonlyArray<Needs> {
    const calls = this.calls;
    this.calls = [];
    return calls;
  }
}

const PARTS = [part("a", 20), part("b", 20), part("c", 20), part("d", 20), part("e", 20)];
const MIXED = chunkWith([
  { part: 0 },
  { part: 1, tilted: true },
  { part: 2, voxelized: true },
  { part: 3, tilted: true, voxelized: true },
]);
const MIXED_NEAR = { detailed: [0, 1, 2, 3], far: [] };
const MIXED_MID = { detailed: [1, 3], far: [0, 2] };
const MIXED_FAR = { detailed: [1], far: [0] };
const GROWN = chunkWith([{ part: 0 }, { part: 1, tilted: true }, { part: 4 }]);
const GROWN_FAR = { detailed: [1], far: [0, 4] };

function hold(needs: Omit<Needs, "call">): Needs {
  return { call: "hold", ...needs };
}

function release(needs: Omit<Needs, "call">): Needs {
  return { call: "release", ...needs };
}

function tieredBackend(): { backend: ThreeSceneBackend; listener: RecordingListener } {
  const backend = new ThreeSceneBackend();
  const listener = new RecordingListener();
  backend.setNeededMeshListener(listener);
  backend.setPalette(palette(PARTS));
  backend.setFarStuds([]);
  return { backend, listener };
}

it("has each chunk hold the part meshes its tier draws, claiming the new lists before releasing the old", () => {
  const { backend, listener } = tieredBackend();

  backend.forceTier("near");
  backend.setChunk(1, MIXED);
  expect(listener.take()).toEqual([hold(MIXED_NEAR)]);
  backend.forceTier("mid");
  expect(listener.take()).toEqual([hold(MIXED_MID), release(MIXED_NEAR)]);
  backend.forceTier("far");
  expect(listener.take()).toEqual([hold(MIXED_FAR), release(MIXED_MID)]);
  backend.setPartMeshes([{ index: 0, level: "far", part: part("a", 40) }]);
  expect(listener.take()).toEqual([]);
  backend.setChunk(1, GROWN);
  expect(listener.take()).toEqual([hold(GROWN_FAR), release(MIXED_FAR)]);
  backend.deleteChunk(1);
  expect(listener.take()).toEqual([release(GROWN_FAR)]);
});

it("takes a chunk's tier from the view when it is set and when the eye moves", () => {
  const { backend, listener } = tieredBackend();
  backend.resize(640, 480);
  backend.setView(0, CLOSE_EYE_LDU, 0, 0, 0, 1);

  backend.setChunk(1, MIXED);
  expect(listener.take()).toEqual([hold(MIXED_NEAR)]);
  backend.setView(0, DISTANT_EYE_LDU, 0, 0, 0, 1);
  expect(listener.take()).toEqual([hold(MIXED_FAR), release(MIXED_NEAR)]);
  backend.setView(0, DISTANT_EYE_LDU, 0, 0, 0, 1);
  expect(listener.take()).toEqual([]);
  backend.setChunk(2, MIXED);
  expect(listener.take()).toEqual([hold(MIXED_FAR)]);
});

it("moves chunks set before tiers turn on to their tier's lists, though they keep their instances", () => {
  const backend = new ThreeSceneBackend();
  const listener = new RecordingListener();
  backend.setNeededMeshListener(listener);
  backend.setPalette(palette(PARTS));
  backend.forceTier("mid");

  backend.setChunk(1, MIXED);
  expect(listener.take()).toEqual([hold(MIXED_NEAR)]);
  backend.setFarStuds([]);
  expect(listener.take()).toEqual([hold(MIXED_MID), release(MIXED_NEAR)]);
});

it.each([
  {
    holder: "the ghost",
    set: (backend: ThreeSceneBackend, model: ChunkInstances) => backend.setGhost(model),
    clear: (backend: ThreeSceneBackend) => backend.setGhost(null),
  },
  {
    holder: "a vehicle",
    set: (backend: ThreeSceneBackend, model: ChunkInstances) => backend.setVehicle(0, model),
    clear: (backend: ThreeSceneBackend) => backend.deleteVehicle(0),
  },
])("has $holder hold its part meshes at the detailed level while it is set", ({ set, clear }) => {
  const { backend, listener } = tieredBackend();
  backend.forceTier("mid");

  set(backend, MIXED);
  expect(listener.take()).toEqual([hold(MIXED_NEAR)]);
  backend.setPartMeshes([{ index: 1, level: "detailed", part: part("b", 40) }]);
  expect(listener.take()).toEqual([]);
  set(backend, GROWN);
  const grownNear = { detailed: [0, 1, 4], far: [] };
  expect(listener.take()).toEqual([hold(grownNear), release(MIXED_NEAR)]);
  clear(backend);
  expect(listener.take()).toEqual([release(grownNear)]);
});

it("swaps meshes, far studs and far model meshes while chunks, a vehicle, a ghost and far models are on the scene", () => {
  const backend = new ThreeSceneBackend();
  backend.setPalette(palette([part("a", 20)]));
  backend.addParts([part("b", 40)]);
  backend.setChunk(1, chunkOf(0));
  backend.setChunk(2, chunkOf(1));
  backend.setVehicle(0, chunkOf(0));
  backend.setGhost(chunkOf(1));
  backend.placeGhost(0, 0, 0, 0);
  backend.setFarModel(7, {
    modelIndex: 0,
    originX: 0,
    originZ: 0,
    matrix: Float32Array.from(IDENTITY),
    chunkKeys: [1, 2],
  });

  backend.setPartMeshes([
    { index: 0, level: "detailed", part: part("a", 20) },
    { index: 1, level: "far", part: part("b", 40) },
  ]);
  backend.setFarStuds([]);
  backend.setPartMeshes([{ index: 1, level: "far", part: part("b", 40) }]);
  backend.setFarModelMesh(0, triangle(80));

  expect(() =>
    backend.setPartMeshes([{ index: 2, level: "detailed", part: part("c", 20) }]),
  ).toThrow("part 2 is not in the palette");
});

describe("the render origin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebases to the eye's chunk once the eye has been still for the settle time, without another setView", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const backend = new ThreeSceneBackend();
    backend.resize(640, 480);
    const z = CHUNK_LDU / 2;
    const firstX = CHUNK_LDU / 2;
    const nextChunkX = CHUNK_LDU + CHUNK_LDU / 2;
    const rebasedChunks = (): ReadonlyArray<readonly [number, number]> =>
      backend.rebaseLog().map(({ chunkX, chunkZ }) => [chunkX, chunkZ] as const);

    backend.setView(firstX, VIEW_EYE_HEIGHT_LDU, z, firstX, 0, z + 1);
    backend.setView(nextChunkX, VIEW_EYE_HEIGHT_LDU, z, nextChunkX, 0, z + 1);
    const whileMoving = rebasedChunks();
    vi.advanceTimersByTime(WELL_PAST_SETTLE_MS);
    const ray = new Float64Array(6);
    backend.rayThrough(0, 0, ray);

    expect({ whileMoving, settled: rebasedChunks(), eyeX: ray[0], eyeZ: ray[2] }).toEqual({
      whileMoving: [[0, 0]],
      settled: [
        [0, 0],
        [1, 0],
      ],
      eyeX: nextChunkX,
      eyeZ: z,
    });
  });
});
