import { ASSET_FETCHER, EMPTY_COLUMN, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type ChunkTier,
  type EdgeMarker,
  type FarModelPlacement,
  type FrameStats,
  type GroundGrid,
  type GuideSegment,
  type ISceneBackend,
  type LookSettings,
  type NeededMeshListener,
  type PartMeshUpdate,
  type PartPalette,
  type PlanOverlay,
  type RebaseEvent,
  type TrackEndMarker,
  type WorldBox,
} from "@brr/render";
import type { PartAsset, PartMesh, StudPrimitiveAsset } from "@brr/catalog";
import { Container } from "inversify";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHeapStatistics, writeHeapSnapshot } from "node:v8";
import { STUD_LDU } from "@brr/math";
import { mainThreadModules } from "../src/client.module.ts";
import { EDITOR, PLACEABLE_CATALOG } from "../src/tokens.ts";
import { loadCatalogItem } from "../src/catalog/catalog-item.test-support.ts";
import type { IPlaceableCatalog } from "../src/catalog/placeable-catalog.ts";
import type { IEditor } from "../src/edit/editor.ts";
import { WithFixtureModels } from "../src/edit/fixture-model.test-support.ts";
import type { Placeable, PlaceableCells } from "../src/edit/placeable.ts";
import { meshesSettled } from "../src/edit/mesh-progress.ts";
import { parseHeapSnapshot, tallyOwners, type OwnerRules, type OwnerTally } from "./heap-owners.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const TILE_LDU = 640;
const HALF_TILE_LDU = TILE_LDU / 2;
const SET_EVERY_TILES = 2;
const ROAD_ROWS = 1;
const TRACK_ROWS = 3;
const TRACK_RUN_TILES = 2;
const RAY_HEIGHT_LDU = 10_000;
const SETTLE_MS = 2_000;
const GC_PASSES = 4;
const RUNS = 3;
const MB = 1e6;
const BASEPLATE = "ldraw:3811@2";
const ROAD_PLATE = "ldraw:44336p01@2";
const TRACK_ITEM = "track:lego-9v";
const SETS: ReadonlyArray<string> = [
  "omr:10264-1",
  "omr:10185-1",
  "omr:10218-1",
  "omr:10190-1",
  "omr:7936-1",
  "omr:10205-1",
];
const TILE_ITEMS: ReadonlyArray<string> = [BASEPLATE, ROAD_PLATE, ...SETS];
const DENSE_FIXTURE = "brick-2x4";
const DENSE_BRICK = `generated:${DENSE_FIXTURE}`;
const MS_PER_SECOND = 1000;
const P50 = 0.5;
const P95 = 0.95;

type Layout =
  | { readonly kind: "tiles"; readonly tiles: number }
  | {
      readonly kind: "dense";
      readonly across: number;
      readonly deep: number;
      readonly layers: number;
    };

const SCALES: Readonly<Record<string, Layout>> = {
  small: { kind: "tiles", tiles: 5 },
  medium: { kind: "tiles", tiles: 10 },
  large: { kind: "tiles", tiles: 18 },
  dense: { kind: "dense", across: 64, deep: 128, layers: 15 },
};
const DEFAULT_SCALES: ReadonlyArray<string> = ["small", "medium", "large"];
const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};

const PLACED = "client: PlacedChunks";
const WORLD = "domain: World";
const OCCUPANCY = "domain: OccupancyGrid";
const HISTORY = "domain: EditHistory";
const INSTANCES = "render: instance matrices and colours";
const SCENE = "render: scene objects";
const GEOMETRY = "render: geometry";
const PART_MESHES = "client: part meshes and palette";
const OTHER = "other";
const GEOMETRY_AND_PART_MESH_OWNERS: ReadonlySet<string> = new Set([GEOMETRY, PART_MESHES]);
const OBJECT3D_CLASSES: ReadonlyArray<string> = [
  "Scene",
  "Group",
  "Mesh",
  "InstancedMesh",
  "StudMesh",
  "LineSegments",
  "DirectionalLight",
];
const RENDERABLE_CLASSES: ReadonlySet<string> = new Set([
  "Mesh",
  "InstancedMesh",
  "StudMesh",
  "LineSegments",
]);

function fields(owner: string, names: ReadonlyArray<string>): ReadonlyMap<string, string> {
  return new Map(names.map((name) => [name, owner]));
}

const RULES: OwnerRules = {
  unowned: OTHER,
  byClass: new Map([
    ["PlacedChunks", PLACED],
    ["PlacedEntry", PLACED],
    ["World", WORLD],
    ["EditHistory", HISTORY],
    ["Scene", SCENE],
    ["Group", SCENE],
    ["Mesh", SCENE],
    ["StudMesh", SCENE],
    ["BufferGeometry", GEOMETRY],
    ["BufferAttribute", GEOMETRY],
    ["PartMeshStream", PART_MESHES],
  ]),
  byField: new Map([
    [
      "ThreeSceneBackend",
      new Map([
        ...fields(INSTANCES, ["ghostPage", "studBases", "studLookups"]),
        ...fields(GEOMETRY, ["detailedLevel", "farLevel", "farModelGeometries", "partBounds"]),
        ...fields(SCENE, ["chunks", "chunkList", "scene"]),
      ]),
    ],
    ["PlaceableCatalog", fields(PART_MESHES, ["placeablesByRefId", "palette", "slots"])],
    ["PlacedEntry", fields(PART_MESHES, ["placeable"])],
    ["PlacedChunks", new Map([...fields(SCENE, ["backend"]), ...fields(OCCUPANCY, ["occupancy"])])],
    ["ChunkRecord", fields(INSTANCES, ["page"])],
    ["Mesh", fields(GEOMETRY, ["geometry"])],
    [
      "InstancedMesh",
      new Map([
        ...fields(INSTANCES, ["instanceMatrix", "instanceColor"]),
        ...fields(GEOMETRY, ["geometry"]),
      ]),
    ],
    [
      "StudMesh",
      new Map([
        ...fields(INSTANCES, ["studTranslations", "studBasisAndColorIndex"]),
        ...fields(SCENE, ["geometry"]),
      ]),
    ],
  ]),
};

interface Measured {
  readonly heapBytes: number;
  readonly arrayBufferBytes: number;
}

interface OwnerRow {
  readonly owner: string;
  readonly baselineBytes: number;
  readonly layoutBytes: number;
}

interface Snapshots {
  readonly baseline: string;
  readonly layout: string;
}

interface PlacementTimes {
  readonly totalSeconds: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

interface RunResult {
  readonly scale: string;
  readonly arrangement: string;
  readonly parts: number;
  readonly placements: number;
  readonly placementCells: number;
  readonly placing: PlacementTimes;
  readonly studsDrawn: number;
  readonly studsTotal: number;
  readonly renderInput: string;
  readonly baseline: Measured;
  readonly layout: Measured;
  readonly snapshots: Snapshots | null;
}

interface OwnerSplit {
  readonly scale: string;
  readonly parts: number;
  readonly owners: ReadonlyArray<OwnerRow>;
  readonly objects: ReadonlyArray<readonly [string, number, number]>;
}

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function chunkDigest(chunk: ChunkInstances): string {
  const hash = createHash("sha256");
  hash.update(Float64Array.of(chunk.originX, chunk.originZ, chunk.count, chunk.studs.count));
  for (const array of [
    chunk.partIndex,
    chunk.colorIndex,
    chunk.matrices,
    chunk.voxelized ?? new Uint8Array(0),
    chunk.studs.primitiveIndex,
    chunk.studs.colorIndex,
    chunk.studs.matrices,
  ]) {
    hash.update(bytesOf(array));
  }
  return hash.digest("hex");
}

function farModelDigest(placement: FarModelPlacement): string {
  return createHash("sha256")
    .update(Float64Array.of(placement.modelIndex, placement.originX, placement.originZ))
    .update(bytesOf(placement.matrix))
    .update(Float64Array.from(placement.chunkKeys))
    .digest("hex");
}

class WindowlessBackend implements ISceneBackend {
  private aimX = 0;
  private aimZ = 0;
  private readonly chunkDigests = new Map<number, string>();
  private readonly farModelDigests = new Map<number, string>();

  constructor(private readonly scene: ISceneBackend) {}

  async init(): Promise<BackendInfo> {
    return {
      requestedApi: "webgl2",
      activeApi: "webgl2",
      adapter: "none",
      backgroundSrgb: 0,
      look: NO_LOOK,
    };
  }
  setPalette(palette: PartPalette): void {
    this.scene.setPalette(palette);
  }
  addParts(parts: ReadonlyArray<PartAsset>): void {
    this.scene.addParts(parts);
  }
  setPartMeshes(updates: ReadonlyArray<PartMeshUpdate>): void {
    this.scene.setPartMeshes(updates);
  }
  setFarStuds(studPrimitives: ReadonlyArray<StudPrimitiveAsset>): void {
    this.scene.setFarStuds(studPrimitives);
  }
  setFarModelMesh(modelIndex: number, mesh: PartMesh): void {
    this.scene.setFarModelMesh(modelIndex, mesh);
  }
  setColors(colorsSrgb: Uint8Array, colorsAlpha: Uint8Array): void {
    this.scene.setColors(colorsSrgb, colorsAlpha);
  }
  setChunk(key: number, chunk: ChunkInstances): void {
    this.chunkDigests.set(key, chunkDigest(chunk));
    this.scene.setChunk(key, chunk);
  }
  deleteChunk(key: number): void {
    this.chunkDigests.delete(key);
    this.scene.deleteChunk(key);
  }
  setNeededMeshListener(listener: NeededMeshListener | null): void {
    this.scene.setNeededMeshListener(listener);
  }
  setGhost(model: ChunkInstances | null): void {
    this.scene.setGhost(model);
  }
  placeGhost(x: number, yLdu: number, z: number, rot: number): void {
    this.scene.placeGhost(x, yLdu, z, rot);
  }
  setSelectionBox(box: WorldBox | null): void {
    this.scene.setSelectionBox(box);
  }
  setMarkers(markers: ReadonlyArray<EdgeMarker>): void {
    this.scene.setMarkers(markers);
  }
  setTrackEnds(markers: ReadonlyArray<TrackEndMarker>): void {
    this.scene.setTrackEnds(markers);
  }
  setPlanOverlays(overlays: ReadonlyArray<PlanOverlay>): void {
    this.scene.setPlanOverlays(overlays);
  }
  setIssueBoxes(boxes: ReadonlyArray<WorldBox>): void {
    this.scene.setIssueBoxes(boxes);
  }
  setGroundGrid(grid: GroundGrid | null): void {
    this.scene.setGroundGrid(grid);
  }
  setGuides(segments: ReadonlyArray<GuideSegment>): void {
    this.scene.setGuides(segments);
  }
  projectToNdc(x: number, y: number, z: number, out: Float64Array, offset: number): void {
    this.scene.projectToNdc(x, y, z, out, offset);
  }
  aim(x: number, z: number): void {
    this.aimX = x;
    this.aimZ = z;
  }
  rayThrough(_ndcX: number, _ndcY: number, out: Float64Array): void {
    out[0] = this.aimX;
    out[1] = RAY_HEIGHT_LDU;
    out[2] = this.aimZ;
    out[3] = 0;
    out[4] = -1;
    out[5] = 0;
  }
  setVehicle(vehicle: number, model: ChunkInstances): void {
    this.scene.setVehicle(vehicle, model);
  }
  setVehiclePose(vehicle: number, x: number, y: number, z: number, yaw: number): void {
    this.scene.setVehiclePose(vehicle, x, y, z, yaw);
  }
  deleteVehicle(vehicle: number): void {
    this.scene.deleteVehicle(vehicle);
  }
  setView(
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    atX: number,
    atY: number,
    atZ: number,
    orthoHalfHeightLdu?: number,
  ): void {
    this.scene.setView(eyeX, eyeY, eyeZ, atX, atY, atZ, orthoHalfHeightLdu);
  }
  resize(width: number, height: number): void {
    this.scene.resize(width, height);
  }
  renderFrame(_out: FrameStats): void {}
  needsFrame(): boolean {
    return true;
  }
  async waitForGpu(): Promise<void> {}
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  forceTier(tier: ChunkTier | null): void {
    this.scene.forceTier(tier);
  }
  setFarModel(id: number, placement: FarModelPlacement | null): void {
    if (placement) this.farModelDigests.set(id, farModelDigest(placement));
    else this.farModelDigests.delete(id);
    this.scene.setFarModel(id, placement);
  }
  renderInputDigest(): string {
    const entries = [
      ...[...this.chunkDigests].map(([key, digest]) => `chunk ${key} ${digest}`),
      ...[...this.farModelDigests].map(([id, digest]) => `far ${id} ${digest}`),
    ].toSorted();
    return createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16);
  }
  forgetDigests(): void {
    this.chunkDigests.clear();
    this.farModelDigests.clear();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collect(): void {
  const gc: unknown = Reflect.get(globalThis, "gc");
  if (typeof gc !== "function") throw new Error("run the memory bench with --expose-gc");
  for (let i = 0; i < GC_PASSES; i++) gc();
}

function measure(): Measured {
  collect();
  return {
    heapBytes: getHeapStatistics().used_heap_size,
    arrayBufferBytes: process.memoryUsage().arrayBuffers,
  };
}

async function settled(editor: IEditor, backend: WindowlessBackend): Promise<void> {
  let before = "";
  for (;;) {
    await delay(SETTLE_MS);
    const { meshes, farTier } = editor.snapshot();
    const after = backend.renderInputDigest();
    if (farTier !== "loading" && meshesSettled(meshes) && after === before) return;
    before = after;
  }
}

function tileCentre(index: number): number {
  return index * TILE_LDU + HALF_TILE_LDU;
}

function setsByTile(tiles: number): ReadonlyMap<number, string> {
  const sets = new Map<number, string>();
  let set = 0;
  for (let row = 0; row < tiles; row += SET_EVERY_TILES) {
    for (let column = 0; column < tiles; column++) {
      if ((row / SET_EVERY_TILES + column) % 2 !== 0) continue;
      sets.set(row * tiles + column, SETS[set % SETS.length] ?? "");
      set++;
    }
  }
  return sets;
}

function liesInBaseplateLayer(placeable: Placeable): boolean {
  return placeable.slabBoxes.length > 0;
}

function placementCells(placeable: Placeable): number {
  let cells = 0;
  for (const top of placeable.cells.columnTop) if (top !== EMPTY_COLUMN) cells++;
  return cells;
}

interface DensePose {
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
}

function densePoses(
  layout: Extract<Layout, { kind: "dense" }>,
  brick: PlaceableCells,
): ReadonlyArray<DensePose> {
  const bond = Math.floor(brick.width / 2);
  const poses: DensePose[] = [];
  for (let layer = 0; layer < layout.layers; layer++) {
    const shift = layer % 2 === 0 ? 0 : bond;
    for (let row = 0; row < layout.deep; row++) {
      for (let column = 0; column < layout.across; column++) {
        poses.push({
          x: (column * brick.width + shift - brick.cellX0) * STUD_LDU,
          z: (row * brick.depth - brick.cellZ0) * STUD_LDU,
          yPlates: layer * brick.heightPlates,
        });
      }
    }
  }
  return poses;
}

function poseKey(x: number, z: number, yPlates: number): string {
  return `${x},${z},${yPlates}`;
}

function misplacedBricks(editor: IEditor, expected: ReadonlyArray<DensePose>): string | null {
  const { refs, placements } = editor.dump();
  const wanted = new Map<string, number>();
  for (const pose of expected) {
    const key = poseKey(pose.x, pose.z, pose.yPlates);
    wanted.set(key, (wanted.get(key) ?? 0) + 1);
  }
  let bricks = 0;
  for (let i = 0; i < placements.refId.length; i++) {
    if (refs[placements.refId[i] ?? -1] !== DENSE_BRICK) continue;
    bricks++;
    const key = poseKey(placements.x[i] ?? 0, placements.z[i] ?? 0, placements.yPlates[i] ?? 0);
    const left = wanted.get(key) ?? 0;
    if (left === 0)
      return `a brick landed at ${key} (x, z, plates), which the dense rule never aims at`;
    wanted.set(key, left - 1);
  }
  return bricks === expected.length
    ? null
    : `${bricks} bricks were placed where the dense rule aims ${expected.length}`;
}

class LayoutBuilder {
  readonly times: number[] = [];

  constructor(
    private readonly editor: IEditor,
    private readonly backend: WindowlessBackend,
    private readonly baseplateLayerSets: ReadonlySet<string>,
  ) {}

  place(item: string, x: number, z: number): void {
    const editor = this.editor;
    editor.chooseItem(item);
    this.backend.aim(x, z);
    const before = editor.snapshot().placements;
    const started = performance.now();
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
    this.times.push(performance.now() - started);
    if (editor.snapshot().placements !== before + 1) {
      throw new Error(
        `${item} at ${x}, ${z} was refused: ${editor.snapshot().lastRefusal?.reason}`,
      );
    }
  }

  layTrack(fromX: number, toX: number, z: number): void {
    const editor = this.editor;
    editor.chooseItem(TRACK_ITEM);
    this.backend.aim(fromX, z);
    editor.pointerMove(0, 0);
    editor.dragStart(0, 0);
    for (let x = fromX + TILE_LDU / 4; x <= toX; x += TILE_LDU / 4) {
      this.backend.aim(x, z);
      editor.dragMove(0, 0);
    }
    const before = editor.snapshot().track?.pieces ?? 0;
    editor.dragEnd(0, 0, 0);
    if ((editor.snapshot().track?.pieces ?? 0) <= before) {
      throw new Error(
        `track from ${fromX} to ${toX} at ${z} laid nothing: ${editor.snapshot().lastRefusal?.reason}`,
      );
    }
  }

  buildDense(poses: ReadonlyArray<DensePose>): void {
    for (const pose of poses) this.place(DENSE_BRICK, pose.x, pose.z);
    this.editor.chooseItem(null);
  }

  buildTiles(tiles: number): void {
    const sets = setsByTile(tiles);
    let displacedBaseplates = 0;
    for (let row = 0; row < tiles; row++) {
      for (let column = 0; column < tiles; column++) {
        const set = sets.get(row * tiles + column);
        if (set !== undefined && this.baseplateLayerSets.has(set)) {
          displacedBaseplates++;
          continue;
        }
        this.place(BASEPLATE, tileCentre(column), tileCentre(row));
      }
    }
    for (const [tile, set] of sets) {
      this.place(set, tileCentre(tile % tiles), tileCentre(Math.floor(tile / tiles)));
    }
    const roadRow = tiles;
    for (let row = roadRow; row < roadRow + ROAD_ROWS; row++) {
      for (let column = 0; column < tiles; column++) {
        this.place(ROAD_PLATE, tileCentre(column), tileCentre(row));
      }
    }
    const trackRow = roadRow + ROAD_ROWS + 1;
    const runs = Math.floor(tiles / (TRACK_RUN_TILES + 1));
    for (let row = 0; row < TRACK_ROWS; row++) {
      for (let run = 0; run < runs; run++) {
        const fromX = run * (TRACK_RUN_TILES + 1) * TILE_LDU + HALF_TILE_LDU;
        this.layTrack(fromX, fromX + TRACK_RUN_TILES * TILE_LDU, tileCentre(trackRow + row));
      }
    }
    const spareRow = trackRow + TRACK_ROWS + 1;
    for (let i = 0; i < displacedBaseplates; i++) {
      this.place(BASEPLATE, tileCentre(i % tiles), tileCentre(spareRow + Math.floor(i / tiles)));
    }
    this.editor.chooseItem(null);
  }
}

function cellsOf(editor: IEditor, cells: ReadonlyMap<string, number>): number {
  const { refs, placements } = editor.dump();
  let total = 0;
  for (let i = 0; i < placements.refId.length; i++) {
    total += cells.get(refs[placements.refId[i] ?? 0] ?? "") ?? 0;
  }
  return total;
}

function partsOf(editor: IEditor): number {
  const parts = new Map(editor.snapshot().catalog.map((item) => [item.id, item.parts]));
  const { refs, placements } = editor.dump();
  let total = editor.snapshot().track?.pieces ?? 0;
  for (let i = 0; i < placements.refId.length; i++) {
    total += parts.get(refs[placements.refId[i] ?? 0] ?? "") ?? 0;
  }
  return total;
}

function placementTimes(times: ReadonlyArray<number>): PlacementTimes {
  const sorted = times.toSorted((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
  return {
    totalSeconds: times.reduce((sum, ms) => sum + ms, 0) / MS_PER_SECOND,
    p50Ms: at(P50),
    p95Ms: at(P95),
  };
}

function itemsOf(layout: Layout): ReadonlyArray<string> {
  switch (layout.kind) {
    case "tiles":
      return [...TILE_ITEMS, TRACK_ITEM];
    case "dense":
      return [DENSE_BRICK];
    default: {
      const unknown: never = layout;
      throw new Error(`unknown layout ${JSON.stringify(unknown)}`);
    }
  }
}

function arrangementOf(layout: Layout): string {
  switch (layout.kind) {
    case "tiles":
      return `${layout.tiles}×${layout.tiles} tiles`;
    case "dense":
      return `${layout.across}×${layout.deep}×${layout.layers} bricks`;
    default: {
      const unknown: never = layout;
      throw new Error(`unknown layout ${JSON.stringify(unknown)}`);
    }
  }
}

function denseBrick(catalog: IPlaceableCatalog): PlaceableCells {
  const brick = catalog.placeables().find((placeable) => placeable?.id === DENSE_BRICK);
  if (!brick) throw new Error(`${DENSE_BRICK} is not loaded from the fixture bundle`);
  return brick.cells;
}

function build(
  layout: Layout,
  builder: LayoutBuilder,
  catalog: IPlaceableCatalog,
): ReadonlyArray<DensePose> {
  switch (layout.kind) {
    case "tiles":
      builder.buildTiles(layout.tiles);
      return [];
    case "dense": {
      const poses = densePoses(layout, denseBrick(catalog));
      builder.buildDense(poses);
      return poses;
    }
    default: {
      const unknown: never = layout;
      throw new Error(`unknown layout ${JSON.stringify(unknown)}`);
    }
  }
}

async function runChild(
  scale: string,
  snapshotDir: string | null,
  worldsDir: string | null,
): Promise<RunResult> {
  const plan = SCALES[scale];
  if (plan === undefined) throw new Error(`unknown scale ${scale}`);
  Object.assign(globalThis, { requestAnimationFrame: () => 0 });
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const files = new BundleDirectoryFetcher();
  container.rebind(ASSET_FETCHER).toConstantValue(files);
  if (plan.kind === "dense") {
    const shipped = container.get(PART_BUNDLE_LOADER);
    container
      .rebind(PART_BUNDLE_LOADER)
      .toConstantValue(new WithFixtureModels(shipped, [DENSE_FIXTURE]));
  }
  const backend = new WindowlessBackend(container.get(SCENE_BACKEND));
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 1280,
    clientHeight: 800,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  const started = editor.snapshot();
  if (started.status !== "ready") throw new Error(`editor did not start: ${started.error ?? ""}`);
  await settled(editor, backend);
  const catalog = container.get(PLACEABLE_CATALOG);
  const cells = new Map<string, number>();
  const baseplateLayerSets = new Set<string>();
  for (const item of itemsOf(plan)) {
    if (item !== TRACK_ITEM) {
      const placeable = await loadCatalogItem(catalog, item);
      cells.set(item, placementCells(placeable));
      if (SETS.includes(item) && liesInBaseplateLayer(placeable)) baseplateLayerSets.add(item);
    }
    editor.chooseItem(item);
  }
  editor.chooseItem(null);
  await settled(editor, backend);
  const baseline = measure();
  const baselineSnapshot = snapshotDir
    ? writeHeapSnapshot(join(snapshotDir, `${scale}-baseline.heapsnapshot`))
    : null;
  const builder = new LayoutBuilder(editor, backend, baseplateLayerSets);
  const aimed = build(plan, builder, catalog);
  await settled(editor, backend);
  if (plan.kind === "dense") {
    const misplaced = misplacedBricks(editor, aimed);
    if (misplaced) throw new Error(misplaced);
  }
  const renderInput = backend.renderInputDigest();
  backend.forgetDigests();
  const layout = measure();
  const layoutSnapshot = snapshotDir
    ? writeHeapSnapshot(join(snapshotDir, `${scale}-layout.heapsnapshot`))
    : null;
  if (worldsDir) {
    const exported = await editor.exportWorld();
    writeFileSync(join(worldsDir, `${scale}.brr.zip`), exported.bytes);
  }
  const studs = editor.snapshot().studs;
  return {
    scale,
    arrangement: arrangementOf(plan),
    parts: partsOf(editor),
    placements: editor.snapshot().placements,
    placementCells: cellsOf(editor, cells),
    placing: placementTimes(builder.times),
    studsDrawn: studs?.drawn ?? 0,
    studsTotal: (studs?.drawn ?? 0) + (studs?.culledUnderFootprints ?? 0),
    renderInput,
    baseline,
    layout,
    snapshots:
      baselineSnapshot && layoutSnapshot
        ? { baseline: baselineSnapshot, layout: layoutSnapshot }
        : null,
  };
}

function ownersIn(path: string): OwnerTally {
  const tally = tallyOwners(parseHeapSnapshot(readFileSync(path)), RULES);
  rmSync(path);
  return tally;
}

function ownerSplit(result: RunResult, snapshots: Snapshots): OwnerSplit {
  const before = ownersIn(snapshots.baseline);
  const after = ownersIn(snapshots.layout);
  return {
    scale: result.scale,
    parts: result.parts,
    owners: [...new Set([...before.bytes.keys(), ...after.bytes.keys()])].map((owner) => ({
      owner,
      baselineBytes: before.bytes.get(owner) ?? 0,
      layoutBytes: after.bytes.get(owner) ?? 0,
    })),
    objects: OBJECT3D_CLASSES.map((name) => [
      name,
      before.objects.get(name) ?? 0,
      after.objects.get(name) ?? 0,
    ]),
  };
}

function median(values: ReadonlyArray<number>): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function mb(bytes: number): string {
  return (bytes / MB).toFixed(1);
}

function perPart(bytes: number, parts: number): string {
  return parts > 0 ? Math.round(bytes / parts).toLocaleString("en-US") : "n/a";
}

function forkRun(
  scale: string,
  snapshotDir: string | null,
  worldsDir: string | null,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const args = ["--child", scale, snapshotDir ?? "", worldsDir ?? ""];
    const child = fork(fileURLToPath(import.meta.url), args, {
      execArgv: ["--expose-gc", "--max-old-space-size=16384"],
    });
    child.on("message", (message: RunResult) => resolve(message));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`${scale} run exited with ${String(code)}`));
    });
  });
}

function report(results: ReadonlyArray<RunResult>, splits: ReadonlyArray<OwnerSplit>): string {
  const lines = [
    `cpu: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}, node ${process.version}`,
    `method: each run is a fresh process that starts the real IEditor (mainThreadModules, local bundle) on ThreeSceneBackend with no renderer, loads and meshes every item first (baseline), then places the layout through chooseItem/pointerMove/click and track drags (a set that brings its own baseplates, so has slab boxes, stands on its tile without a 3811, and that 3811 goes in a spare row after the track, so parts and placements match the full grid); ${GC_PASSES} forced GCs before each reading; medians of ${RUNS} runs; owners from the first run's baseline and layout V8 heap snapshots per scale (self sizes over a BFS tree from the GC roots, assigned by owning class and field); the render input digest hashes every chunk's instances and far-model placement the editor last handed the backend, and every run of a scale must hand it the same`,
    `dense layout: ${DENSE_BRICK} (one 3001 from the fixture bundle) placed across × deep per layer for each of the layers, alternate layers shifted half a brick along its width, at the pitch and layer height of its compiled cells, each through hover and click so it rests on the bricks below; the run fails unless every brick lands at the pose and layer its rule aims at`,
    "placement cells: the occupied columns of each placed item's cells, summed over the placements; placing: the editor's pointerMove and click per placement, summed over the layout (total) and as p50 and p95, medians of the runs",
    "",
    "| Scale | Layout | Parts | Placements | Placement cells per part | Placing total, p50, p95 | Studs drawn of total | Heap, layout − baseline | ArrayBuffers, layout − baseline | Bytes per part | Render input digest |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  const scales = [...new Set(results.map((result) => result.scale))];
  for (const scale of scales) {
    const runs = results.filter((result) => result.scale === scale);
    const first = runs[0];
    if (!first) continue;
    const heap = median(runs.map((r) => r.layout.heapBytes - r.baseline.heapBytes));
    const buffers = median(
      runs.map((r) => r.layout.arrayBufferBytes - r.baseline.arrayBufferBytes),
    );
    const total = median(runs.map((r) => r.placing.totalSeconds));
    const p50 = median(runs.map((r) => r.placing.p50Ms));
    const p95 = median(runs.map((r) => r.placing.p95Ms));
    lines.push(
      `| ${scale} | ${first.arrangement} | ${first.parts.toLocaleString("en-US")} | ${first.placements.toLocaleString("en-US")} | ${(first.placementCells / first.parts).toFixed(2)} | ${total.toFixed(1)} s, ${p50.toFixed(2)} ms, ${p95.toFixed(2)} ms | ${first.studsDrawn.toLocaleString("en-US")} of ${first.studsTotal.toLocaleString("en-US")} | ${mb(heap)} MB | ${mb(buffers)} MB | ${perPart(heap + buffers, first.parts)} B | \`${first.renderInput}\` |`,
    );
  }
  for (const split of splits) {
    const parts = split.parts;
    lines.push(
      "",
      `${split.scale} (${parts.toLocaleString("en-US")} parts), heap snapshot owners:`,
      "",
      "| Owner | Baseline | Layout | Layout − baseline | Bytes per part |",
      "|---|---:|---:|---:|---:|",
    );
    let withoutGeometryAndPartMeshes = 0;
    const rows = split.owners.toSorted(
      (a, b) => b.layoutBytes - b.baselineBytes - (a.layoutBytes - a.baselineBytes),
    );
    for (const row of rows) {
      const delta = row.layoutBytes - row.baselineBytes;
      if (!GEOMETRY_AND_PART_MESH_OWNERS.has(row.owner)) withoutGeometryAndPartMeshes += delta;
      lines.push(
        `| ${row.owner} | ${mb(row.baselineBytes)} MB | ${mb(row.layoutBytes)} MB | ${mb(delta)} MB | ${perPart(delta, parts)} B |`,
      );
    }
    lines.push(
      `| **all but geometry and part meshes** | | | **${mb(withoutGeometryAndPartMeshes)} MB** | **${perPart(withoutGeometryAndPartMeshes, parts)} B** |`,
      "",
      "| Object3D class | Baseline | Layout |",
      "|---|---:|---:|",
    );
    let renderables = 0;
    for (const [name, before, after] of split.objects) {
      if (RENDERABLE_CLASSES.has(name)) renderables += after - before;
      lines.push(
        `| ${name} | ${before.toLocaleString("en-US")} | ${after.toLocaleString("en-US")} |`,
      );
    }
    lines.push(
      `| **renderable objects added by the layout** | | **${renderables.toLocaleString("en-US")}** |`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const [mode, childScale, snapshotDir, worldsDir] = process.argv.slice(2);
  if (mode === "--child") {
    const result = await runChild(childScale ?? "", snapshotDir || null, worldsDir || null);
    process.send?.(result);
    process.exit(0);
  }
  const scales = process.env["LAYOUT_SCALES"]?.split(",") ?? DEFAULT_SCALES;
  const worlds = process.env["LAYOUT_WORLDS_DIR"] ?? null;
  if (worlds) mkdirSync(worlds, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "layout-memory-"));
  const results: RunResult[] = [];
  const splits: OwnerSplit[] = [];
  try {
    for (const scale of scales) {
      for (let run = 0; run < RUNS; run++) {
        const first = run === 0;
        const result = await forkRun(scale, first ? scratch : null, first ? worlds : null);
        process.stdout.write(
          `${scale} run ${run + 1}: ${result.parts} parts, heap +${mb(result.layout.heapBytes - result.baseline.heapBytes)} MB, buffers +${mb(result.layout.arrayBufferBytes - result.baseline.arrayBufferBytes)} MB\n`,
        );
        const firstRun = results.find((earlier) => earlier.scale === scale);
        if (firstRun && firstRun.renderInput !== result.renderInput) {
          throw new Error(
            `${scale} run ${run + 1} handed the backend different render input (${result.renderInput}) from run 1 (${firstRun.renderInput})`,
          );
        }
        if (result.snapshots) splits.push(ownerSplit(result, result.snapshots));
        results.push(result);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const text = report(results, splits);
  process.stdout.write(`${text}\n`);
  const out = process.env["LAYOUT_MEMORY_REPORT"];
  if (out) writeFileSync(out, `${text}\n`);
}

await main();
