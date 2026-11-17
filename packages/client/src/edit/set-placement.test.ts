import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type CompiledPartGlb,
  type IAssetFetcher,
  type ImportContext,
  type IPartBundleLoader,
  type ModelBundle,
  type PartAsset,
  type PartBundle,
  type PartFilter,
} from "@brr/catalog";
import { CHUNK_LDU, STUD_LDU } from "@brr/math";
import type { BundleLod, BundleManifest } from "@brr/schema/bundle";
import {
  INSTANCE_MATRIX_FLOATS,
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type ISceneBackend,
  type PartPalette,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR } from "../tokens.ts";
import { TRACK_ITEM_ID, type IEditor } from "./editor.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const SET_ON_BASEPLATES = "10128-1";
const BASEPLATE = "ldraw:3811";
const NDC_TO_LDU = 10_000;
const RAY_START_Y = 1000;
const FAR_Z = 6000;
const RUN_START = [420, 140] as const;
const RUN_STRAIGHTS = 3;
const STRAIGHT_LDU = 320;
const SWEEP_LDU = 700;
const SWEEP_STEP_LDU = 40;
const OFF_LATTICE = [7, 3] as const;
const PLATE_SPACING_LDU = 4000;
const RUN_MODULES = 3;
const MILS_MODULE_LDU = CHUNK_LDU;
const JITTER_LDU = 0.5;

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class ModelSubsetLoader implements IPartBundleLoader {
  constructor(
    private readonly loader: IPartBundleLoader,
    private readonly models: ReadonlyArray<string>,
  ) {}

  loadManifest(lod: BundleLod): Promise<BundleManifest> {
    return this.loader.loadManifest(lod);
  }

  async load(lod: BundleLod, include: PartFilter): Promise<PartBundle> {
    const bundle = await this.loader.load(lod, include);
    return { ...bundle, models: bundle.models.filter((m) => this.models.includes(m.name)) };
  }

  loadModel(lod: BundleLod, name: string): Promise<ModelBundle> {
    return this.loader.loadModel(lod, name);
  }

  importContext(lod: BundleLod): Promise<ImportContext> {
    return this.loader.importContext(lod);
  }

  loadPartSet(
    lod: BundleLod,
    partIds: ReadonlyArray<string>,
    compiled: ReadonlyArray<CompiledPartGlb>,
  ): Promise<PartBundle> {
    return this.loader.loadPartSet(lod, partIds, compiled);
  }
}

class JitteredBaseplates implements IPartBundleLoader {
  constructor(private readonly loader: IPartBundleLoader) {}

  loadManifest(lod: BundleLod): Promise<BundleManifest> {
    return this.loader.loadManifest(lod);
  }

  load(lod: BundleLod, include: PartFilter): Promise<PartBundle> {
    return this.loader.load(lod, include);
  }

  async loadModel(lod: BundleLod, name: string): Promise<ModelBundle> {
    const loaded = await this.loader.loadModel(lod, name);
    const { model, bundle } = loaded;
    const matrices = Float32Array.from(model.matrices);
    for (let i = 0; i < model.instanceCount; i++) {
      if (!bundle.parts[model.partIndex[i] ?? 0]?.baseplate) continue;
      const x = i * INSTANCE_MATRIX_FLOATS + 3;
      matrices[x] = (matrices[x] ?? 0) + JITTER_LDU;
    }
    return { ...loaded, model: { ...model, matrices } };
  }

  importContext(lod: BundleLod): Promise<ImportContext> {
    return this.loader.importContext(lod);
  }

  loadPartSet(
    lod: BundleLod,
    partIds: ReadonlyArray<string>,
    compiled: ReadonlyArray<CompiledPartGlb>,
  ): Promise<PartBundle> {
    return this.loader.loadPartSet(lod, partIds, compiled);
  }
}

interface PlacedPlate {
  readonly id: string;
  readonly topY: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function extent(
  m: Float32Array,
  axis: number,
  part: PartAsset,
  origin: number,
): readonly [number, number] {
  let lo = origin + (m[axis * 4 + 3] ?? 0);
  let hi = lo;
  for (let k = 0; k < 3; k++) {
    const coefficient = m[axis * 4 + k] ?? 0;
    const a = coefficient * (part.boundsMin[k] ?? 0);
    const b = coefficient * (part.boundsMax[k] ?? 0);
    lo += Math.min(a, b);
    hi += Math.max(a, b);
  }
  return [lo, hi];
}

class TopDownBackend implements ISceneBackend {
  private parts: ReadonlyArray<PartAsset> = [];
  private readonly chunks = new Map<number, ChunkInstances>();

  async init(): Promise<BackendInfo> {
    return { requestedApi: "webgl2", activeApi: "webgl2", adapter: "none", backgroundSrgb: 0 };
  }
  setPalette(palette: PartPalette): void {
    this.parts = palette.detailed.parts;
  }
  setChunk(key: number, chunk: ChunkInstances): void {
    this.chunks.set(key, chunk);
  }
  deleteChunk(key: number): void {
    this.chunks.delete(key);
  }
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  setIssueBoxes(): void {}
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    out.set([ndcX * NDC_TO_LDU, RAY_START_Y, ndcY * NDC_TO_LDU, 0, -1, 0]);
  }
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  async waitForGpu(): Promise<void> {}
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }

  plates(): PlacedPlate[] {
    const plates: PlacedPlate[] = [];
    for (const chunk of this.chunks.values()) {
      for (let i = 0; i < chunk.count; i++) {
        const part = this.parts[chunk.partIndex[i] ?? 0];
        if (!part?.baseplate) continue;
        const m = chunk.matrices.subarray(i * INSTANCE_MATRIX_FLOATS);
        const [minX, maxX] = extent(m, 0, part, chunk.originX);
        const [minZ, maxZ] = extent(m, 2, part, chunk.originZ);
        plates.push({ id: part.id, topY: m[7] ?? 0, minX, maxX, minZ, maxZ });
      }
    }
    return plates;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startEditor(
  backend: ISceneBackend,
  wrap: (loader: IPartBundleLoader) => IPartBundleLoader = (loader) => loader,
): Promise<IEditor> {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container
    .rebind(PART_BUNDLE_LOADER)
    .toConstantValue(wrap(new ModelSubsetLoader(realLoader, [SET_ON_BASEPLATES])));
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1 });
  return editor;
}

function clickAt(editor: IEditor, x: number, z: number): void {
  editor.pointerMove(x / NDC_TO_LDU, z / NDC_TO_LDU);
  editor.click(x / NDC_TO_LDU, z / NDC_TO_LDU, 0);
}

function chooseGroup(editor: IEditor, group: string): void {
  const item = editor.snapshot().catalog.find((entry) => entry.group === group);
  if (!item) throw new Error(`the catalog offers no ${group}`);
  editor.chooseItem(item.id);
}

function onGrid(value: number, grid: number): boolean {
  return Number.isInteger(value / grid);
}

function setPlates(backend: TopDownBackend, standalone: PlacedPlate): PlacedPlate[] {
  return backend.plates().filter((plate) => plate.id !== standalone.id);
}

function itemGrid(editor: IEditor, id: string, rot: number): { x: number; z: number } {
  const baseplate = editor.snapshot().catalog.find((item) => item.id === id)?.baseplate;
  if (!baseplate) throw new Error(`${id} has no baseplate of its own`);
  const wide = baseplate.gridStudsWide * STUD_LDU;
  const deep = baseplate.gridStudsDeep * STUD_LDU;
  return rot % 2 === 0 ? { x: wide, z: deep } : { x: deep, z: wide };
}

it("seats a set by its own baseplates: tops flush with a standalone baseplate, edges pulled flush onto its module grid at any rotation", async () => {
  const backend = new TopDownBackend();
  const editor = await startEditor(backend);
  expect(editor.snapshot().error).toBeNull();
  const set = `omr:${SET_ON_BASEPLATES}`;

  chooseGroup(editor, BASEPLATE);
  const plateItem = editor.snapshot().activeItem ?? "";
  expect(itemGrid(editor, plateItem, 0)).toEqual({ x: MILS_MODULE_LDU, z: MILS_MODULE_LDU });
  clickAt(editor, MILS_MODULE_LDU / 2 - 13, 7 - MILS_MODULE_LDU / 2);
  const [standalone, ...others] = backend.plates();
  if (!standalone) throw new Error("the standalone baseplate was not drawn");
  expect(others).toEqual([]);
  expect(standalone.topY).toBe(0);
  for (const edge of [standalone.minX, standalone.maxX, standalone.minZ, standalone.maxZ]) {
    expect(onGrid(edge, MILS_MODULE_LDU)).toBe(true);
  }

  editor.chooseItem(set);
  for (const [rot, side] of [
    [0, "maxX"],
    [1, "minX"],
  ] as const) {
    while (editor.snapshot().ghostRot !== rot) editor.rotate(0);
    const grid = itemGrid(editor, set, rot);
    clickAt(editor, 0, FAR_Z);
    const probeX = editor.snapshot().hover?.x ?? 0;
    const probe = setPlates(backend, standalone).filter((plate) => plate.minZ > FAR_Z / 2);
    expect(probe.length).toBeGreaterThan(1);
    const offset =
      side === "maxX"
        ? Math.min(...probe.map((plate) => plate.minX)) - probeX
        : Math.max(...probe.map((plate) => plate.maxX)) - probeX;
    editor.undo(0);
    expect(setPlates(backend, standalone).filter((plate) => plate.minZ > FAR_Z / 2)).toEqual([]);

    const target = standalone[side];
    clickAt(editor, target - offset + grid.x / 2 - 3, 29);
    expect(editor.snapshot().lastRefusal).toBeNull();
    const placed = setPlates(backend, standalone).filter((plate) =>
      side === "maxX" ? plate.minX >= target - grid.x : plate.maxX <= target + grid.x,
    );
    expect(placed.length).toBe(probe.length);
    const touching =
      side === "maxX"
        ? Math.min(...placed.map((plate) => plate.minX))
        : Math.max(...placed.map((plate) => plate.maxX));
    expect(touching).toBe(target);
    const outline = {
      minX: Math.min(...placed.map((plate) => plate.minX)),
      minZ: Math.min(...placed.map((plate) => plate.minZ)),
    };
    expect(onGrid(outline.minX, grid.x)).toBe(true);
    expect(onGrid(outline.minZ, grid.z)).toBe(true);
  }

  for (const plate of backend.plates()) expect(plate.topY).toBe(standalone.topY);
}, 120_000);

it("skips a set whose baseplates sit off the stud lattice, with the reason, and keeps the editor working", async () => {
  const backend = new TopDownBackend();
  const editor = await startEditor(backend, (loader) => new JitteredBaseplates(loader));
  const snapshot = editor.snapshot();
  expect(snapshot.status).toBe("ready");
  expect(snapshot.catalog.map((item) => item.id)).not.toContain(`omr:${SET_ON_BASEPLATES}`);
  const skipped = snapshot.catalogSkipped.find((entry) => entry.name === SET_ON_BASEPLATES);
  expect(skipped?.reason).toMatch(/20 LDU/);

  chooseGroup(editor, BASEPLATE);
  clickAt(editor, 0, 0);
  expect(backend.plates()).toHaveLength(1);
}, 120_000);

it("lets a set that carries track snap exactly onto drawn track off the baseplate grid before the grid snap applies", async () => {
  const editor = await startEditor(new TopDownBackend());
  expect(editor.snapshot().error).toBeNull();
  chooseGroup(editor, BASEPLATE);
  for (let module = 0; module < RUN_MODULES; module++) {
    clickAt(editor, (module + 0.5) * MILS_MODULE_LDU, MILS_MODULE_LDU / 2);
  }
  editor.chooseItem(TRACK_ITEM_ID);
  const [startX, startZ] = RUN_START;
  const endX = startX + RUN_STRAIGHTS * STRAIGHT_LDU;
  editor.pointerMove(startX / NDC_TO_LDU, startZ / NDC_TO_LDU);
  editor.dragStart(startX / NDC_TO_LDU, startZ / NDC_TO_LDU);
  editor.dragMove(endX / NDC_TO_LDU, startZ / NDC_TO_LDU);
  editor.dragEnd(endX / NDC_TO_LDU, startZ / NDC_TO_LDU, 0);
  expect(editor.snapshot().track?.pieces).toBe(RUN_STRAIGHTS);

  editor.chooseItem(`omr:${SET_ON_BASEPLATES}`);
  let joined = 0;
  for (let rot = 0; rot < 4; rot++) {
    while (editor.snapshot().ghostRot !== rot) editor.rotate(0);
    for (let dx = -SWEEP_LDU; dx <= SWEEP_LDU; dx += SWEEP_STEP_LDU) {
      for (let dz = -SWEEP_LDU; dz <= SWEEP_LDU; dz += SWEEP_STEP_LDU) {
        const x = startX + dx + OFF_LATTICE[0];
        const z = startZ + dz + OFF_LATTICE[1];
        editor.pointerMove(x / NDC_TO_LDU, z / NDC_TO_LDU);
        if ((editor.snapshot().ghost?.trackJoins ?? 0) > 0) joined++;
      }
    }
  }
  expect(joined).toBeGreaterThan(0);
}, 300_000);

it("lets every standalone baseplate take a flush 3811 on each side, where it is drawn", async () => {
  const backend = new TopDownBackend();
  const editor = await startEditor(backend);
  expect(editor.snapshot().error).toBeNull();
  const groups = [
    ...new Set(
      editor
        .snapshot()
        .catalog.filter((item) => item.kind === "baseplate")
        .map((item) => item.group),
    ),
  ];
  expect(groups.length).toBeGreaterThan(1);
  const plateAt = (x: number, z: number): PlacedPlate => {
    const plate = backend
      .plates()
      .find((p) => p.minX <= x && x <= p.maxX && p.minZ <= z && z <= p.maxZ);
    if (!plate) throw new Error(`no baseplate is drawn at ${x}, ${z}`);
    return plate;
  };

  chooseGroup(editor, BASEPLATE);
  clickAt(editor, -PLATE_SPACING_LDU, -PLATE_SPACING_LDU);
  const probe = plateAt(-PLATE_SPACING_LDU, -PLATE_SPACING_LDU);
  const probeHover = editor.snapshot().hover;
  if (!probeHover) throw new Error("the cursor left the ground");
  const neighbour = {
    minX: probe.minX - probeHover.x,
    maxX: probe.maxX - probeHover.x,
    minZ: probe.minZ - probeHover.z,
    maxZ: probe.maxZ - probeHover.z,
  };
  editor.undo(0);

  groups.forEach((group, i) => {
    const x = i * PLATE_SPACING_LDU;
    chooseGroup(editor, group);
    clickAt(editor, x, 0);
    const placedBefore = editor.snapshot().placements;
    const plate = plateAt(editor.snapshot().hover?.x ?? x, editor.snapshot().hover?.z ?? 0);
    chooseGroup(editor, BASEPLATE);
    const sides = [
      [plate.maxX - neighbour.minX, plate.maxZ - neighbour.maxZ],
      [plate.minX - neighbour.maxX, plate.minZ - neighbour.minZ],
      [plate.minX - neighbour.minX, plate.maxZ - neighbour.minZ],
      [plate.maxX - neighbour.maxX, plate.minZ - neighbour.maxZ],
    ] as const;
    for (const [nx, nz] of sides) clickAt(editor, nx, nz);
    expect({ group, placed: editor.snapshot().placements - placedBefore }).toEqual({
      group,
      placed: sides.length,
    });
  });
}, 300_000);

function dragFrom(editor: IEditor, from: readonly [number, number], to: readonly [number, number]) {
  editor.pointerMove(from[0] / NDC_TO_LDU, from[1] / NDC_TO_LDU);
  const took = editor.dragStart(from[0] / NDC_TO_LDU, from[1] / NDC_TO_LDU);
  editor.pointerMove(to[0] / NDC_TO_LDU, to[1] / NDC_TO_LDU);
  editor.dragMove(to[0] / NDC_TO_LDU, to[1] / NDC_TO_LDU);
  editor.dragEnd(to[0] / NDC_TO_LDU, to[1] / NDC_TO_LDU, 0);
  return took;
}

it("drags a placed set as one unit: every baseplate follows, a drop into another placement is refused, undo puts it back", async () => {
  const backend = new TopDownBackend();
  const editor = await startEditor(backend);
  const set = `omr:${SET_ON_BASEPLATES}`;
  chooseGroup(editor, BASEPLATE);
  clickAt(editor, 0, 0);
  const [standalone] = backend.plates();
  if (!standalone) throw new Error("the standalone baseplate was not drawn");
  editor.chooseItem(set);
  clickAt(editor, 0, FAR_Z);
  editor.chooseItem(null);
  const setPlatesNow = () => setPlates(backend, standalone);
  const start = setPlatesNow();
  expect(start.length).toBeGreaterThan(1);
  const grab = [(start[0]?.minX ?? 0) + 7, (start[0]?.minZ ?? 0) + 7] as const;

  const shift = 2 * MILS_MODULE_LDU;
  expect(dragFrom(editor, grab, [grab[0] + shift, grab[1]])).toBe(true);
  expect(editor.snapshot().lastRefusal).toBeNull();
  const moved = setPlatesNow();
  expect(moved).toEqual(
    start.map((plate) => ({ ...plate, minX: plate.minX + shift, maxX: plate.maxX + shift })),
  );
  expect(editor.snapshot().placements).toBe(2);
  expect(editor.snapshot().history.undo).toBe("move");

  const ontoBaseplate = [standalone.minX + 7, standalone.minZ + 7] as const;
  const grabMoved = [grab[0] + shift, grab[1]] as const;
  dragFrom(editor, grabMoved, ontoBaseplate);
  expect(editor.snapshot().lastRefusal?.action).toBe("move");
  expect(editor.snapshot().lastRefusal?.rule).toBe("overlap");
  expect(setPlatesNow()).toEqual(moved);

  editor.undo(0);
  expect(setPlatesNow()).toEqual(start);
}, 120_000);
