import { ASSET_FETCHER, type IAssetFetcher } from "@brr/catalog";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type ChunkTier,
  type EdgeMarker,
  type FarModelPlacement,
  type FrameStats,
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
import { mainThreadModules } from "../src/client.module.ts";
import { EDITOR, PLACEABLE_CATALOG } from "../src/tokens.ts";
import { loadCatalogItem } from "../src/catalog/catalog-item.test-support.ts";
import type { IEditor } from "../src/edit/editor.ts";
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
const ITEMS: ReadonlyArray<string> = [BASEPLATE, ROAD_PLATE, ...SETS];
const SCALES: Readonly<Record<string, number>> = { small: 5, medium: 10, large: 18 };
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
  "LineSegments",
  "DirectionalLight",
];
const RENDERABLE_CLASSES: ReadonlySet<string> = new Set(["Mesh", "InstancedMesh", "LineSegments"]);

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
    ["BufferGeometry", GEOMETRY],
    ["BufferAttribute", GEOMETRY],
    ["PartMeshStream", PART_MESHES],
  ]),
  byField: new Map([
    [
      "ThreeSceneBackend",
      new Map([
        ...fields(INSTANCES, ["ghostPage"]),
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

interface RunResult {
  readonly scale: string;
  readonly tiles: number;
  readonly parts: number;
  readonly placements: number;
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

class LayoutBuilder {
  constructor(
    private readonly editor: IEditor,
    private readonly backend: WindowlessBackend,
  ) {}

  place(item: string, x: number, z: number): void {
    const editor = this.editor;
    editor.chooseItem(item);
    this.backend.aim(x, z);
    editor.pointerMove(0, 0);
    const before = editor.snapshot().placements;
    editor.click(0, 0, 0);
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

  build(tiles: number): void {
    for (let row = 0; row < tiles; row++) {
      for (let column = 0; column < tiles; column++) {
        this.place(BASEPLATE, tileCentre(column), tileCentre(row));
      }
    }
    let set = 0;
    for (let row = 0; row < tiles; row += SET_EVERY_TILES) {
      for (let column = 0; column < tiles; column++) {
        if ((row / SET_EVERY_TILES + column) % 2 !== 0) continue;
        this.place(SETS[set % SETS.length] ?? "", tileCentre(column), tileCentre(row));
        set++;
      }
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
    this.editor.chooseItem(null);
  }
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

async function runChild(
  scale: string,
  snapshotDir: string | null,
  worldsDir: string | null,
): Promise<RunResult> {
  const tiles = SCALES[scale];
  if (tiles === undefined) throw new Error(`unknown scale ${scale}`);
  Object.assign(globalThis, { requestAnimationFrame: () => 0 });
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const files = new BundleDirectoryFetcher();
  container.rebind(ASSET_FETCHER).toConstantValue(files);
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
  for (const item of ITEMS) {
    await loadCatalogItem(catalog, item);
    editor.chooseItem(item);
  }
  editor.chooseItem(TRACK_ITEM);
  editor.chooseItem(null);
  await settled(editor, backend);
  const baseline = measure();
  const baselineSnapshot = snapshotDir
    ? writeHeapSnapshot(join(snapshotDir, `${scale}-baseline.heapsnapshot`))
    : null;
  new LayoutBuilder(editor, backend).build(tiles);
  await settled(editor, backend);
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
    tiles,
    parts: partsOf(editor),
    placements: editor.snapshot().placements,
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
    `method: each run is a fresh process that starts the real IEditor (mainThreadModules, local bundle) on ThreeSceneBackend with no renderer, loads and meshes every item first (baseline), then places the layout through chooseItem/pointerMove/click and track drags; ${GC_PASSES} forced GCs before each reading; medians of ${RUNS} runs; owners from the first run's baseline and layout V8 heap snapshots per scale (self sizes over a BFS tree from the GC roots, assigned by owning class and field); the render input digest hashes every chunk's instances and far-model placement the editor last handed the backend, and every run of a scale must hand it the same`,
    "",
    "| Scale | Tiles | Parts | Placements | Studs drawn of total | Heap, layout − baseline | ArrayBuffers, layout − baseline | Bytes per part | Render input digest |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
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
    lines.push(
      `| ${scale} | ${first.tiles}×${first.tiles} | ${first.parts.toLocaleString("en-US")} | ${first.placements} | ${first.studsDrawn.toLocaleString("en-US")} of ${first.studsTotal.toLocaleString("en-US")} | ${mb(heap)} MB | ${mb(buffers)} MB | ${perPart(heap + buffers, first.parts)} B | \`${first.renderInput}\` |`,
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
  const scales = process.env["LAYOUT_SCALES"]?.split(",") ?? Object.keys(SCALES);
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
