import {
  INHERIT_COLOR,
  type PartAsset,
  type PartMesh,
  type StudPrimitiveAsset,
} from "@brr/catalog";
import { CHUNK_LDU } from "@brr/math";
import {
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  Vector3,
  type BufferGeometry,
  type MeshStandardNodeMaterial,
  type Object3D,
} from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChunkInstances,
  ChunkTier,
  FarModelPlacement,
  NeededMeshListener,
  PartPalette,
  PlanOverlay,
  WorldBox,
} from "../scene-backend.ts";
import { edgeIdOf } from "./edge-ids.ts";
import { studBasisIndexOf } from "./instance-page.ts";
import { STUD_BASIS_FLOATS, type StudBasisTable } from "./stud-basis-table.ts";
import { StudMesh } from "./stud-mesh.ts";
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
    topSurface: null,
    outline: null,
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

const CHUNK = 640;
const OPAQUE = 255;
const TRANSLUCENT = 128;
const TWO_COLOURS_SRGB = Uint8Array.of(200, 0, 0, 0, 0, 200);

function stud(): StudPrimitiveAsset {
  return {
    mesh: {
      positions: Float32Array.of(0, 0, 0, 4, 0, 0, 0, 4, 0),
      normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1),
      indices: Uint32Array.of(0, 1, 2),
    },
  };
}

function edgeBackend(): ThreeSceneBackend {
  const backend = new ThreeSceneBackend();
  backend.setPalette({
    detailed: { parts: [part("a", 20)], studPrimitives: [stud()] },
    colorsSrgb: TWO_COLOURS_SRGB,
    colorsAlpha: Uint8Array.of(OPAQUE, OPAQUE),
    ldrawColors: new Map([[RED, { srgb: 0xc80000, alpha: OPAQUE }]]),
  });
  backend.setFarStuds([stud()]);
  return backend;
}

function partsAndStudAt(originX: number, originZ: number): ChunkInstances {
  return {
    originX,
    originZ,
    count: 2,
    partIndex: Uint16Array.of(0, 0),
    colorIndex: Uint16Array.of(0, 1),
    matrices: Float32Array.from([...IDENTITY, ...IDENTITY]),
    studs: {
      count: 1,
      primitiveIndex: Uint8Array.of(0),
      colorIndex: Uint16Array.of(0),
      matrices: Float32Array.from(IDENTITY),
    },
  };
}

function drawnMeshes(backend: ThreeSceneBackend): Mesh[] {
  const meshes: Mesh[] = [];
  const scene: Object3D = backend["scene"];
  scene.traverse((object) => {
    if (object instanceof Mesh && object.visible && edgeIdOf(object) !== 0) meshes.push(object);
  });
  return meshes;
}

function drawnEdgeIds(backend: ThreeSceneBackend): number[] {
  return drawnMeshes(backend).map(edgeIdOf);
}

const CONSIST = [0, 1, 2, 3, 4, 5, 6];
const VEHICLE_EDGE_IDS = [
  [2624768, 2626816],
  [2887040, 2889088],
  [3149312, 3151360],
  [3411584, 3413632],
  [3673856, 3675904],
  [3936128, 3938176],
  [2624768, 2626816],
].flat();
const GHOST_EDGE_IDS = [2362496, 2364544];

it.each<{ readonly tier: ChunkTier; readonly chunks: ReadonlyArray<number> }>([
  { tier: "near", chunks: [2048, 4096, 526592, 528640] },
  { tier: "mid", chunks: [2048, 4096, 526592, 528640] },
  { tier: "far", chunks: [2048, 526592] },
])(
  "tags each chunk mesh drawn at $tier by its chunk's edge slot and its ordinal at that tier, and vehicles and the ghost by theirs",
  ({ tier, chunks }) => {
    const backend = edgeBackend();
    backend.setChunk(1, partsAndStudAt(0, 0));
    backend.setChunk(2, partsAndStudAt(-CHUNK, 0));
    for (const vehicle of CONSIST) backend.setVehicle(vehicle, partsAndStudAt(0, 0));
    backend.setGhost(partsAndStudAt(0, 0));

    backend.forceTier(tier);

    expect(drawnEdgeIds(backend)).toEqual([...chunks, ...VEHICLE_EDGE_IDS, ...GHOST_EDGE_IDS]);
  },
);

it("gives a chunk the same edge ids whether its far mesh arrived before it was set, after, or while its tier deferred the rebuild", () => {
  const before = edgeBackend();
  before.forceTier("mid");
  before.setPartMeshes([{ index: 0, level: "far", part: part("a", 40) }]);
  before.setChunk(1, partsAndStudAt(0, 0));
  const after = edgeBackend();
  after.forceTier("mid");
  after.setChunk(1, partsAndStudAt(0, 0));
  after.setPartMeshes([{ index: 0, level: "far", part: part("a", 40) }]);
  const deferred = edgeBackend();
  deferred.forceTier("near");
  deferred.setChunk(1, partsAndStudAt(0, 0));
  deferred.setPartMeshes([{ index: 0, level: "far", part: part("a", 40) }]);
  deferred.forceTier("mid");

  expect([drawnEdgeIds(before), drawnEdgeIds(after), drawnEdgeIds(deferred)]).toEqual([
    [2048, 4096],
    [2048, 4096],
    [2048, 4096],
  ]);
});

const HANDED_TRANSFORMS: ReadonlyArray<ReadonlyArray<number>> = [
  IDENTITY,
  TILTED,
  [0, 0, 1, 40, 0, 1, 0, 0, -1, 0, 0, 0],
  [-1, 0, 0, 80, 0, 1, 0, 0, 0, 0, 1, 0],
  [1, 0, 0, 120, 0, 0, -1, 0, 0, -1, 0, 0],
  [0, 0.8938, 0.4478, 160, 1, 0, 0.0915, 0, -0.0817, -0.4497, 0.89, 0],
  [0.5, 0, 0, 200, 0, -2, 0, 0, 0, 0, 1, 0],
];

function handedChunk(): ChunkInstances {
  const count = HANDED_TRANSFORMS.length;
  const matrices = Float32Array.from(HANDED_TRANSFORMS.flat());
  return {
    originX: 0,
    originZ: 0,
    count,
    partIndex: new Uint16Array(count),
    colorIndex: new Uint16Array(count),
    matrices,
    studs: {
      count,
      primitiveIndex: new Uint8Array(count),
      colorIndex: new Uint16Array(count),
      matrices,
    },
  };
}

function frontFacesOutward(geometry: BufferGeometry, matrix: Matrix4): boolean {
  const index = geometry.getIndex();
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  if (!index) throw new Error("drawn geometry has no index");
  const normalMatrix = new Matrix3().getNormalMatrix(matrix);
  for (let t = 0; t < index.count; t += 3) {
    const a = new Vector3().fromBufferAttribute(positions, index.getX(t)).applyMatrix4(matrix);
    const b = new Vector3().fromBufferAttribute(positions, index.getX(t + 1)).applyMatrix4(matrix);
    const c = new Vector3().fromBufferAttribute(positions, index.getX(t + 2)).applyMatrix4(matrix);
    const winding = b.sub(a).cross(c.sub(a));
    const normal = new Vector3()
      .fromBufferAttribute(normals, index.getX(t))
      .applyMatrix3(normalMatrix);
    if (winding.dot(normal) <= 0) return false;
  }
  return true;
}

function studMatrixOf(backend: ThreeSceneBackend, mesh: StudMesh, i: number): Matrix4 {
  const bases: StudBasisTable = backend["studBases"];
  const basis = studBasisIndexOf(mesh.studBasisAndColorIndex.getX(i)) * STUD_BASIS_FLOATS;
  const elements = Array.from(bases.columns.subarray(basis, basis + STUD_BASIS_FLOATS));
  return new Matrix4().fromArray([
    ...elements,
    mesh.studTranslations.getX(i),
    mesh.studTranslations.getY(i),
    mesh.studTranslations.getZ(i),
    1,
  ]);
}

function inwardInstances(backend: ThreeSceneBackend): string[] {
  const inward: string[] = [];
  for (const mesh of drawnMeshes(backend)) {
    if (mesh instanceof InstancedMesh) {
      for (let i = 0; i < mesh.count; i++) {
        const matrix = new Matrix4().fromArray(mesh.instanceMatrix.array, i * 16);
        if (!frontFacesOutward(mesh.geometry, matrix)) inward.push(`part ${i} of mesh ${mesh.id}`);
      }
    } else if (mesh instanceof StudMesh) {
      for (let i = 0; i < mesh.geometry.instanceCount; i++) {
        const matrix = studMatrixOf(backend, mesh, i);
        if (!frontFacesOutward(mesh.geometry, matrix)) inward.push(`stud ${i} of mesh ${mesh.id}`);
      }
    }
  }
  return inward;
}

it.each<ChunkTier>(["near", "mid"])(
  "draws every part and stud at the %s tier with its outer faces in front, mirrored or not, in chunks, vehicles and the ghost",
  (tier) => {
    const backend = edgeBackend();
    backend.setPartMeshes([{ index: 0, level: "far", part: part("a", 20) }]);
    backend.setChunk(1, handedChunk());
    backend.setVehicle(0, handedChunk());
    backend.setGhost(handedChunk());

    backend.forceTier(tier);

    expect(drawnMeshes(backend).length).toBeGreaterThan(0);
    expect(inwardInstances(backend)).toEqual([]);
  },
);

it("keeps edge ids when colours are appended, and refuses colours that change which colours share an alpha slot", () => {
  const backend = edgeBackend();
  backend.forceTier("near");
  backend.setChunk(1, partsAndStudAt(0, 0));
  backend.setColors(
    Uint8Array.of(...TWO_COLOURS_SRGB, 0, 200, 0),
    Uint8Array.of(OPAQUE, OPAQUE, TRANSLUCENT),
  );
  const meshes = drawnMeshes(backend).map((mesh) => mesh.id);

  expect(drawnEdgeIds(backend)).toEqual([2048, 4096]);
  expect(() => backend.setColors(TWO_COLOURS_SRGB, Uint8Array.of(OPAQUE, TRANSLUCENT))).toThrow(
    "setColors may only append colours",
  );
  expect(drawnMeshes(backend).map((mesh) => mesh.id)).toEqual(meshes);
});

const WEST_CHUNK_KEY = 35184367894528;
const MIDDLE_CHUNK_KEY = 35184376283136;
const EAST_CHUNK_KEY = 35184384671744;

function chunkKeysInSceneOrder(backend: ThreeSceneBackend): number[] {
  const scene: Object3D = backend["scene"];
  const chunks: Map<number, { readonly group: Object3D }> = backend["chunks"];
  const keyOfGroup = new Map(Array.from(chunks, ([key, record]) => [record.group, key]));
  const keys: number[] = [];
  scene.traverse((object) => {
    const key = keyOfGroup.get(object);
    if (key !== undefined) keys.push(key);
  });
  return keys;
}

it("keeps chunk groups in chunk-key order whatever order they were built and rebuilt in", () => {
  const rebuiltOnArrival = edgeBackend();
  rebuiltOnArrival.forceTier("mid");
  rebuiltOnArrival.setChunk(MIDDLE_CHUNK_KEY, partsAndStudAt(0, 0));
  rebuiltOnArrival.setPartMeshes([{ index: 0, level: "far", part: part("a", 40) }]);
  rebuiltOnArrival.setChunk(WEST_CHUNK_KEY, partsAndStudAt(-CHUNK, 0));
  rebuiltOnArrival.setChunk(EAST_CHUNK_KEY, partsAndStudAt(CHUNK, 0));
  const rebuiltOnTierChange = edgeBackend();
  rebuiltOnTierChange.forceTier("near");
  rebuiltOnTierChange.setChunk(EAST_CHUNK_KEY, partsAndStudAt(CHUNK, 0));
  rebuiltOnTierChange.setChunk(WEST_CHUNK_KEY, partsAndStudAt(-CHUNK, 0));
  rebuiltOnTierChange.setChunk(MIDDLE_CHUNK_KEY, partsAndStudAt(0, 0));
  rebuiltOnTierChange.setPartMeshes([{ index: 0, level: "far", part: part("a", 40) }]);
  rebuiltOnTierChange.forceTier("mid");

  expect([
    chunkKeysInSceneOrder(rebuiltOnArrival),
    chunkKeysInSceneOrder(rebuiltOnTierChange),
  ]).toEqual([
    [WEST_CHUNK_KEY, MIDDLE_CHUNK_KEY, EAST_CHUNK_KEY],
    [WEST_CHUNK_KEY, MIDDLE_CHUNK_KEY, EAST_CHUNK_KEY],
  ]);
});

function worldBox(minX: number, minZ: number, size: number): WorldBox {
  return { minX, minY: 0, minZ, maxX: minX + size, maxY: 24, maxZ: minZ + size };
}

function room(minX: number): PlanOverlay {
  return {
    room: worldBox(minX, 0, 1280),
    tables: [worldBox(minX, 0, 640)],
    obstacles: [],
    active: true,
  };
}

const FAR_MODEL: FarModelPlacement = {
  modelIndex: 0,
  originX: 0,
  originZ: 0,
  matrix: Float32Array.from(IDENTITY),
  chunkKeys: [MIDDLE_CHUNK_KEY],
};

function containerContents(backend: ThreeSceneBackend): Array<Array<number | string>> {
  const scene: Object3D = backend["scene"];
  const chunks: Map<number, { readonly group: Object3D }> = backend["chunks"];
  const farModels: Map<number, { readonly group: Object3D }> = backend["farModelNodes"];
  const vehicles: Map<number, { readonly group: Object3D }> = backend["vehicles"];
  const ghost: Object3D | undefined = backend["ghost"];
  const ground: Object3D = backend["ground"]["mesh"];
  const labels = new Map<Object3D, number | string>([[ground, "ground"]]);
  for (const [key, record] of chunks) labels.set(record.group, key);
  for (const [id, node] of farModels) labels.set(node.group, `far model ${id}`);
  for (const [id, record] of vehicles) labels.set(record.group, `vehicle ${id}`);
  if (ghost) labels.set(ghost, "ghost");
  return scene.children.map((container) =>
    container.children.map((child) => labels.get(child) ?? `at x ${child.position.x}`),
  );
}

it("keeps every holder under its own container, and the scene's direct children unchanged, through repeated updates", () => {
  const backend = edgeBackend();
  const model = partsAndStudAt(0, 0);
  backend.setChunk(MIDDLE_CHUNK_KEY, model);
  backend.setFarModel(7, FAR_MODEL);
  backend.setFarModel(7, FAR_MODEL);
  backend.setFarModel(9, FAR_MODEL);
  backend.setVehicle(3, model);
  backend.setVehicle(0, model);
  backend.setVehicle(0, model);
  backend.setGhost(model);
  backend.setGhost(model);
  backend.setPlanOverlays([room(0), room(1280)]);
  backend.setPlanOverlays([room(1280), room(0)]);
  backend.setIssueBoxes([worldBox(0, 0, 20), worldBox(100, 0, 20), worldBox(200, 0, 20)]);
  backend.setIssueBoxes([worldBox(200, 0, 20), worldBox(0, 0, 20)]);
  backend.setSelectionBoxes([worldBox(300, 0, 20)]);
  backend.setSelectionBoxes([worldBox(400, 0, 20), worldBox(500, 0, 20)]);
  const beforePalette = containerContents(backend);
  backend.setPalette(palette([part("a", 20)]));

  expect([beforePalette, containerContents(backend)]).toEqual([
    [
      [MIDDLE_CHUNK_KEY],
      ["far model 7", "far model 9"],
      ["vehicle 0", "vehicle 3"],
      ["ghost"],
      ["at x 1280", "at x 0"],
      ["at x 210", "at x 10"],
      ["ground"],
      ["at x 410", "at x 510"],
    ],
    [
      [],
      [],
      [],
      [],
      ["at x 1280", "at x 0"],
      ["at x 210", "at x 10"],
      ["ground"],
      ["at x 410", "at x 510"],
    ],
  ]);
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

function ghostLooks(backend: ThreeSceneBackend): string[] {
  const ghost: Object3D | undefined = backend["ghost"];
  const looks = new Set<string>();
  ghost?.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const materials: ReadonlyArray<MeshStandardNodeMaterial> = [object.material].flat();
    for (const material of materials) {
      looks.add(`${material.color.getHexString()} ${material.emissive.getHexString()}`);
    }
  });
  return [...looks];
}

function ghostHitShown(backend: ThreeSceneBackend) {
  const hit: Mesh = backend["ghostHit"];
  if (!hit.visible) return null;
  return {
    x: hit.position.x,
    y: hit.position.y,
    z: hit.position.z,
    size: [hit.scale.x, hit.scale.y, hit.scale.z],
  };
}

const HIT_CELL: WorldBox = { minX: 320, minY: 8, minZ: -140, maxX: 340, maxY: 24, maxZ: -120 };

function ghostBackend(): ThreeSceneBackend {
  const backend = new ThreeSceneBackend();
  backend.setPalette(palette([part("a", 20)]));
  return backend;
}

function ghostLooksAfter(steps: (backend: ThreeSceneBackend) => void): string[] {
  const backend = ghostBackend();
  steps(backend);
  return ghostLooks(backend);
}

it("tints the ghost by its verdict, whether the verdict or the ghost came first, and untints it when the verdict clears", () => {
  const untinted = ghostLooksAfter((backend) => backend.setGhost(chunkOf(0)));
  const fits = ghostLooksAfter((backend) => {
    backend.setGhost(chunkOf(0));
    backend.setGhostVerdict({ tone: "fits", hit: null, precise: false });
  });
  const mates = ghostLooksAfter((backend) => {
    backend.setGhost(chunkOf(0));
    backend.setGhostVerdict({ tone: "mates", hit: null, precise: false });
  });
  const refusedAfter = ghostLooksAfter((backend) => {
    backend.setGhost(chunkOf(0));
    backend.setGhostVerdict({ tone: "refused", hit: HIT_CELL, precise: false });
  });
  const refusedBefore = ghostLooksAfter((backend) => {
    backend.setGhostVerdict({ tone: "refused", hit: HIT_CELL, precise: false });
    backend.setGhost(chunkOf(0));
  });
  const cleared = ghostLooksAfter((backend) => {
    backend.setGhost(chunkOf(0));
    backend.setGhostVerdict({ tone: "refused", hit: HIT_CELL, precise: false });
    backend.setGhostVerdict(null);
  });

  expect(refusedBefore).toEqual(refusedAfter);
  expect(cleared).toEqual(untinted);
  expect(
    new Set([untinted, fits, mates, refusedAfter].map((looks) => looks.join())),
  ).toHaveProperty("size", 4);
});

it("boxes a refused ghost's hit cell only while the ghost is placed", () => {
  const backend = ghostBackend();
  backend.setGhostVerdict({ tone: "refused", hit: HIT_CELL, precise: false });
  backend.setGhost(chunkOf(0));
  const beforePlaced = ghostHitShown(backend);
  backend.placeGhost(320, 0, -140, 0);
  const placed = ghostHitShown(backend);
  backend.setGhostVerdict({ tone: "fits", hit: null, precise: false });
  const fits = ghostHitShown(backend);
  backend.setGhostVerdict({ tone: "refused", hit: HIT_CELL, precise: false });
  backend.setGhost(null);

  expect({ beforePlaced, placed, fits, cleared: ghostHitShown(backend) }).toEqual({
    beforePlaced: null,
    placed: { x: 330, y: 16, z: -130, size: [20, 16, 20] },
    fits: null,
    cleared: null,
  });
});

function ghostOutlineShown(backend: ThreeSceneBackend) {
  const outline: Object3D = backend["ghostOutline"];
  const ghost: Object3D | undefined = backend["ghost"];
  if (!outline.visible || outline.parent !== ghost) return null;
  return {
    centre: [outline.position.x, outline.position.y, outline.position.z],
    size: [outline.scale.x, outline.scale.y, outline.scale.z],
  };
}

it("outlines the ghost's bounds in precise mode only, whatever its tone, and keeps the outline on a rebuilt ghost", () => {
  const backend = ghostBackend();
  backend.setGhost(chunkOf(0));
  const magnetic = ghostOutlineShown(backend);
  backend.setGhostVerdict({ tone: "refused", hit: HIT_CELL, precise: true });
  const refused = ghostOutlineShown(backend);
  backend.setGhostVerdict({ tone: null, hit: null, precise: true });
  backend.setGhost(chunkOf(0));
  const rebuilt = ghostOutlineShown(backend);
  backend.setGhostVerdict({ tone: "fits", hit: null, precise: false });

  const outlined = { centre: [10, 10, 0], size: [20, 20, 0] };
  expect({ magnetic, refused, rebuilt, back: ghostOutlineShown(backend) }).toEqual({
    magnetic: null,
    refused: outlined,
    rebuilt: outlined,
    back: null,
  });
});
