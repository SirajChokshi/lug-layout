import { ASSET_FETCHER, type IAssetFetcher } from "@brr/catalog";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ISceneBackend,
  type LookSettings,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { mainThreadModules } from "../src/client.module.ts";
import { EDITOR, PLACEABLE_CATALOG } from "../src/tokens.ts";
import { loadCatalogItem } from "../src/catalog/catalog-item.test-support.ts";
import type { IPlaceableCatalog } from "../src/catalog/placeable-catalog.ts";
import type { IEditor } from "../src/edit/editor.ts";
import { meshesSettled } from "../src/edit/mesh-progress.ts";
import type { Placeable } from "../src/edit/placeable.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const TILE_LDU = 640;
const HALF_TILE_LDU = TILE_LDU / 2;
const GRID_TILES = 16;
const SET_EVERY_TILES = 2;
const ROAD_ROWS = 2;
const ROAD_ROW = GRID_TILES;
const RAIL_ROW = GRID_TILES + ROAD_ROWS + 1;
const ROAD_MODULE_ROW = RAIL_ROW + 1;
const TRACK_ROW = ROAD_MODULE_ROW + 2;
const MODULE_COLUMNS = 12;
const TRACK_ROWS = 3;
const SPARE_ROW = TRACK_ROW + TRACK_ROWS + 1;
const TRACK_RUNS = 5;
const TRACK_RUN_TILES = 2;
const RAY_HEIGHT_LDU = 10_000;
const GC_SETTLE_MS = 50;
const HOVER_CALLS = 2_000;
const HOVER_WARMUP_CALLS = 200;
const CLICK_CYCLES = 60;
const CLICK_WARMUP_CYCLES = 5;
const BASEPLATE = "ldraw:3811@2";
const ROAD_PLATE = "ldraw:44336p01@2";
const RAIL_MODULE = "generated:mils-rail-straight";
const ROAD_MODULE = "generated:mils-road-straight";
const TRACK_ITEM = "track:lego-9v";
const TRACK_PIECE = "track-piece:ldraw:74746";
const SET_ON_BASEPLATES = "omr:2150-1";
const SETS: ReadonlyArray<string> = [
  "omr:10264-1",
  "omr:10185-1",
  "omr:10218-1",
  "omr:10190-1",
  "omr:7936-1",
  "omr:10205-1",
];
const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class HeadlessBackend implements ISceneBackend {
  private aimX = 0;
  private aimZ = 0;
  async init(): Promise<BackendInfo> {
    return {
      requestedApi: "webgl2",
      activeApi: "webgl2",
      adapter: "none",
      backgroundSrgb: 0,
      look: NO_LOOK,
    };
  }
  setPalette(): void {}
  addParts(): void {}
  setPartMeshes(): void {}
  setFarStuds(): void {}
  setFarModelMesh(): void {}
  setColors(): void {}
  setChunk(): void {}
  deleteChunk(): void {}
  setNeededMeshListener(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setGround(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}
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
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  needsFrame(): boolean {
    return true;
  }
  async waitForGpu(): Promise<void> {}
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
  forceTier(): void {}
  setFarModel(): void {}
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

interface Row {
  readonly name: string;
  readonly digest: string;
  readonly calls: number;
  readonly medianUs: number;
  readonly p95Us: number;
  readonly meanUs: number;
  readonly gcs: number;
}

const rows: Row[] = [];

function quantile(sorted: Float64Array, fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

function digestOf(values: ReadonlyArray<unknown>): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 12);
}

function observed(editor: IEditor): unknown {
  const state = editor.snapshot();
  return {
    hover: state.hover,
    snap: state.snap,
    ghostRot: state.ghostRot,
    placements: state.placements,
    lastRefusal: state.lastRefusal,
    refusedClicks: state.refusedClicks,
    selection: state.selection,
    roads: { ...state.roads, checkMs: 0 },
    studs: state.studs,
    held: state.track?.held ?? null,
    trackPieces: state.track?.pieces ?? 0,
  };
}

function record(name: string, samplesMs: Float64Array, gcs: number, digest: string): void {
  const sorted = samplesMs.toSorted();
  let total = 0;
  for (const sample of sorted) total += sample;
  rows.push({
    name,
    digest,
    calls: sorted.length,
    medianUs: quantile(sorted, 0.5) * 1000,
    p95Us: quantile(sorted, 0.95) * 1000,
    meanUs: (total / sorted.length) * 1000,
    gcs,
  });
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, GC_SETTLE_MS));
}

async function timeCalls(
  editor: IEditor,
  name: string,
  calls: number,
  warmup: number,
  call: (i: number) => void,
): Promise<void> {
  for (let i = 0; i < warmup; i++) call(i);
  await settle();
  const samples = new Float64Array(calls);
  const gcBefore = collections;
  for (let i = 0; i < calls; i++) {
    const start = performance.now();
    call(i);
    samples[i] = performance.now() - start;
  }
  await settle();
  const gcs = collections - gcBefore;
  const seen: unknown[] = [];
  for (let i = 0; i < calls; i++) {
    call(i);
    seen.push(observed(editor));
  }
  record(name, samples, gcs, digestOf(seen));
}

function farTierAndMeshesSettled(editor: IEditor): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      const { farTier, meshes } = editor.snapshot();
      if (farTier === "loading" || !meshesSettled(meshes)) return;
      unsubscribe();
      resolve();
    };
    const unsubscribe = editor.subscribe(check);
    check();
  });
}

function tileCentre(index: number): number {
  return index * TILE_LDU + HALF_TILE_LDU;
}

function setsByTile(): ReadonlyMap<number, string> {
  const sets = new Map<number, string>();
  let set = 0;
  for (let row = 0; row < GRID_TILES; row += SET_EVERY_TILES) {
    for (let column = 0; column < GRID_TILES; column += 1) {
      if ((row / SET_EVERY_TILES + column) % 2 !== 0) continue;
      sets.set(row * GRID_TILES + column, SETS[set % SETS.length] ?? "");
      set++;
    }
  }
  return sets;
}

function liesInBaseplateLayer(placeable: Placeable): boolean {
  return placeable.slabBoxes.length > 0;
}

async function startEditor(): Promise<{
  editor: IEditor;
  backend: HeadlessBackend;
  catalog: IPlaceableCatalog;
}> {
  const backend = new HeadlessBackend();
  Object.assign(globalThis, { requestAnimationFrame: () => 0 });
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  const { status, error } = editor.snapshot();
  if (status !== "ready") throw new Error(`editor did not start: ${error ?? status}`);
  return { editor, backend, catalog: container.get(PLACEABLE_CATALOG) };
}

function placer(editor: IEditor, backend: HeadlessBackend, clickMs: number[]) {
  return (item: string, x: number, z: number): void => {
    editor.chooseItem(item);
    backend.aim(x, z);
    editor.pointerMove(0, 0);
    const before = editor.snapshot().placements;
    const start = performance.now();
    editor.click(0, 0, 0);
    clickMs.push(performance.now() - start);
    if (editor.snapshot().placements !== before + 1) {
      throw new Error(
        `${item} at ${x}, ${z} was refused: ${editor.snapshot().lastRefusal?.reason}`,
      );
    }
  };
}

function layTrack(
  editor: IEditor,
  backend: HeadlessBackend,
  fromX: number,
  toX: number,
  z: number,
) {
  editor.chooseItem(TRACK_ITEM);
  backend.aim(fromX, z);
  editor.pointerMove(0, 0);
  editor.dragStart(0, 0);
  for (let x = fromX + TILE_LDU / 4; x <= toX; x += TILE_LDU / 4) {
    backend.aim(x, z);
    editor.dragMove(0, 0);
  }
  editor.dragEnd(0, 0, 0);
}

function partsOf(editor: IEditor): number {
  const parts = new Map(editor.snapshot().catalog.map((item) => [item.id, item.parts]));
  let total = 0;
  const { refs, placements } = editor.dump();
  for (let i = 0; i < placements.refId.length; i++) {
    total += parts.get(refs[placements.refId[i] ?? 0] ?? "") ?? 0;
  }
  return total;
}

const loadStart = performance.now();
const { editor, backend, catalog } = await startEditor();
const loadMs = performance.now() - loadStart;
const baseplateLayerSets = new Set<string>();
for (const model of [...SETS, SET_ON_BASEPLATES, RAIL_MODULE, ROAD_MODULE]) {
  const placeable = await loadCatalogItem(catalog, model);
  if (SETS.includes(model) && liesInBaseplateLayer(placeable)) baseplateLayerSets.add(model);
}
const sets = setsByTile();
const clickMs: number[] = [];
const place = placer(editor, backend, clickMs);
const buildStart = performance.now();
let displacedBaseplates = 0;
for (let row = 0; row < GRID_TILES; row++) {
  for (let column = 0; column < GRID_TILES; column++) {
    const set = sets.get(row * GRID_TILES + column);
    if (set !== undefined && baseplateLayerSets.has(set)) {
      displacedBaseplates++;
      continue;
    }
    place(BASEPLATE, tileCentre(column), tileCentre(row));
  }
}
for (let i = 0; i < displacedBaseplates; i++) {
  place(BASEPLATE, tileCentre(i % GRID_TILES), tileCentre(SPARE_ROW + Math.floor(i / GRID_TILES)));
}
for (const [tile, set] of sets) {
  place(set, tileCentre(tile % GRID_TILES), tileCentre(Math.floor(tile / GRID_TILES)));
}
for (let row = ROAD_ROW; row < ROAD_ROW + ROAD_ROWS; row++) {
  for (let column = 0; column < GRID_TILES; column++) {
    place(ROAD_PLATE, tileCentre(column), tileCentre(row));
  }
}
for (let column = 0; column < MODULE_COLUMNS; column++) {
  place(RAIL_MODULE, tileCentre(column), tileCentre(RAIL_ROW));
  place(ROAD_MODULE, tileCentre(column), tileCentre(ROAD_MODULE_ROW));
}
for (let row = 0; row < TRACK_ROWS; row++) {
  for (let run = 0; run < TRACK_RUNS; run++) {
    const fromX = run * (TRACK_RUN_TILES + 1) * TILE_LDU + HALF_TILE_LDU;
    const z = tileCentre(TRACK_ROW + row);
    layTrack(editor, backend, fromX, fromX + TRACK_RUN_TILES * TILE_LDU, z);
  }
}
const buildMs = performance.now() - buildStart;
await farTierAndMeshesSettled(editor);
const snapshot = editor.snapshot();
const totalParts = partsOf(editor);
const placeSamples = Float64Array.from(clickMs);
const built = digestOf([editor.dump(), observed(editor)]);
record("build: place click (whole build)", placeSamples, 0, built);
record(
  "build: place click (last 25%)",
  placeSamples.subarray(Math.floor((placeSamples.length * 3) / 4)),
  0,
  built,
);

const midX = tileCentre(GRID_TILES / 2);
const midZ = tileCentre(GRID_TILES / 2);
const hover = (x0: number, z0: number) => (i: number) => {
  backend.aim(x0 + (i % 8) * 20, z0 + ((i >> 3) % 8) * 20);
  editor.pointerMove(0, 0);
};
editor.chooseItem(BASEPLATE);
await timeCalls(
  editor,
  "hover: 3811 baseplate ghost",
  HOVER_CALLS,
  HOVER_WARMUP_CALLS,
  hover(midX, midZ),
);
editor.chooseItem("omr:10264-1");
await timeCalls(
  editor,
  "hover: 10264-1 set ghost over free baseplates",
  HOVER_CALLS,
  HOVER_WARMUP_CALLS,
  hover(midX, tileCentre(GRID_TILES / 2 - 1)),
);
editor.chooseItem(ROAD_PLATE);
await timeCalls(
  editor,
  "hover: road plate ghost over the road rows",
  HOVER_CALLS,
  HOVER_WARMUP_CALLS,
  hover(tileCentre(GRID_TILES / 2), tileCentre(ROAD_ROW + 1) - 100),
);
await timeCalls(
  editor,
  "hover: road plate ghost past the end of the road rows",
  HOVER_CALLS,
  HOVER_WARMUP_CALLS,
  hover(GRID_TILES * TILE_LDU + 100, tileCentre(ROAD_ROW) + 100),
);
editor.chooseItem(RAIL_MODULE);
await timeCalls(
  editor,
  "hover: rail module ghost beside the module row",
  HOVER_CALLS,
  HOVER_WARMUP_CALLS,
  hover(tileCentre(MODULE_COLUMNS), tileCentre(RAIL_ROW)),
);
editor.chooseItem(TRACK_PIECE);
await timeCalls(
  editor,
  "hover: held straight track piece near open ends",
  HOVER_CALLS,
  HOVER_WARMUP_CALLS,
  hover(TRACK_RUN_TILES * TILE_LDU + HALF_TILE_LDU - 60, tileCentre(TRACK_ROW) - 60),
);

async function placeAndUndo(name: string, item: string, x: number, z: number): Promise<void> {
  editor.chooseItem(item);
  backend.aim(x, z);
  editor.pointerMove(0, 0);
  const placeCycle = new Float64Array(CLICK_CYCLES);
  const undoCycle = new Float64Array(CLICK_CYCLES);
  const placedSeen: unknown[] = [];
  const undoneSeen: unknown[] = [];
  await settle();
  const gcBefore = collections;
  for (let i = -CLICK_WARMUP_CYCLES; i < CLICK_CYCLES; i++) {
    const before = editor.snapshot().placements;
    const start = performance.now();
    editor.click(0, 0, 0);
    const placed = performance.now();
    if (editor.snapshot().placements !== before + 1) throw new Error(`${name}: refused`);
    editor.undo(0);
    const undone = performance.now();
    if (i >= 0) {
      placeCycle[i] = placed - start;
      undoCycle[i] = undone - placed;
    }
  }
  await settle();
  const gcs = collections - gcBefore;
  for (let i = 0; i < CLICK_WARMUP_CYCLES; i++) {
    editor.click(0, 0, 0);
    placedSeen.push(observed(editor));
    editor.undo(0);
    undoneSeen.push(observed(editor));
  }
  record(`place click: ${name}`, placeCycle, gcs, digestOf(placedSeen));
  record(`undo: ${name}`, undoCycle, gcs, digestOf(undoneSeen));
}

await placeAndUndo(
  "10185-1 flush beside the baseplates",
  "omr:10185-1",
  tileCentre(GRID_TILES),
  tileCentre(1),
);
await placeAndUndo("2150-1 on free baseplates", SET_ON_BASEPLATES, tileCentre(1), tileCentre(1));
await placeAndUndo(
  "road plate extending the road rows",
  ROAD_PLATE,
  GRID_TILES * TILE_LDU + HALF_TILE_LDU,
  tileCentre(ROAD_ROW),
);
await placeAndUndo(
  "rail module extending the module row",
  RAIL_MODULE,
  tileCentre(MODULE_COLUMNS),
  tileCentre(RAIL_ROW),
);

editor.chooseItem(null);
await timeCalls(editor, "select click: pick a placed set", 200, 20, (i) => {
  backend.aim(tileCentre((i % GRID_TILES) & ~1), tileCentre(0));
  editor.click(0, 0, 0);
});

const header = [
  `cpu: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}, node ${process.version}`,
  `layout: ${snapshot.placements} placements, ${totalParts} parts, ${snapshot.track?.pieces ?? 0} track pieces, ${snapshot.roads.placements} road placements`,
  `editor start: ${loadMs.toFixed(0)} ms, build through the UI: ${buildMs.toFixed(0)} ms`,
];
const table = [
  "| Operation | Calls | Median µs | p95 µs | Mean µs | GCs | Result digest |",
  "|---|---:|---:|---:|---:|---:|---|",
  ...rows.map(
    (row) =>
      `| ${row.name} | ${row.calls} | ${row.medianUs.toFixed(1)} | ${row.p95Us.toFixed(1)} | ${row.meanUs.toFixed(1)} | ${row.gcs} | \`${row.digest}\` |`,
  ),
];
observer.disconnect();
const report = [...header, "", ...table].join("\n");
process.stdout.write(`${report}\n`);
const out = process.env["LARGE_LAYOUT_REPORT"];
if (out) await writeFile(out, `${report}\n`);
